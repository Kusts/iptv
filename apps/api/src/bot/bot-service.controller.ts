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
import { getBotReplyEligibility, isDuplicateInbound } from "./streammax-bot-queries.js";

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
    return { plans: plans.filter((p) => p.price).map((p) => ({
      planId: p.planId, name: p.name, amountMinor: p.price!.amountMinor.toString(), currency: p.price!.currency,
    })) };
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
}
