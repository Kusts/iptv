import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { applyMigrations } from "../src/index.js";

/**
 * Real two-session concurrency proof for the migration 050 outbox worker
 * protocol (P1). The SQL proof `db/tests/015_platform_outbox_worker.sql`
 * exercises the whole matrix in one session; this file proves the parts that
 * only two live connections can show:
 *
 *   1. `FOR UPDATE SKIP LOCKED` disjointness: while worker A holds an
 *      uncommitted claim (row lock), worker B claims a DIFFERENT row instead
 *      of blocking. If SKIP LOCKED regressed, B would wait on A's lock while A
 *      waits to commit → a bounded `statement_timeout` turns that into a fast
 *      failure instead of a hung teardown.
 *   2. Cross-session CAS fencing: a token from a reclaimed attempt cannot
 *      complete the row; the current token can.
 *
 * Isolation: the claim is deliberately GLOBAL (cross-tenant by design), so a
 * shared database with other suites' leftover due rows would make this test
 * non-deterministic. It therefore creates its OWN disposable database from
 * `TEST_DATABASE_URL` (same server), applies all migrations there, runs, and
 * drops it. Raw `pg` pools are used (not Kysely) so an `error` listener can
 * absorb the `DROP DATABASE ... WITH (FORCE)` terminations. Requires
 * `TEST_DATABASE_URL` with CREATEDB rights; skipped otherwise.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

interface ClaimRow {
  id: string;
  tenant_id: string;
  claim_token: string;
}

/** Derive a sibling connection URL (same server/credentials, other database). */
function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function makePool(connectionStringValue: string): Pool {
  const pool = new Pool({ connectionString: connectionStringValue, max: 4 });
  // A terminated idle client (e.g. `DROP DATABASE ... WITH (FORCE)` during
  // teardown) emits an 'error' event; without a listener Node/Vitest treats
  // it as an unhandled error and fails the suite even though the tests passed.
  pool.on("error", () => undefined);
  return pool;
}

