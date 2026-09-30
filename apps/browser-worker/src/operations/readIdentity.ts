/**
 * `cinevision.readIdentity` — read-only identity probe.
 *
 * SINGLE-BINDING operator smoke (see `constants.ts`): the tenant/account
 * binding comes from deployment env only. This operation never accepts
 * identity from argv/caller input, serves no HTTP API, and resolves
 * exactly the three `FIXED_SECRET_REFS`. A future API integration MUST
 * look the binding up by tenant/account id in its own DB instead of
 * trusting request-supplied ids.
 *
 * Flow (all browser I/O behind the injected `BrowserDriver` so unit tests
 * run fully mocked — no real site, no Infisical):
 *
 * 1. gate on `BROWSER_WORKER_ENABLED=1` (config already enforces);
 * 2. refuse to submit when `CINEVISION_LOGIN_PATH` is absent (CONFIG —
 *    config resolution already fails closed; this is defense in depth);
 * 3. resolve the three FIXED refs in-process;
 * 4. SSRF guard: secret URL must match `CINEVISION_ALLOWED_ORIGIN` + HTTPS;
 * 5. prepare the tenant/account-isolated persistent profile (0700,
 *    re-chmodded on POSIX even when pre-existing) and take the atomic
 *    per-binding file lock (`PROFILE_LOCKED` on collision); the lock is
 *    always released in a `finally`;
 * 6. open the profile; install the network policy (GET-only + a single
 *    login POST exception armed ONLY inside `submitLogin`, exact route +
 *    exact configured path);
 * 7. navigate to the allowlisted origin; strict-semantic login fill ONLY
 *    when there is exactly ONE form with exactly one email/user input,
 *    one password input and one form-scoped submit button; challenge/
 *    CAPTCHA/MFA → HUMAN_REQUIRED (never bypass); ambiguous DOM → no
 *    click, HUMAN_REQUIRED;
 * 8. no login success → no readback;
 * 9. read-only: GET the ABSOLUTE `/api/auth/me` URL TWICE via the page
 *    context (redirects disabled; cross-origin redirect → HUMAN_REQUIRED
 *    without following); compare the observed identity boolean with the
 *    expected credential (timing-safe, in-process); emit ONLY booleans.
 *
 * Nothing sensitive leaves the process: no storageState/HAR/screenshots/
 * traces/console or network bodies on disk or in logs/outputs.
 */

import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, stat } from "node:fs/promises";
import { platform } from "node:os";
import { assertSecretUrlAllowed, type WorkerConfig } from "../config.js";
import { READ_IDENTITY_PATH, type WorkerErrorCode, type WorkerStatus } from "../constants.js";
import { newResult, type WorkerResult } from "../output.js";
import { normalizeLoginPath } from "../policy.js";
import { acquireProfileLock, ProfileLockError } from "../profileLock.js";
import { CredentialError, resolveCredentials } from "../secrets.js";
import type { SecretsPort } from "@iptv/secrets";

/** Minimal page surface the operation needs (real impl: Playwright). */
export interface ReadIdentityPage {
  /** Current page URL (for sign-in route detection). */
  currentUrl(): string;
  /** Navigate to an allowlisted URL. */
  goto(url: string): Promise<void>;
  /**
   * Login control census. `forms` is the `<form>` count; the input/submit
   * counts are scoped to the single form when `forms === 1`. Null when no
   * login controls exist (existing persistent session).
   */
  probeLoginForm(): Promise<{
    forms: number;
    emailInputs: number;
    passwordInputs: number;
    submitButtons: number;
  } | null>;
  /** True when a bot challenge / MFA / captcha is visible. */
  detectChallenge(): Promise<boolean>;
  /**
   * Fill + submit using the strict-unique semantic controls. Returns false
   * WITHOUT clicking when the DOM is not exactly-one-form + unique
   * controls, when off the sign-in route, or when no login path is
   * configured.
   */
  submitLogin(email: string, password: string): Promise<boolean>;
  /**
   * Same-origin GET of the fixed identity endpoint via an ABSOLUTE URL.
   * Resolves raw JSON unknown. Cross-origin redirects fail closed.
   */
  fetchIdentity(): Promise<unknown>;
  close(): Promise<void>;
}

/** Minimal browser surface (real impl: `chromium.launchPersistentContext`). */
export interface ReadIdentityBrowser {
  open(profileDir: string, allowedOrigin: string, loginPath: string): Promise<ReadIdentityPage>;
}

export interface ReadIdentityDeps {
  secrets: SecretsPort;
  browser: ReadIdentityBrowser;
}

export interface ReadIdentityOutcome {
  status: WorkerStatus;
  identityMatched: boolean;
  readbackMatched: boolean;
  needsHuman: boolean;
  errorCode: WorkerErrorCode;
}

/** Extract a comparable identity string from `/api/auth/me` JSON, if present. */
export function extractIdentityField(body: unknown): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  for (const key of ["email", "username", "login", "user"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const nested = (value as Record<string, unknown>)["email"];
      if (typeof nested === "string" && nested.length > 0) return nested;
    }
  }
  return null;
}

