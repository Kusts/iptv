import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDb } from "@iptv/database";
import { buildEnvelope, newId } from "@iptv/domain";
import { LegacyOutboxDrainDisabledError, OutboxDrainer } from "../src/outbox/outbox-drainer.js";
import { LocalTransport } from "../src/outbox/transport.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const ENV_KEY = "LEGACY_OUTBOX_DRAIN_ENABLED";

describe.skipIf(!hasDb)("Legacy outbox drain quiescence (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  const savedEnv = process.env[ENV_KEY];

  async function seedClaimableRow(): Promise<{ tenantId: string; eventId: string }> {
    const tenantId = newId();
    await db
      .insertInto("control.tenants")
      .values({
        id: tenantId,
        slug: `legacy-q-${tenantId.slice(0, 8)}`,
        name: "Legacy Quiescence Tenant",
        status: "ACTIVE",
        default_currency: "BRL",
        timezone: "America/Sao_Paulo",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const envelope = buildEnvelope({
      event_type: "test.ping_done.v1",
      tenant_id: tenantId,
      aggregate_type: "test.aggregate",
      aggregate_id: newId(),
      aggregate_version: 1,
      data: { ping: "quiescence" },
      actor: { type: "system", id: null },
    });
    const domainEventId = newId();
    await db
      .insertInto("platform.domain_events")
      .values({
        id: domainEventId,
        event_id: envelope.event_id,
        tenant_id: tenantId,
        event_type: envelope.event_type,
        aggregate_type: envelope.aggregate_type,
        aggregate_id: envelope.aggregate_id,
        aggregate_version: envelope.aggregate_version,
        occurred_at: new Date(envelope.occurred_at),
        recorded_at: new Date(envelope.recorded_at),
        correlation_id: envelope.correlation_id,
        causation_id: null,
        actor_type: "system",
        actor_id: null,
        schema_version: 1,
        data_json: envelope.data,
      })
      .execute();
    await db
      .insertInto("platform.outbox_messages")
      .values({
        id: newId(),
        tenant_id: tenantId,
        domain_event_id: domainEventId,
        topic: "test.ping_done.v1",
        message_key: null,
        payload_json: envelope as unknown as Record<string, unknown>,
        headers_json: {},
        state: "PENDING",
        attempt_count: 0,
        next_attempt_at: new Date(Date.now() - 1000),
        published_at: null,
        last_error_code: null,
        created_at: new Date(),
      })
      .execute();
    return { tenantId, eventId: envelope.event_id };
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
  }, 120_000);

  afterAll(async () => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
    await db.destroy().catch(() => undefined);
  });

  it("enabled drain publishes the seeded row against migrated DB", async () => {
    delete process.env[ENV_KEY];
    const { eventId } = await seedClaimableRow();
    const transport = new LocalTransport();
    const drainer = new OutboxDrainer(db, transport);
    const result = await drainer.drain(25);
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.published).toBeGreaterThanOrEqual(1);
    expect(result.eventIds).toContain(eventId);
    expect(transport.published.map((e) => e.event_id)).toContain(eventId);
    const state = drainer.getDrainState();
    expect(state).toMatchObject({ enabled: true, inFlight: 0 });
    expect(state.totalDrains).toBeGreaterThanOrEqual(1);
    expect(state.lastFinishedAt).not.toBeNull();
  });

  it("disabled drain throws with a live DB (gate precedes claim)", async () => {
    process.env[ENV_KEY] = "0";
    try {
      const drainer = new OutboxDrainer(db, new LocalTransport());
      await expect(drainer.drain(25)).rejects.toBeInstanceOf(LegacyOutboxDrainDisabledError);
      expect(drainer.getDrainState()).toMatchObject({ enabled: false, inFlight: 0, totalDrains: 0 });
      await expect(drainer.waitForQuiescence(100)).resolves.toBeUndefined();
    } finally {
      delete process.env[ENV_KEY];
    }
  });
});
