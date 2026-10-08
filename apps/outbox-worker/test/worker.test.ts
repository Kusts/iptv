import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildEnvelope } from "@iptv/domain";
import { checkActivationGate } from "../src/activation.js";
import type { OutboxWorkerConfig } from "../src/config.js";
import { assertOutboxWorkerIdentity } from "../src/roleGuard.js";
import type { ClaimRow, DbPort } from "../src/rpc.js";
import { FakeTransport } from "../src/transport.js";
import { OutboxWorker } from "../src/worker.js";

const TOPIC = "proof.item_published.v1";

interface TestConfigOverrides {
  workerId?: string;
  batchSize?: number;
  renewAfterMs?: number;
  maxRenews?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

function testConfig(overrides: TestConfigOverrides = {}): OutboxWorkerConfig {
  return {
    workerId: overrides.workerId ?? "wA",
    databaseUrl: "postgres://outbox_worker@localhost:5432/iptv",
    batchSize: overrides.batchSize ?? 10,
    pollMs: 50,
    leaseSeconds: 300,
    renewAfterMs: overrides.renewAfterMs ?? 30,
    maxConcurrency: 2,
    minBackoffMs: overrides.minBackoffMs ?? 1000,
    maxBackoffMs: overrides.maxBackoffMs ?? 60_000,
    shutdownTimeoutMs: 1000,
    maxRenews: overrides.maxRenews ?? 5,
  };
}

function makeEnvelope(tenantId: string = randomUUID()): Record<string, unknown> {
  return buildEnvelope({
    event_type: TOPIC,
    tenant_id: tenantId,
    aggregate_type: "proof",
    aggregate_id: randomUUID(),
    aggregate_version: 1,
    data: { n: 1 },
    actor: { type: "system", id: null },
  }) as unknown as Record<string, unknown>;
}

type MemState = "PENDING" | "PUBLISHING" | "FAILED" | "PUBLISHED";

interface MemRow {
  id: string;
  tenantId: string;
  domainEventId: string;
  topic: string;
  payload: unknown;
  state: MemState;
  token: string | null;
  owner: string | null;
  leaseUntil: number;
  attempt: number;
  lastError: string | null;
  retryAt: number;
}

/** In-memory DbPort with token/lease CAS semantics mirroring migration 050. */
class FakeDb implements DbPort {
  readonly rows = new Map<string, MemRow>();
  renewCalls = 0;
  /** When true, complete()/fail() throw like a server RAISE (must not kill the batch). */
  outcomeThrows = false;

  seed(payload: unknown, tenantId = randomUUID()): string {
    const id = randomUUID();
    this.rows.set(id, {
      id,
      tenantId,
      domainEventId: randomUUID(),
      topic: TOPIC,
      payload,
      state: "PENDING",
      token: null,
      owner: null,
      leaseUntil: 0,
      attempt: 0,
      lastError: null,
      retryAt: 0,
    });
    return id;
  }

  expireLease(id: string): void {
    const row = this.rows.get(id);
    if (row !== undefined) row.leaseUntil = Date.now() - 1000;
  }

  private toClaim(row: MemRow, token: string): ClaimRow {
    return {
      id: row.id,
      tenant_id: row.tenantId,
      domain_event_id: row.domainEventId,
      topic: row.topic,
      message_key: null,
      payload_json: row.payload,
      headers_json: null,
      claim_token: token,
      lease_expires_at: new Date(row.leaseUntil).toISOString(),
      attempt_count: row.attempt,
    };
  }

  async claim(limit: number, worker: string, leaseSeconds: number): Promise<ClaimRow[]> {
    const now = Date.now();
    const out: ClaimRow[] = [];
    for (const row of this.rows.values()) {
      if (out.length >= limit) break;
      const due =
        (row.state === "PENDING" || (row.state === "FAILED" && row.retryAt <= now)) ||
        (row.state === "PUBLISHING" && row.token !== null && row.leaseUntil <= now);
      if (!due) continue;
      const token = randomUUID();
      row.state = "PUBLISHING";
      row.token = token;
      row.owner = worker;
      row.leaseUntil = now + leaseSeconds * 1000;
      row.attempt += 1;
      row.lastError = null;
      out.push(this.toClaim(row, token));
    }
    return out;
  }

  async renew(id: string, token: string, leaseSeconds: number): Promise<number> {
    this.renewCalls += 1;
    const row = this.rows.get(id);
    if (row === undefined || row.token !== token || row.state !== "PUBLISHING") return 0;
    if (row.leaseUntil <= Date.now()) return 0;
    row.leaseUntil = Date.now() + leaseSeconds * 1000;
    return 1;
  }

  async complete(id: string, token: string): Promise<number> {
    if (this.outcomeThrows) throw new Error("OUTCOME_RAISE");
    const row = this.rows.get(id);
    if (row === undefined || row.token !== token || row.state !== "PUBLISHING") return 0;
    row.state = "PUBLISHED";
    row.token = null;
    row.owner = null;
    return 1;
  }

