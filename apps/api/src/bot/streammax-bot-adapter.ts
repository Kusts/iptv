import { withTenantTransaction, type Database } from "@iptv/database";
import type { Kysely } from "kysely";
import type { CommandActor, CommandResult } from "@iptv/domain";
import { CommandBus } from "../commands/command-bus.js";
import { normalizeIdentity } from "../crm/crm.commands.js";
import { listActiveSellablePlans } from "../commerce/catalog-queries.js";
import { getDeliveryState, getOrderState, getRenewalInfo } from "./streammax-bot-queries.js";
import { botActor } from "./bot-actor.js";
import type { BotContact, BotContractDependencies, BotSupportKind } from "./streammax-bot-contract.js";

type Serialized = { personId: string; leadId: string | null };
const queues = new Map<string, Promise<void>>();
const uncertainPurchases = new Map<string, { orderId: string; chargeId: string; qrCode: null; effectUncertain: true }>();
const BOT_COMMANDS = new Set([
  "person.register", "lead.capture", "message.send_manual", "offer.quote",
  "order.submit", "billing.customer_provision", "charge.create", "support.ticket.open",
  "conversation.start_manual", "conversation.release",
]);
/**
 * Enforces the bot's command boundary before an actor reaches the bus.
 * The default actor is synthetic and intended for in-process wiring; external
 * callers (such as HTTP service routes) must pass the actor from the credential.
 */
export async function botExecute<T>(
  bus: CommandBus,
  tenantId: string,
  name: string,
  payload: unknown,
  opts?: { idempotencyKey?: string },
  actor?: CommandActor,
) {
  if (!BOT_COMMANDS.has(name)) throw new Error(`Bot command is not allowlisted: ${name}`);
  return bus.execute<T>(actor ?? botActor(tenantId), name, payload, opts);
}

// This mutex is intra-process only. Bus idempotency and identity.identities' unique
// constraint cover distributed races; do not hold a database transaction across the bus.
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  queues.set(key, current);
  await previous;
  try { return await work(); }
  finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

export function serializedForContact<T>(
  tenantId: string,
  waId: string,
  work: () => Promise<T>,
): Promise<T> {
  return serialized(`${tenantId}:${normalizeIdentity("WHATSAPP", waId)}`, work);
}