describe.skipIf(!hasDb)("outbox worker concurrency (requires TEST_DATABASE_URL)", () => {
  const databaseName = `obx_conc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  let adminPool: Pool;
  let ownerPool: Pool;
  let poolA: Pool;
  let poolB: Pool;

  beforeAll(async () => {
    adminPool = makePool(withDatabase(connectionString as string, "postgres"));
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const dedicatedUrl = withDatabase(connectionString as string, databaseName);
    ownerPool = makePool(dedicatedUrl);
    poolA = makePool(dedicatedUrl);
    poolB = makePool(dedicatedUrl);
    await applyMigrations(dedicatedUrl, { migrationsDir: MIGRATIONS_DIR });
    // Fresh disposable database seeds the runtime interlock at LEGACY gen 1,
    // under which outbox_claim refuses ("not WORKER"). Bring the authority
    // through the forward protocol (LEGACY -> QUIESCING -> WORKER) via the
    // operator-only set(), naming the observed generation each step; the
    // unfenced guard passes on a fresh database (zero PUBLISHING rows).
    await ownerPool.query(
      `SELECT platform.outbox_runtime_set('LEGACY', 'QUIESCING', 'integration-fixture', 1)`,
    );
    await ownerPool.query(
      `SELECT platform.outbox_runtime_set('QUIESCING', 'WORKER', 'integration-fixture', 2)`,
    );
  }, 180_000);

  afterAll(async () => {
    await Promise.all([ownerPool?.end(), poolA?.end(), poolB?.end()]);
    if (adminPool !== undefined) {
      await adminPool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
  });

  /** Seed `count` due PENDING rows for one fresh tenant; returns their ids. */
  async function seedDueRows(count: number): Promise<{ tenantId: string; ids: string[] }> {
    const slug = `obx-conc-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const tenant = await ownerPool.query<{ id: string }>(
      `INSERT INTO control.tenants (slug, name) VALUES ($1, 'Outbox Concurrency') RETURNING id`,
      [slug],
    );
    const tenantId = tenant.rows[0]!.id;
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const event = await ownerPool.query<{ id: string }>(
        `INSERT INTO platform.domain_events
           (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version,
            occurred_at, correlation_id, actor_type)
         VALUES ($1, 'proof.event', 'proof', $2, 1, now(), $3, 'system')
         RETURNING id`,
        [tenantId, randomUUID(), randomUUID()],
      );
      const row = await ownerPool.query<{ id: string }>(
        `INSERT INTO platform.outbox_messages
           (tenant_id, domain_event_id, topic, payload_json, state, next_attempt_at)
         VALUES ($1, $2, $3, '{"n":1}', 'PENDING', now() - interval '5 seconds')
         RETURNING id`,
        [tenantId, event.rows[0]!.id, `obx-conc-${i}-${slug}`],
      );
      ids.push(row.rows[0]!.id);
    }
    return { tenantId, ids };
  }

  async function claimAsWorker(pool: Pool, worker: string): Promise<ClaimRow | null> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE outbox_worker");
      const res = await client.query<ClaimRow>(
        `SELECT id, tenant_id, claim_token FROM platform.outbox_claim(1, $1, 300)`,
        [worker],
      );
      await client.query("COMMIT");
      return res.rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  it("two live sessions never hold a current claim on the same row (SKIP LOCKED)", async () => {
    const { tenantId, ids } = await seedDueRows(2);
    const clientA = await poolA.connect();
    const clientB = await poolB.connect();
    try {
      await clientA.query("BEGIN");
      await clientA.query("SET LOCAL ROLE outbox_worker");
      const aRes = await clientA.query<ClaimRow>(
        `SELECT id, tenant_id, claim_token FROM platform.outbox_claim(1, 'wA', 300)`,
      );
      const rowA = aRes.rows[0]!;

      // A's transaction (and row lock) is still open here. B must SKIP it.
      await clientB.query("BEGIN");
      await clientB.query("SET LOCAL statement_timeout = '10s'");
      await clientB.query("SET LOCAL ROLE outbox_worker");
      const bRes = await clientB.query<ClaimRow>(
        `SELECT id, tenant_id, claim_token FROM platform.outbox_claim(1, 'wB', 300)`,
      );
      const rowB = bRes.rows[0] ?? null;
      await clientB.query("COMMIT");
      await clientA.query("COMMIT");

      expect(ids).toContain(rowA.id);
      expect(tenantId).toBe(rowA.tenant_id);
      expect(rowB).not.toBeNull();
      expect(ids).toContain(rowB!.id);
      expect(rowB!.id).not.toBe(rowA.id);
      expect(rowB!.claim_token).not.toBe(rowA.claim_token);
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  it("a stale token cannot complete a row reclaimed by another session (CAS)", async () => {
    const { tenantId, ids } = await seedDueRows(1);
    const rowId = ids[0]!;

    const first = await claimAsWorker(poolA, "w1");
    expect(first).not.toBeNull();
    expect(first!.id).toBe(rowId);
    expect(first!.claim_token).toBeTruthy();

    // Simulate the holder stalling past its lease (owner backdates the clock).
    await ownerPool.query(
      `UPDATE platform.outbox_messages
         SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [rowId],
    );

    const second = await claimAsWorker(poolB, "w2");
    expect(second).not.toBeNull();
    expect(second!.id).toBe(rowId);
    expect(second!.claim_token).not.toBe(first!.claim_token);

    // The resurrected first worker is fenced: its token writes 0 rows.
    const staleResult = await poolA.query<{ n: number }>(
      `SELECT platform.outbox_complete($1, $2) AS n`,
      [rowId, first!.claim_token],
    );
    expect(Number(staleResult.rows[0]!.n)).toBe(0);

    // The current holder finishes normally.
    const currentResult = await poolB.query<{ n: number }>(
      `SELECT platform.outbox_complete($1, $2) AS n`,
      [rowId, second!.claim_token],
    );
    expect(Number(currentResult.rows[0]!.n)).toBe(1);

    const finalState = await ownerPool.query<{ state: string }>(
      `SELECT state FROM platform.outbox_messages WHERE id = $1`,
      [rowId],
    );
    expect(finalState.rows[0]!.state).toBe("PUBLISHED");
    expect(tenantId).toBeTruthy();
  });
});
