/**
 * Real Playwright driver (thin glue, NOT unit-tested live here).
 *
 * - `chromium.launchPersistentContext(profileDir, â€¦)` with an exclusive
 *   per-tenant/account profile dir (never the default Chrome profile).
 *   Concurrency for the same binding is serialized beforehand by the
 *   atomic `profileLock.ts` sidecar (the driver never opens a profile
 *   twice concurrently).
 * - `serviceWorkers: "block"` so `context.route` observes every request.
 * - Route policy: block cross-origin; GET/HEAD/OPTIONS same-origin;
 *   at most ONE POST, only from the MAIN frame to the exact configured
 *   `CINEVISION_LOGIN_PATH` while the MAIN page is on the EXACT
 *   `#/sign-in` route AND inside the single `submitLogin` click window;
 *   plus exactly ONE bounded reauth POST per command armed explicitly
 *   via `armReauthWindow` with the same guarantees (re-arming refused);
 *   block PUT/PATCH/DELETE and every other POST (popups, iframes,
 *   arbitrary forms, second POST, off-window, off-path).
 * - Every popup is closed on sight (same-origin included): only the main
 *   page may issue requests, so no popup form can ride the login window.
 * - Identity reads use an ABSOLUTE URL (`new URL(path, allowedOrigin)`)
 *   with redirects disabled (`maxRedirects: 0`); a cross-origin redirect
 *   target fails closed WITHOUT following (no cookie/token leaves the
 *   allowlist origin).
 * - Login submit requires exactly ONE `<form>` with exactly one email-ish
 *   input, one password input and one submit button scoped to that form â€”
 *   never `first()` over ambiguous controls; anything else returns false
 *   (caller maps to HUMAN_REQUIRED) before any fill or click.
 * - No storageState, HAR, screenshots, traces, console or network-body
 *   capture â€” none of these APIs are called.
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import type { BrowserOpenOptions, ReadIdentityBrowser, ReadIdentityPage } from "./operations/readIdentity.js";
import { READ_IDENTITY_PATH } from "./constants.js";
import {
  fetchProjectedInPage,
  type InPageRequest,
  type InPageResult,
} from "./providers/cinevision/api-client.js";
import {
  armReauthWindow,
  consumeLoginPost,
  decideRoutedRequest,
  initialPolicyState,
  isSignInRoute,
  type PolicyState,
} from "./policy.js";
import type { WorkerConfig } from "./config.js";


const FORM_SELECTOR = "form";
const EMAIL_SELECTOR =
  'input[type="email"], input[name*="user" i], input[name*="mail" i], input[id*="user" i]';
const PASSWORD_SELECTOR = 'input[type="password"]';
const SUBMIT_SELECTOR = 'button[type="submit"], input[type="submit"]';

export class CrossOriginRedirectError extends Error {
  constructor() {
    super("browser-worker identity: cross-origin redirect");
    this.name = "CrossOriginRedirectError";
  }
}

/**
 * Build the ABSOLUTE identity URL. Rejects anything but the fixed
 * `READ_IDENTITY_PATH` so callers cannot smuggle a relative/foreign URL
 * into the authenticated request context.
 */
export function buildIdentityUrl(allowedOrigin: string, path: string = READ_IDENTITY_PATH): string {
  if (path !== READ_IDENTITY_PATH) {
    throw new CrossOriginRedirectError();
  }
  return new URL(path, allowedOrigin).toString();
}

/** Origin of a redirect `Location` resolved against the request URL. */
export function redirectTargetOrigin(location: string, base: string): string | null {
  try {
    return new URL(location, base).origin;
  } catch {
    return null;
  }
}

/** True when following `location` would leave the allowlist origin. */
export function isCrossOriginRedirect(allowedOrigin: string, requestUrl: string, location: string): boolean {
  if (location.trim().length === 0) return true;
  const target = redirectTargetOrigin(location, requestUrl);
  return target === null || target !== allowedOrigin;
}

/**
 * Budget abort during the login submit: thrown at step boundaries so
 * late-resolving fills perform NO further step (no click, no POST
 * window, no settle wait). Never surfaced past the command runner: it
 * maps to the same fail-closed timeout outcome.
 */
export class SubmitAbortedError extends Error {
  constructor() {
    super("browser-worker submit: budget exceeded");
    this.name = "SubmitAbortedError";
  }
}

/**
 * Default bounded wait for a canceled launch to settle + its tardy
 * context to close (F1). Overridable per-call (`launchSettleMs`) and via
 * `BROWSER_WORKER_LAUNCH_SETTLE_MS` (see `config.ts`).
 */
