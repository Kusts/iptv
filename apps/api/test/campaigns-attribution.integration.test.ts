import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDb, applyMigrations } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";
import { CommandBus } from "../src/commands/command-bus.js";
import { isQuietHour } from "../src/growth/growth-policy.js";
import { OutboxDrainer } from "../src/outbox/outbox-drainer.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(-12)}@example.com`;
}

const PERMISSIONS = ["crm.person.read", "crm.lead.write"];

/**
 * Wave 11 Campaigns/Attribution (requires TEST_DATABASE_URL).
 *
 * Covers the acceptance slice against a disposable database:
 * activate → event; quiet-window schedule → DEFERRED; budget cap →
 * BLOCKED; conversion resolves the first-touch version (G17);
 * cross-tenant 404; intent-key replay is idempotent. No message is ever
 * sent: scheduling only writes intents/contacts behind the gateway.
 */
describe.skipIf(!hasDb)("Wave 11 Campaigns/Attribution (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let token = "";
  let tenantId = "";
  let userId = "";
  let bus: CommandBus;
  let drainer: OutboxDrainer;

  let campaignId = "";
  let audienceId = "";
  let quietIntentId = "";
  let personA = "";
  let personB = "";
  let personC = "";
  let personD = "";

  function actor(): CommandActor {
    return {
      userId,
      isPlatformAdmin: false,
      tenantId,
      roleKeys: ["tenant_owner"],
      permissions: PERMISSIONS,
      actorType: "human",
    };
  }

  function injectRaw(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    revision?: string | null;
    headers?: Record<string, string>;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
      if (opts.revision !== null && headers["x-tenant-context-revision"] === undefined) {
        headers["x-tenant-context-revision"] = opts.revision ?? "0";
      }
    }
    const options: {
      method: "GET" | "POST";
      url: string;
      headers: Record<string, string>;
      payload?: Record<string, unknown>;
    } = { method: opts.method, url: opts.url, headers };
    if (opts.payload !== undefined) {
      options.payload = opts.payload;
    }
    return app.getHttpAdapter().getInstance().inject(options);
  }

  async function makePerson(): Promise<string> {
    const result = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Wave11 Person",
    });
    if (!result.ok) {
      throw new Error(`person.register failed: ${result.message}`);
    }
    return result.data.id;
  }

  async function makePersonWithIdentity(normalizedValue: string): Promise<{ personId: string; identityId: string }> {
    const result = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Wave11 Identity Person",
      identities: [{ identityType: "WHATSAPP", normalizedValue }],
    });
    if (!result.ok) {
      throw new Error(`person.register failed: ${result.message}`);
    }
    const identity = await db
      .selectFrom("identity.identities")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("person_id", "=", result.data.id)
      .where("detached_at", "is", null)
      .executeTakeFirstOrThrow();
    return { personId: result.data.id, identityId: identity.id };
  }

  /**
   * Standalone ACTIVE campaign for the Wave 11 fix tests (findings 1, 3–5):
   * isolated budget/cost accounting per test, no shared-version interference.
   */
  async function createActiveCampaign(input: {
    name: string;
    budgetCapMinor?: string;
    unitCostMinor?: string;
    memberPersonIds?: string[];
  }): Promise<{ campaignId: string; versionId: string; audienceId: string }> {
    const created = await injectRaw({
      method: "POST",
      url: "/v1/campaigns",
      token,
      payload: { name: input.name },
    });
    expect(created.statusCode).toBe(201);
    const campaignId = created.json<{ id: string }>().id;
    const published = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/versions`,
      token,
      payload: {
        offerSnapshot: {},
        policySnapshot: {},
        ...(input.budgetCapMinor !== undefined ? { budgetCapMinor: input.budgetCapMinor } : {}),
        ...(input.unitCostMinor !== undefined ? { unitCostMinor: input.unitCostMinor } : {}),
      },
    });
    expect(published.statusCode).toBe(201);
    const versionId = published.json<{ versionId: string }>().versionId;
    const audience = await injectRaw({
      method: "POST",
      url: "/v1/audiences",
      token,
      payload: {
        campaignId,
        name: `${input.name} audience`,
        membershipType: "STATIC",
        criteriaJson: {},
        memberPersonIds: input.memberPersonIds ?? [],
      },
    });
    expect(audience.statusCode).toBe(201);
    const audienceId = audience.json<{ audienceId: string }>().audienceId;
    const creative = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/creatives`,
      token,
      payload: { channel: "WHATSAPP", name: `${input.name} creative`, content: { text: "Olá!" } },
    });
    expect(creative.statusCode).toBe(201);
    const activated = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/activate`,
      token,
    });
    expect(activated.statusCode).toBe(201);
    return { campaignId, versionId, audienceId };
  }

  async function outboxCount(topic: string): Promise<number> {
    const row = await db
      .selectFrom("platform.outbox_messages")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("tenant_id", "=", tenantId)
      .where("topic", "=", topic)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async function contactCount(intentId: string): Promise<number> {
    const row = await db
      .selectFrom("communication.scheduled_contacts")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("tenant_id", "=", tenantId)
      .where("intent_id", "=", intentId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);
    drainer = app.get(OutboxDrainer);

    const register = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w11"), password: "correct-horse-8", tenantName: "Wave11 Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;

    personA = await makePerson();
    personB = await makePerson();
    personC = await makePerson();
    personD = await makePerson();
  });

  afterAll(async () => {
    if (hasDb && drainer !== undefined) {
      await drainer.drain(1000).catch(() => undefined);
    }
    await app?.close().catch(() => undefined);
    await (db as unknown as { destroy: () => Promise<void> }).destroy?.().catch(() => undefined);
  });

  it("creates a campaign and refuses activation before readiness", async () => {
    const created = await injectRaw({
      method: "POST",
      url: "/v1/campaigns",
      token,
      payload: { name: "Winback Q4", objective: "recover churned trials" },
    });
    expect(created.statusCode).toBe(201);
    const campaign = created.json<{ id: string; status: string; currentVersionId: string | null }>();
    expect(campaign.status).toBe("DRAFT");
    campaignId = campaign.id;

    const activate = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/activate`,
      token,
    });
    expect(activate.statusCode).toBe(409);
  });

  it("publishes v1 with a budget cap, audience and creative, then activates with an event", async () => {
    const published = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/versions`,
      token,
      payload: {
        offerSnapshot: { plan: "monthly", discount_pct: 20 },
        policySnapshot: { quiet_hours: "21-08 America/Sao_Paulo" },
        budgetCapMinor: "1000",
        unitCostMinor: "0",
        currency: "BRL",
      },
    });
    expect(published.statusCode).toBe(201);

    const audience = await injectRaw({
      method: "POST",
      url: "/v1/audiences",
      token,
      payload: {
        campaignId,
        name: "Churned trials",
        membershipType: "STATIC",
        criteriaJson: { segment: "churned-trial" },
        memberPersonIds: [personA, personB],
      },
    });
    expect(audience.statusCode).toBe(201);
    audienceId = audience.json<{ audienceId: string }>().audienceId;

    const creative = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/creatives`,
      token,
      payload: { channel: "WHATSAPP", name: "winback-hero", content: { text: "Volte!" } },
    });
    expect(creative.statusCode).toBe(201);

    const activated = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/activate`,
      token,
    });
    expect(activated.statusCode).toBe(201);
    expect(activated.json<{ status: string }>().status).toBe("ACTIVE");
    expect(await outboxCount("growth.campaign.activated.v1")).toBe(1);
  });

  it("defers contacts scheduled inside quiet hours and never sends", async () => {
    const scheduled = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/schedule`,
      token,
      headers: { "idempotency-key": "w11-quiet-1" },
      payload: {
        audienceId,
        channel: "WHATSAPP",
        scheduledFor: "2026-09-30T22:30:00-03:00",
        estimatedCostMinor: "0",
      },
    });
    expect(scheduled.statusCode).toBe(201);
    const body = scheduled.json<{
      intentId: string;
      status: string;
      already: boolean;
      contacts: Array<{ personId: string; status: string; reason: string | null }>;
    }>();
    expect(body.already).toBe(false);
    expect(body.status).toBe("SCHEDULED");
    expect(body.contacts).toHaveLength(2);
    quietIntentId = body.intentId;
    for (const contact of body.contacts) {
      expect(contact.status).toBe("DEFERRED");
      expect(contact.reason).toBe("QUIET_HOURS");
    }
    // Finding 2: DEFERRED rows persist the next allowed release instant in
    // the tenant timezone — never the requested time inside the window.
    const deferredRows = await db
      .selectFrom("communication.scheduled_contacts")
      .select(["scheduled_for", "status"])
      .where("tenant_id", "=", tenantId)
      .where("intent_id", "=", quietIntentId)
      .execute();
    expect(deferredRows).toHaveLength(2);
    for (const row of deferredRows) {
      expect(row.status).toBe("DEFERRED");
      expect(isQuietHour(row.scheduled_for, "America/Sao_Paulo")).toBe(false);
    }
    // Nothing was sent: no message rows were created for these contacts.
    const messages = await db
      .selectFrom("communication.messages")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("tenant_id", "=", tenantId)
      .executeTakeFirstOrThrow();
    expect(Number(messages.n)).toBe(0);
  });

  it("blocks contacts over the version budget cap (caller estimate is not authoritative)", async () => {
    // Finding 3: the per-contact cost authority is the version's
    // `unit_cost_minor`. The caller passes estimatedCostMinor "0" (a cap
    // bypass attempt) — the version cost of 600 still drives the cap.
    const published = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/versions`,
      token,
      payload: {
        offerSnapshot: { plan: "monthly", discount_pct: 25 },
        policySnapshot: {},
        budgetCapMinor: "1000",
        unitCostMinor: "600",
      },
    });
    expect(published.statusCode).toBe(201);
    const costVersion = published.json<{ versionId: string }>().versionId;
    const scheduled = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/schedule`,
      token,
      headers: { "idempotency-key": "w11-budget-1" },
      payload: {
        campaignVersionId: costVersion,
        personIds: [personC, personD],
        channel: "WHATSAPP",
        scheduledFor: "2026-09-30T10:00:00-03:00",
        estimatedCostMinor: "0",
      },
    });
    expect(scheduled.statusCode).toBe(201);
    const body = scheduled.json<{
      contacts: Array<{ personId: string; status: string; reason: string | null }>;
    }>();
    expect(body.contacts).toHaveLength(2);
    expect(body.contacts[0]?.status).toBe("SCHEDULED");
    expect(body.contacts[0]?.reason).toBeNull();
    expect(body.contacts[1]?.status).toBe("BLOCKED");
    expect(body.contacts[1]?.reason).toBe("BUDGET_EXCEEDED");
  });

  it("blocks suppressed and opted-out recipients", async () => {
    await db
      .insertInto("communication.communication_suppressions")
      .values({
        id: newId(),
        tenant_id: tenantId,
        person_id: personC,
        identity_id: null,
        channel: "WHATSAPP",
        purpose_key: null,
        reason: "test suppression",
        starts_at: new Date(Date.now() - 60_000),
        ends_at: null,
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto("communication.communication_preferences")
      .values({
        id: newId(),
        tenant_id: tenantId,
        person_id: personD,
        purpose_key: "MARKETING",
        channel: "WHATSAPP",
        status: "DENIED",
        source: "test",
        evidence_ref: null,
        updated_at: new Date(),
        created_at: new Date(),
      })
      .execute();
    const scheduled = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/schedule`,
      token,
      headers: { "idempotency-key": "w11-policy-1" },
      payload: {
        personIds: [personC, personD],
        channel: "WHATSAPP",
        scheduledFor: "2026-09-30T10:00:00-03:00",
        estimatedCostMinor: "0",
      },
    });
    expect(scheduled.statusCode).toBe(201);
    const body = scheduled.json<{
      status: string;
      contacts: Array<{ personId: string; status: string; reason: string | null }>;
    }>();
    expect(body.status).toBe("BLOCKED");
    const byPerson = new Map(body.contacts.map((c) => [c.personId, c]));
    expect(byPerson.get(personC)?.status).toBe("BLOCKED");
    expect(byPerson.get(personC)?.reason).toBe("SUPPRESSED");
    expect(byPerson.get(personD)?.status).toBe("BLOCKED");
    expect(byPerson.get(personD)?.reason).toBe("OPTED_OUT");
  });

  it("finding 1: identity-only suppression never blocks an unlinked person", async () => {
    const linked = await makePersonWithIdentity("5511999940001");
    const unlinked = await makePerson();
    const { campaignId: fixCampaign } = await createActiveCampaign({
      name: "W11 Fix Suppression Scope",
      budgetCapMinor: "100000",
      unitCostMinor: "0",
    });
    // Identity-directed suppression: person_id NULL, identity of `linked`.
    await db
      .insertInto("communication.communication_suppressions")
      .values({
        id: newId(),
        tenant_id: tenantId,
        person_id: null,
        identity_id: linked.identityId,
        channel: "WHATSAPP",
        purpose_key: null,
        reason: "identity-only suppression",
        starts_at: new Date(Date.now() - 60_000),
        ends_at: null,
        created_at: new Date(),
      })
      .execute();
    const scheduled = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${fixCampaign}/schedule`,
      token,
      headers: { "idempotency-key": "w11-fix-suppression-1" },
      payload: {
        personIds: [linked.personId, unlinked],
        channel: "WHATSAPP",
        scheduledFor: "2026-09-30T10:00:00-03:00",
      },
    });
    expect(scheduled.statusCode).toBe(201);
    const body = scheduled.json<{
      contacts: Array<{ personId: string; status: string; reason: string | null }>;
    }>();
    expect(body.contacts).toHaveLength(2);
    const byPerson = new Map(body.contacts.map((c) => [c.personId, c]));
    expect(byPerson.get(linked.personId)?.status).toBe("BLOCKED");
    expect(byPerson.get(linked.personId)?.reason).toBe("SUPPRESSED");
    expect(byPerson.get(unlinked)?.status).toBe("SCHEDULED");
  });

  it("finding 3: schedule without a version unit cost fails closed", async () => {
    const person = await makePerson();
    const { campaignId: fixCampaign } = await createActiveCampaign({
      name: "W11 Fix No Unit Cost",
      budgetCapMinor: "100000",
    });
    const scheduled = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${fixCampaign}/schedule`,
      token,
      headers: { "idempotency-key": "w11-fix-nocost-1" },
      payload: {
        personIds: [person],
        channel: "WHATSAPP",
        scheduledFor: "2026-09-30T10:00:00-03:00",
        estimatedCostMinor: "0",
      },
    });
    expect(scheduled.statusCode).toBe(201);
    const body = scheduled.json<{
      status: string;
      contacts: Array<{ personId: string; status: string; reason: string | null }>;
    }>();
    expect(body.status).toBe("BLOCKED");
    expect(body.contacts).toHaveLength(1);
    expect(body.contacts[0]?.status).toBe("BLOCKED");
    expect(body.contacts[0]?.reason).toBe("NO_UNIT_COST");
  });

  it("finding 4: cross-campaign audiences are rejected", async () => {
    const first = await createActiveCampaign({ name: "W11 Fix Audience A", budgetCapMinor: "1000", unitCostMinor: "0" });
    const second = await createActiveCampaign({ name: "W11 Fix Audience B", budgetCapMinor: "1000", unitCostMinor: "0" });
    const scheduled = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${first.campaignId}/schedule`,
      token,
      headers: { "idempotency-key": "w11-fix-audience-1" },
      payload: {
        audienceId: second.audienceId,
        channel: "WHATSAPP",
        scheduledFor: "2026-09-30T10:00:00-03:00",
      },
    });
    expect(scheduled.statusCode).toBe(404);
  });

  it("finding 5: schedule after pause is rejected (no lost-update window)", async () => {
    const person = await makePerson();
    const { campaignId: fixCampaign } = await createActiveCampaign({
      name: "W11 Fix Pause Race",
      budgetCapMinor: "1000",
      unitCostMinor: "0",
      memberPersonIds: [person],
    });
    const paused = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${fixCampaign}/pause`,
      token,
    });
    expect(paused.statusCode).toBe(201);
    const scheduled = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${fixCampaign}/schedule`,
      token,
      headers: { "idempotency-key": "w11-fix-race-1" },
      payload: {
        personIds: [person],
        channel: "WHATSAPP",
        scheduledFor: "2026-09-30T10:00:00-03:00",
      },
    });
    expect(scheduled.statusCode).toBe(409);
  });

  it("keeps first-touch attribution and resolves conversions to the first-touch version (G17)", async () => {
    // The current version moved since v1 (budget test published a cost
    // version): resolve expectations against the live current version.
    const live = await injectRaw({ method: "GET", url: `/v1/campaigns/${campaignId}`, token });
    expect(live.statusCode).toBe(200);
    const liveVersion = live.json<{ currentVersionId: string }>().currentVersionId;
    const first = await injectRaw({
      method: "POST",
      url: "/v1/attribution/touches",
      token,
      payload: { personId: personA, campaignId, touchType: "CLICK" },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{ touchId: string; campaignVersionId: string; already: boolean }>();
    expect(firstBody.already).toBe(false);
    expect(firstBody.campaignVersionId).toBe(liveVersion);
    expect(await outboxCount("growth.attribution_touch.recorded.v1")).toBe(1);

    // Publish v2 AFTER the first touch: late touches must not move attribution.
    const published = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/versions`,
      token,
      payload: { offerSnapshot: { plan: "monthly", discount_pct: 30 }, budgetCapMinor: "5000" },
    });
    expect(published.statusCode).toBe(201);
    const versionV2 = published.json<{ versionId: string }>().versionId;
    expect(versionV2).not.toBe(liveVersion);

    const late = await injectRaw({
      method: "POST",
      url: "/v1/attribution/touches",
      token,
      payload: { personId: personA, campaignId, touchType: "CLICK" },
    });
    expect(late.statusCode).toBe(201);
    const lateBody = late.json<{ touchId: string; campaignVersionId: string; already: boolean }>();
    expect(lateBody.already).toBe(true);
    expect(lateBody.touchId).toBe(firstBody.touchId);
    expect(lateBody.campaignVersionId).toBe(liveVersion);
    expect(await outboxCount("growth.attribution_touch.recorded.v1")).toBe(1);

    const assist = await injectRaw({
      method: "POST",
      url: "/v1/attribution/touches",
      token,
      payload: { personId: personA, campaignId, touchType: "REFERRAL_ASSIST" },
    });
    expect(assist.statusCode).toBe(201);
    expect(assist.json<{ already: boolean }>().already).toBe(false);
    expect(await outboxCount("growth.attribution_touch.recorded.v1")).toBe(2);

    const conversion = await injectRaw({
      method: "POST",
      url: "/v1/attribution/conversions",
      token,
      headers: { "idempotency-key": "w11-conv-1" },
      payload: { personId: personA, conversionType: "ORDER_SETTLED", amountMinor: "3000", currency: "BRL" },
    });
    expect(conversion.statusCode).toBe(201);
    const conversionBody = conversion.json<{
      conversionId: string;
      campaignId: string;
      campaignVersionId: string;
      already: boolean;
    }>();
    expect(conversionBody.already).toBe(false);
    expect(conversionBody.campaignId).toBe(campaignId);
    // G17: resolves the first-touch version, not the current v2.
    expect(conversionBody.campaignVersionId).toBe(liveVersion);

    // Replay with the same intent-scoped key resolves to the stored row.
    const replay = await injectRaw({
      method: "POST",
      url: "/v1/attribution/conversions",
      token,
      payload: {
        personId: personA,
        conversionType: "ORDER_SETTLED",
        amountMinor: "3000",
        currency: "BRL",
        idempotencyKey: "w11-conv-key-1",
      },
    });
    expect(replay.statusCode).toBe(201);
    const replayId = replay.json<{ conversionId: string; already: boolean }>().conversionId;
    const replay2 = await injectRaw({
      method: "POST",
      url: "/v1/attribution/conversions",
      token,
      payload: {
        personId: personA,
        conversionType: "ORDER_SETTLED",
        amountMinor: "3000",
        currency: "BRL",
        idempotencyKey: "w11-conv-key-1",
      },
    });
    expect(replay2.statusCode).toBe(201);
    const replay2Body = replay2.json<{ conversionId: string; already: boolean }>();
    expect(replay2Body.already).toBe(true);
    expect(replay2Body.conversionId).toBe(replayId);
  });

  it("returns 404 for cross-tenant campaign reads", async () => {
    const other = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w11-other"), password: "correct-horse-8", tenantName: "Wave11 Other" },
    });
    expect(other.statusCode).toBe(201);
    const otherToken = other.json<{ token: string }>().token;
    const cross = await injectRaw({
      method: "GET",
      url: `/v1/campaigns/${campaignId}`,
      token: otherToken,
    });
    expect(cross.statusCode).toBe(404);
  });

  it("replays an intent schedule idempotently", async () => {
    // Bus-level replay (same header + payload) returns the stored response:
    // same intent, no duplicate contacts.
    const busReplay = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/schedule`,
      token,
      headers: { "idempotency-key": "w11-quiet-1" },
      payload: {
        audienceId,
        channel: "WHATSAPP",
        scheduledFor: "2026-09-30T22:30:00-03:00",
        estimatedCostMinor: "0",
      },
    });
    expect(busReplay.statusCode).toBe(201);
    expect(busReplay.json<{ intentId: string }>().intentId).toBe(quietIntentId);
    expect(await contactCount(quietIntentId)).toBe(2);
    // Handler-level replay (same intent key, no bus header) resolves to the
    // stored intent with already:true instead of duplicating contacts.
    const replay = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/schedule`,
      token,
      payload: {
        audienceId,
        channel: "WHATSAPP",
        scheduledFor: "2026-09-30T22:30:00-03:00",
        estimatedCostMinor: "0",
        intentKey: "w11-quiet-1",
      },
    });
    expect(replay.statusCode).toBe(201);
    const body = replay.json<{ intentId: string; already: boolean; contacts: Array<unknown> }>();
    expect(body.already).toBe(true);
    expect(body.contacts).toHaveLength(2);
    expect(await contactCount(body.intentId)).toBe(2);
  });

  it("pauses and completes the campaign with events", async () => {
    // Counts are tenant-wide: earlier fix tests paused their own
    // campaigns, so assert deltas rather than absolute totals.
    const pausedBefore = await outboxCount("growth.campaign.paused.v1");
    const completedBefore = await outboxCount("growth.campaign.completed.v1");
    const paused = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/pause`,
      token,
    });
    expect(paused.statusCode).toBe(201);
    expect(paused.json<{ status: string }>().status).toBe("PAUSED");
    expect(await outboxCount("growth.campaign.paused.v1")).toBe(pausedBefore + 1);

    const completed = await injectRaw({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/complete`,
      token,
    });
    expect(completed.statusCode).toBe(201);
    expect(completed.json<{ status: string }>().status).toBe("COMPLETED");
    expect(await outboxCount("growth.campaign.completed.v1")).toBe(completedBefore + 1);
  });
});
