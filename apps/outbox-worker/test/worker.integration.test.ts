import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildEnvelope } from "@iptv/domain";
import { applyMigrations } from "../../../packages/database/src/index.js";
import { parseOutboxWorkerConfig } from "../src/config.js";
import type { OutboxWorkerConfig } from "../src/config.js";
import { closePool, createOutboxWorkerPool } from "../src/db.js";
import { assertOutboxWorkerIdentity } from "../src/roleGuard.js";
import { PgOutboxRpc } from "../src/rpc.js";
import { FakeTransport } from "../src/transport.js";
import { OutboxWorker } from "../src/worker.js";

/**
 * Live rehearsal against a disposable database (same pattern as
 * `packages/database/test/outbox-worker-concurrency.integration.test.ts`):
 * creates its OWN database from `TEST_DATABASE_URL`, applies all migrations,
 * sets a temporary `outbox_worker` password (cluster-global role — reset to
 * NULL in teardown), and connects FOR REAL as `outbox_worker`.
 *
 * No Docker, no external network: everything is local PostgreSQL. Skipped
 * without `TEST_DATABASE_URL`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const TOPIC = "proof.int_rehearsed.v1";

function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function withWorkerIdentity(base: string, password: string): string {
  const url = new URL(base);
  url.username = "outbox_worker";
  url.password = password;
  return url.toString();
}

function makePool(connectionStringValue: string): Pool {
  const pool = new Pool({ connectionString: connectionStringValue, max: 4 });
  pool.on("error", () => undefined);
  return pool;
}

function testConfig(workerId: string): OutboxWorkerConfig {
  return {
    workerId,
    databaseUrl: "postgres://outbox_worker@localhost:5432/iptv",
    batchSize: 10,
    pollMs: 50,
    leaseSeconds: 300,
    renewAfterMs: 60_000,
    maxConcurrency: 2,
    minBackoffMs: 60_000,
    maxBackoffMs: 3_600_000,
    shutdownTimeoutMs: 5000,
    maxRenews: 6,
  };
}

describe.skipIf(!hasDb)("outbox worker live rehearsal (requires TEST_DATABASE_URL)", () => {
  const databaseName = `obx_wrk_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const workerPassword = `tmp${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  let adminPool: Pool;
  let ownerPool: Pool;
  let workerPool: Pool;
  let workerUrl = "";

  beforeAll(async () => {
    adminPool = makePool(withDatabase(connectionString as string, "postgres"));
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const dedicatedUrl = withDatabase(connectionString as string, databaseName);
    ownerPool = makePool(dedicatedUrl);
    await applyMigrations(dedicatedUrl, { migrationsDir: MIGRATIONS_DIR });
    // Temporary password ONLY on this disposable database's session scope —
    // the role is cluster-global, so it is reset to NULL in teardown.
    await ownerPool.query(`ALTER ROLE outbox_worker WITH PASSWORD '${workerPassword}'`);
    workerUrl = withWorkerIdentity(dedicatedUrl, workerPassword);
    workerPool = createOutboxWorkerPool(workerUrl);
  }, 180_000);

  afterAll(async () => {
    await workerPool?.end().catch(() => undefined);
    if (ownerPool !== undefined) {
      await ownerPool.query("ALTER ROLE outbox_worker WITH PASSWORD NULL").catch(() => undefined);
      await ownerPool.end().catch(() => undefined);
    }
    if (adminPool !== undefined) {
      await adminPool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
  });

  async function seedPendingRow(): Promise<{ tenantId: string; rowId: string }> {
    const slug = `obx-wrk-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const tenant = await ownerPool.query<{ id: string }>(
      `INSERT INTO control.tenants (slug, name) VALUES ($1, 'Outbox Worker Rehearsal') RETURNING id`,
      [slug],
    );
    const tenantId = tenant.rows[0]?.id as string;
    const event = await ownerPool.query<{ id: string }>(
      `INSERT INTO platform.domain_events
         (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version,
          occurred_at, correlation_id, actor_type)
       VALUES ($1, $2, 'proof', $3, 1, now(), $4, 'system')
       RETURNING id`,
      [tenantId, TOPIC, randomUUID(), randomUUID()],
    );
    const eventId = event.rows[0]?.id as string;
    const envelope = buildEnvelope({
      event_id: randomUUID(),
      event_type: TOPIC,
      tenant_id: tenantId,
      aggregate_type: "proof",
      aggregate_id: randomUUID(),
      aggregate_version: 1,
      data: { rehearsal: true },
      actor: { type: "system", id: null },
    });
    const row = await ownerPool.query<{ id: string }>(
      `INSERT INTO platform.outbox_messages
         (tenant_id, domain_event_id, topic, payload_json, state, next_attempt_at)
       VALUES ($1, $2, $3, $4, 'PENDING', now() - interval '5 seconds')
       RETURNING id`,
      [tenantId, eventId, TOPIC, JSON.stringify(envelope)],
    );
    return { tenantId, rowId: row.rows[0]?.id as string };
  }

  it("role guard passes on a real outbox_worker connection", async () => {
    await expect(
      assertOutboxWorkerIdentity((sql, params) =>
        workerPool.query(sql, params).then((res) => ({ rows: res.rows })),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("runOnce publishes a seeded row to PUBLISHED through the real RPC", async () => {
    const { rowId } = await seedPendingRow();
    const rpc = new PgOutboxRpc((sql, params) =>
      workerPool.query(sql, params).then((res) => ({ rows: res.rows })),
    );
    const transport = new FakeTransport();
    const worker = new OutboxWorker({
      config: testConfig("int-w1"),
      rpc,
      transport,
      logger: () => undefined,
    });

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({ claimed: 1, published: 1, failed: 0, stale: 0 });
    expect(transport.atLeastOnceCount(TOPIC)).toBe(1);
    const state = await ownerPool.query<{ state: string }>(
      `SELECT state FROM platform.outbox_messages WHERE id = $1`,
      [rowId],
    );
    expect(state.rows[0]?.state).toBe("PUBLISHED");
  });

  it("config refuses an owner/API database url", () => {
    const dedicatedUrl = withDatabase(connectionString as string, databaseName);
    let message = "";
    try {
      parseOutboxWorkerConfig({
        OUTBOX_WORKER_ENABLED: "1",
        OUTBOX_WORKER_DATABASE_URL: dedicatedUrl,
        OUTBOX_WORKER_ID: "int-w1",
        OUTBOX_LEGACY_QUIESCED: "1",
      });
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message).toMatch(/outbox_worker/);
    expect(message).not.toContain(databaseName);
  });

  it("an api-role session calling claim gets permission denied", async () => {
    const exists = await ownerPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_roles WHERE rolname = 'iptv_app'`,
    );
    if (Number(exists.rows[0]?.n ?? 0) === 0) return;
    const client = await ownerPool.connect();
    try {
      await client.query("SET ROLE iptv_app");
      await expect(
        client.query(`SELECT * FROM platform.outbox_claim(1, 'intruder', 300)`),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
  });

  it("closePool drains the worker pool", async () => {
    const pool = createOutboxWorkerPool(workerUrl);
    await pool.query("SELECT 1");
    await closePool(pool);
    await expect(pool.query("SELECT 1")).rejects.toThrow();
  });
});