  async fail(id: string, token: string, code: string, retryAt: string): Promise<number> {
    if (this.outcomeThrows) throw new Error("OUTCOME_RAISE");
    const row = this.rows.get(id);
    if (row === undefined || row.token !== token || row.state !== "PUBLISHING") return 0;
    row.state = "FAILED";
    row.lastError = code;
    row.retryAt = Date.parse(retryAt);
    row.token = null;
    row.owner = null;
    return 1;
  }
}

const silent = (): void => undefined;

function errorWithCode(message: string, code?: string): Error {
  const err = new Error(message);
  if (code !== undefined) (err as { code?: string }).code = code;
  return err;
}

describe("outbox worker", () => {
  it("publishes valid rows to PUBLISHED", async () => {
    const db = new FakeDb();
    const tenant = randomUUID();
    const idA = db.seed(makeEnvelope(tenant), tenant);
    const idB = db.seed(makeEnvelope(tenant), tenant);
    const transport = new FakeTransport();
    const worker = new OutboxWorker({ config: testConfig(), rpc: db, transport, logger: silent });

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({ claimed: 2, published: 2, failed: 0, stale: 0, empty: false });
    expect(db.rows.get(idA)?.state).toBe("PUBLISHED");
    expect(db.rows.get(idB)?.state).toBe("PUBLISHED");
    expect(transport.atLeastOnceCount(TOPIC)).toBe(2);
    expect(worker.snapshot().published).toBe(2);
  });

  it("records FAILED with a classified code and future retry on transport errors", async () => {
    const db = new FakeDb();
    const id = db.seed(makeEnvelope(), randomUUID());
    const transport = new FakeTransport({
      failWith: errorWithCode("connection reset", "TRANSPORT_TIMEOUT"),
      failTimes: Number.POSITIVE_INFINITY,
    });
    const before = Date.now();
    const worker = new OutboxWorker({ config: testConfig(), rpc: db, transport, logger: silent });

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({ claimed: 1, published: 0, failed: 1 });
    const row = db.rows.get(id);
    expect(row?.state).toBe("FAILED");
    expect(row?.lastError).toBe("TRANSPORT_TIMEOUT");
    expect(row?.retryAt ?? 0).toBeGreaterThan(before);
  });

  it("falls back to TRANSPORT_ERROR for unclassifiable errors", async () => {
    const db = new FakeDb();
    const id = db.seed(makeEnvelope(), randomUUID());
    const transport = new FakeTransport({
      failWith: errorWithCode("!!!"),
      failTimes: Number.POSITIVE_INFINITY,
    });
    const worker = new OutboxWorker({ config: testConfig(), rpc: db, transport, logger: silent });

    await worker.runOnce();

    expect(db.rows.get(id)?.lastError).toBe("TRANSPORT_ERROR");
  });

  it("fails invalid envelopes as INVALID_ENVELOPE", async () => {
    const db = new FakeDb();
    const id = db.seed({ bogus: true });
    const transport = new FakeTransport();
    const worker = new OutboxWorker({ config: testConfig(), rpc: db, transport, logger: silent });

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({ claimed: 1, failed: 1 });
    expect(db.rows.get(id)?.state).toBe("FAILED");
    expect(db.rows.get(id)?.lastError).toBe("INVALID_ENVELOPE");
    expect(transport.publishes).toBe(0);
  });

  it("renews the lease during a slow publish and still completes", async () => {
    const db = new FakeDb();
    db.seed(makeEnvelope(), randomUUID());
    const transport = new FakeTransport({ delayMs: 120 });
    const worker = new OutboxWorker({
      config: testConfig({ renewAfterMs: 30, maxRenews: 10 }),
      rpc: db,
      transport,
      logger: silent,
    });

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({ claimed: 1, published: 1 });
    expect(db.renewCalls).toBeGreaterThanOrEqual(1);
    expect(worker.snapshot().renewals).toBeGreaterThanOrEqual(1);
  });

  it("abandons the item without complete/fail when the lease moved on (stale A, active B)", async () => {
    const db = new FakeDb();
    const id = db.seed(makeEnvelope(), randomUUID());
    const transport = new FakeTransport();
    const worker = new OutboxWorker({ config: testConfig(), rpc: db, transport, logger: silent });
    // Interpose on publish: A's lease expires and B reclaims BEFORE A records.
    const inner = transport.publish.bind(transport);
    transport.publish = async (envelope) => {
      await inner(envelope);
      db.expireLease(id);
      await db.claim(1, "wB", 300);
    };

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({ claimed: 1, published: 0, stale: 1 });
    expect(worker.snapshot().staleTokenOutcomes).toBe(1);
    const row = db.rows.get(id);
    // B owns the row now; A's outcome attempt wrote nothing.
    expect(row?.state).toBe("PUBLISHING");
    expect(row?.owner).toBe("wB");
  });

  it("reclaims a crashed-before-publish row with no duplicate delivery", async () => {
    const db = new FakeDb();
    const id = db.seed(makeEnvelope(), randomUUID());
    // Worker A claims then crashes before publishing.
    const crashed = await db.claim(1, "wA", 300);
    expect(crashed).toHaveLength(1);
    db.expireLease(id);
    const transport = new FakeTransport();
    const worker = new OutboxWorker({
      config: testConfig({ workerId: "wB" }),
      rpc: db,
      transport,
      logger: silent,
    });

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({ claimed: 1, published: 1 });
    expect(db.rows.get(id)?.state).toBe("PUBLISHED");
    expect(worker.snapshot().reclaimed).toBe(1);
    expect(transport.atLeastOnceCount(TOPIC)).toBe(1);
  });

  it("documents crash-after-publish as at-least-once (delivery counted twice)", async () => {
    const db = new FakeDb();
    const id = db.seed(makeEnvelope(), randomUUID());
    const transport = new FakeTransport();
    // Worker A publishes, then crashes before complete.
    const claimed = await db.claim(1, "wA", 300);
    const payload = claimed[0]?.payload_json;
    expect(payload).toBeDefined();
    const { safeParseEnvelope } = await import("@iptv/domain");
    const parsed = safeParseEnvelope(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) await transport.publish(parsed.data);
    db.expireLease(id);
    // Worker B reclaims and publishes again.
    const worker = new OutboxWorker({
      config: testConfig({ workerId: "wB" }),
      rpc: db,
      transport,
      logger: silent,
    });

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({ claimed: 1, published: 1 });
    expect(db.rows.get(id)?.state).toBe("PUBLISHED");
    expect(transport.atLeastOnceCount(TOPIC)).toBe(2);
  });

  it("keeps two workers on disjoint rows", async () => {
    const db = new FakeDb();
    const tenant = randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(db.seed(makeEnvelope(tenant), tenant));
    const t1 = new FakeTransport();
    const t2 = new FakeTransport();
    const w1 = new OutboxWorker({
      config: testConfig({ workerId: "w1", batchSize: 2 }),
      rpc: db,
      transport: t1,
      logger: silent,
    });
    const w2 = new OutboxWorker({
      config: testConfig({ workerId: "w2", batchSize: 2 }),
      rpc: db,
      transport: t2,
      logger: silent,
    });

    const [o1, o2] = await Promise.all([w1.runOnce(), w2.runOnce()]);

    expect(o1.published + o2.published).toBe(4);
    const first = ids[0];
    expect(first).toBeDefined();
    for (const id of ids) expect(db.rows.get(id)?.state).toBe("PUBLISHED");
    expect(t1.published.length + t2.published.length).toBe(4);
  });

  it("refuses boot for a foreign role via the role guard", async () => {
    const foreign = async (): Promise<{ rows: Array<Record<string, unknown>> }> => ({
      rows: [{ u: "iptv_app", s: "iptv_app" }],
    });
    await expect(assertOutboxWorkerIdentity(foreign)).rejects.toThrow(/session identity/);
  });

  it("refuses boot while the legacy drain is active", () => {
    expect(() =>
      checkActivationGate({ legacyQuiesced: true, legacyDrainEnabled: true, legacyInFlight: null }),
    ).toThrow(/LEGACY_DRAIN_STILL_ENABLED/);
  });

  it("counts stale instead of crashing when complete() raises", async () => {
    const db = new FakeDb();
    db.seed(makeEnvelope(), randomUUID());
    db.outcomeThrows = true;
    const worker = new OutboxWorker({
      config: testConfig(),
      rpc: db,
      transport: new FakeTransport(),
      logger: silent,
    });

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({ claimed: 1, published: 0, failed: 0, stale: 1 });
    expect(worker.snapshot().staleTokenOutcomes).toBe(1);
  });

  it("counts stale instead of crashing when fail() raises", async () => {
    const db = new FakeDb();
    db.seed(makeEnvelope(), randomUUID());
    db.outcomeThrows = true;
    const transport = new FakeTransport({
      failWith: errorWithCode("boom", "TRANSPORT_DOWN"),
      failTimes: Number.POSITIVE_INFINITY,
    });
    const worker = new OutboxWorker({ config: testConfig(), rpc: db, transport, logger: silent });

    const outcome = await worker.runOnce();

    expect(outcome).toMatchObject({ claimed: 1, published: 0, failed: 0, stale: 1 });
  });

  it("caps the fail retry below the server 7-day refusal", async () => {
    const db = new FakeDb();
    const id = db.seed(makeEnvelope(), randomUUID());
    const transport = new FakeTransport({
      failWith: errorWithCode("down", "TRANSPORT_DOWN"),
      failTimes: 1,
    });
    const worker = new OutboxWorker({
      config: testConfig({ minBackoffMs: 604_800_000, maxBackoffMs: 604_800_000 }),
      rpc: db,
      transport,
      logger: silent,
    });

    await worker.runOnce();

    const retryAt = db.rows.get(id)?.retryAt ?? 0;
    expect(db.rows.get(id)?.state).toBe("FAILED");
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 7 * 24 * 60 * 60 * 1000 - 60_000);
    expect(retryAt).toBeGreaterThan(Date.now());
  });
});
