import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { applyMigrations, createDb } from "@iptv/database";

/**
 * Real two-session concurrency proof for the migration 050 outbox worker
 * protocol (P1). The SQL proof `db/tests/015_platform_outbox_worker.sql`
 * exercises the whole matrix in one session; this file proves the parts that
 * only two live connections can show:
 *
 *   1. `FOR UPDATE SKIP LOCKED` disjointness: while worker A holds an
 *      uncommitted claim (row lock), worker B claims a DIFFERENT row instead
 *      of blocking. If SKIP LOCKED were missing this test would deadlock
 *      (B waits on A's lock, A waits for B to finish).
 *   2. Cross-session CAS fencing: a token from a reclaimed attempt cannot
 *      complete the row; the current token can.
 *
 * Isolation: the claim is deliberately GLOBAL (cross-tenant by design), so a
 * shared database with other suites' leftover due rows would make this test
 * non-deterministic. It therefore creates its OWN disposable database from
 * `TEST_DATABASE_URL` (same server), applies all migrations there, runs, and
 * drops it. Requires `TEST_DATABASE_URL` with CREATEDB rights; skipped
 * otherwise.
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Derive a sibling connection URL (same server/credentials, other database). */
function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

describe.skipIf(!hasDb)("outbox worker concurrency (requires TEST_DATABASE_URL)", () => {
  const databaseName = `obx_conc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  // Built inside beforeAll: the suite callback still runs under skipIf, so a
  // module/describe-level `new URL(undefined)` would throw at collection time
  // when TEST_DATABASE_URL is unset instead of skipping cleanly.
  let adminDb: ReturnType<typeof createDb>;
  let dbOwner: ReturnType<typeof createDb>;
  let dbSessionA: ReturnType<typeof createDb>;
  let dbSessionB: ReturnType<typeof createDb>;

  beforeAll(async () => {
    adminDb = createDb({ connectionString: withDatabase(connectionString as string, "postgres") });
    await sql`CREATE DATABASE ${sql.id(databaseName)}`.execute(adminDb);
    const dedicatedUrl = withDatabase(connectionString as string, databaseName);
    dbOwner = createDb({ connectionString: dedicatedUrl });
    dbSessionA = createDb({ connectionString: dedicatedUrl });
    dbSessionB = createDb({ connectionString: dedicatedUrl });
    await applyMigrations(dedicatedUrl, { migrationsDir: MIGRATIONS_DIR });
  }, 180_000);

  afterAll(async () => {
    await Promise.all([dbOwner?.destroy(), dbSessionA?.destroy(), dbSessionB?.destroy()]);
    if (adminDb !== undefined) {
      await sql`DROP DATABASE ${sql.id(databaseName)} WITH (FORCE)`.execute(adminDb);
      await adminDb.destroy();
    }
  });

  /** Seed `count` due PENDING rows for one fresh tenant. */
  async function seedDueRows(count: number): Promise<{ tenantId: string; ids: string[] }> {
    const slug = `obx-conc-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const tenant = await sql<{ id: string }>`
      INSERT INTO control.tenants (slug, name) VALUES (${slug}, 'Outbox Concurrency')
      RETURNING id
    `.execute(dbOwner);
    const tenantId = tenant.rows[0]!.id;
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const event = await sql<{ id: string }>`
        INSERT INTO platform.domain_events
          (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version,
           occurred_at, correlation_id, actor_type)
        VALUES (${tenantId}, 'proof.event', 'proof', ${randomUUID()}, 1,
                now(), ${randomUUID()}, 'system')
        RETURNING id
      `.execute(dbOwner);
      const row = await sql<{ id: string }>`
        INSERT INTO platform.outbox_messages
          (tenant_id, domain_event_id, topic, payload_json, state, next_attempt_at)
        VALUES (${tenantId}, ${event.rows[0]!.id}, ${`obx-conc-${i}-${slug}`},
                '{"n":1}', 'PENDING', now() - interval '5 seconds')
        RETURNING id
      `.execute(dbOwner);
      ids.push(row.rows[0]!.id);
    }
    return { tenantId, ids };
  }

  it("two live sessions never hold a current claim on the same row (SKIP LOCKED)", async () => {
    const { tenantId, ids } = await seedDueRows(2);
    const aHoldsClaim = deferred<void>();
    const bMayFinish = deferred<void>();

    const sessionA = dbSessionA.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE outbox_worker`.execute(trx);
      const res = await sql<ClaimRow>`
        SELECT id, tenant_id, claim_token FROM platform.outbox_claim(1, 'wA', 300)
      `.execute(trx);
      const row = res.rows[0]!;
      // Signal B to attempt while this transaction (and its row lock) is open.
      aHoldsClaim.resolve();
      await bMayFinish.promise;
      return row;
    });

    await aHoldsClaim.promise;

    // If SKIP LOCKED regressed, B would block on A's row lock (A waits for B),
    // so a bounded statement_timeout turns that into a fast, clean failure
    // instead of a hung teardown. `bMayFinish` is always released so A can
    // finish even when B throws.
    let rowB: ClaimRow | null = null;
    try {
      rowB = await dbSessionB.transaction().execute(async (trx) => {
        await sql`SET LOCAL statement_timeout = '10s'`.execute(trx);
        await sql`SET LOCAL ROLE outbox_worker`.execute(trx);
        const res = await sql<ClaimRow>`
          SELECT id, tenant_id, claim_token FROM platform.outbox_claim(1, 'wB', 300)
        `.execute(trx);
        return res.rows[0] ?? null;
      });
    } finally {
      bMayFinish.resolve();
    }
    const rowA = await sessionA;

    expect(ids).toContain(rowA.id);
    expect(rowB).not.toBeNull();
    expect(ids).toContain(rowB!.id);
    expect(rowB!.id).not.toBe(rowA.id);
    expect(rowB!.claim_token).not.toBe(rowA.claim_token);
    expect(tenantId).toBe(rowA.tenant_id);
  });

  it("a stale token cannot complete a row reclaimed by another session (CAS)", async () => {
    const { tenantId, ids } = await seedDueRows(1);
    const rowId = ids[0]!;

    const first = await dbSessionA.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE outbox_worker`.execute(trx);
      const res = await sql<ClaimRow>`
        SELECT id, claim_token FROM platform.outbox_claim(1, 'w1', 300)
        WHERE id = ${rowId}
      `.execute(trx);
      return res.rows[0]!;
    });
    expect(first.claim_token).toBeTruthy();

    // Simulate the holder stalling past its lease (owner backdates the clock).
    await sql`
      UPDATE platform.outbox_messages
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = ${rowId}
    `.execute(dbOwner);

    const second = await dbSessionB.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE outbox_worker`.execute(trx);
      const res = await sql<ClaimRow>`
        SELECT id, claim_token FROM platform.outbox_claim(1, 'w2', 300)
        WHERE id = ${rowId}
      `.execute(trx);
      return res.rows[0] ?? null;
    });
    expect(second).not.toBeNull();
    expect(second!.claim_token).not.toBe(first.claim_token);

    // The resurrected first worker is fenced: its token writes 0 rows.
    const staleResult = await dbSessionA.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE outbox_worker`.execute(trx);
      const res = await sql<{ n: number }>`
        SELECT platform.outbox_complete(${rowId}, ${first.claim_token}) AS n
      `.execute(trx);
      return Number(res.rows[0]!.n);
    });
    expect(staleResult).toBe(0);

    // The current holder finishes normally.
    const currentResult = await dbSessionB.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE outbox_worker`.execute(trx);
      const res = await sql<{ n: number }>`
        SELECT platform.outbox_complete(${rowId}, ${second!.claim_token}) AS n
      `.execute(trx);
      return Number(res.rows[0]!.n);
    });
    expect(currentResult).toBe(1);

    const finalState = await sql<{ state: string }>`
      SELECT state FROM platform.outbox_messages WHERE id = ${rowId}
    `.execute(dbOwner);
    expect(finalState.rows[0]!.state).toBe("PUBLISHED");
    expect(tenantId).toBeTruthy();
  });
});
