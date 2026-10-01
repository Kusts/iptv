/**
 * `cinevision.readIdentity` — read-only identity probe (V2 path).
 *
 * SINGLE-BINDING operator smoke (see `constants.ts`): the tenant/account
 * binding comes from deployment env only. This operation never accepts
 * identity from argv/caller input, serves no HTTP API, and resolves
 * exactly the three `FIXED_SECRET_REFS`. A future API integration MUST
 * look the binding up by tenant/account id in its own DB instead of
 * trusting request-supplied ids.
 *
 * Implementation: thin wrapper over the V2 command runner
 * (`cinevisionCommand.ts`), which reuses the session acquisition
 * (login + bounded challenge wait + token in-page) and runs the Fase-1
 * `readIdentity` reader through the same self-contained
 * `fetchProjectedInPage` closure — one projected read, timing-safe
 * compare against the deployment credential (never emitted), repeat
 * read for readback. Envelope-compatible with the legacy probe
 * (`status`, `identityMatched`, `readbackMatched`, `needsHuman`,
 * `errorCode`) plus V2 execution metadata.
 *
 * Nothing sensitive leaves the process: no storageState/HAR/screenshots/
 * traces/console or network bodies on disk or in logs/outputs.
 */

import type { WorkerConfig } from "../config.js";
import type { WorkerResult } from "../output.js";
import { CredentialError } from "../secrets.js";
import {
  runCinevisionCommand,
  type CinevisionCommandDeps,
} from "./cinevisionCommand.js";
import { ensureProfileDir, extractIdentityField, identityEquals } from "./shared.js";

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
  submitLogin(email: string, password: string, signal?: AbortSignal): Promise<boolean>;
  /**
   * Same-origin GET of the fixed identity endpoint via an ABSOLUTE URL.
   * Resolves raw JSON unknown. Cross-origin redirects fail closed.
   * (Legacy probe entry; the V2 path reads via `evaluateCapability`.)
   */
  fetchIdentity(): Promise<unknown>;
  close(): Promise<void>;
}

/** Minimal browser surface (real impl: `chromium.launchPersistentContext`). */
export interface ReadIdentityBrowser {
  open(
    profileDir: string,
    allowedOrigin: string,
    loginPath: string,
    opts?: BrowserOpenOptions,
  ): Promise<ReadIdentityPage>;
}

/**
 * Cancelable-open options. `signal` aborts a pending acquisition;
 * `onContext` receives the underlying closable resource AS SOON as it
 * exists (before `open` resolves) so the budget owner can close it even
 * when setup is still pending. Implementations MUST close a
 * late-resolving context boundedly instead of handing it out after
 * abort, and MUST never resolve a usable page after abort.
 * `onPendingLaunch` receives the launch-quiescence promise (F1: settle
 * of the pending launch + close of any tardy context) so the lock owner
 * can await it boundedly BEFORE releasing the profile lock — the lock
 * is never released while a launch is still pending. `launchSettleMs`
 * overrides the configured quiescence bound for one call.
 */
export interface BrowserOpenOptions {
  signal?: AbortSignal | undefined;
  onContext?: (closable: { close(): Promise<void> }) => void;
  onPendingLaunch?: (quiescence: Promise<void>) => void;
  launchSettleMs?: number | undefined;
}

export interface ReadIdentityDeps {
  secrets: CinevisionCommandDeps["secrets"];
  browser: CinevisionCommandDeps["browser"];
}

export interface ReadIdentityOutcome {
  status: WorkerResult["status"];
  identityMatched: boolean;
  readbackMatched: boolean;
  needsHuman: boolean;
  errorCode: WorkerResult["errorCode"];
}

/** Execute the read-only probe via the V2 command runner. Never throws. */
export async function runReadIdentity(
  config: WorkerConfig,
  deps: ReadIdentityDeps,
): Promise<WorkerResult> {
  return runCinevisionCommand(config, deps, "cinevision.readIdentity", {});
}

export { CredentialError };
export { ensureProfileDir, extractIdentityField, identityEquals };
export { READ_IDENTITY_PATH } from "../constants.js";