export const LAUNCH_QUIESCE_DEFAULT_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded close: never lets a wedged context outlive cleanup. */
async function closeBounded(closable: { close(): Promise<void> }, timeoutMs: number): Promise<void> {
  try {
    await Promise.race([closable.close(), sleep(timeoutMs)]);
  } catch {
    // ignore
  }
}

/** Bounded quiescence wait: true when settled within the bound. */
async function settleBounded(quiescence: Promise<void>, timeoutMs: number): Promise<boolean> {
  // `quiescence` never rejects (launch failures map to undefined and
  // `closeBounded` swallows close errors); the flag records whether it
  // settled before the bound expired.
  let settled = false;
  void quiescence.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.race([quiescence, sleep(timeoutMs)]);
  return settled;
}

function throwIfSubmitAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new SubmitAbortedError();
}
export interface SubmitLoginSteps {
  fillEmail(): Promise<void>;
  fillPassword(): Promise<void>;
  clickSubmit(): Promise<void>;
  waitSettled(): Promise<void>;
}

/**
 * Run fill â†’ click with the single-POST window armed ONLY around the click.
 * Fills execute with the window closed (a page input/change handler firing
 * a POST during fill is blocked by the route); the route consumes the
 * exception (`loginPostUsed`) and the window closes in `finally`, even
 * when the click throws. The budget `signal` is checked BEFORE every
 * step, so a late-resolving fill after abort performs no click and
 * arms no window.
 */
export async function performSubmitLogin(
  state: PolicyState,
  steps: SubmitLoginSteps,
  signal?: AbortSignal,
): Promise<void> {
  throwIfSubmitAborted(signal);
  await steps.fillEmail();
  throwIfSubmitAborted(signal);
  await steps.fillPassword();
  throwIfSubmitAborted(signal);
  state.loginWindowOpen = true;
  try {
    throwIfSubmitAborted(signal);
    await steps.clickSubmit();
    throwIfSubmitAborted(signal);
    await steps.waitSettled();
  } finally {
    state.loginWindowOpen = false;
  }
}

export class PlaywrightPage implements ReadIdentityPage {
  private readonly page: Page;
  private readonly context: BrowserContext;
  private readonly allowedOrigin: string;
  private readonly state: PolicyState;
  private readonly loginPath: string;

  constructor(
    page: Page,
    context: BrowserContext,
    allowedOrigin: string,
    state: PolicyState,
    loginPath: string,
  ) {
    this.page = page;
    this.context = context;
    this.allowedOrigin = allowedOrigin;
    this.state = state;
    this.loginPath = loginPath;
  }