/** Timing-safe string equality (length-mismatch safe). */
export function identityEquals(expected: string, observed: string | null): boolean {
  if (observed === null) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(observed, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function outcome(
  status: WorkerStatus,
  errorCode: WorkerErrorCode,
  flags: { identityMatched?: boolean; readbackMatched?: boolean; needsHuman?: boolean } = {},
): ReadIdentityOutcome {
  return {
    status,
    identityMatched: flags.identityMatched ?? false,
    readbackMatched: flags.readbackMatched ?? false,
    needsHuman: needsHumanFor(status, flags.needsHuman),
    errorCode,
  };
}

function needsHumanFor(status: WorkerStatus, explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  return status === "HUMAN_REQUIRED";
}

/**
 * Ensure the profile root + dir exist with `0700`. `mkdir(mode)` only
 * applies on creation, so on POSIX an EXISTING dir is re-chmodded to
 * `0700` explicitly. Throws on failure (caller fails closed).
 */
export async function ensureProfileDir(profileRoot: string, profileDir: string): Promise<void> {
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  if (platform() !== "win32") {
    // On Windows isolation relies on the %LOCALAPPDATA% container ACLs.
    const fix = async (path: string): Promise<void> => {
      const mode = (await stat(path)).mode & 0o777;
      if (mode !== 0o700) await chmod(path, 0o700);
    };
    await fix(profileRoot);
    await fix(profileDir);
  }
}

/** Execute the read-only probe. Never throws with secrets in the message. */
export async function runReadIdentity(
  config: WorkerConfig,
  deps: ReadIdentityDeps,
): Promise<WorkerResult> {
  const done = (o: ReadIdentityOutcome): WorkerResult =>
    newResult(config.providerAccountId, o);

  // Defense in depth: without a configured + valid login path nothing
  // may submit — HUMAN_REQUIRED/CONFIG (config already fails closed).
  try {
    normalizeLoginPath(config.loginPath);
  } catch {
    return done(outcome("HUMAN_REQUIRED", "CONFIG"));
  }

  let credentials: { panelUrl: string; email: string; password: string };
  try {
    credentials = await resolveCredentials(deps.secrets);
  } catch (err) {
    void err;
    return done(outcome("HUMAN_REQUIRED", "SECRET_UNAVAILABLE"));
  }
  if (errIsCredentialEmpty(credentials)) {
    return done(outcome("HUMAN_REQUIRED", "SECRET_UNAVAILABLE"));
  }

  try {
    assertSecretUrlAllowed(credentials.panelUrl, config.allowedOrigin);
  } catch {
    return done(outcome("HUMAN_REQUIRED", "ORIGIN_MISMATCH"));
  }

  try {
    await ensureProfileDir(config.profileRoot, config.profileDir);
  } catch {
    return done(outcome("HUMAN_REQUIRED", "TRANSPORT"));
  }

  let lock: { release(): Promise<void> } | null = null;
  try {
    lock = await acquireProfileLock(config.profileDir);
  } catch (err) {
    void err;
    if (err instanceof ProfileLockError) {
      return done(outcome("HUMAN_REQUIRED", "PROFILE_LOCKED"));
    }
    return done(outcome("HUMAN_REQUIRED", "TRANSPORT"));
  }

  let page: ReadIdentityPage | null = null;
  try {
    page = await deps.browser.open(config.profileDir, config.allowedOrigin, config.loginPath);
    await page.goto(credentials.panelUrl);

    // Managed challenges (Cloudflare "Um momento…") auto-clear within
    // seconds for a real headed browser. Wait a bounded window for that;
    // interactive or persistent challenges still fail closed below.
    const challengeDeadline = Date.now() + config.challengeWaitSeconds * 1000;
    while (await page.detectChallenge()) {
      if (Date.now() >= challengeDeadline) {
        return done(outcome("HUMAN_REQUIRED", "CHALLENGE_DETECTED"));
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    const form = await page.probeLoginForm();
    if (form !== null) {
      // A login form is showing: exactly one form with unique controls.
      const unique =
        form.forms === 1 &&
        form.emailInputs === 1 &&
        form.passwordInputs === 1 &&
        form.submitButtons === 1;
      if (!unique) {
        return done(outcome("HUMAN_REQUIRED", "AMBIGUOUS_LOGIN_FORM"));
      }
      if (await page.detectChallenge()) {
        return done(outcome("HUMAN_REQUIRED", "CHALLENGE_DETECTED"));
      }
      const loggedIn = await page.submitLogin(credentials.email, credentials.password);
      if (!loggedIn) {
        return done(outcome("HUMAN_REQUIRED", "IDENTITY_MISMATCH"));
      }
      if (await page.detectChallenge()) {
        return done(outcome("HUMAN_REQUIRED", "CHALLENGE_DETECTED"));
      }
    }
    // form === null: existing persistent session, no login needed.

    const first = await page.fetchIdentity();
    const firstField = extractIdentityField(first);
    const identityMatched = identityEquals(credentials.email, firstField);
    if (!identityMatched) {
      // Secret/profile mismatch or unexpected payload — human, no readback leak.
      return done(outcome("HUMAN_REQUIRED", "IDENTITY_MISMATCH"));
    }

    const second = await page.fetchIdentity();
    const secondField = extractIdentityField(second);
    const repeatMatched =
      firstField !== null && secondField !== null && identityEquals(firstField, secondField);
    if (!repeatMatched) {
      return done(outcome("INCONCLUSIVE", "READ_MISMATCH"));
    }

    return done(
      outcome("READ_CONFIRMED", "NONE", {
        identityMatched: true,
        readbackMatched: true,
        needsHuman: false,
      }),
    );
  } catch {
    return done(outcome("INCONCLUSIVE", "TRANSPORT"));
  } finally {
    // Best-effort close; close failures never change the outcome.
    try {
      await page?.close();
    } catch {
      // ignore
    }
    try {
      await lock?.release();
    } catch {
      // ignore
    }
    // Explicitly drop credential references out of scope.
    credentials = { panelUrl: "", email: "", password: "" };
  }
}

function errIsCredentialEmpty(c: { panelUrl: string; email: string; password: string }): boolean {
  return c.panelUrl.length === 0 || c.email.length === 0 || c.password.length === 0;
}

export { CredentialError };
export { READ_IDENTITY_PATH };
