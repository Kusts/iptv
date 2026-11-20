import { Controller, HttpException, Inject, Post, Req, UseGuards, Header } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { Database } from "@iptv/database";
import { withTenantTransaction } from "@iptv/database";
import { loadConfig } from "@iptv/config";
import { CommandBus } from "../commands/command-bus.js";
import { listActiveSellablePlans } from "../commerce/catalog-queries.js";
import { botExecute, createStreamMaxBotDependencies, serializedForContact } from "./streammax-bot-adapter.js";
import { composeResponse, listSellablePlans, resolveOrCreateLead } from "./streammax-bot-contract.js";
import { BotServiceGuard } from "./bot-service.guard.js";
import { botServiceActor } from "./bot-service-actor.js";
import { getBotReplyEligibility, getOrderState, isDuplicateInbound } from "./streammax-bot-queries.js";
import { APPROVED_CATALOG, type ApprovedPlanPeriod } from "../commerce/approved-catalog.js";
import { evaluateEligibility, mergePolicyRows, parseEligibilityPolicy, ELIGIBILITY_FAMILY } from "../trial/trial-policy.js";
import { readFulfillmentStatus } from "../fulfillment/fulfillment-queries.js";

const base = {
  messageId: z.string().trim().min(1).max(320),
  requestedAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(1).max(200),
};
const listSchema = z.object(base).strict();
const leadSchema = z.object({ ...base, waId: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(200).optional() }).strict();
const replySchema = z.object({
  ...base,
  conversationId: z.string().uuid(),
  inboundText: z.string().min(1).max(4000),
  waId: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(200).optional(),
}).strict();
const quoteSchema = z.object({
  ...base, personId: z.string().uuid(), planId: z.string().uuid(),
  addonQuantity: z.number().int().min(0).max(1000).optional(),
  periodicityMonths: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]).optional(),
}).strict();
const createOrderSchema = z.object({ ...base, personId: z.string().uuid(), quoteId: z.string().uuid() }).strict();
const personSchema = z.object({ ...base, personId: z.string().uuid() }).strict();
const fulfillmentSchema = z.object({ ...base, subscriptionId: z.string().uuid() }).strict();
const getChargeSchema = z.object({ ...base, personId: z.string().uuid(), orderId: z.string().uuid() }).strict();
const ticketSchema = z.object({ ...base, personId: z.string().uuid(), kind: z.enum(["TECHNICAL", "BILLING", "GENERAL"]), summary: z.string().trim().min(1).max(1800) }).strict();
const getTicketSchema = z.object({ ...base, personId: z.string().uuid(), ticketId: z.string().uuid() }).strict();
const renewSchema = z.object({ ...base, personId: z.string().uuid(), quoteId: z.string().uuid() }).strict();

