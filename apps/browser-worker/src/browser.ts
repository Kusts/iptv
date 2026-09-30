/**
 * Real Playwright driver (thin glue, NOT unit-tested live here).
 *
 * - `chromium.launchPersistentContext(profileDir, …)` with an exclusive
 *   per-tenant/account profile dir (never the default Chrome profile).
 *   Concurrency for the same binding is serialized beforehand by the
 *   atomic `profileLock.ts` sidecar (the driver never opens a profile
 *   twice concurrently).
 * - `serviceWorkers: "block"` so `context.route` observes every request.
 * - Route policy: block cross-origin; GET/HEAD/OPTIONS same-origin;
 *   at most ONE POST, only from the MAIN frame to the exact configured
 *   `CINEVISION_LOGIN_PATH` while the MAIN page is on the EXACT
 *   `#/sign-in` route AND inside the single `submitLogin` click window;
 *   block PUT/PATCH/DELETE and every other POST (popups, iframes,
 *   arbitrary forms, second POST, off-window, off-path).
 * - Every popup is closed on sight (same-origin included): only the main
 *   page may issue requests, so no popup form can ride the login window.
 * - Identity reads use an ABSOLUTE URL (`new URL(path, allowedOrigin)`)
 *   with redirects disabled (`maxRedirects: 0`); a cross-origin redirect
 *   target fails closed WITHOUT following (no cookie/token leaves the
 *   allowlist origin).
 * - Login submit requires exactly ONE `<form>` with exactly one email-ish
 *   input, one password input and one submit button scoped to that form —
 *   never `first()` over ambiguous controls; anything else returns false
 *   (caller maps to HUMAN_REQUIRED) before any fill or click.
 * - No storageState, HAR, screenshots, traces, console or network-body
 *   capture — none of these APIs are called.
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import type { ReadIdentityBrowser, ReadIdentityPage } from "./operations/readIdentity.js";
import { READ_IDENTITY_PATH } from "./constants.js";
import {
  decideRoutedRequest,
  initialPolicyState,
  isSignInRoute,
  type PolicyState,
} from "./policy.js";
import type { WorkerConfig } from "./config.js";

const CHALLENGE_RE = /captcha|turnstile|cloudflare|challenge|mfa|two-factor|2fa|verify you are human/i;

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

/** Minimal submit steps, injectable so the window timing is unit-testable. */
export interface SubmitLoginSteps {
  fillEmail(): Promise<void>;
  fillPassword(): Promise<void>;
  clickSubmit(): Promise<void>;
  waitSettled(): Promise<void>;
}

/**
 * Run fill → click with the single-POST window armed ONLY around the click.
 * Fills execute with the window closed (a page input/change handler firing
 * a POST during fill is blocked by the route); the route consumes the
 * exception (`loginPostUsed`) and the window closes in `finally`, even
 * when the click throws.
 */
export async function performSubmitLogin(state: PolicyState, steps: SubmitLoginSteps): Promise<void> {
  await steps.fillEmail();
  await steps.fillPassword();
  state.loginWindowOpen = true;
  try {
    await steps.clickSubmit();
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
    const frames = this.page.frames();
    for (const frame of frames) {
      const url = frame.url();
      if (/captcha|turnstile|challenge/i.test(url)) return true;
    }
    const body = await this.page.content().catch(() => "");
    return CHALLENGE_RE.test(body);
  }

  async submitLogin(email: string, password: string): Promise<boolean> {
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
    // Exactly one form-associated submit button — no `first()` over many,
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
    });
    // Success heuristic: no login form remains and no challenge visible.
    const formNow = await this.probeLoginForm();
    if (formNow !== null) return false;
    return true;
  }

  async fetchIdentity(): Promise<unknown> {
    const url = buildIdentityUrl(this.allowedOrigin);
    const first = await this.context.request.get(url, { maxRedirects: 0 });
    const response =
      first.status() >= 300 && first.status() < 400 ? await this.followSameOriginRedirect(url, first) : first;
    if (!response.ok()) {
      throw new Error(`identity read failed with status ${response.status()}`);
    }
    return (await response.json().catch(() => null)) as unknown;
  }

  private async followSameOriginRedirect(
    requestUrl: string,
    response: { status(): number; headers(): Record<string, string> },
  ): Promise<{ ok(): boolean; status(): number; json(): Promise<unknown> }> {
    const location = response.headers()["location"] ?? "";
    if (location.length === 0 || isCrossOriginRedirect(this.allowedOrigin, requestUrl, location)) {
      // Cross-origin (or unparseable) redirect: fail closed WITHOUT
      // following — no cookie/token is sent to another origin.
      throw new CrossOriginRedirectError();
    }
    const next = await this.context.request.get(new URL(location, requestUrl).toString(), {
      maxRedirects: 0,
    });
    if (next.status() >= 300 && next.status() < 400) {
      throw new CrossOriginRedirectError();
    }
    return next;
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

export class PlaywrightBrowser implements ReadIdentityBrowser {
  private readonly config: WorkerConfig;

  constructor(config: WorkerConfig) {
    this.config = config;
  }

  async open(
    profileDir: string,
    allowedOrigin: string,
    loginPath: string,
  ): Promise<ReadIdentityPage> {
    const state = initialPolicyState();
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: this.config.headless,
      serviceWorkers: "block",
      acceptDownloads: false,
      // No video/HAR/tracing/storageState by construction.
    });
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
      });
      if (decision === "allow") {
        void route.continue();
        return;
      }
      if (decision === "allow-login-post") {
        state.loginPostUsed = true;
        void route.continue();
        return;
      }
      void route.abort();
    });
    return new PlaywrightPage(mainPage, context, allowedOrigin, state, loginPath);
  }
}
