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

/** Execution metadata stamped on every successful command envelope. */
export const EXECUTION_CHANNEL = "BROWSER" as const;
export const READ_STRATEGY = "API_IN_BROWSER" as const;
export const ADAPTER_VERSION = "cinevision-browser-v2" as const;

/** Hash fragment where the single login POST exception may occur. */
export const SIGN_IN_HASH = "#/sign-in" as const;

/**
 * DOM strategy slot (architecture only): DOM selection is NOT certified.
 * Reads run exclusively via `API_IN_BROWSER`; any CLI attempt to select
 * DOM (`--selector`, `--dom`, `--xpath`, `--strategy dom`, …) fails
 * closed with `DOM_NOT_CERTIFIED` before any browser launches.
 */
export const DOM_STRATEGY_STATUS = "NOT_CERTIFIED" as const;

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
  // Fase-1 taxonomy members with no legacy equivalent (fail-closed add).
  "SESSION_EXPIRED",
  "PERMISSION_DENIED",
  "INTEGRATION_INACTIVE",
  "RATE_LIMITED",
  "HTTP_FAILURE",
  "BAD_RESPONSE",
  // DOM selection attempted (architecture slot, never implemented).
  "DOM_NOT_CERTIFIED",
] as const;

export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[number];

/**
 * Certified read-only CLI commands (V2). Each entry maps a kebab-case
 * subcommand to its dotted operation and declares which narrow args it
 * accepts: `id` (`--id`), `serverId` (`--server-id`), pagination
 * (`--page`/`--per-page`). No command accepts paths, URLs, methods or
 * selectors — CLI args are numeric ids/pagination only. No writes exist.
 */
export const CINEVISION_READ_COMMANDS = [
  { subcommand: "read-identity", operation: "cinevision.readIdentity" },
  { subcommand: "read-credit-balance", operation: "cinevision.readCreditBalance" },
  { subcommand: "list-customers", operation: "cinevision.listCustomers", pagination: true },
  { subcommand: "read-customer", operation: "cinevision.readCustomer", id: true },
  { subcommand: "read-customer-status", operation: "cinevision.readCustomerStatus", id: true },
  { subcommand: "read-connections", operation: "cinevision.readConnections", id: true },
  { subcommand: "list-servers", operation: "cinevision.listServers" },
  { subcommand: "read-server-status", operation: "cinevision.readServerStatus" },
  { subcommand: "list-package-prices", operation: "cinevision.listPackagePrices" },
  {
    subcommand: "read-live-connections",
    operation: "cinevision.readLiveConnections",
    serverId: true,
    pagination: true,
  },
  { subcommand: "list-integrations", operation: "cinevision.listIntegrations" },
] as const;

export type CinevisionSubcommand =
  (typeof CINEVISION_READ_COMMANDS)[number]["subcommand"];
export type CinevisionOperation =
  (typeof CINEVISION_READ_COMMANDS)[number]["operation"];