  currentUrl(): string {
    return this.page.url();
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async probeLoginForm(): Promise<{
    forms: number;
    emailInputs: number;
    passwordInputs: number;
    submitButtons: number;
  } | null> {
    const forms = await this.page.locator(FORM_SELECTOR).count();
    if (forms !== 1) {
      // Ambiguous (or no) form scope: report global counts, caller refuses.
      const emailInputs = await this.page.locator(EMAIL_SELECTOR).count();
      const passwordInputs = await this.page.locator(PASSWORD_SELECTOR).count();
      const submitButtons = await this.page.locator(SUBMIT_SELECTOR).count();
      if (emailInputs === 0 && passwordInputs === 0) return null;
      return { forms, emailInputs, passwordInputs, submitButtons };
    }
    const form = this.page.locator(FORM_SELECTOR).first();
    const emailInputs = await form.locator(EMAIL_SELECTOR).count();
    const passwordInputs = await form.locator(PASSWORD_SELECTOR).count();
    const submitButtons = await form.locator(SUBMIT_SELECTOR).count();
    if (emailInputs === 0 && passwordInputs === 0) return null;
    return { forms, emailInputs, passwordInputs, submitButtons };
  }

  async detectChallenge(): Promise<boolean> {
    // Interstitial challenges (Cloudflare "Just a moment") manifest on the
    // main frame: title + marker elements. Embedded Turnstile iframes on the
    // login form are login-protection widgets, not blockers; if they require
    // interaction the login submit fails closed downstream.
    const title = (await this.page.title().catch(() => "")).toLowerCase();
    if (
      /just a moment|attention required|checking your browser|verify you are human|um momento|sÃ³ um momento|verifique que vocÃª Ã© humano|por favor aguarde|un momento|verifique que eres humano/.test(
        title,
      )
    ) {
      return true;
    }
    const mainUrl = this.page.mainFrame().url();
    if (/captcha|turnstile|challenge/i.test(mainUrl)) return true;
    const markers = await this.page
      .locator(
        "#challenge-error-text, #cf-please-wait, #cf-challenge-running, #challenge-form, #challenge-stage",
      )
      .count()
      .catch(() => 0);
    return markers > 0;
  }

  async submitLogin(email: string, password: string, signal?: AbortSignal): Promise<boolean> {
    // Fail closed BEFORE any fill/click: exactly one form, exact route,
    // configured login path, unique controls scoped to that form.
    if (this.loginPath.length === 0) return false;
    if (!isSignInRoute(this.page.url())) return false;
    if ((await this.page.locator(FORM_SELECTOR).count()) !== 1) return false;
    const form = this.page.locator(FORM_SELECTOR).first();
    const emailBox = form.locator(EMAIL_SELECTOR);
    const passwordBox = form.locator(PASSWORD_SELECTOR);
    const submit = form.locator(SUBMIT_SELECTOR);
    if ((await emailBox.count()) !== 1) return false;
    if ((await passwordBox.count()) !== 1) return false;
    // Exactly one form-associated submit button â€” no `first()` over many,
    // no Enter-key fallback that bypasses the submit control.
    if ((await submit.count()) !== 1) return false;
    const emailHandle = emailBox.first();
    const passwordHandle = passwordBox.first();
    const submitHandle = submit.first();
    // Fills run with the window CLOSED (a page input/change handler
    // cannot smuggle a POST through); the single-POST window is armed
    // only around the one click and closed in `finally`.
    await performSubmitLogin(this.state, {
      fillEmail: () => emailHandle.fill(email),
      fillPassword: () => passwordHandle.fill(password),
      clickSubmit: () => submitHandle.click(),
      waitSettled: async () => {
        await this.page.waitForLoadState("domcontentloaded").catch(() => undefined);
      },
    }, signal);
    // Success heuristic: no login form remains and no challenge visible.
    const formNow = await this.probeLoginForm();
    if (formNow !== null) return false;
    return true;
  }

  async fetchIdentity(): Promise<unknown> {
    // The panel authenticates with a Bearer token in localStorage (not
    // cookies), so the read runs INSIDE the page â€” same-origin fetch with
    // the session token the worker's own login produced. Cross-origin is
    // unreachable by construction (page stays on the allowed origin).
    const identityUrl = buildIdentityUrl(this.allowedOrigin);
    return await this.page.evaluate(async (url) => {
      const scope = globalThis as unknown as {
        localStorage: { getItem(key: string): string | null };
      };
      const token = scope.localStorage.getItem("token");
      const headers: Record<string, string> = { Accept: "application/json" };
      if (typeof token === "string" && token.length > 0) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetch(url, { headers, redirect: "manual" });
      if (!response.ok) {
        return { __identityReadStatus: response.status };
      }
      return (await response.json().catch(() => null)) as unknown;
    }, identityUrl);
  }

  async close(): Promise<void> {
    await this.context.close();
  }

  /**
   * Arm the single bounded reauth login POST window (F4). Returns false
   * when the reauth window was already armed/consumed — at most one
   * reauth POST per command lifetime, with unchanged guarantees.
   */
  armReauthWindow(): boolean {
    return armReauthWindow(this.state);
  }

  /**
   * Run one Fase-1 capability read inside the page. The in-page closure
   * is ALWAYS `fetchProjectedInPage` (imported, never duplicated): it
   * validates origin + exact path BEFORE touching the session token and
   * projects allowlisted primitive fields in-page. Same `evaluate` entry
   * `fetchCapability` uses, with the same gates.
   */
  async evaluateCapability(req: InPageRequest): Promise<InPageResult> {
    return await this.page.evaluate(fetchProjectedInPage, req);
  }
}

export class PlaywrightBrowser implements ReadIdentityBrowser {
  private readonly config: WorkerConfig;
  private readonly launcher: (
    profileDir: string,
    options: {
      headless: boolean;
      serviceWorkers: "block";
      acceptDownloads: false;
    },
  ) => Promise<BrowserContext>;

  constructor(
    config: WorkerConfig,
    launcher: (
      profileDir: string,
      options: {
        headless: boolean;
        serviceWorkers: "block";
        acceptDownloads: false;
      },
    ) => Promise<BrowserContext> = (dir, options) =>
      chromium.launchPersistentContext(dir, options),
  ) {
    this.config = config;
    this.launcher = launcher;
  }

