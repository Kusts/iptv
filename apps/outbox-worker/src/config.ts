/**
 * Outbox worker config — fail-closed env resolution.
 *
 * The worker process MUST run as the `outbox_worker` database role (migration
 * 050): `OUTBOX_WORKER_DATABASE_URL` is validated to authenticate EXACTLY as
 * that role, and `src/roleGuard.ts` re-asserts the posture after connecting.
 * `OUTBOX_WORKER_ENABLED` must be exactly `"1"` and the legacy drain must be
 * quiesced (`OUTBOX_LEGACY_QUIESCED` exactly `"1"` — activation gate, see
 * `src/activation.ts`). Anything unconfigured or mismatched fails closed.
 *
 * Errors never echo values (no URLs, tokens, ids, or argv fragments).
 *
 * Numeric policy: an absent/invalid value resolves to the documented default;
 * a well-formed value outside the documented range is CLAMPED to the nearest
 * bound (never silently reset to the default). Bounds are documented in
 * `README.md` alongside every variable.
 */

export class ConfigError extends Error {
  constructor(detail: string) {
    super(`outbox-worker config: ${detail}`);
    this.name = "ConfigError";
  }
}

const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Query keys that would smuggle identity/connection overrides past review. */
const FORBIDDEN_QUERY_KEYS = new Set([
  "user",
  "role",
  "options",
  "host",
  "port",
  "database",
  "db",
  "dbname",
]);

export interface OutboxWorkerConfig {
  workerId: string;
  /** Connection string for the `outbox_worker` role (never log this). */
  databaseUrl: string;
  /** Rows claimed per batch (claim p_limit). Default 25, clamped [1..100]. */
  batchSize: number;
  /** Idle delay between batches. Default 1000ms, clamped [100..60000]. */
  pollMs: number;
  /** Lease seconds per claim/renew (claim p_lease_seconds). Default 300, clamped [1..3600]. */
  leaseSeconds: number;
  /** Publish duration after which a heartbeat renew fires. Default lease*500ms, clamped [min(1000,lease*750)..lease*750ms] — always strictly before expiry. */
  renewAfterMs: number;
  /** Max items processed concurrently within one batch. Default 4, clamped [1..16]. */
  maxConcurrency: number;
  /** Backoff floor for fail() retryAt. Default 60000ms, clamped [1000..3600000]. */
  minBackoffMs: number;
  /** Backoff ceiling for fail() retryAt. Default 3600000ms, clamped [60000..604800000]. */
  maxBackoffMs: number;
  /** Graceful-stop budget for in-flight items. Default 15000ms, clamped [1000..120000]. */
  shutdownTimeoutMs: number;
  /** Max heartbeat renews per item publish. Default 6, clamped [0..60]. */
  maxRenews: number;
}

/** Gate: the worker starts only when explicitly enabled. */
export function isOutboxWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["OUTBOX_WORKER_ENABLED"] === "1";
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  const value = raw === undefined ? "" : raw.trim();
  if (value.length === 0) {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}

/**
 * Validate the worker database URL. Requires an absolute pg:/postgres:/
 * postgresql: URL authenticating EXACTLY as `outbox_worker`, with no
 * fragment (`#` never reaches the server — fail closed) and no identity
 * query keys. Never echoes the value.
 */
export function validateOutboxWorkerDatabaseUrl(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) {
    throw new ConfigError("OUTBOX_WORKER_DATABASE_URL is required");
  }
  if (value.includes("#")) {
    throw new ConfigError("OUTBOX_WORKER_DATABASE_URL must not contain a fragment");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("OUTBOX_WORKER_DATABASE_URL must be an absolute postgres url");
  }
  if (url.protocol !== "pg:" && url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigError("OUTBOX_WORKER_DATABASE_URL must use a postgres scheme");
  }
  if (url.hostname.length === 0) {
    throw new ConfigError("OUTBOX_WORKER_DATABASE_URL must name a host");
  }
  let username: string;
  try {
    username = decodeURIComponent(url.username);
  } catch {
    throw new ConfigError("OUTBOX_WORKER_DATABASE_URL has a malformed username encoding");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(username)) {
    throw new ConfigError("OUTBOX_WORKER_DATABASE_URL has an invalid username encoding");
  }
  if (username !== "outbox_worker") {
    throw new ConfigError("OUTBOX_WORKER_DATABASE_URL must authenticate as the outbox_worker role");
  }
  for (const key of url.searchParams.keys()) {
    if (FORBIDDEN_QUERY_KEYS.has(key.toLowerCase())) {
      throw new ConfigError("OUTBOX_WORKER_DATABASE_URL must not carry identity query parameters");
    }
  }
  return value;
}

