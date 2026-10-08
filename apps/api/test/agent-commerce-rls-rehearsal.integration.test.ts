import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDb, applyMigrations, withTenantTransaction, type Database } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { ContextBuilder } from "../src/agent/context-builder.js";
import { KyselyAgentReleaseStore } from "../src/agent/release-store.js";
import { AgentPipeline } from "../src/agent/pipeline.js";
import { KyselyPolicyRepository, PolicyResolver } from "../src/policy/policy-resolver.js";
import { CommerceController } from "../src/commerce/commerce.controller.js";
import { createToolDispatcher } from "../src/agent/crm-lookup.tool.js";

/**
 * CODER-P8-WRAPS regression: agent context-builder + agent pipeline +
 * commerce reads under the effective `iptv_app` pool (RLS fail-closed when
 * `app.tenant_id` is unset). Mirrors
 * `communications-rls-rehearsal.integration.test.ts`.
 *
 * WHAT IS PROVEN HERE (genuine `iptv_app` session, no SET ROLE tricks):
 *
 * - raw pool-level selects without tenant context fail-close to 0 rows
 *   (`communication.conversations`, `identity.persons`, `commerce.orders`,
 *   `agent.human_review_requests`, `agent.agent_runs`, `agent.agent_tasks`);
 * - `ContextBuilder.build` resolves the tenant bundle (person, 1 recent
 *   message, active suppression, 1 open review) and maps a foreign
 *   conversation id to null (never leaks);
 * - `GET /v1/orders/:id` + `GET /v1/orders` wrapped in
 *   `withTenantTransaction`: tenant A sees its own order + item, tenant B
 *   never sees A's rows, cross-tenant detail → 404;
 * - `AgentPipeline.evaluateInbound` SHADOW path (echo gateway, stubbed bus)
 *   persists the `agent_runs` row + review link under the actor tenant;
 *   `resumeApproved` → SENT and `resumeRejected` → DISCARDED run through the
 *   same wrapped writes; the run is invisible under the other tenant;
 * - no residual `app.tenant_id` survives on the pool after the wrapped ops.
 *
 * The model gateway is forced to echo (`OPENAI_API_KEY` stubbed empty) so
 * the pipeline runs fully offline; the bus/capability/gate collaborators are
 * stubbed because command-owned writes are out of scope here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function withAppIdentity(base: string, password: string): string {
  const url = new URL(base);
  url.username = "iptv_app";
  url.password = password;
  return url.toString();
}

function actorFor(tenantId: string, userId: string): CommandActor {
  return {
    userId,
    isPlatformAdmin: false,
    tenantId,
    roleKeys: ["tenant_owner"],
    permissions: ["conversation.reply", "billing.read", "agent.review.request"],
    actorType: "human",
  };
}

function reqFor(tenantId: string): { tenant: { id: string } } {
  return { tenant: { id: tenantId } };
}

describe.skipIf(!hasDb)("Agent + commerce RLS rehearsal under iptv_app (requires TEST_DATABASE_URL)", () => {
  let adminDb: Kysely<Database>;
  let databaseName = "";
  let ownerDb: Kysely<Database>;
  let appDb: Kysely<Database>;

  let tenantA = "";
  let tenantB = "";
  let personA = "";
  let personB = "";
  let convA = "";
  let convB = "";
  let orderA = "";
  let orderB = "";
  let reviewProbeA = "";
  let reviewProbeA2 = "";
  let reviewProbeB = "";

  async function makeTenant(slug: string): Promise<string> {
    const id = newId();
    await ownerDb
      .insertInto("control.tenants")
      .values({
        id,
        slug: `${slug}-${id.replace(/-/g, "").slice(-8)}`,
        name: "P8 Wraps Tenant",
        status: "ACTIVE",
        default_currency: "BRL",
        timezone: "America/Sao_Paulo",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    return id;
  }

  async function makePerson(tenantId: string): Promise<string> {
    const id = newId();
    await ownerDb
      .insertInto("identity.persons")
      .values({
        id,
        tenant_id: tenantId,
        status: "ACTIVE",
        canonical_name: null,
        locale: null,
        timezone: null,
        created_at: new Date(),
        updated_at: new Date(),
        anonymized_at: null,
      })
      .execute();
    return id;
  }

  async function makeConversation(tenantId: string, personId: string): Promise<string> {
    const id = newId();
    await ownerDb
      .insertInto("communication.conversations")
      .values({
        id,
        tenant_id: tenantId,
        person_id: personId,
        channel: "WHATSAPP",
        external_thread_id: null,
        status: "OPEN",
        control_mode: "AI_CONTROL",
        last_message_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
        resolved_at: null,
        archived_at: null,
      })
      .execute();
    return id;
  }

  async function makeMessage(tenantId: string, conversationId: string, personId: string): Promise<void> {
    await ownerDb
      .insertInto("communication.messages")
      .values({
        id: newId(),
        tenant_id: tenantId,
        conversation_id: conversationId,
        person_id: personId,
        direction: "INBOUND",
        channel: "WHATSAPP",
        sender_type: "HUMAN",
        external_message_id: null,
        idempotency_key: null,
        content_type: "TEXT",
        body_text: "Olá, gostaria de falar sobre meu plano atual",
        attachment_ref: null,
        metadata_json: {},
        occurred_at: new Date(),
        received_at: new Date(),
        created_at: new Date(),
      })
      .execute();
  }

  async function makeSuppression(tenantId: string, personId: string): Promise<void> {
    await ownerDb
      .insertInto("communication.communication_suppressions")
      .values({
        id: newId(),
        tenant_id: tenantId,
        person_id: personId,
        identity_id: null,
        channel: "WHATSAPP",
        purpose_key: null,
        reason: "P8-WRAPS probe",
        starts_at: new Date(Date.now() - 60_000),
        ends_at: null,
        created_at: new Date(),
      })
      .execute();
  }

  async function makeReview(tenantId: string, resourceId: string): Promise<string> {
    const id = newId();
    await ownerDb
      .insertInto("agent.human_review_requests")
      .values({
        id,
        tenant_id: tenantId,
        status: "REQUESTED",
        review_mode: "APPROVAL",
        reason: "RISK_REVIEW",
        risk_class: "R1",
        priority: "NORMAL",
        resource_type: "agent_proposal",
        resource_id: resourceId,
        requested_by_type: "agent",
        requested_by_id: "agent-pipeline",
        assigned_to_user_id: null,
        summary: "P8-WRAPS probe review",
        context_json: {},
        sla_due_at: null,
        escalation_policy: null,
        created_at: new Date(),
        resolved_at: null,
      })
      .execute();
    return id;
  }

  async function makeOrder(tenantId: string, personId: string): Promise<{ orderId: string }> {
    const orderId = newId();
    await ownerDb
      .insertInto("commerce.orders")
      .values({
        id: orderId,
        tenant_id: tenantId,
        person_id: personId,
        customer_id: null,
        source_offer_id: null,
        order_type: "NEW_SUBSCRIPTION",
        status: "DRAFT",
        currency: "BRL",
        gross_amount_minor: "1000",
        discount_amount_minor: "0",
        reward_amount_minor: "0",
        net_amount_minor: "1000",
        settled_amount_minor: "0",
        created_at: new Date(),
        awaiting_payment_at: null,
        settled_at: null,
        cancelled_at: null,
        expires_at: null,
      })
      .execute();
    await ownerDb
      .insertInto("commerce.order_items")
      .values({
        id: newId(),
        tenant_id: tenantId,
        order_id: orderId,
        item_type: "BASE_PLAN",
        sellable_type: "PLAN",
        sellable_id: newId(),
        quantity: "1",
        unit_price_minor: "1000",
        gross_minor: "1000",
        discount_minor: "0",
        reward_minor: "0",
        net_minor: "1000",
        metadata_json: {},
        created_at: new Date(),
      })
      .execute();
    return { orderId };
  }

  function buildContexts(): ContextBuilder {
    return new ContextBuilder(appDb, new PolicyResolver(new KyselyPolicyRepository(appDb)));
  }

  function buildPipeline(reviewIds: string[]) {
    const bus = {
      execute: async (_actor: unknown, command: string) => {
        if (command === "human_review.request") {
          const next = reviewIds.shift();
          if (next === undefined) {
            return { ok: false as const, code: "validation_failed" as const, message: "no probe review left" };
          }
          return { ok: true as const, data: { id: next } };
        }
        if (command === "human_review.approve") {
          return { ok: true as const, data: { id: reviewIds[0] ?? "probe", resolution: "APPROVED" } };
        }
        if (command === "human_review.reject") {
          return { ok: true as const, data: {} };
        }
        if (command === "message.send_manual") {
          return {
            ok: true as const,
            data: { messageId: newId(), deliveryStatus: "SENT", providerMessageId: null },
          };
        }
        return { ok: false as const, code: "validation_failed" as const, message: `unexpected command ${command}` };
      },
    };
    const capabilities = { get: async () => null };
    const gate = { resolve: async () => ({ action: "REQUIRE_APPROVAL", provenance: [], degraded: false as const, reason: "probe" }) };
    return new AgentPipeline(
      appDb,
      bus as never,
      buildContexts(),
      new KyselyAgentReleaseStore(appDb),
      capabilities as never,
      gate as never,
    );
  }

  beforeAll(async () => {
    // Force the echo gateway (offline): the ambient env may carry an
    // OpenAI-compatible key (OpenCode Go), which would turn the pipeline
    // into a network call.
    vi.stubEnv("OPENAI_API_KEY", "");
    const base = connectionString as string;
    adminDb = createDb({ connectionString: withDatabase(base, "postgres") });
    databaseName = `p8w_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(databaseName)) {
      throw new Error("unsafe generated scratch database name");
    }
    await sql.raw(`CREATE DATABASE "${databaseName}"`).execute(adminDb);
    const dedicatedUrl = withDatabase(base, databaseName);
    await applyMigrations(dedicatedUrl, { migrationsDir: MIGRATIONS_DIR });
    ownerDb = createDb({ connectionString: dedicatedUrl });

    const appPassword = `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
    await sql.raw(`ALTER ROLE iptv_app WITH LOGIN PASSWORD '${appPassword}'`).execute(ownerDb);
    appDb = createDb({ connectionString: withAppIdentity(dedicatedUrl, appPassword) });

    tenantA = await makeTenant("p8w-a");
    tenantB = await makeTenant("p8w-b");
    personA = await makePerson(tenantA);
    personB = await makePerson(tenantB);
    convA = await makeConversation(tenantA, personA);
    convB = await makeConversation(tenantB, personB);
    await makeMessage(tenantA, convA, personA);
    await makeSuppression(tenantA, personA);
    reviewProbeA = await makeReview(tenantA, newId());
    reviewProbeA2 = await makeReview(tenantA, newId());
    reviewProbeB = await makeReview(tenantB, newId());
    ({ orderId: orderA } = await makeOrder(tenantA, personA));
    ({ orderId: orderB } = await makeOrder(tenantB, personB));
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await appDb?.destroy().catch(() => undefined);
    if (ownerDb !== undefined) {
      await sql.raw("ALTER ROLE iptv_app WITH PASSWORD NULL").execute(ownerDb).catch(() => undefined);
      await ownerDb.destroy().catch(() => undefined);
    }
    if (adminDb !== undefined && databaseName !== "") {
      await sql.raw(`DROP DATABASE "${databaseName}" WITH (FORCE)`).execute(adminDb).catch(() => undefined);
      await adminDb.destroy().catch(() => undefined);
    }
  });

  it("effective pool identity is iptv_app (REAL)", async () => {
    const who = await sql<{ u: string }>`SELECT current_user AS u`.execute(appDb);
    expect(who.rows[0]?.u).toBe("iptv_app");
  });

  it("raw selects without tenant context fail-close to 0 rows (REAL)", async () => {
    const convs = await appDb
      .selectFrom("communication.conversations")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .execute();
    expect(convs).toHaveLength(0);
    const persons = await appDb
      .selectFrom("identity.persons")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .execute();
    expect(persons).toHaveLength(0);
    const orders = await appDb
      .selectFrom("commerce.orders")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .execute();
    expect(orders).toHaveLength(0);
    const reviews = await appDb
      .selectFrom("agent.human_review_requests")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .execute();
    expect(reviews).toHaveLength(0);
    const runs = await appDb
      .selectFrom("agent.agent_runs")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .execute();
    expect(runs).toHaveLength(0);
    const tasks = await appDb
      .selectFrom("agent.agent_tasks")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .execute();
    expect(tasks).toHaveLength(0);
  });

  it("ContextBuilder.build resolves the tenant bundle and never leaks foreign conversations", async () => {
    const contexts = buildContexts();

    const bundleA = await contexts.build(tenantA, convA);
    expect(bundleA).not.toBeNull();
    expect(bundleA?.personSummary?.personId).toBe(personA);
    expect(bundleA?.recentMessages).toHaveLength(1);
    expect(bundleA?.suppressionsActive).toBe(true);
    expect(bundleA?.openReviewCount).toBe(2);

    expect(await contexts.build(tenantA, convB)).toBeNull();

    const bundleB = await contexts.build(tenantB, convB);
    expect(bundleB).not.toBeNull();
    expect(bundleB?.personSummary?.personId).toBe(personB);
    expect(bundleB?.suppressionsActive).toBe(false);
    expect(bundleB?.openReviewCount).toBe(1);
  }, 60_000);

  it("commerce reads are tenant-isolated on the effective iptv_app pool", async () => {
    const controller = new CommerceController(appDb, {} as never);

    const detailA = await controller.get(orderA, reqFor(tenantA) as never);
    expect(detailA.order.id).toBe(orderA);
    expect(detailA.items).toHaveLength(1);

    await expect(controller.get(orderA, reqFor(tenantB) as never)).rejects.toMatchObject({ status: 404 });

    const listA = await controller.list({}, reqFor(tenantA) as never);
    expect(listA.orders.map((o) => o.id)).toEqual([orderA]);

    const listB = await controller.list({}, reqFor(tenantB) as never);
    expect(listB.orders.map((o) => o.id)).toEqual([orderB]);
    expect(listB.orders.map((o) => o.id)).not.toContain(orderA);
  }, 60_000);

  it("pipeline SHADOW evaluate + approve/reject persist under the actor tenant only", async () => {
    const pipeline = buildPipeline([reviewProbeA, reviewProbeA2, reviewProbeB]);

    // Tenant A carries an active suppression: the echo model respects it and
    // the harness validates the completion as an ESCALATE proposal (nothing
    // to send on approval — the refusal itself is acknowledged).
    const first = await pipeline.evaluateInbound({
      tenantId: tenantA,
      conversationId: convA,
      inboundText: "Olá, gostaria de falar sobre meu plano atual",
    });
    expect(first.evaluated).toBe(true);
    if (!first.evaluated) {
      throw new Error("expected evaluation");
    }
    expect(first.mode).toBe("SHADOW");
    expect(first.reviewId).toBe(reviewProbeA);
    expect(first.sent).toBe(false);

    const stored = await withTenantTransaction(appDb, tenantA, (trx) =>
      trx
        .selectFrom("agent.agent_runs")
        .select(["id", "status", "mode", "proposal_kind", "human_review_request_id"])
        .where("tenant_id", "=", tenantA)
        .where("id", "=", first.runId)
        .executeTakeFirst(),
    );
    expect(stored?.status).toBe("PROPOSED");
    expect(stored?.mode).toBe("SHADOW");
    expect(stored?.proposal_kind).toBe("ESCALATE");
    expect(stored?.human_review_request_id).toBe(reviewProbeA);

    const foreign = await withTenantTransaction(appDb, tenantB, (trx) =>
      trx
        .selectFrom("agent.agent_runs")
        .select(["id"])
        .where("tenant_id", "=", tenantB)
        .where("id", "=", first.runId)
        .executeTakeFirst(),
    );
    expect(foreign).toBeUndefined();

    const approvedEscalation = await pipeline.resumeApproved({
      tenantId: tenantA,
      reviewId: reviewProbeA,
      actor: actorFor(tenantA, newId()),
    });
    expect(approvedEscalation).toEqual({ ok: true, sent: false, messageId: null });
    const discardedEscalation = await withTenantTransaction(appDb, tenantA, (trx) =>
      trx
        .selectFrom("agent.agent_runs")
        .select(["status"])
        .where("id", "=", first.runId)
        .executeTakeFirst(),
    );
    expect(discardedEscalation?.status).toBe("DISCARDED");

    const second = await pipeline.evaluateInbound({
      tenantId: tenantA,
      conversationId: convA,
      inboundText: "Olá, gostaria de falar sobre meu plano atual",
    });
    expect(second.evaluated).toBe(true);
    if (!second.evaluated) {
      throw new Error("expected evaluation");
    }
    expect(second.reviewId).toBe(reviewProbeA2);

    const rejected = await pipeline.resumeRejected({
      tenantId: tenantA,
      reviewId: reviewProbeA2,
      actor: actorFor(tenantA, newId()),
    });
    expect(rejected).toEqual({ ok: true });
    const discardedRow = await withTenantTransaction(appDb, tenantA, (trx) =>
      trx
        .selectFrom("agent.agent_runs")
        .select(["status"])
        .where("id", "=", second.runId)
        .executeTakeFirst(),
    );
    expect(discardedRow?.status).toBe("DISCARDED");

    // Tenant B has no suppression: the proposal is a REPLY, so approval sends
    // through the stubbed `message.send_manual` and marks the run SENT.
    const third = await pipeline.evaluateInbound({
      tenantId: tenantB,
      conversationId: convB,
      inboundText: "Olá, gostaria de falar sobre meu plano atual",
    });
    expect(third.evaluated).toBe(true);
    if (!third.evaluated) {
      throw new Error("expected evaluation");
    }
    expect(third.reviewId).toBe(reviewProbeB);

    const approved = await pipeline.resumeApproved({
      tenantId: tenantB,
      reviewId: reviewProbeB,
      actor: actorFor(tenantB, newId()),
    });
    expect(approved).toMatchObject({ ok: true, sent: true });
    const sentRow = await withTenantTransaction(appDb, tenantB, (trx) =>
      trx
        .selectFrom("agent.agent_runs")
        .select(["status", "proposal_kind"])
        .where("id", "=", third.runId)
        .executeTakeFirst(),
    );
    expect(sentRow?.status).toBe("SENT");
    expect(sentRow?.proposal_kind).toBe("REPLY");
  }, 120_000);

  it("crm.lookup_person dispatcher resolves own person and hides foreign rows under iptv_app", async () => {
    const dispatch = createToolDispatcher(appDb);
    const own = await dispatch(
      { tenantId: tenantA, actorType: "agent", actorId: "agent-pipeline", conversationId: convA },
      "crm.lookup_person",
      { personId: personA },
    );
    expect(own.ok).toBe(true);
    if (own.ok) {
      expect(own.output["person_id"]).toBe(personA);
    }
    const cross = await dispatch(
      { tenantId: tenantB, actorType: "agent", actorId: "agent-pipeline", conversationId: convB },
      "crm.lookup_person",
      { personId: personA },
    );
    expect(cross).toMatchObject({ ok: false, code: "NOT_FOUND" });
  }, 60_000);

  it("no residual app.tenant_id survives on the pool after wrapped ops", async () => {
    const contexts = buildContexts();
    await contexts.build(tenantA, convA);
    const commerce = new CommerceController(appDb, {} as never);
    await commerce.list({}, reqFor(tenantA) as never);
    const pipeline = buildPipeline([]);
    await pipeline.resumeRejected({
      tenantId: tenantB,
      reviewId: reviewProbeA,
      actor: actorFor(tenantB, newId()),
    });

    const setting = await sql<{ value: string | null }>`
      SELECT nullif(current_setting('app.tenant_id', true), '') AS value
    `.execute(appDb);
    expect(setting.rows[0]?.value ?? null).toBeNull();
  });
});