export function createStreamMaxBotDependencies(
  db: Kysely<Database>,
  bus: CommandBus,
): BotContractDependencies {
  const findLeadByPerson = async (tenantId: string, personId: string): Promise<string | null> =>
    withTenantTransaction(db, tenantId, async (trx) => {
      const lead = await trx.selectFrom("crm.leads")
        .select(["id as leadId"])
        .where("tenant_id", "=", tenantId)
        .where("person_id", "=", personId)
        .orderBy("created_at", "asc")
        .limit(1)
        .executeTakeFirst();
      return lead?.leadId ?? null;
    });

  const findPersonByWaId = async (tenantId: string, waId: string): Promise<Serialized | null> => {
    const normalized = normalizeIdentity("WHATSAPP", waId);
    return withTenantTransaction(db, tenantId, async (trx) => {
      const identity = await trx.selectFrom("identity.identities as i")
        .select(["i.person_id as personId"])
        .where("i.tenant_id", "=", tenantId)
        .where("i.identity_type", "=", "WHATSAPP")
        .where("i.normalized_value", "=", normalized)
        .where("i.detached_at", "is", null)
        .executeTakeFirst();
      if (!identity) return null;
      const lead = await trx.selectFrom("crm.leads")
        .select(["id as leadId"])
        .where("tenant_id", "=", tenantId)
        .where("person_id", "=", identity.personId)
        .orderBy("created_at", "asc")
        .limit(1)
        .executeTakeFirst();
      return { personId: identity.personId, leadId: lead?.leadId ?? null };
    });
  };

  const registerPersonUnlocked = async (contact: BotContact) => {
        const normalized = normalizeIdentity("WHATSAPP", contact.waId);
        const result = await botExecute<{ id: string }>(bus, contact.tenantId, "person.register", {
          canonicalName: contact.name,
          identities: [{ identityType: "WHATSAPP", normalizedValue: normalized }],
        }, { idempotencyKey: `bot:person:${contact.tenantId}:${normalized}` });
        if (result.ok) return result.data.id;
        if (result.code === "precondition_failed" || (result.code as string) === "in_progress") {
          const found = await findPersonByWaId(contact.tenantId, normalized);
          if (found) return found.personId;
          throw new Error(`person.register ${result.code}; no person found for normalized WhatsApp identity`);
        }
        throw new Error(result.message);
  };
  const captureLeadUnlocked = async (tenantId: string, personId: string) => {
      const result: CommandResult<{ id: string }> = await botExecute(
        bus, tenantId, "lead.capture", { personId },
        { idempotencyKey: `bot:lead:${tenantId}:${personId}` },
      );
      if (result.ok) return result.data.id;
      if (result.code === "precondition_failed" || (result.code as string) === "in_progress") {
        const leadId = await findLeadByPerson(tenantId, personId);
        if (leadId) return leadId;
        throw new Error(`lead.capture ${result.code}; no lead found for person ${personId}`);
      }
      throw new Error(result.message);
  };
  return {
    findPersonByWaId,
    registerPerson: (contact) => serializedForContact(contact.tenantId, contact.waId, () => registerPersonUnlocked(contact)),
    registerPersonUnlocked,
    captureLead: (tenantId, personId) => captureLeadUnlocked(tenantId, personId),
    captureLeadUnlocked,
    ensureConversation: async (tenantId: string, personId: string, options?: { release?: boolean }) => {
      const releaseConversation = options?.release !== false;
      if (!releaseConversation) {
        const existing = await withTenantTransaction(db, tenantId, async (trx) =>
          trx.selectFrom("communication.conversations")
            .select(["id"])
            .where("tenant_id", "=", tenantId)
            .where("person_id", "=", personId)
            .where("channel", "=", "WHATSAPP")
            .where("status", "=", "OPEN")
            .limit(1)
            .executeTakeFirst(),
        );
        if (existing) return;
      }
      const started = await botExecute<{ id: string }>(bus, tenantId, "conversation.start_manual",
        { personId, channel: "WHATSAPP" }, { idempotencyKey: `bot:conversation:${tenantId}:${personId}` });
      let conversationId: string;
      let shouldRelease = true;
      if (started.ok) {
        conversationId = started.data.id;
      } else if (started.code === "precondition_failed" || (started.code as string) === "in_progress") {
        const existing = await withTenantTransaction(db, tenantId, async (trx) =>
          trx.selectFrom("communication.conversations")
            .select(["id", "control_mode as controlMode"])
            .where("tenant_id", "=", tenantId)
            .where("person_id", "=", personId)
            .where("channel", "=", "WHATSAPP")
            .where("status", "=", "OPEN")
            .orderBy("created_at", "desc")
            .limit(1)
            .executeTakeFirst(),
        );
        if (!existing) throw new Error(`conversation.start_manual ${started.code}; no conversation found for person ${personId}`);
        conversationId = existing.id;
        shouldRelease = existing.controlMode !== "HUMAN_CONTROL";
      } else {
        throw new Error(started.message);
      }
      if (!releaseConversation) return;
      if (!shouldRelease) return;
      const released = await botExecute(bus, tenantId, "conversation.release", { conversationId },
        { idempotencyKey: `bot:conversation-release:${tenantId}:${personId}` });
      if (!released.ok) throw new Error(released.message);
    },
    listActivePlans: async (tenantId) => listActiveSellablePlans(db, tenantId),
    getOrderState: (tenantId, personId, orderId) => getOrderState(db, tenantId, personId, orderId),
    getDeliveryState: (tenantId, personId, ref) => getDeliveryState(db, tenantId, personId, ref),
    getRenewalInfo: (tenantId, personId) => getRenewalInfo(db, tenantId, personId),
    openSupportRequest: async (contact, kind: BotSupportKind, summary, refId, intentRef) => {
      const customerText = summary.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().replace(/"/g, '""').slice(0, 1940);
      const safeSummary = `Solicitação recebida pelo bot. Cliente: "${customerText || "sem detalhes"}"`;
      const result = await botExecute(bus, contact.tenantId, "support.ticket.open", {
        personId: contact.personId, priority: "NORMAL", category: `bot:${kind}`, summary: safeSummary,
      }, { idempotencyKey: `bot:ticket:${contact.tenantId}:${contact.personId}:${kind}:${refId ?? "general"}:${intentRef ?? crypto.randomUUID()}` });
      if (!result.ok) throw new Error(result.message);
    },
    startPurchase: async (contact, planId, intentRef) => {
      const quoteKey = `bot:quote:${contact.tenantId}:${contact.personId}:${planId}:${intentRef ?? `${contact.waId}:${planId}`}`;
      const quote = await botExecute<{ id: string }>(bus, contact.tenantId, "offer.quote", {
        personId: contact.personId, items: [{ sellableType: "PLAN", sellableId: planId, quantity: 1 }],
      }, { idempotencyKey: quoteKey });
      if (!quote.ok) throw new Error(quote.message);
      const submitted = await botExecute<{ id: string }>(bus, contact.tenantId, "order.submit", { orderId: quote.data.id }, { idempotencyKey: `bot:submit:${quote.data.id}` });
      if (!submitted.ok) throw new Error(submitted.message);
      const priorUncertain = uncertainPurchases.get(`${contact.tenantId}:${quote.data.id}`);
      if (priorUncertain) return priorUncertain;
      const provision = await botExecute<{ id: string }>(bus, contact.tenantId, "billing.customer_provision", { personId: contact.personId }, { idempotencyKey: `bot:cust:${contact.tenantId}:${contact.personId}` });
      if (!provision.ok) throw new Error(provision.message);
      const charge = await botExecute<{ id: string; qrCode?: string | null; effectUncertain: boolean }>(bus, contact.tenantId, "charge.create", { orderId: quote.data.id, billingType: "PIX" }, { idempotencyKey: `bot:charge:${quote.data.id}` });
      if (!charge.ok) throw new Error(charge.message);
      const result = { orderId: quote.data.id, chargeId: charge.data.id, qrCode: charge.data.effectUncertain ? null : charge.data.qrCode ?? null, effectUncertain: charge.data.effectUncertain };
      // This in-memory suppression is volatile; cross-process/restart safety depends
      // on command-bus charge idempotency for the stable charge key.
      if (charge.data.effectUncertain) uncertainPurchases.set(`${contact.tenantId}:${quote.data.id}`, { ...result, qrCode: null, effectUncertain: true });
      return result;
    },
  };
}
