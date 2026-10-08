import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database } from "./schema.js";

export interface DbConfig {
  connectionString: string;
  maxConnections?: number;
  /**
   * Optional idle-client error observer (tests/metrics). The pool NEVER
   * rethrows: the internal handler always swallows after notifying, so the
   * process survives a Postgres restart. Throwing inside this callback is
   * contained and never crashes the process.
   */
  onPoolError?: (err: Error) => void;
}

/**
 * Strip credential material from a driver error message before logging.
 * Replaces URI userinfo (`://user:pass@`) with `://***@`; never appends the
 * connection string. Truncated to keep the log line bounded.
 */
export function sanitizeDbErrorMessage(message: string): string {
  return message.replace(/:\/\/[^/\s@]+@/g, "://***@").slice(0, 500);
}

/**
 * Attach the idle-client `error` handler that keeps the API alive across a
 * Postgres restart.
 *
 * Without ANY `error` listener, `pg`'s Pool rethrows idle-client errors on
 * the EventEmitter, which crashes Node (exit 1) — the P7 rehearsal failure.
 * With this listener the faulty idle client is discarded by `pg` and the
 * pool reconnects lazily on the next checkout (no retry loop here, so no
 * unbounded backoff to tune; readiness probes stay bounded via
 * `READINESS_PROBE_TIMEOUT_MS` and report 503 until the database answers
 * again). Logging is structured and credential-free by construction.
 */
export function attachPoolErrorHandler(pool: Pool, onError?: (err: Error) => void): void {
  pool.on("error", (err: Error) => {
    if (onError !== undefined) {
      try {
        onError(err);
      } catch {
        // Observer failure is never fatal.
      }
      return;
    }
    try {
      const code = (err as NodeJS.ErrnoException).code ?? "unknown";
      const error = sanitizeDbErrorMessage(err?.message ?? String(err));
      console.error(JSON.stringify({ msg: "db pool idle client error", code, error }));
    } catch {
      // Logging must never throw on the pool error path.
    }
  });
}

/**
 * Create a Kysely instance over `pg`. No CamelCasePlugin: the schema is
 * snake_case and is mapped explicitly via the typed interfaces in schema.ts.
 */
export function createDb(config: DbConfig): Kysely<Database> {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
  });
  attachPoolErrorHandler(pool, config.onPoolError);
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