@Controller("v1/bot/streammax")
@UseGuards(BotServiceGuard)
export class BotServiceController {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject(CommandBus) private readonly bus: CommandBus,
  ) {}

  private context(req: FastifyRequest) {
    if (!this.db || !req.botService) throw new HttpException("unavailable", 503);
    const tenantId = req.botService.tenantId;
    return { db: this.db, tenantId, deps: createStreamMaxBotDependencies(this.db, this.bus), actor: botServiceActor(req.botService) };
  }

  private parse<T>(schema: z.ZodType<T>, body: unknown): T {
    if (body && typeof body === "object" && ["tenantId", "tenant_id", "tenant"].some((key) => key in body)) {
      throw new HttpException("invalid request", 400);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new HttpException("invalid request", 400);
    return parsed.data;
  }

  @Post("list-plans")
  @Header("Cache-Control", "no-store")
  async listPlans(@Req() req: FastifyRequest) {
    this.parse(listSchema, req.body);
    const { db, tenantId } = this.context(req);
    const plans = await listActiveSellablePlans(db, tenantId);
    const addon = await withTenantTransaction(db, tenantId, (trx) => trx.selectFrom("catalog.addons as a")
      .leftJoin("catalog.prices as pr", (join) => join.onRef("pr.sellable_id", "=", "a.id").on("pr.sellable_type", "=", "ADDON")
        .on("pr.status", "=", "ACTIVE").onRef("pr.tenant_id", "=", "a.tenant_id"))
      .select(["a.id as sellableId", "pr.segment_key as segmentKey", "pr.amount_minor as amountMinor", "pr.currency"])
      .where("a.tenant_id", "=", tenantId).where("a.addon_key", "=", "additional-connection")
      .where("a.status", "=", "ACTIVE").execute());
    const segmentMonths = { P1M: 1, P3M: 3, P6M: 6, P12M: 12 } as const;
    const addonId = addon[0]?.sellableId ?? "additional-connection";
    return {
      plans: plans.filter((p) => p.price).map((p) => ({
        planId: p.planId, name: p.name, amountMinor: p.price!.amountMinor.toString(), currency: p.price!.currency,
        periodMonths: Number(p.billingIntervalCount) * (p.billingIntervalUnit === "YEAR" ? 12 : 1),
      })),
      addons: (Object.entries(APPROVED_CATALOG.additionalScreen) as [ApprovedPlanPeriod, { amountMinor: number; currency: string }][])
        .map(([segmentKey, price]) => ({
          sellableId: addonId, segmentKey, periodMonths: segmentMonths[segmentKey],
          amountMinor: String(price.amountMinor), currency: price.currency,
          executable: addon.some((row) => row.segmentKey === segmentKey && row.amountMinor !== null &&
            String(row.amountMinor) === String(price.amountMinor) && row.currency === price.currency),
          source: addon.some((row) => row.segmentKey === segmentKey && row.amountMinor !== null &&
            String(row.amountMinor) === String(price.amountMinor) && row.currency === price.currency)
            ? "catalog.prices (matches approved-catalog V1.0)" : "approved-catalog V1.0 (reference only)",
        })),
      catalog: {
        version: APPROVED_CATALOG.metadata.version, approvedAt: APPROVED_CATALOG.metadata.approvedAt,
        source: "docs/01-product/CATALOGO-COMERCIAL.md",
        operationalCatalogLoaded: addon.some((row) => row.segmentKey === "P1M" && row.amountMinor !== null),
        message: "Preços de adicionais são referência até carga operacional autorizada em M4.",
      },
    };
  }

  @Post("quote")
  @Header("Cache-Control", "no-store")
  async quote(@Req() req: FastifyRequest) {
    const input = this.parse(quoteSchema, req.body);
    const { tenantId, actor } = this.context(req);
    const period = input.periodicityMonths === undefined ? undefined : `P${input.periodicityMonths}M`;
    const items: Array<{ sellableType: "PLAN" | "ADDON"; sellableId: string; quantity: number; segmentKey?: string }> = [
      { sellableType: "PLAN", sellableId: input.planId, quantity: 1 },
    ];
    if ((input.addonQuantity ?? 0) > 0) {
      if (!period) throw new HttpException("periodicityMonths required for addon", 400);
      const addons = await withTenantTransaction(this.db!, tenantId, (trx) => trx.selectFrom("catalog.addons")
        .select("id").where("tenant_id", "=", tenantId).where("addon_key", "=", "additional-connection")
        .where("status", "=", "ACTIVE").executeTakeFirst());
      if (!addons) throw new HttpException({ code: "catalog_price_unavailable" }, 409);
      items.push({ sellableType: "ADDON", sellableId: addons.id, quantity: input.addonQuantity!, segmentKey: period });
    }
    const result = await botExecute<{ id: string; netAmountMinor: string; currency: string }>(
      this.bus, tenantId, "offer.quote", { personId: input.personId, items }, { idempotencyKey: `bot-api:quote:${input.idempotencyKey}` }, actor,
    );
    if (!result.ok) {
      const unavailable = /no active.*catalog price/i.test(result.message);
      throw new HttpException({ code: unavailable ? "catalog_price_unavailable" : result.code, message: result.message }, unavailable ? 409 : 400);
    }
    return { quoteId: result.data.id, amountMinor: result.data.netAmountMinor, currency: result.data.currency, early: false };
  }

  @Post("create-order")
  @Header("Cache-Control", "no-store")
  async createOrder(@Req() req: FastifyRequest) {
    const input = this.parse(createOrderSchema, req.body);
    const { tenantId, actor } = this.context(req);
    const quote = await withTenantTransaction(this.db!, tenantId, (trx) => trx.selectFrom("commerce.orders")
      .select(["id", "person_id as personId"]).where("tenant_id", "=", tenantId).where("id", "=", input.quoteId).executeTakeFirst());
    if (!quote || quote.personId !== input.personId) throw new HttpException({ code: "not_found", message: "quote not found for person" }, 404);
    const submitted = await botExecute<{ id: string }>(this.bus, tenantId, "order.submit", { orderId: input.quoteId }, { idempotencyKey: `bot-api:submit:${input.quoteId}` }, actor);
    if (!submitted.ok) throw new HttpException({ code: submitted.code, message: submitted.message }, 409);
    const provision = await botExecute<{ id: string }>(this.bus, tenantId, "billing.customer_provision", { personId: input.personId }, { idempotencyKey: `bot-api:customer:${input.personId}` }, actor);
    if (!provision.ok) throw new HttpException({ code: provision.code, message: provision.message }, 409);
    const charge = await botExecute<{ id: string; qrCode?: string | null; effectUncertain: boolean }>(
      this.bus, tenantId, "charge.create", { orderId: input.quoteId, billingType: "PIX" }, { idempotencyKey: `bot-api:charge:${input.quoteId}` }, actor,
    );
    if (!charge.ok) throw new HttpException({ code: charge.code, message: charge.message }, 409);
    return { orderId: input.quoteId, chargeId: charge.data.id, qrCode: charge.data.effectUncertain ? null : charge.data.qrCode ?? null, effectUncertain: charge.data.effectUncertain, status: submitted.data.id ? "AWAITING_PAYMENT" : "pending" };
  }

  @Post("resolve-lead")
  @Header("Cache-Control", "no-store")
  async resolveLead(@Req() req: FastifyRequest) {
    const input = this.parse(leadSchema, req.body);
    const { tenantId, deps, actor } = this.context(req);
    const result = await serializedForContact(tenantId, input.waId, async () => {
      const root = `bot-api:lead:${tenantId}:${input.idempotencyKey}`;
      const originalRegister = deps.registerPersonUnlocked;
      const originalCapture = deps.captureLeadUnlocked;
      const originalConversation = deps.ensureConversation;
      const originalFind = deps.findPersonByWaId;
      const existingBeforeRegister = await originalFind(tenantId, input.waId);
      if (existingBeforeRegister) {
        const priorClaim = await withTenantTransaction(this.db!, tenantId, (trx) =>
          trx.selectFrom("platform.idempotency_keys").select("idempotency_key")
            .where("tenant_id", "=", tenantId).where("scope", "=", "person.register")
            .where("idempotency_key", "=", `${root}:person`).executeTakeFirst());
        if (priorClaim) {
          const claim = await botExecute<{ id: string }>(this.bus, tenantId, "person.register", {
            canonicalName: input.name,
            identities: [{ identityType: "WHATSAPP", normalizedValue: input.waId.replace(/\D/g, "") }],
          }, { idempotencyKey: `${root}:person` }, actor);
          if (!claim.ok && claim.code !== "precondition_failed") {
            throw new HttpException("conflict", 409);
          }
        }
        const leadId = existingBeforeRegister.leadId ?? await originalCapture!(tenantId, existingBeforeRegister.personId);
        return { personId: existingBeforeRegister.personId, leadId, isNew: false };
      }
      // Always claim/check the request-scoped key first, preserving payload
      // conflict detection; a precondition failure can instead mean identity exists.
      deps.findPersonByWaId = async (_tenant, waId) => {
        const claim = await botExecute<{ id: string }>(this.bus, tenantId, "person.register", {
          canonicalName: input.name,
          identities: [{ identityType: "WHATSAPP", normalizedValue: waId.replace(/\D/g, "") }],
        }, { idempotencyKey: `${root}:person` }, actor);
        if (claim.ok) return null;
        if (claim.code === "precondition_failed") return originalFind(tenantId, waId);
        throw Object.assign(new Error(claim.message), { commandCode: claim.code });
      };
      deps.registerPersonUnlocked = async (contact) => {
        const normalized = contact.waId.replace(/\D/g, "");
        let created;
        try {
          created = await botExecute<{id:string}>(this.bus, tenantId, "person.register", {
            canonicalName: contact.name, identities: [{ identityType: "WHATSAPP", normalizedValue: normalized }],
          }, { idempotencyKey: `${root}:person` }, actor);
        } catch (error) {
          const raced = await originalFind(tenantId, contact.waId);
          if (raced) return raced.personId;
          throw error;
        }
        if (!created.ok && created.code !== "precondition_failed") throw Object.assign(new Error(created.message), { commandCode: created.code });
        if (!created.ok) {
          const existing = await originalFind(tenantId, contact.waId);
          if (!existing) throw Object.assign(new Error(created.message), { commandCode: created.code });
          return existing.personId;
        }
        return created.data.id;
      };
      deps.captureLeadUnlocked = async (_tenant, personId) => {
        return originalCapture!(tenantId, personId);
      };
      deps.ensureConversation = async (_tenant, personId, options) => {
        if (options?.release === false) return;
        const started = await botExecute<{id:string}>(this.bus, tenantId, "conversation.start_manual", { personId, channel: "WHATSAPP" }, { idempotencyKey: `${root}:conversation` }, actor);
        if (!started.ok && started.code !== "precondition_failed") throw Object.assign(new Error(started.message), { commandCode: started.code });
        const conversation = await (async () => {
          const { db } = this.context(req);
          return withTenantTransaction(db, tenantId, (trx) =>
            trx.selectFrom("communication.conversations").select(["id", "control_mode as controlMode"])
              .where("tenant_id", "=", tenantId).where("person_id", "=", personId)
              .where("channel", "=", "WHATSAPP").where("status", "=", "OPEN")
              .orderBy("created_at", "desc").executeTakeFirst());
        })();
        // Only release a conversation just created by this bot; existing HUMAN_CONTROL
        // may represent an intentional human takeover and must remain untouched.
        if (started.ok && conversation?.controlMode === "HUMAN_CONTROL") {
          const released = await botExecute(this.bus, tenantId, "conversation.release", { conversationId: conversation.id },
            { idempotencyKey: `${root}:conversation-release` }, actor);
          if (!released.ok) throw Object.assign(new Error(released.message), { commandCode: released.code });
        }
      };
      try { return await resolveOrCreateLead({ tenantId, waId: input.waId, name: input.name }, deps); }
      catch (error) {
        if (error && typeof error === "object" && "commandCode" in error &&
            ["validation_failed", "precondition_failed", "conflict"].includes(String(error.commandCode))) {
          throw new HttpException("conflict", 409);
        }
        throw error;
      } finally {
        deps.registerPersonUnlocked = originalRegister;
        deps.captureLeadUnlocked = originalCapture;
        deps.ensureConversation = originalConversation;
        deps.findPersonByWaId = originalFind;
      }
    });
    return result;
  }

  @Post("reply")
  @Header("Cache-Control", "no-store")
  async reply(@Req() req: FastifyRequest) {
    const input = this.parse(replySchema, req.body);
    const { db, tenantId } = this.context(req);
    if (loadConfig().STREAMMAX_BOT_ENABLED === "true") return { handled: false, sent: false, reason: "flag_off" };
    const eligibility = await getBotReplyEligibility(db, tenantId, input.conversationId);
    if (eligibility !== "eligible") return { handled: true, sent: false, reason: eligibility };
    if (await isDuplicateInbound(db, tenantId, input.messageId)) return { handled: true, sent: false, reason: "duplicate" };
    const plans = await listSellablePlans(tenantId, createStreamMaxBotDependencies(db, this.bus));
    return { handled: true, text: composeResponse({ tenantId, personId: "", leadId: "" }, plans), sent: false };
  }

  @Post("get-charge")
  @Header("Cache-Control", "no-store")
  async getCharge(@Req() req: FastifyRequest) {
    const input = this.parse(getChargeSchema, req.body);
    const { db, tenantId } = this.context(req);
    let state;
    try { state = await getOrderState(db, tenantId, input.personId, input.orderId); }
    catch (error) {
      if (error instanceof Error && error.message === "order not found") {
        throw new HttpException({ code: "not_found" }, 404);
      }
      throw new HttpException({ code: "unavailable" }, 503);
    }
    return {
      personId: input.personId, orderId: input.orderId,
      order: state.order ? { ...state.order, netAmountMinor: state.order.netAmountMinor.toString() } : null,
      charge: state.charge ? { chargeId: state.charge.chargeId, status: state.charge.status } : null,
      settled: state.settled, pix: null,
    };
  }

  @Post("get-subscription")
  @Header("Cache-Control", "no-store")
  async getSubscription(@Req() req: FastifyRequest) {
    const input = this.parse(personSchema, req.body);
    const { db, tenantId } = this.context(req);
    const subscription = await withTenantTransaction(db, tenantId, (trx) => trx.selectFrom("subscription.subscriptions as s")
      .innerJoin("crm.customers as c", (join) => join.onRef("c.tenant_id", "=", "s.tenant_id").onRef("c.id", "=", "s.customer_id"))
      .select(["s.id as subscriptionId", "s.status", "s.current_period_start as currentPeriodStart", "s.current_period_end as currentPeriodEnd"])
      .where("s.tenant_id", "=", tenantId).where("c.person_id", "=", input.personId)
      .orderBy("s.created_at", "desc").executeTakeFirst());
    return subscription ? {
      personId: input.personId, subscriptionId: subscription.subscriptionId, status: subscription.status,
      currentPeriodStart: subscription.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null, projectedState: null,
    } : { personId: input.personId, subscription: null };
  }

  /**
   * Read-only projection of the existing human fulfillment read. Same tenant
   * derivation (credential, never body), same sanitized columns, no command
   * bus and no new actor permission: the bot cannot resolve or reconcile a
   * provider operation, it can only observe its current state.
   */
  @Post("get-fulfillment")
  @Header("Cache-Control", "no-store")
  async getFulfillment(@Req() req: FastifyRequest) {
    const input = this.parse(fulfillmentSchema, req.body);
    const { db, tenantId } = this.context(req);
    const view = await readFulfillmentStatus(db, tenantId, input.subscriptionId);
    if (view === null) {
      throw new HttpException({ code: "NOT_FOUND", message: "no fulfillment operation for this subscription" }, 404);
    }
    return view;
  }

  @Post("get-trial")
  @Header("Cache-Control", "no-store")
  async getTrial(@Req() req: FastifyRequest) {
    const input = this.parse(personSchema, req.body);
    const { db, tenantId } = this.context(req);
    let trials: Array<{ id: string; trialKind: string; lifecycleStatus: string; technicalOutcome: string; requestedDurationMinutes: number | string; activatedAt: Date | null; expiresAt: Date | null }>;
    let policyRows;
    try {
      [trials, policyRows] = await withTenantTransaction(db, tenantId, async (trx) => Promise.all([trx.selectFrom("trial.trials")
      .select(["id", "trial_kind as trialKind", "lifecycle_status as lifecycleStatus",
        "technical_outcome as technicalOutcome", "requested_duration_minutes as requestedDurationMinutes", "activated_at as activatedAt", "expires_at as expiresAt"])
      .where("tenant_id", "=", tenantId).where("person_id", "=", input.personId)
      .orderBy("created_at", "desc").execute(),
      trx.selectFrom("platform.policy_documents").select(["id", "tenant_id as tenantId", "family", "scope", "class", "version", "status", "document", "published_at as publishedAt"])
      .where("family", "=", ELIGIBILITY_FAMILY).where("status", "=", "PUBLISHED")
      .where((eb) => eb.or([eb.and([eb("scope", "=", "PLATFORM"), eb("tenant_id", "is", null)]), eb.and([eb("scope", "=", "TENANT"), eb("tenant_id", "=", tenantId)])]))
        .orderBy("version", "desc").execute()]));
    } catch {
      return {
        personId: input.personId, durationHours: APPROVED_CATALOG.trial.durationHours,
        usesPerUser: APPROVED_CATALOG.trial.usesPerUser, trials: [],
        eligibilityComputed: false, eligible: null, reason: "ELIGIBILITY_DATA_UNAVAILABLE",
      };
    }
    let evaluation: ReturnType<typeof evaluateEligibility>;
    try {
      const previous = trials.find((trial) => trial.trialKind === "TRIAL");
      const hasTechnicalException = previous?.lifecycleStatus === "INVALIDATED" && previous.technicalOutcome === "FAILED";
      const policy = parseEligibilityPolicy(mergePolicyRows(policyRows as never).document);
      evaluation = !policy.durationsMinutes.includes(APPROVED_CATALOG.trial.durationHours * 60)
        ? { outcome: "DENY" as const, reasonCodes: ["TRIAL_DURATION_NOT_ALLOWED"] }
        : evaluateEligibility(policy, {
          hasPrimary: trials.some((trial) => trial.trialKind === "TRIAL") && !hasTechnicalException,
          hasOpen: trials.some((trial) => ["REQUESTED", "PROVISIONING", "ACTIVE"].includes(trial.lifecycleStatus)),
          isRetrial: hasTechnicalException, previousStatus: hasTechnicalException ? previous.lifecycleStatus : null,
          durationMinutes: 360, adult: false,
        });
    } catch {
      return {
        personId: input.personId, durationHours: APPROVED_CATALOG.trial.durationHours,
        usesPerUser: APPROVED_CATALOG.trial.usesPerUser,
        trials: trials.map((trial) => ({ ...trial, requestedDurationMinutes: Number(trial.requestedDurationMinutes),
          activatedAt: trial.activatedAt?.toISOString() ?? null, expiresAt: trial.expiresAt?.toISOString() ?? null })),
        eligibilityComputed: false, eligible: null, reason: "ELIGIBILITY_EVALUATION_UNAVAILABLE",
      };
    }
    const eligible = evaluation.outcome === "ALLOW" || evaluation.outcome === "ALLOW_RETRIAL"
      ? true : evaluation.outcome === "DENY" ? false : null;
    return {
      personId: input.personId, durationHours: APPROVED_CATALOG.trial.durationHours,
      usesPerUser: APPROVED_CATALOG.trial.usesPerUser,
      trials: trials.map((trial) => ({ ...trial, requestedDurationMinutes: Number(trial.requestedDurationMinutes),
        activatedAt: trial.activatedAt?.toISOString() ?? null, expiresAt: trial.expiresAt?.toISOString() ?? null })),
      eligibilityComputed: eligible !== null, eligible, reason: evaluation.reasonCodes[0] ?? "POLICY_REVIEW_REQUIRED",
    };
  }

  @Post("open-ticket")
  @Header("Cache-Control", "no-store")
  async openTicket(@Req() req: FastifyRequest) {
    const input = this.parse(ticketSchema, req.body);
    const { tenantId, actor } = this.context(req);
    const customerText = input.summary.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().replace(/"/g, '""').slice(0, 1940);
    const result = await botExecute<{ id: string; status: string }>(this.bus, tenantId, "support.ticket.open", {
      personId: input.personId, category: `bot:${input.kind}`, summary: customerText,
    }, { idempotencyKey: `bot:ticket:${tenantId}:${input.personId}:${input.kind}:${input.idempotencyKey}` }, actor);
    if (!result.ok) throw new HttpException({ code: result.code, message: result.message }, result.code === "not_found" ? 404 : 409);
    return { ticketId: result.data.id, status: result.data.status, personId: input.personId, kind: input.kind };
  }

  @Post("get-ticket")
  @Header("Cache-Control", "no-store")
  async getTicket(@Req() req: FastifyRequest) {
    const input = this.parse(getTicketSchema, req.body);
    const { db, tenantId } = this.context(req);
    const ticket = await withTenantTransaction(db, tenantId, (trx) => trx.selectFrom("support.support_tickets")
      .select(["id", "status", "priority", "category", "summary", "person_id as personId",
        "created_at as createdAt", "resolved_at as resolvedAt", "closed_at as closedAt"])
      .where("tenant_id", "=", tenantId).where("person_id", "=", input.personId)
      .where("id", "=", input.ticketId).executeTakeFirst());
    if (!ticket) throw new HttpException({ code: "not_found" }, 404);
    return { personId: input.personId, ticket: { ...ticket, createdAt: ticket.createdAt.toISOString(),
      resolvedAt: ticket.resolvedAt?.toISOString() ?? null, closedAt: ticket.closedAt?.toISOString() ?? null } };
  }

  @Post("renewal-quote")
  @Header("Cache-Control", "no-store")
  async renewalQuote(@Req() req: FastifyRequest) {
    const input = this.parse(personSchema, req.body);
    const { db, tenantId, actor } = this.context(req);
    const sub = await withTenantTransaction(db, tenantId, (trx) => trx.selectFrom("subscription.subscriptions as s")
      .innerJoin("crm.customers as c", (join) => join.onRef("c.tenant_id", "=", "s.tenant_id").onRef("c.id", "=", "s.customer_id"))
      .select("s.id").where("s.tenant_id", "=", tenantId).where("c.person_id", "=", input.personId)
      .orderBy("s.created_at", "desc").executeTakeFirst());
    if (!sub) throw new HttpException({ code: "not_found" }, 404);
    const result = await botExecute<{ orderId: string; status: string; netAmountMinor: string; currency: string; early: boolean; already: boolean }>(
      this.bus, tenantId, "renewal.quote", { subscriptionId: sub.id },
      { idempotencyKey: `bot-api:renewal-quote:${tenantId}:${input.personId}:${input.idempotencyKey}` }, actor);
    if (!result.ok) throw new HttpException({ code: result.code, message: result.message }, result.code === "not_found" ? 404 : 409);
    return { personId: input.personId, quoteId: result.data.orderId, orderId: result.data.orderId,
      status: result.data.status, amountMinor: result.data.netAmountMinor, currency: result.data.currency,
      early: result.data.early, already: result.data.already };
  }

  @Post("renew")
  @Header("Cache-Control", "no-store")
  async renew(@Req() req: FastifyRequest) {
    const input = this.parse(renewSchema, req.body);
    const { db, tenantId, actor } = this.context(req);
    const order = await withTenantTransaction(db, tenantId, (trx) => trx.selectFrom("commerce.orders")
      .select(["id", "order_type as orderType", "status", "person_id as personId"])
      .where("tenant_id", "=", tenantId).where("id", "=", input.quoteId).executeTakeFirst());
    if (!order || order.personId !== input.personId) throw new HttpException({ code: "not_found" }, 404);
    if (order.orderType !== "RENEWAL") throw new HttpException({ code: "invalid_order_type" }, 400);
    if (order.status !== "SETTLED") throw new HttpException({ code: "renewal_not_settled" }, 409);
    const result = await botExecute<{ subscriptionId: string; cycleId: string; cycleNo: number; startsAt: string; endsAt: string; already: boolean }>(
      this.bus, tenantId, "subscription.renew", { orderId: input.quoteId },
      { idempotencyKey: `bot-api:renew:${tenantId}:${input.quoteId}` }, actor);
    if (!result.ok) throw new HttpException({ code: result.code, message: result.message }, result.code === "not_found" ? 404 : 409);
    return { personId: input.personId, orderId: input.quoteId, ...result.data };
  }
}
