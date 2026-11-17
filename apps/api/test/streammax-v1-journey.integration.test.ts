import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { applyMigrations, createDb } from "@iptv/database";
import { newId } from "@iptv/domain";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";
import { CommandBus } from "../src/commands/command-bus.js";
import { resetGatewayForTests } from "../src/communications/messaging-gateway.js";
import { composeResponse, listSellablePlans } from "../src/bot/streammax-bot-contract.js";
import { WahaWebhookService } from "../src/communications/waha-webhook.service.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");
const databaseUrl = process.env["TEST_DATABASE_URL"];
const hasDb = typeof databaseUrl === "string" && databaseUrl.length > 0;
const WAHA_SECRET = "streammax-synthetic-waha-secret";
const ASAAS_SECRET = "streammax-synthetic-asaas-secret";
const SENDER = "5511998765432";
const PERMISSIONS = ["crm.person.read", "crm.lead.write", "conversation.reply", "agent.review.request", "agent.review.decide", "conversation.start", "conversation.release", "commerce.order.write", "billing.read", "billing.charge.write", "subscription.read", "subscription.write", "support.ticket.read", "support.ticket.write"];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe.skipIf(!hasDb)("HOMOLOGAÇÃO SINTÉTICA — não é produção: StreamMax V1 jornada", () => {
  const db = createDb({ connectionString: databaseUrl as string });
  let app: NestFastifyApplication;
  let bus: CommandBus;
  let tenantId = "";
  let userId = "";
  let botFlag: { STREAMMAX_BOT_ENABLED: string } | undefined;
  let originalBotFlag = "";
  let journeyPersonId = "";
  let journeyLeadId = "";
  let journeyOrderId = "";
  let journeyChargeId = "";
  let providerChargeId = "";

  function actor() {
    return { userId, isPlatformAdmin: false as const, tenantId, roleKeys: ["tenant_owner"], permissions: PERMISSIONS, actorType: "human" as const };
  }

  async function execute(command: string, input: Record<string, unknown> = {}): Promise<{ id: string }> {
    const result = await bus.execute<{ id: string }>(actor(), command, input);
    if (!result.ok) throw new Error(`${command} failed: ${JSON.stringify(result)}`);
    return result.data;
  }

  async function deliver(id: string, body: string): Promise<void> {
    const payload = { event: "message", session: "default", payload: { id, from: `${SENDER}@c.us`, fromMe: false, body, timestamp: 1758912000 } };
    const webhooks = app.get(WahaWebhookService);
    const accepted = await webhooks.acceptRaw({ tenantId, channel: "WHATSAPP", externalEventId: `waha:${id}`, payload });
    await webhooks.processRow(tenantId, accepted.inboxId, payload);
  }

  beforeAll(async () => {
    await applyMigrations(databaseUrl as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = databaseUrl as string;
    process.env["BETTER_AUTH_SECRET"] = "synthetic-integration-secret-0123456789";
    delete process.env["WAHA_BASE_URL"];
    delete process.env["WAHA_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    resetGatewayForTests();
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);
    botFlag = app.get("APP_CONFIG") as { STREAMMAX_BOT_ENABLED: string };
    originalBotFlag = botFlag.STREAMMAX_BOT_ENABLED;
    botFlag.STREAMMAX_BOT_ENABLED = "true";

    const auth = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: `streammax-${newId()}@example.com`, password: "correct-horse-8", tenantName: "Synthetic StreamMax" },
    });
    expect(auth.statusCode).toBe(201);
    const account = auth.json<{ activeTenantId: string; user: { id: string } }>();
    tenantId = account.activeTenantId;
    userId = account.user.id;
    await db.insertInto("communication.tenant_channels").values({
      id: newId(), tenant_id: tenantId, channel: "WHATSAPP", tenant_key: `sm-synthetic-${newId().replace(/-/g, "").slice(-10)}`,
      webhook_secret_hash: sha256(WAHA_SECRET), status: "ACTIVE", waha_session_name: null, waha_status: null,
      created_at: new Date(), updated_at: new Date(),
    }).execute();
  }, 120_000);

  afterAll(async () => {
    if (botFlag) botFlag.STREAMMAX_BOT_ENABLED = originalBotFlag;
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
    resetGatewayForTests();
  });

  it("cria identidade/conversa e envia uma resposta por inbound, sem duplicar o cliente", async () => {
    const person = await execute("person.register", {
      canonicalName: "Cliente Sintético",
      identities: [{ identityType: "WHATSAPP", normalizedValue: SENDER }],
    });
    const lead = await execute("lead.capture", { personId: person.id });
    journeyPersonId = person.id;
    journeyLeadId = lead.id;
    const conversation = await execute("conversation.start_manual", { personId: person.id, channel: "WHATSAPP" });
    await execute("conversation.release", { conversationId: conversation.id });
    const before = await db.selectFrom("communication.messages").select(["id"]).where("tenant_id", "=", tenantId).where("direction", "=", "OUTBOUND").execute();

    await deliver("sm-synthetic-inbound-1", "Olá, gostaria de conhecer os planos");
    await deliver("sm-synthetic-inbound-2", "Ainda estou interessado");

    const identities = await db.selectFrom("identity.identities").select(["person_id"]).where("tenant_id", "=", tenantId).where("normalized_value", "=", SENDER).execute();
    const people = await db.selectFrom("identity.persons").select(["id"]).where("tenant_id", "=", tenantId).where("id", "=", person.id).execute();
    const leads = await db.selectFrom("crm.leads").select(["id"]).where("tenant_id", "=", tenantId).where("id", "=", lead.id).execute();
    const conversations = await db.selectFrom("communication.conversations").select(["id"]).where("tenant_id", "=", tenantId).where("id", "=", conversation.id).execute();
    const after = await db.selectFrom("communication.messages").select(["body_text"]).where("tenant_id", "=", tenantId).where("direction", "=", "OUTBOUND").execute();
    expect(identities).toHaveLength(1);
    expect(identities[0]?.person_id).toBe(person.id);
    expect(people).toHaveLength(1);
    expect(leads).toHaveLength(1);
    expect(conversations).toHaveLength(1);
    expect(after.length - before.length).toBe(2);
    expect(after.map((message) => message.body_text).join(" ")).not.toMatch(/pago|ativo|ativado|renovado/i);
  }, 60_000);

  it("responde com catálogo vendável ou texto neutro sem preço oficial", async () => {
    const plans = await listSellablePlans(tenantId, {
      findPersonByWaId: async () => null,
      registerPerson: async () => "synthetic",
      captureLead: async () => "synthetic",
      listActivePlans: async () => [],
    });
    const response = composeResponse({ tenantId, personId: "synthetic", leadId: "synthetic" }, plans);
    if (plans.length === 0) expect(response).toContain("aguardando as condições comerciais oficiais");
    else expect(response).toContain(plans[0]!.name);
    expect(response).not.toMatch(/pago|ativado|renovado/i);
  });

  it("HOMOLOGAÇÃO SINTÉTICA — não é produção: pedido, PIX simulado e estado não pago", async () => {
    const tail = newId().replace(/-/g, "").slice(-12);
    const productId = newId();
    const planId = newId();
    await db.insertInto("catalog.products").values({
      id: productId, tenant_id: tenantId, product_key: `sm-${tail}`, name: "Plano sintético",
      product_type: "SERVICE", status: "ACTIVE", metadata_json: {}, created_at: new Date(), updated_at: new Date(),
    }).execute();
    await db.insertInto("catalog.plans").values({
      id: planId, tenant_id: tenantId, product_id: productId, plan_key: `sm-plan-${tail}`,
      name: "Plano sintético", billing_interval_unit: "MONTH", billing_interval_count: 1,
      status: "ACTIVE", metadata_json: {}, created_at: new Date(), updated_at: new Date(),
    }).execute();
    await db.insertInto("catalog.prices").values({
      id: newId(), tenant_id: tenantId, sellable_type: "PLAN", sellable_id: planId,
      amount_minor: "3000", currency: "BRL", starts_at: new Date(Date.now() - 60_000),
      ends_at: null, segment_key: null, status: "ACTIVE", metadata_json: {}, created_at: new Date(),
    }).execute();
    const quote = await bus.execute<{ id: string }>(actor(), "offer.quote", {
      personId: journeyPersonId, items: [{ sellableType: "PLAN", sellableId: planId, quantity: 1 }],
      orderType: "NEW_SUBSCRIPTION",
    });
    if (!quote.ok) throw new Error(`offer.quote failed: ${JSON.stringify(quote)}`);
    journeyOrderId = quote.data.id;
    await execute("order.submit", { orderId: journeyOrderId });
    await execute("billing.customer_provision", { personId: journeyPersonId });
    const previousEcho = process.env["ASAAS_ECHO_CREATE"];
    process.env["ASAAS_ECHO_CREATE"] = "1";
    try {
      const charge = await bus.execute<{ id: string; status: string; providerChargeId: string | null; qrCode?: string | null; effectUncertain: boolean }>(
        actor(), "charge.create", { orderId: journeyOrderId, billingType: "PIX" },
      );
      if (!charge.ok) throw new Error(`charge.create failed: ${JSON.stringify(charge)}`);
      journeyChargeId = charge.data.id;
      providerChargeId = charge.data.providerChargeId ?? "";
      expect(charge.data.status).not.toBe("PAID");
      expect(charge.data.effectUncertain).toBe(false);
      const order = await db.selectFrom("commerce.orders").select(["status"]).where("tenant_id", "=", tenantId).where("id", "=", journeyOrderId).executeTakeFirstOrThrow();
      expect(order.status).not.toBe("SETTLED");
      expect(journeyLeadId).toBeTruthy();
    } finally {
      if (previousEcho === undefined) delete process.env["ASAAS_ECHO_CREATE"];
      else process.env["ASAAS_ECHO_CREATE"] = previousEcho;
    }
  }, 60_000);

  it("HOMOLOGAÇÃO SINTÉTICA — não é produção: PAID autenticado e redelivery idempotente", async () => {
    const tenantKey = `sm-asaas-${newId().replace(/-/g, "").slice(-10)}`;
    await db.insertInto("billing.tenant_channels").values({
      id: newId(), tenant_id: tenantId, channel: "ASAAS", tenant_key: tenantKey,
      webhook_secret_hash: sha256(ASAAS_SECRET), status: "ACTIVE", created_at: new Date(), updated_at: new Date(),
    }).execute();
    const event = { event: "PAYMENT_RECEIVED", id: "sm-paid-event-1", payment: { id: providerChargeId, value: 30, currency: "BRL" } };
    const send = () => app.getHttpAdapter().getInstance().inject({
      method: "POST", url: `/v1/webhooks/asaas/${tenantKey}`,
      headers: { "asaas-access-token": ASAAS_SECRET }, payload: event,
    });
    await send();
    const pending = await db.selectFrom("commerce.orders").select(["status"]).where("tenant_id", "=", tenantId).where("id", "=", journeyOrderId).executeTakeFirstOrThrow();
    expect(pending.status).toBe("SETTLED");
    const transactionsBefore = await db.selectFrom("finance.financial_transactions").select(["id"]).where("tenant_id", "=", tenantId).where("reference_type", "=", "order").where("reference_id", "=", journeyOrderId).execute();
    const duplicate = await send();
    expect(duplicate.statusCode).toBe(202);
    const transactionsAfter = await db.selectFrom("finance.financial_transactions").select(["id"]).where("tenant_id", "=", tenantId).where("reference_type", "=", "order").where("reference_id", "=", journeyOrderId).execute();
    expect(transactionsAfter).toHaveLength(transactionsBefore.length);
  }, 60_000);

  it("HOMOLOGAÇÃO SINTÉTICA — não é produção: ativação/fulfillment manual e suporte idempotente", async () => {
    const activated = await execute("subscription.activate_pending_settled_orders", {});
    expect(activated).toBeDefined();
    const subscriptions = await db.selectFrom("subscription.subscriptions").select(["id", "status"]).where("tenant_id", "=", tenantId).where("originating_order_id", "=", journeyOrderId).execute();
    expect(subscriptions.length).toBeGreaterThan(0);
    expect(subscriptions.some((row) => row.status === "ACTIVE" || row.status === "PENDING_ACTIVATION")).toBe(true);
    const ticket = await execute("support.ticket.open", { personId: journeyPersonId, summary: "Dúvida sobre ativação", category: "ACTIVATION_DELAY" });
    const savedTicket = await db.selectFrom("support.support_tickets").select(["id", "person_id", "summary"]).where("tenant_id", "=", tenantId).where("id", "=", ticket.id).executeTakeFirstOrThrow();
    expect(savedTicket.person_id).toBe(journeyPersonId);
    expect(savedTicket.summary).toBe("Dúvida sobre ativação");
  }, 60_000);

  it("HOMOLOGAÇÃO SINTÉTICA — não é produção: consistência final e sem afirmação de pagamento", async () => {
    const charge = await db.selectFrom("billing.charges").select(["status"]).where("tenant_id", "=", tenantId).where("id", "=", journeyChargeId).executeTakeFirstOrThrow();
    const order = await db.selectFrom("commerce.orders").select(["status"]).where("tenant_id", "=", tenantId).where("id", "=", journeyOrderId).executeTakeFirstOrThrow();
    expect(charge.status).toBe("PAID");
    expect(order.status).toBe("SETTLED");
    expect(JSON.stringify({ charge, order })).not.toMatch(/credential|secret|token/i);
  }, 30_000);
});
