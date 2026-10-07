import { Pool } from "pg";

/**
 * Worker pool — thin `pg` pool, no Kysely. Sized by the caller from
 * `maxConcurrency` (lanes) plus headroom for heartbeat renews racing slow
 * publishes: every lane can hold one publish call and one renew call at once.
 * `application_name` identifies the process in `pg_stat_activity` for ops
 * triage.
 */
export function createOutboxWorkerPool(connectionString: string, maxClients = 2): Pool {
  if (!Number.isInteger(maxClients) || maxClients < 1 || maxClients > 32) {
    throw new Error("outbox-worker pool: maxClients must be an integer in [1..32]");
  }
  const pool = new Pool({
    connectionString,
    max: maxClients,
    application_name: "outbox-worker",
  });
  // A terminated idle client emits 'error'; without a listener Node treats it
  // as unhandled and crashes the process.
  pool.on("error", () => undefined);
  return pool;
}

export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}
