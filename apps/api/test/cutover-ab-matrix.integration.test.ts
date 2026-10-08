import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql, type Kysely } from "kysely";
import { createDb, applyMigrations, withTenantTransaction, type Database } from "@iptv/database";
import { newId } from "@iptv/domain";
import { AppModule, resolveAppConnectionString } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";

/**
 * CODER-P1EXIT (P1-exit parte 1): matriz A/B tenant sob `iptv_app` efetivo
 * (migrations 001–059 aplicadas fresh em scratch descartável) + prova HTTP
 * dos wraps `withTenantTransaction` de finance/provider/human-review.
 *
 * COBERTURA (1 tabela RLS-enrolled por domínio crítico; fixtures inseridas
 * via pool owner, leituras SEMPRE via pool efetivo `iptv_app`):
 *
 * | domínio      | tabela (SELECT fail-closed sem `app.tenant_id`) | migration |
 * |--------------|-----------------------------------------------|-----------|
 * | billing      | billing.tenant_channels                       | 052       |
 * | finance      | finance.cost_allocations                      | 052       |
 * | trial        | trial.trials                                  | 055       |
 * | subscription | subscription.subscriptions                    | 055       |
 * | commerce     | commerce.orders                               | 055       |
 * | provider     | provider.provider_accounts                    | 055       |
 * | support      | support.incidents                             | 057       |
 * | knowledge    | knowledge.knowledge_items                     | 057       |
 * | referral     | referral.referrals                            | 058       |
 * | partners     | partners.partner_accounts                     | 058       |
 * | analytics    | analytics.metric_snapshots                    | 059       |
 * | growth       | growth.campaigns                              | 058       |
 *
 * Padrão de pool reutilizado de billing-rls-rehearsal (dual-app owner +
 * `iptv_app` genuíno, guards reais, sem mocks, sem SET ROLE); fixtures aqui
 * são inserts diretos mínimos via owner (cadeias FK respeitadas:
 * persons→customers→(trials, orders, subscriptions+plans, referrals+programs),
 * providers→accounts→operations), não fluxos do bus.
 *
 * PROVA HTTP (wraps desta slice): provider list, human-review queue e
 * finance overview via app `iptv_app` com tenants A/B — linha própria
 * visível, cruzada ausente. Sem o wrap, cada uma devolveria vazio sob
 * `iptv_app` (fail-closed silencioso); o overview ancora em
 * `monthCostMinor` semeado por tenant (100 vs 200).
 *
 * FORA DE ESCOPO (explícito): escritas cross-tenant (bloqueio de escrita é
 * das slices P1.x com prova em db/tests); semântica DEGRADED dos
 * controllers (coberta pelas suítes existentes no pool owner).
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

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(-12)}@example.com`;
}

function short(): string {
  return newId().replace(/-/g, "").slice(-10);
}

describe.skipIf(!hasDb)("Cutover A/B tenant matrix under iptv_app (requires TEST_DATABASE_URL)", () => {
  let adminDb: Kysely<Database>;
  let databaseName = "";
  let ownerDb: Kysely<Database>;
  let appDb: Kysely<Database>;
  let ownerApp: NestFastifyApplication;
  let app: NestFastifyApplication;

  let tokenA = "";
  let tenantA = "";
  let tokenB = "";
  let tenantB = "";

  const now = () => new Date();

  /** Linhas-âncora por domínio (id próprio de cada tenant). */
  const anchors = new Map<string, { table: string; idA: string; idB: string }>();
  let matrixProviderId = "";
  const matrixOperationIds = {} as Record<"a" | "b", string>;
  const matrixReviewIds = {} as Record<"a" | "b", string>;

  function injectRaw(
    target: NestFastifyApplication,
    opts: { method: "GET"; url: string; token?: string },
  ) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
      headers["x-tenant-context-revision"] = "0";
    }
    return target.getHttpAdapter().getInstance().inject({ method: opts.method, url: opts.url, headers });
  }

  async function seedTenant(tenantId: string, tag: "a" | "b"): Promise<void> {
    const personId = newId();
    await ownerDb
      .insertInto("identity.persons")
      .values({
        id: personId,
        tenant_id: tenantId,
        status: "ACTIVE",
        canonical_name: null,
        locale: null,
        timezone: null,
        created_at: now(),
        updated_at: now(),
        anonymized_at: null,
      })
      .execute();
    const customerId = newId();
    await ownerDb
      .insertInto("crm.customers")
      .values({
        id: customerId,
        tenant_id: tenantId,
        person_id: personId,
        status: "ACTIVE",
        customer_since: now(),
        last_reactivated_at: null,
        created_at: now(),
        updated_at: now(),
      })
      .execute();
    const productId = newId();
    await ownerDb
      .insertInto("catalog.products")
      .values({
        id: productId,
        tenant_id: tenantId,
        product_key: `mx-prod-${tag}-${short()}`,
        name: "Matrix Product",
        product_type: "SERVICE",
        status: "ACTIVE",
        metadata_json: {},
        created_at: now(),
        updated_at: now(),
      })
      .execute();
    const planId = newId();
    await ownerDb
      .insertInto("catalog.plans")
      .values({
        id: planId,
        tenant_id: tenantId,
        product_id: productId,
        plan_key: `mx-plan-${tag}-${short()}`,
        name: "Matrix Plan",
        billing_interval_unit: "MONTH",
        billing_interval_count: 1,
        status: "ACTIVE",
        metadata_json: {},
        created_at: now(),
        updated_at: now(),
      })
      .execute();

    const put = async (domain: string, table: string, id: string) => {
      const slot = anchors.get(domain) ?? { table, idA: "", idB: "" };
      if (tag === "a") slot.idA = id;
      else slot.idB = id;
      anchors.set(domain, slot);
    };

    const channelId = newId();
    await ownerDb
      .insertInto("billing.tenant_channels")
      .values({
        id: channelId,
        tenant_id: tenantId,
        channel: "ASAAS",
        tenant_key: `mx-billing-${tag}-${short()}`,
        webhook_secret_hash: null,
        status: "ACTIVE",
        created_at: now(),
        updated_at: now(),
      })
      .execute();
    await put("billing", "billing.tenant_channels", channelId);

    const allocId = newId();
    await ownerDb
      .insertInto("finance.cost_allocations")
      .values({
        id: allocId,
        tenant_id: tenantId,
        cost_type: "MATRIX_PROBE",
        amount_minor: tag === "a" ? "100" : "200",
        currency: "BRL",
        allocation_target_type: "MATRIX",
        allocation_target_id: newId(),
        allocation_method: "DIRECT",
        source_transaction_id: null,
        occurred_at: now(),
        created_at: now(),
      })
      .execute();
    await put("finance", "finance.cost_allocations", allocId);

    const trialId = newId();
    await ownerDb
      .insertInto("trial.trials")
      .values({
        id: trialId,
        tenant_id: tenantId,
        person_id: personId,
        lead_id: null,
        previous_trial_id: null,
        trial_kind: "TRIAL",
        retrial_reason: null,
        lifecycle_status: "REQUESTED",
        technical_outcome: "PENDING",
        requested_duration_minutes: 60,
        adult_content_enabled: false,
        provider_account_id: null,
        provider_binding_id: null,
        activated_at: null,
        expires_at: null,
        ended_at: null,
        invalidated_reason: null,
        created_at: now(),
        updated_at: now(),
      })
      .execute();
    await put("trial", "trial.trials", trialId);

    const subscriptionId = newId();
    await ownerDb
      .insertInto("subscription.subscriptions")
      .values({
        id: subscriptionId,
        tenant_id: tenantId,
        customer_id: customerId,
        plan_id: planId,
        originating_order_id: null,
        status: "PENDING_ACTIVATION",
        started_at: null,
        current_period_start: null,
        current_period_end: null,
        cancel_at_period_end: false,
        cancelled_at: null,
        created_at: now(),
        updated_at: now(),
      })
      .execute();
    await put("subscription", "subscription.subscriptions", subscriptionId);

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
        gross_amount_minor: "0",
        discount_amount_minor: "0",
        reward_amount_minor: "0",
        net_amount_minor: "0",
        settled_amount_minor: "0",
        created_at: now(),
        awaiting_payment_at: null,
        settled_at: null,
        cancelled_at: null,
        expires_at: null,
      })
      .execute();
    await put("commerce", "commerce.orders", orderId);

    const accountId = newId();
    await ownerDb
      .insertInto("provider.provider_accounts")
      .values({
        id: accountId,
        tenant_id: tenantId,
        provider_id: matrixProviderId,
        name: `Matrix Account ${tag}`,
        status: "ACTIVE",
        secret_ref: "matrix-ref",
        settings_json: {},
        last_recharge_at: null,
        created_at: now(),
        updated_at: now(),
      })
      .execute();
    await put("provider", "provider.provider_accounts", accountId);
    const operationId = newId();
    await ownerDb
      .insertInto("provider.provider_operations")
      .values({
        id: operationId,
        tenant_id: tenantId,
        provider_account_id: accountId,
        action: "custom.ping",
        entity_type: "trial",
        entity_id: newId(),
        status: "REQUESTED",
        idempotency_key: `mx-${tag}-${short()}`,
        execution_channel: null,
        adapter_version: null,
        requested_payload_json: {},
        result_summary_json: null,
        requested_at: now(),
        started_at: null,
        completed_at: null,
        correlation_id: newId(),
        effect_certainty: "UNKNOWN",
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        dispatch_started_at: null,
      })
      .execute();
    matrixOperationIds[tag] = operationId;

    const incidentId = newId();
    await ownerDb
      .insertInto("support.incidents")
      .values({
        id: incidentId,
        tenant_id: tenantId,
        status: "DETECTED",
        severity: "MEDIUM",
        provider_account_id: null,
        server_key: null,
        service_key: null,
        title: `matrix ${tag}`,
        summary: null,
        detected_at: now(),
        confirmed_at: null,
        resolved_at: null,
        created_at: now(),
        updated_at: now(),
      })
      .execute();
    await put("support", "support.incidents", incidentId);

    const itemId = newId();
    await ownerDb
      .insertInto("knowledge.knowledge_items")
      .values({
        id: itemId,
        tenant_id: tenantId,
        status: "DISCOVERED",
        knowledge_type: "FACT",
        canonical_key: null,
        current_version_id: null,
        confidence_score: null,
        freshness_score: null,
        created_at: now(),
        updated_at: now(),
      })
      .execute();
    await put("knowledge", "knowledge.knowledge_items", itemId);

    const programId = newId();
    await ownerDb
      .insertInto("referral.referral_programs")
      .values({
        id: programId,
        tenant_id: tenantId,
        name: `Matrix ${tag}`,
        status: "ACTIVE",
        rules_version: "v1",
        rules_json: {},
        starts_at: now(),
        ends_at: null,
        created_at: now(),
        updated_at: now(),
      })
      .execute();
    const referralId = newId();
    await ownerDb
      .insertInto("referral.referrals")
      .values({
        id: referralId,
        tenant_id: tenantId,
        program_id: programId,
        advocate_customer_id: customerId,
        referred_person_id: null,
        referral_code: `MX-${tag}-${short()}`.toUpperCase(),
        status: "CREATED",
        source_context: null,
        created_at: now(),
        attributed_at: null,
        confirmed_at: null,
        expired_at: null,
        reversed_at: null,
      })
      .execute();
    await put("referral", "referral.referrals", referralId);

    const partnerId = newId();
    await ownerDb
      .insertInto("partners.partner_accounts")
      .values({
        id: partnerId,
        tenant_id: tenantId,
        display_name: `Matrix ${tag}`,
        account_type: "SERVICE_RESELLER",
        status: "ACTIVE",
        linked_tenant_id: null,
        created_at: now(),
        updated_at: now(),
      })
      .execute();
    await put("partners", "partners.partner_accounts", partnerId);

    const snapshotId = newId();
    await ownerDb
      .insertInto("analytics.metric_snapshots")
      .values({
        id: snapshotId,
        tenant_id: tenantId,
        metric_key: "matrix_probe",
        bucket_start: now(),
        granularity: "DAY",
        value_json: {},
        value_minor: "1",
        computed_at: now(),
        data_quality: "OK",
      })
      .execute();
    await put("analytics", "analytics.metric_snapshots", snapshotId);

    const campaignId = newId();
    await ownerDb
      .insertInto("growth.campaigns")
      .values({
        id: campaignId,
        tenant_id: tenantId,
        campaign_key: `mx-${tag}-${short()}`,
        name: `Matrix ${tag}`,
        objective: null,
        status: "DRAFT",
        current_version_id: null,
        created_at: now(),
        updated_at: now(),
      })
      .execute();
    await put("growth", "growth.campaigns", campaignId);

    const reviewId = newId();
    await ownerDb
      .insertInto("agent.human_review_requests")
      .values({
        id: reviewId,
        tenant_id: tenantId,
        status: "REQUESTED",
        review_mode: "APPROVAL",
        reason: "OTHER",
        risk_class: "R1",
        priority: "NORMAL",
        resource_type: "trial",
        resource_id: trialId,
        requested_by_type: "system",
        requested_by_id: null,
        assigned_to_user_id: null,
        summary: `matrix probe ${tag}`,
        context_json: {},
        sla_due_at: null,
        escalation_policy: null,
        created_at: now(),
        resolved_at: null,
      })
      .execute();
    matrixReviewIds[tag] = reviewId;
  }

  beforeAll(async () => {
    const base = connectionString as string;
    adminDb = createDb({ connectionString: withDatabase(base, "postgres") });
    databaseName = `p1exit_ab_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(databaseName)) {
      throw new Error("unsafe generated scratch database name");
    }
    await sql.raw(`CREATE DATABASE "${databaseName}"`).execute(adminDb);
    const dedicatedUrl = withDatabase(base, databaseName);
    await applyMigrations(dedicatedUrl, { migrationsDir: MIGRATIONS_DIR });
    ownerDb = createDb({ connectionString: dedicatedUrl });
    const appPassword = `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
    if (!/^[0-9a-f]{16,}$/.test(appPassword)) {
      throw new Error("unsafe generated app password");
    }
    await sql.raw(`ALTER ROLE iptv_app WITH LOGIN PASSWORD '${appPassword}'`).execute(ownerDb);
    const appUrl = withAppIdentity(dedicatedUrl, appPassword);
    appDb = createDb({ connectionString: appUrl });

    process.env["DATABASE_URL"] = dedicatedUrl;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    process.env["APP_DATABASE_URL"] = "";
    ownerApp = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(ownerApp);
    await ownerApp.init();

    process.env["APP_DATABASE_URL"] = appUrl;
    expect(resolveAppConnectionString()).toBe(appUrl);
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();

    const regA = await ownerApp.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("mxa"), password: "correct-horse-8", tenantName: "Matrix Tenant A" },
    });
    expect(regA.statusCode).toBe(201);
    const bodyA = regA.json<{ token: string; activeTenantId: string }>();
    tokenA = bodyA.token;
    tenantA = bodyA.activeTenantId;

    const regB = await ownerApp.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("mxb"), password: "correct-horse-8", tenantName: "Matrix Tenant B" },
    });
    expect(regB.statusCode).toBe(201);
    const bodyB = regB.json<{ token: string; activeTenantId: string }>();
    tokenB = bodyB.token;
    tenantB = bodyB.activeTenantId;
    expect(tenantB).not.toBe(tenantA);

    matrixProviderId = newId();
    await ownerDb
      .insertInto("provider.providers")
      .values({
        id: matrixProviderId,
        provider_key: `mx-provider-${short()}`,
        name: "Matrix Provider",
        provider_type: "MATRIX",
        status: "ACTIVE",
        created_at: new Date(),
      })
      .execute();

    await seedTenant(tenantA, "a");
    await seedTenant(tenantB, "b");
  }, 180_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await ownerApp?.close().catch(() => undefined);
    for (const target of [app, ownerApp]) {
      try {
        const poolDb = target?.get("DB") as Kysely<Database> | null | undefined;
        await poolDb?.destroy();
      } catch {
        // Best-effort teardown only.
      }
    }
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

  it("effective pool identity is iptv_app with no bypass and no ownership (REAL)", async () => {
    const who = await sql<{ u: string; su: string; is_superuser: string }>`
      SELECT current_user AS u, session_user AS su, current_setting('is_superuser') AS is_superuser
    `.execute(appDb);
    expect(who.rows[0]?.u).toBe("iptv_app");
    expect(who.rows[0]?.su).toBe("iptv_app");
    expect(who.rows[0]?.is_superuser).toBe("off");
    const role = await sql<{ rolbypassrls: boolean }>`
      SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app'
    `.execute(ownerDb);
    expect(role.rows[0]?.rolbypassrls).toBe(false);
  });

  const domains = [
    "billing",
    "finance",
    "trial",
    "subscription",
    "commerce",
    "provider",
    "support",
    "knowledge",
    "referral",
    "partners",
    "analytics",
    "growth",
  ] as const;

  for (const domain of domains) {
    it(`${domain}: own rows visible, cross-tenant invisible, no context fail-closed (REAL)`, async () => {
      const slot = anchors.get(domain);
      expect(slot).toBeDefined();
      const { table, idA, idB } = slot as { table: string; idA: string; idB: string };
      expect(idA).not.toBe("");
      expect(idB).not.toBe("");

      async function idsUnder(ctxTenant: string, rowTenant: string): Promise<string[]> {
        const res = await withTenantTransaction(appDb, ctxTenant, async (trx) => {
          const out = await sql<{ id: string }>`
            SELECT id::text AS id FROM ${sql.ref(table)} WHERE tenant_id = ${rowTenant}
          `.execute(trx);
          return out.rows.map((r) => r.id);
        });
        return res;
      }
      async function idsWithoutContext(rowTenant: string): Promise<string[]> {
        const out = await sql<{ id: string }>`
          SELECT id::text AS id FROM ${sql.ref(table)} WHERE tenant_id = ${rowTenant}
        `.execute(appDb);
        return out.rows.map((r) => r.id);
      }

      // Próprias visíveis.
      expect(await idsUnder(tenantA, tenantA)).toContain(idA);
      expect(await idsUnder(tenantB, tenantB)).toContain(idB);
      // Cruzadas invisíveis/negadas.
      expect(await idsUnder(tenantA, tenantB)).not.toContain(idB);
      expect(await idsUnder(tenantB, tenantA)).not.toContain(idA);
      // Sem contexto = fail-closed.
      expect(await idsWithoutContext(tenantA)).toHaveLength(0);
      expect(await idsWithoutContext(tenantB)).toHaveLength(0);
    });
  }

  it("provider queue wrap: own operations visible, cross-tenant absent over HTTP (REAL)", async () => {
    const unauth = await injectRaw(app, { method: "GET", url: "/v1/provider/operations" });
    expect(unauth.statusCode).toBe(401);

    const resA = await injectRaw(app, { method: "GET", url: "/v1/provider/operations", token: tokenA });
    expect(resA.statusCode).toBe(200);
    const idsA = resA.json<{ operations: Array<{ id: string }> }>().operations.map((o) => o.id);
    expect(idsA).toContain(matrixOperationIds["a"]);
    expect(idsA).not.toContain(matrixOperationIds["b"]);

    const resB = await injectRaw(app, { method: "GET", url: "/v1/provider/operations", token: tokenB });
    expect(resB.statusCode).toBe(200);
    const idsB = resB.json<{ operations: Array<{ id: string }> }>().operations.map((o) => o.id);
    expect(idsB).toContain(matrixOperationIds["b"]);
    expect(idsB).not.toContain(matrixOperationIds["a"]);
  });

  it("human-review queue wrap: own reviews visible, cross-tenant absent over HTTP (REAL)", async () => {
    const resA = await injectRaw(app, { method: "GET", url: "/v1/human-reviews", token: tokenA });
    expect(resA.statusCode).toBe(200);
    const idsA = resA.json<{ reviews: Array<{ id: string }> }>().reviews.map((r) => r.id);
    expect(idsA).toContain(matrixReviewIds["a"]);
    expect(idsA).not.toContain(matrixReviewIds["b"]);

    const resB = await injectRaw(app, { method: "GET", url: "/v1/human-reviews", token: tokenB });
    expect(resB.statusCode).toBe(200);
    const idsB = resB.json<{ reviews: Array<{ id: string }> }>().reviews.map((r) => r.id);
    expect(idsB).toContain(matrixReviewIds["b"]);
    expect(idsB).not.toContain(matrixReviewIds["a"]);
  });

  it("finance overview wrap: per-tenant month cost read through under iptv_app (REAL)", async () => {
    const resA = await injectRaw(app, { method: "GET", url: "/v1/metrics/overview", token: tokenA });
    expect(resA.statusCode).toBe(200);
    const bodyA = resA.json<{ monthCostMinor: string; dataQuality: string }>();
    // Sem o wrap, o select falharia-fechado e devolveria "0".
    expect(bodyA.monthCostMinor).toBe("100");
    expect(bodyA.dataQuality).toBe("OK");

    const resB = await injectRaw(app, { method: "GET", url: "/v1/metrics/overview", token: tokenB });
    expect(resB.statusCode).toBe(200);
    expect(resB.json<{ monthCostMinor: string }>().monthCostMinor).toBe("200");
  });
});