function parseBoundedInt(
  raw: string | undefined,
  name: string,
  def: number,
  min: number,
  max: number,
): number {
  const value = (raw ?? "").trim();
  if (value.length === 0) return def;
  const n = Number(value);
  if (!Number.isInteger(n)) return def;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Pure, testable config resolution over an explicit env mapping.
 * Throws `ConfigError` with fixed words (never echoes values).
 */
export function parseOutboxWorkerConfig(env: NodeJS.ProcessEnv): OutboxWorkerConfig {
  if (env["OUTBOX_WORKER_ENABLED"] !== "1") {
    throw new ConfigError("DISABLED (OUTBOX_WORKER_ENABLED must be 1)");
  }
  // Byte-exact like the API guard: a padded credential is a configuration
  // error to report, not something to repair by trimming.
  const rawUrl = env["OUTBOX_WORKER_DATABASE_URL"];
  if (rawUrl !== undefined && rawUrl !== rawUrl.trim()) {
    throw new ConfigError("OUTBOX_WORKER_DATABASE_URL must not have leading or trailing whitespace");
  }
  const databaseUrl = validateOutboxWorkerDatabaseUrl(required(env, "OUTBOX_WORKER_DATABASE_URL"));
  const workerId = required(env, "OUTBOX_WORKER_ID");
  if (!WORKER_ID_RE.test(workerId)) {
    throw new ConfigError("OUTBOX_WORKER_ID has invalid characters");
  }
  if ((env["OUTBOX_LEGACY_QUIESCED"] ?? "") !== "1") {
    throw new ConfigError("NOT_QUIESCED (OUTBOX_LEGACY_QUIESCED must be 1)");
  }
  const leaseSeconds = parseBoundedInt(env["OUTBOX_WORKER_LEASE_SECONDS"], "OUTBOX_WORKER_LEASE_SECONDS", 300, 1, 3600);
  // Heartbeat must fire strictly BEFORE expiry: `outbox_renew` requires
  // `lease_expires_at > now()`, so a heartbeat scheduled at 100% of the
  // lease loses by construction. Cap the window at 75% of the lease; for
  // sub-second leases the window collapses to a single instant (documented:
  // heartbeats need leases comfortably above 1s).
  const renewMax = Math.max(Math.floor(leaseSeconds * 750), 1);
  const renewMin = Math.min(1000, renewMax);
  const renewDefault = Math.min(Math.max(leaseSeconds * 500, renewMin), renewMax);
  const minBackoffMs = parseBoundedInt(
    env["OUTBOX_WORKER_MIN_BACKOFF_MS"],
    "OUTBOX_WORKER_MIN_BACKOFF_MS",
    60_000,
    1_000,
    3_600_000,
  );
  const maxBackoffMs = parseBoundedInt(
    env["OUTBOX_WORKER_MAX_BACKOFF_MS"],
    "OUTBOX_WORKER_MAX_BACKOFF_MS",
    3_600_000,
    60_000,
    604_800_000,
  );
  if (minBackoffMs > maxBackoffMs) {
    throw new ConfigError("OUTBOX_WORKER_MIN_BACKOFF_MS must not exceed OUTBOX_WORKER_MAX_BACKOFF_MS");
  }
  return {
    workerId,
    databaseUrl,
    batchSize: parseBoundedInt(env["OUTBOX_WORKER_BATCH_SIZE"], "OUTBOX_WORKER_BATCH_SIZE", 25, 1, 100),
    pollMs: parseBoundedInt(env["OUTBOX_WORKER_POLL_MS"], "OUTBOX_WORKER_POLL_MS", 1000, 100, 60_000),
    leaseSeconds,
    renewAfterMs: parseBoundedInt(
      env["OUTBOX_WORKER_RENEW_AFTER_MS"],
      "OUTBOX_WORKER_RENEW_AFTER_MS",
      renewDefault,
      renewMin,
      renewMax,
    ),
    maxConcurrency: parseBoundedInt(
      env["OUTBOX_WORKER_MAX_CONCURRENCY"],
      "OUTBOX_WORKER_MAX_CONCURRENCY",
      4,
      1,
      16,
    ),
    minBackoffMs,
    maxBackoffMs,
    shutdownTimeoutMs: parseBoundedInt(
      env["OUTBOX_WORKER_SHUTDOWN_TIMEOUT_MS"],
      "OUTBOX_WORKER_SHUTDOWN_TIMEOUT_MS",
      15_000,
      1000,
      120_000,
    ),
    maxRenews: parseBoundedInt(env["OUTBOX_WORKER_MAX_RENEWS"], "OUTBOX_WORKER_MAX_RENEWS", 6, 0, 60),
  };
}

/** Resolve config from the process environment. Throws `ConfigError`. */
export function resolveOutboxWorkerConfig(env: NodeJS.ProcessEnv = process.env): OutboxWorkerConfig {
  return parseOutboxWorkerConfig(env);
}