  /** Bounded launch-quiescence (F1): default 3s, env/test override. */
  private launchSettleMs(opts?: BrowserOpenOptions): number {
    const candidate = opts?.launchSettleMs ?? this.config.launchSettleMs;
    if (candidate === undefined) return LAUNCH_QUIESCE_DEFAULT_MS;
    if (!Number.isInteger(candidate)) return LAUNCH_QUIESCE_DEFAULT_MS;
    return Math.min(15_000, Math.max(500, candidate));
  }

  async open(
    profileDir: string,
    allowedOrigin: string,
    loginPath: string,
    opts?: BrowserOpenOptions,
  ): Promise<PlaywrightPage> {
    const signal = opts?.signal;
    const onContext = opts?.onContext;
    const onPendingLaunch = opts?.onPendingLaunch;
    const settleMs = this.launchSettleMs(opts);
    throwIfSubmitAborted(signal);
    const state = initialPolicyState();
    // Claimed once the winner takes ownership; a tardy launch that loses
    // the abort race closes itself instead of leaking a live context.
    let claimed: BrowserContext | null = null;
    const launch = this.launcher(profileDir, {
      headless: this.config.headless,
      serviceWorkers: "block",
      acceptDownloads: false,
      // No video/HAR/tracing/storageState by construction.
    });
    // F1 quiescence: settles when the pending launch settles AND any
    // tardy (unclaimed) context has been closed boundedly. Registered
    // with the lock owner synchronously so the profile lock is never
    // released while Chromium may still be starting on the profile.
    // Only an aborted-while-pending launch is tardy: the signal state
    // at settle time decides (not the `claimed` write, which races the
    // `await launch` continuation). An owned context — including one
    // that later fails setup or aborts mid-setup — is closed exactly
    // once by the setup `catch` below, never here.
    const quiescence: Promise<void> = launch.then(
      (ctx) => {
        if (signal?.aborted === true && ctx !== claimed) return closeBounded(ctx, settleMs);
        return undefined;
      },
      () => undefined,
    );
    onPendingLaunch?.(quiescence);
    let context: BrowserContext;
    if (signal === undefined) {
      context = await launch;
    } else {
      try {
        context = await Promise.race([
          launch,
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new SubmitAbortedError()), { once: true });
          }),
        ]);
      } catch (err) {
        // Abort (or launch failure) before ownership: wait BOUNDED for
        // the pending launch to settle and the tardy context to close
        // BEFORE rejecting — the caller releases the profile lock only
        // after this returns, so the lock is never freed while a launch
        // is still pending (F1). A still-pending launch after the bound
        // keeps closing in the background via `quiescence`.
        await settleBounded(quiescence, settleMs);
        throw err;
      }
    }
    claimed = context;
    // Expose the resource to the shared registry BEFORE any further
    // setup, so the timeout owner can close it while setup pends.
    onContext?.({ close: () => context.close() });
    try {
      throwIfSubmitAborted(signal);
      // Every popup is closed on sight — only the main page may request.
      context.on("page", (popup) => {
        void (async () => {
          try {
            await popup.close();
          } catch {
            // ignore
          }
        })();
      });
      // Main page first (about:blank, no network) so the route below binds
      // the login exception to its main frame by identity — never by URL.
      const mainPage = context.pages()[0] ?? (await context.newPage());
      throwIfSubmitAborted(signal);
      await context.route("**", (route) => {
        const request = route.request();
        const frame = request.frame();
        // Frame identity (not URL hash): subframes/popups can never match,
        // even when their own URL carries the sign-in hash. The route check
        // always reads the MAIN page URL, never a frame URL.
        const decision = decideRoutedRequest({
          method: request.method(),
          url: request.url(),
          allowedOrigin,
          mainPageUrl: mainPage.url(),
          isMainFrame: frame !== null && frame === mainPage.mainFrame(),
          loginWindowOpen: state.loginWindowOpen,
          loginPath,
          loginPostUsed: state.loginPostUsed,
          reauthArmed: state.reauthArmed,
          reauthLoginPostUsed: state.reauthLoginPostUsed,
        });
        if (decision === "allow") {
          void route.continue();
          return;
        }
        if (decision === "allow-login-post") {
          consumeLoginPost(state);
          void route.continue();
          return;
        }
        void route.abort();
      });
      throwIfSubmitAborted(signal);
      return new PlaywrightPage(mainPage, context, allowedOrigin, state, loginPath);
    } catch (err) {
      // Abort (or setup failure) after ownership: BOUNDED close BEFORE
      // rejecting — never hand out a page the owner already cleaned up,
      // and never let a wedged close outlive cleanup (F1).
      await closeBounded(context, settleMs);
      throw err;
    }
  }
}
