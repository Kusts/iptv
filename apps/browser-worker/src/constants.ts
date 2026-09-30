/**
 * Browser Worker W0-09 — shared constants.
 *
 * CLI-only scaffold (ADR-0013). Single read-only operation:
 * `cinevision.readIdentity`. No write operations exist; the BROWSER port
 * on the API stays disabled — this CLI does not enable it.
 *
 * SINGLE-BINDING OPERATOR SMOKE (not multi-tenant authZ): this CLI runs
 * with exactly one deployment binding (`BROWSER_WORKER_PROVIDER` must be
 * `CINEVISION`, tenant/account ids from env, exactly the three
 * `FIXED_SECRET_REFS`). It never accepts tenant/account identity from
 * argv, never serves an HTTP API, and never trusts request-supplied ids.
 * A future API integration MUST resolve the provider binding from the
 * tenant/account id in its own DB — never from caller-supplied ids.
 * Without a configured binding the CLI fails closed (CONFIG).
 */

/** The only operation this CLI may execute. Fixed by contract. */
export const FIXED_OPERATION = "cinevision.readIdentity" as const;

export type FixedOperation = typeof FIXED_OPERATION;

/** The only provider binding this CLI supports. Fixed by contract. */
export const BINDING_PROVIDER = "CINEVISION" as const;

export type BindingProvider = typeof BINDING_PROVIDER;

/**
 * Fixed CINEVISION secret refs the worker may resolve. Free-form refs are
 * never accepted — `resolveCredentials` calls `getSecret` only on these.
 */
export const FIXED_SECRET_REFS = [
  "infisical://dev/browser-worker/CINEVISION_URL",
  "infisical://dev/browser-worker/CINEVISION_EMAIL",
  "infisical://dev/browser-worker/CINEVISION_PASSWORD",
] as const;

export type FixedSecretRef = (typeof FIXED_SECRET_REFS)[number];

/** Read-only identity probe path (same-origin GET only, absolute-built). */
export const READ_IDENTITY_PATH = "/api/auth/me" as const;

/** Hash fragment where the single login POST exception may occur. */
export const SIGN_IN_HASH = "#/sign-in" as const;

export type WorkerStatus = "READ_CONFIRMED" | "INCONCLUSIVE" | "HUMAN_REQUIRED";

/**
 * Fixed error codes for CLI output. `exception.message`, raw URLs and
 * secret values are NEVER emitted — only one of these codes.
 */
export const WORKER_ERROR_CODES = [
  "NONE",
  "DISABLED",
  "INVALID_CONFIG",
  "CONFIG",
  "ORIGIN_MISMATCH",
  "SECRET_UNAVAILABLE",
  "IDENTITY_MISMATCH",
  "CHALLENGE_DETECTED",
  "AMBIGUOUS_LOGIN_FORM",
  "READ_MISMATCH",
  "PROFILE_LOCKED",
  "TRANSPORT",
] as const;

export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[number];
