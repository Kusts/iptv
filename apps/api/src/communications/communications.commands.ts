import { z } from "zod";
import { newId, now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type {
  CommandBus,
  CommandHandlerContext,
} from "../commands/command-bus.js";
import {
  emitAndEnqueue,
  kyselyTrxOf,
  memoryStateOf,
  type Wave2MemoryState,
} from "../crm/wave2-store.js";
import {
  GatewayUnknownError,
  currentGateway,
} from "./messaging-gateway.js";
import { normalizeSender } from "./waha-normalizer.js";

/**
 * Wave 2 Communications slice.
 *
 * Canonical rules:
 * - WAHA sits behind the `MessagingGatewayPort`; the provider NEVER owns
 *   business state (messages/deliveries are persisted first, the gateway
 *   only carries an already-recorded outbound row).
 * - Manual human replies are HUMAN actions gated by `conversation.reply` —
 *   they do NOT require the `messaging.outbound` autonomous capability.
 * - Gateway UNKNOWN_EFFECT (timeout after send attempt) → delivery row
 *   `QUEUED` + `error_code=UNKNOWN_EFFECT`, conversation to `PAUSED` with a
 *   `RECONCILE_REQUIRED` control event. Never blind-retry.
 * - `communication_suppressions` hit or a `DENIED` preference on the
 *   recipient channel → `forbidden`, nothing is sent.
 * - Events emitted are registry-listed only: `conversation.started.v1`,
 *   `conversation.human_takeover_started.v1`,
 *   `conversation.returned_to_ai.v1`, `conversation.paused.v1`,
 *   `message.received.v1`, `message.sent.v1`.
 */

export const startManualInput = z.object({
  personId: z.string().uuid(),
  channel: z.string().trim().min(1).max(64),
  externalThreadId: z.string().trim().min(1).max(320).optional(),
});
export type StartManualInput = z.infer<typeof startManualInput>;

export const sendManualInput = z.object({
  conversationId: z.string().uuid(),
  text: z.string().trim().min(1).max(4000),
});
export type SendManualInput = z.infer<typeof sendManualInput>;

export const ingestMessageInput = z.object({
  channel: z.string().trim().min(1).max(64),
  externalMessageId: z.string().trim().min(1).max(320),
  from: z.string().trim().min(1).max(320),
  text: z.string().max(8000).default(""),
  occurredAt: z.string().datetime({ offset: true }),
  session: z.string().max(120).nullable().optional(),
});
export type IngestMessageInput = z.infer<typeof ingestMessageInput>;

export const conversationIdInput = z.object({ conversationId: z.string().uuid() });
export type ConversationIdInput = z.infer<typeof conversationIdInput>;

export const resolveExceptionInput = z.object({
  exceptionId: z.string().uuid(),
  action: z.enum(["map", "discard"]),
  personId: z.string().uuid().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type ResolveExceptionInput = z.infer<typeof resolveExceptionInput>;

const CLOSED_STATUSES = ["RESOLVED", "ARCHIVED"];

interface LoadedConversation {
  id: string;
  personId: string;
  channel: string;
  status: string;
  controlMode: string;
  externalThreadId: string | null;
}

async function loadConversation(
  ctx: CommandHandlerContext,
  conversationId: string,
): Promise<{ trx: NonNullable<ReturnType<typeof kyselyTrxOf>>; conv: LoadedConversation } | { mem: Wave2MemoryState; conv: LoadedConversation } | null> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const row = await trx
      .selectFrom("communication.conversations")
      .select(["id", "person_id", "channel", "status", "control_mode", "external_thread_id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", conversationId)
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    return {
      trx,
      conv: {
        id: row.id,
        personId: row.person_id,
        channel: row.channel,
        status: row.status,
        controlMode: row.control_mode,
        externalThreadId: row.external_thread_id,
      },
    };
  }
  const mem = memoryStateOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 2 store available");
  }
  const c = mem.conversations.get(conversationId);
  if (c === undefined || c.tenantId !== ctx.tenantId) {
    return null;
  }
  return {
    mem,
    conv: {
      id: c.id,
      personId: c.personId,
      channel: c.channel,
      status: c.status,
      controlMode: c.controlMode,
      externalThreadId: c.externalThreadId,
    },
  };
}

/** Pure suppression/opt-out decision over plain rows (shared by both stores; unit-tested). */
export function suppressionDecision(input: {
  suppressions: Array<{
    personId: string | null;
    identityId: string | null;
    channel: string | null;
    startsAt: Date;
    endsAt: Date | null;
  }>;
  preferences: Array<{ personId: string; channel: string; status: string }>;
  personId: string;
  identityIds: string[];
  channel: string;
  at: Date;
}): { blocked: true; reason: string } | { blocked: false } {
  // A NULL person_id is an identity-directed suppression, never a
  // tenant-wide wildcard: it matches only via the linked identity ids.
  const hit = input.suppressions.find(
    (s) =>
      (s.personId === input.personId ||
        (s.personId === null && s.identityId !== null && input.identityIds.includes(s.identityId))) &&
      (s.channel === null || s.channel === input.channel) &&
      s.startsAt.getTime() <= input.at.getTime() &&
      (s.endsAt === null || s.endsAt.getTime() > input.at.getTime()),
  );
  if (hit !== undefined) {
    return { blocked: true, reason: "recipient is suppressed for this channel" };
  }
  const denied = input.preferences.find(
    (p) => p.personId === input.personId && p.channel === input.channel && p.status === "DENIED",
  );
  if (denied !== undefined) {
    return { blocked: true, reason: "channel opted out by preference" };
  }
  return { blocked: false };
}

/** Active suppression for (person, channel) or a DENIED preference on the channel. */
async function suppressionBlock(
  ctx: CommandHandlerContext,
  personId: string,
  channel: string,
): Promise<{ blocked: true; reason: string } | { blocked: false }> {
  const at = new Date();
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const identityRows = await trx
      .selectFrom("identity.identities")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("person_id", "=", personId)
      .where("detached_at", "is", null)
      .execute();
    const identityIds = identityRows.map((row) => row.id);
    const suppressions = await trx
      .selectFrom("communication.communication_suppressions")
      .select(["person_id", "identity_id", "channel", "starts_at", "ends_at"])
      .where("tenant_id", "=", ctx.tenantId)
      .where((eb) =>
        eb.or([
          eb("person_id", "=", personId),
          ...(identityIds.length > 0 ? [eb("identity_id", "in", identityIds)] : []),
        ]),
      )
      .execute();
    const preferences = await trx
      .selectFrom("communication.communication_preferences")
      .select(["person_id", "channel", "status"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("person_id", "=", personId)
      .where("channel", "=", channel)
      .execute();
    return suppressionDecision({
      suppressions: suppressions.map((s) => ({
        personId: s.person_id,
        identityId: s.identity_id,
        channel: s.channel,
        startsAt: s.starts_at,
        endsAt: s.ends_at,
      })),
      preferences: preferences.map((p) => ({ personId: p.person_id, channel: p.channel, status: p.status })),
      personId,
      identityIds,
      channel,
      at,
    });
  }
  const mem = memoryStateOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 2 store available");
  }
  return suppressionDecision(
    {
      suppressions: mem.suppressions
        .filter((s) => s.tenantId === ctx.tenantId)
        .map((s) => ({ personId: s.personId, identityId: null, channel: s.channel, startsAt: s.startsAt, endsAt: s.endsAt })),
      preferences: mem.preferences
        .filter((p) => p.tenantId === ctx.tenantId)
        .map((p) => ({ personId: p.personId, channel: p.channel, status: p.status })),
      personId,
      identityIds: [],
      channel,
      at,
    },
  );
}

async function resolveDestination(
  ctx: CommandHandlerContext,
  personId: string,
  fallbackThread: string | null,
): Promise<string> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const identity = await trx
      .selectFrom("identity.identities")
      .select(["normalized_value"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("person_id", "=", personId)
      .where("identity_type", "=", "WHATSAPP")
      .where("detached_at", "is", null)
      .orderBy("created_at", "asc")
      .executeTakeFirst();
    return identity?.normalized_value ?? fallbackThread ?? "unknown";
  }
  const mem = memoryStateOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 2 store available");
  }
  for (const identity of mem.identities.values()) {
    if (
      identity.tenantId === ctx.tenantId &&
      identity.personId === personId &&
      identity.identityType === "WHATSAPP" &&
      identity.detachedAt === null
    ) {
      return identity.normalizedValue;
    }
  }
  return fallbackThread ?? "unknown";
}

async function appendControlEvent(
  ctx: CommandHandlerContext,
  input: { conversationId: string; fromMode: string | null; toMode: string; reason: string },
): Promise<void> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    await trx
      .insertInto("communication.conversation_control_events")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        conversation_id: input.conversationId,
        from_mode: input.fromMode,
        to_mode: input.toMode,
        reason: input.reason,
        actor_type: ctx.actor.actorType,
        actor_id: ctx.actor.userId,
        occurred_at: now(),
      })
      .execute();
    await trx
      .updateTable("communication.conversations")
      .set({ control_mode: input.toMode, updated_at: now() })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.conversationId)
      .execute();
    return;
  }
  const mem = memoryStateOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 2 store available");
  }
  mem.controlEvents.push({
    id: newId(),
    tenantId: ctx.tenantId,
    conversationId: input.conversationId,
    fromMode: input.fromMode,
    toMode: input.toMode,
    reason: input.reason,
    actorType: ctx.actor.actorType,
    actorId: ctx.actor.userId,
  });
  const conv = mem.conversations.get(input.conversationId);
  if (conv !== undefined) {
    conv.controlMode = input.toMode;
  }
}

async function handleStartManual(
  ctx: CommandHandlerContext,
  input: StartManualInput,
): Promise<CommandResult<{ id: string }>> {
  const conversationId = newId();
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const person = await trx
      .selectFrom("identity.persons")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.personId)
      .executeTakeFirst();
    if (person === undefined) {
      return { ok: false, code: "not_found", message: "person not found in this tenant" };
    }
    await trx
      .insertInto("communication.conversations")
      .values({
        id: conversationId,
        tenant_id: ctx.tenantId,
        person_id: input.personId,
        channel: input.channel,
        external_thread_id: input.externalThreadId ?? null,
        status: "OPEN",
        control_mode: "HUMAN_CONTROL",
        last_message_at: null,
        created_at: now(),
        updated_at: now(),
        resolved_at: null,
        archived_at: null,
      })
      .execute();
  } else {
    const mem = memoryStateOf(ctx);
    if (mem === null) {
      throw new Error("no Wave 2 store available");
    }
    const person = mem.persons.get(input.personId);
    if (person === undefined || person.tenantId !== ctx.tenantId) {
      return { ok: false, code: "not_found", message: "person not found in this tenant" };
    }
    mem.conversations.set(conversationId, {
      id: conversationId,
      tenantId: ctx.tenantId,
      personId: input.personId,
      channel: input.channel,
      externalThreadId: input.externalThreadId ?? null,
      status: "OPEN",
      controlMode: "HUMAN_CONTROL",
      lastMessageAt: null,
      resolvedAt: null,
      archivedAt: null,
    });
  }
  await appendControlEvent(ctx, {
    conversationId,
    fromMode: null,
    toMode: "HUMAN_CONTROL",
    reason: "manual_start",
  });
  await emitAndEnqueue(ctx, {
    eventType: "conversation.started.v1",
    aggregateType: "conversation",
    aggregateId: conversationId,
    data: { conversation_id: conversationId, person_id: input.personId, channel: input.channel },
  });
  return { ok: true, data: { id: conversationId } };
}

async function handleSendManual(
  ctx: CommandHandlerContext,
  input: SendManualInput,
): Promise<CommandResult<{ messageId: string; deliveryStatus: string; providerMessageId: string | null }>> {
  const loaded = await loadConversation(ctx, input.conversationId);
  if (loaded === null) {
    return { ok: false, code: "not_found", message: "conversation not found in this tenant" };
  }
  const conv = loaded.conv;
  if (CLOSED_STATUSES.includes(conv.status)) {
    return { ok: false, code: "precondition_failed", message: `conversation is ${conv.status}` };
  }
  const block = await suppressionBlock(ctx, conv.personId, conv.channel);
  if (block.blocked) {
    return { ok: false, code: "forbidden", message: block.reason };
  }
  const to = await resolveDestination(ctx, conv.personId, conv.externalThreadId);
  const messageId = newId();
  const occurred = now();
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    await trx
      .insertInto("communication.messages")
      .values({
        id: messageId,
        tenant_id: ctx.tenantId,
        conversation_id: conv.id,
        person_id: conv.personId,
        direction: "OUTBOUND",
        channel: conv.channel,
        sender_type: "HUMAN",
        external_message_id: null,
        idempotency_key: null,
        content_type: "TEXT",
        body_text: input.text,
        attachment_ref: null,
        metadata_json: { sent_by: ctx.actor.userId },
        occurred_at: occurred,
        received_at: null,
        created_at: now(),
      })
      .execute();
  } else {
    const mem = memoryStateOf(ctx);
    if (mem === null) {
      throw new Error("no Wave 2 store available");
    }
    mem.messages.set(messageId, {
      id: messageId,
      tenantId: ctx.tenantId,
      conversationId: conv.id,
      personId: conv.personId,
      direction: "OUTBOUND",
      channel: conv.channel,
      senderType: "HUMAN",
      externalMessageId: null,
      bodyText: input.text,
      occurredAt: occurred,
    });
  }

  let deliveryStatus = "SENT";
  let providerMessageId: string | null = null;
  let errorCode: string | null = null;
  try {
    const result = await currentGateway().sendText({
      tenantId: ctx.tenantId,
      conversationId: conv.id,
      to,
      text: input.text,
    });
    if (result.ok) {
      providerMessageId = result.providerMessageId;
    } else {
      deliveryStatus = "FAILED";
      errorCode = result.code;
    }
  } catch (err) {
    if (err instanceof GatewayUnknownError) {
      // Uncertain effect: record UNKNOWN, park the conversation for
      // reconciliation, NEVER blind-retry.
      deliveryStatus = "QUEUED";
      errorCode = "UNKNOWN_EFFECT";
    } else {
      throw err;
    }
  }

  if (trx !== null) {
    await trx
      .insertInto("communication.message_deliveries")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        message_id: messageId,
        provider: currentGateway().name,
        status: deliveryStatus,
        attempt_no: 1,
        external_delivery_id: providerMessageId,
        error_code: errorCode,
        error_detail_json: {},
        occurred_at: now(),
      })
      .execute();
    await trx
      .updateTable("communication.conversations")
      .set({ last_message_at: occurred, updated_at: now() })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", conv.id)
      .execute();
  } else {
    const mem = memoryStateOf(ctx);
    if (mem === null) {
      throw new Error("no Wave 2 store available");
    }
    mem.deliveries.push({
      id: newId(),
      tenantId: ctx.tenantId,
      messageId,
      provider: currentGateway().name,
      status: deliveryStatus,
      attemptNo: 1,
      externalDeliveryId: providerMessageId,
      errorCode,
    });
    const c = mem.conversations.get(conv.id);
    if (c !== undefined) {
      c.lastMessageAt = occurred;
    }
  }

  if (deliveryStatus === "SENT") {
    await emitAndEnqueue(ctx, {
      eventType: "message.sent.v1",
      aggregateType: "message",
      aggregateId: messageId,
      data: {
        message_id: messageId,
        conversation_id: conv.id,
        provider_message_id: providerMessageId,
      },
    });
  } else if (deliveryStatus === "QUEUED") {
    await appendControlEvent(ctx, {
      conversationId: conv.id,
      fromMode: conv.controlMode,
      toMode: "PAUSED",
      reason: "RECONCILE_REQUIRED",
    });
    await emitAndEnqueue(ctx, {
      eventType: "conversation.paused.v1",
      aggregateType: "conversation",
      aggregateId: conv.id,
      data: { conversation_id: conv.id, reason: "RECONCILE_REQUIRED" },
    });
  }
  return { ok: true, data: { messageId, deliveryStatus, providerMessageId } };
}

async function handleIngest(
  ctx: CommandHandlerContext,
  input: IngestMessageInput,
): Promise<
  CommandResult<{ messageId: string | null; conversationId: string | null; exceptionId: string | null; duplicate: boolean }>
> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const dup = await trx
      .selectFrom("communication.messages")
      .select(["id", "conversation_id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("channel", "=", input.channel)
      .where("external_message_id", "=", input.externalMessageId)
      .executeTakeFirst();
    if (dup !== undefined) {
      return { ok: true, data: { messageId: dup.id, conversationId: dup.conversation_id, exceptionId: null, duplicate: true } };
    }
    const dupExc = await trx
      .selectFrom("communication.exceptions")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("external_message_id", "=", input.externalMessageId)
      .where("status", "=", "OPEN")
      .executeTakeFirst();
    if (dupExc !== undefined) {
      return { ok: true, data: { messageId: null, conversationId: null, exceptionId: dupExc.id, duplicate: true } };
    }
    // Match 1: exact external thread id.
    let conv = await trx
      .selectFrom("communication.conversations")
      .select(["id", "person_id", "status"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("channel", "=", input.channel)
      .where("external_thread_id", "=", input.from)
      .executeTakeFirst();
    // Match 2: person identity → most recent open conversation.
    let personId: string | null = conv?.person_id ?? null;
    if (conv === undefined) {
      const variants = [input.from, normalizeSender(input.from)];
      const identity = await trx
        .selectFrom("identity.identities")
        .select(["person_id"])
        .where("tenant_id", "=", ctx.tenantId)
        .where("normalized_value", "in", variants)
        .where("detached_at", "is", null)
        .orderBy("created_at", "asc")
        .executeTakeFirst();
      if (identity !== undefined) {
        personId = identity.person_id;
        conv = await trx
          .selectFrom("communication.conversations")
          .select(["id", "person_id", "status"])
          .where("tenant_id", "=", ctx.tenantId)
          .where("person_id", "=", identity.person_id)
          .where("channel", "=", input.channel)
          .where("status", "in", ["OPEN", "AWAITING_CUSTOMER", "AWAITING_INTERNAL"])
          .orderBy("last_message_at", "desc")
          .executeTakeFirst();
      }
    }
    if (conv === undefined || CLOSED_STATUSES.includes(conv.status)) {
      const exceptionId = newId();
      await trx
        .insertInto("communication.exceptions")
        .values({
          id: exceptionId,
          tenant_id: ctx.tenantId,
          kind: "UNMATCHED_INBOUND",
          status: "OPEN",
          channel: input.channel,
          external_message_id: input.externalMessageId,
          from_address: input.from,
          conversation_id: null,
          person_id: personId,
          reason: conv === undefined ? "no matching person or conversation" : `conversation is ${conv.status}`,
          payload_json: { text: input.text, session: input.session ?? null },
          created_at: now(),
          updated_at: now(),
          resolved_at: null,
        })
        .execute();
      return { ok: true, data: { messageId: null, conversationId: null, exceptionId, duplicate: false } };
    }
    const messageId = newId();
    const occurred = new Date(input.occurredAt);
    await trx
      .insertInto("communication.messages")
      .values({
        id: messageId,
        tenant_id: ctx.tenantId,
        conversation_id: conv.id,
        person_id: conv.person_id,
        direction: "INBOUND",
        channel: input.channel,
        sender_type: "PERSON",
        external_message_id: input.externalMessageId,
        idempotency_key: null,
        content_type: "TEXT",
        body_text: input.text.length > 0 ? input.text : null,
        attachment_ref: null,
        metadata_json: { provider: "waha", session: input.session ?? null },
        occurred_at: occurred,
        received_at: now(),
        created_at: now(),
      })
      .execute();
    await trx
      .insertInto("communication.message_deliveries")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        message_id: messageId,
        provider: "waha",
        status: "DELIVERED",
        attempt_no: 1,
        external_delivery_id: input.externalMessageId,
        error_code: null,
        error_detail_json: {},
        occurred_at: now(),
      })
      .execute();
    await trx
      .updateTable("communication.conversations")
      .set({ last_message_at: occurred, updated_at: now() })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", conv.id)
      .execute();
    await emitAndEnqueue(ctx, {
      eventType: "message.received.v1",
      aggregateType: "message",
      aggregateId: messageId,
      data: { message_id: messageId, conversation_id: conv.id, channel: input.channel },
    });
    return { ok: true, data: { messageId, conversationId: conv.id, exceptionId: null, duplicate: false } };
  }

  const mem = memoryStateOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 2 store available");
  }
  for (const m of mem.messages.values()) {
    if (m.tenantId === ctx.tenantId && m.channel === input.channel && m.externalMessageId === input.externalMessageId) {
      return { ok: true, data: { messageId: m.id, conversationId: m.conversationId, exceptionId: null, duplicate: true } };
    }
  }
  for (const e of mem.exceptions.values()) {
    if (e.tenantId === ctx.tenantId && e.externalMessageId === input.externalMessageId && e.status === "OPEN") {
      return { ok: true, data: { messageId: null, conversationId: null, exceptionId: e.id, duplicate: true } };
    }
  }
  let conv: { id: string; personId: string; status: string } | undefined;
  let personId: string | null = null;
  for (const c of mem.conversations.values()) {
    if (c.tenantId === ctx.tenantId && c.channel === input.channel && c.externalThreadId === input.from) {
      conv = { id: c.id, personId: c.personId, status: c.status };
      personId = c.personId;
    }
  }
  if (conv === undefined) {
    const variants = [input.from, normalizeSender(input.from)];
    for (const identity of mem.identities.values()) {
      if (identity.tenantId === ctx.tenantId && variants.includes(identity.normalizedValue) && identity.detachedAt === null) {
        personId = identity.personId;
        break;
      }
    }
    if (personId !== null) {
      for (const c of mem.conversations.values()) {
        if (
          c.tenantId === ctx.tenantId &&
          c.personId === personId &&
          c.channel === input.channel &&
          ["OPEN", "AWAITING_CUSTOMER", "AWAITING_INTERNAL"].includes(c.status)
        ) {
          conv = { id: c.id, personId: c.personId, status: c.status };
          break;
        }
      }
    }
  }
  if (conv === undefined || CLOSED_STATUSES.includes(conv.status)) {
    const exceptionId = newId();
    mem.exceptions.set(exceptionId, {
      id: exceptionId,
      tenantId: ctx.tenantId,
      kind: "UNMATCHED_INBOUND",
      status: "OPEN",
      channel: input.channel,
      externalMessageId: input.externalMessageId,
      fromAddress: input.from,
      reason: conv === undefined ? "no matching person or conversation" : `conversation is ${conv.status}`,
      conversationId: null,
      personId,
      resolvedAt: null,
    });
    return { ok: true, data: { messageId: null, conversationId: null, exceptionId, duplicate: false } };
  }
  const messageId = newId();
  mem.messages.set(messageId, {
    id: messageId,
    tenantId: ctx.tenantId,
    conversationId: conv.id,
    personId: conv.personId,
    direction: "INBOUND",
    channel: input.channel,
    senderType: "PERSON",
    externalMessageId: input.externalMessageId,
    bodyText: input.text.length > 0 ? input.text : null,
    occurredAt: new Date(input.occurredAt),
  });
  mem.deliveries.push({
    id: newId(),
    tenantId: ctx.tenantId,
    messageId,
    provider: "waha",
    status: "DELIVERED",
    attemptNo: 1,
    externalDeliveryId: input.externalMessageId,
    errorCode: null,
  });
  await emitAndEnqueue(ctx, {
    eventType: "message.received.v1",
    aggregateType: "message",
    aggregateId: messageId,
    data: { message_id: messageId, conversation_id: conv.id, channel: input.channel },
  });
  return { ok: true, data: { messageId, conversationId: conv.id, exceptionId: null, duplicate: false } };
}

function controlHandler(toMode: "HUMAN_CONTROL" | "AI_CONTROL", reason: string, eventType: string) {
  return async (
    ctx: CommandHandlerContext,
    input: ConversationIdInput,
  ): Promise<CommandResult<{ id: string; controlMode: string; already: boolean }>> => {
    const loaded = await loadConversation(ctx, input.conversationId);
    if (loaded === null) {
      return { ok: false, code: "not_found", message: "conversation not found in this tenant" };
    }
    if (loaded.conv.controlMode === toMode) {
      return { ok: true, data: { id: loaded.conv.id, controlMode: toMode, already: true } };
    }
    await appendControlEvent(ctx, {
      conversationId: loaded.conv.id,
      fromMode: loaded.conv.controlMode,
      toMode,
      reason,
    });
    await emitAndEnqueue(ctx, {
      eventType,
      aggregateType: "conversation",
      aggregateId: loaded.conv.id,
      data: { conversation_id: loaded.conv.id, from_mode: loaded.conv.controlMode, to_mode: toMode },
    });
    return { ok: true, data: { id: loaded.conv.id, controlMode: toMode, already: false } };
  };
}

async function handleClose(
  ctx: CommandHandlerContext,
  input: ConversationIdInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const loaded = await loadConversation(ctx, input.conversationId);
  if (loaded === null) {
    return { ok: false, code: "not_found", message: "conversation not found in this tenant" };
  }
  if (CLOSED_STATUSES.includes(loaded.conv.status)) {
    return { ok: false, code: "precondition_failed", message: `conversation is already ${loaded.conv.status}` };
  }
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    await trx
      .updateTable("communication.conversations")
      .set({ status: "RESOLVED", resolved_at: now(), updated_at: now() })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", loaded.conv.id)
      .execute();
  } else {
    const mem = memoryStateOf(ctx);
    if (mem === null) {
      throw new Error("no Wave 2 store available");
    }
    const c = mem.conversations.get(loaded.conv.id);
    if (c !== undefined) {
      c.status = "RESOLVED";
      c.resolvedAt = new Date();
    }
  }
  return { ok: true, data: { id: loaded.conv.id, status: "RESOLVED" } };
}

async function handleResolveException(
  ctx: CommandHandlerContext,
  input: ResolveExceptionInput,
): Promise<CommandResult<{ id: string; status: string; conversationId: string | null }>> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const exc = await trx
      .selectFrom("communication.exceptions")
      .select(["id", "status", "channel", "from_address"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.exceptionId)
      .executeTakeFirst();
    if (exc === undefined) {
      return { ok: false, code: "not_found", message: "exception not found in this tenant" };
    }
    if (exc.status !== "OPEN") {
      return { ok: false, code: "precondition_failed", message: `exception is already ${exc.status}` };
    }
    if (input.action === "discard") {
      if (input.reason === undefined) {
        return { ok: false, code: "validation_failed", message: "discard requires a reason" };
      }
      await trx
        .updateTable("communication.exceptions")
        .set({ status: "DISCARDED", reason: input.reason, resolved_at: now(), updated_at: now() })
        .where("tenant_id", "=", ctx.tenantId)
        .where("id", "=", exc.id)
        .execute();
      return { ok: true, data: { id: exc.id, status: "DISCARDED", conversationId: null } };
    }
    if (input.personId === undefined) {
      return { ok: false, code: "validation_failed", message: "map requires a personId" };
    }
    const person = await trx
      .selectFrom("identity.persons")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.personId)
      .executeTakeFirst();
    if (person === undefined) {
      return { ok: false, code: "not_found", message: "person not found in this tenant" };
    }
    const conversationId = newId();
    await trx
      .insertInto("communication.conversations")
      .values({
        id: conversationId,
        tenant_id: ctx.tenantId,
        person_id: input.personId,
        channel: exc.channel ?? "WHATSAPP",
        external_thread_id: exc.from_address,
        status: "OPEN",
        control_mode: "HUMAN_CONTROL",
        last_message_at: null,
        created_at: now(),
        updated_at: now(),
        resolved_at: null,
        archived_at: null,
      })
      .execute();
    await trx
      .updateTable("communication.exceptions")
      .set({
        status: "RESOLVED",
        person_id: input.personId,
        conversation_id: conversationId,
        reason: input.reason ?? "mapped to person by human",
        resolved_at: now(),
        updated_at: now(),
      })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", exc.id)
      .execute();
    await appendControlEvent(ctx, {
      conversationId,
      fromMode: null,
      toMode: "HUMAN_CONTROL",
      reason: "exception_resolved",
    });
    await emitAndEnqueue(ctx, {
      eventType: "conversation.started.v1",
      aggregateType: "conversation",
      aggregateId: conversationId,
      data: { conversation_id: conversationId, person_id: input.personId, via_exception: exc.id },
    });
    return { ok: true, data: { id: exc.id, status: "RESOLVED", conversationId } };
  }
  const mem = memoryStateOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 2 store available");
  }
  const exc = mem.exceptions.get(input.exceptionId);
  if (exc === undefined || exc.tenantId !== ctx.tenantId) {
    return { ok: false, code: "not_found", message: "exception not found in this tenant" };
  }
  if (exc.status !== "OPEN") {
    return { ok: false, code: "precondition_failed", message: `exception is already ${exc.status}` };
  }
  if (input.action === "discard") {
    if (input.reason === undefined) {
      return { ok: false, code: "validation_failed", message: "discard requires a reason" };
    }
    exc.status = "DISCARDED";
    exc.reason = input.reason;
    exc.resolvedAt = new Date();
    return { ok: true, data: { id: exc.id, status: "DISCARDED", conversationId: null } };
  }
  if (input.personId === undefined) {
    return { ok: false, code: "validation_failed", message: "map requires a personId" };
  }
  const person = mem.persons.get(input.personId);
  if (person === undefined || person.tenantId !== ctx.tenantId) {
    return { ok: false, code: "not_found", message: "person not found in this tenant" };
  }
  const conversationId = newId();
  mem.conversations.set(conversationId, {
    id: conversationId,
    tenantId: ctx.tenantId,
    personId: input.personId,
    channel: exc.channel ?? "WHATSAPP",
    externalThreadId: exc.fromAddress,
    status: "OPEN",
    controlMode: "HUMAN_CONTROL",
    lastMessageAt: null,
    resolvedAt: null,
    archivedAt: null,
  });
  exc.status = "RESOLVED";
  exc.personId = input.personId;
  exc.conversationId = conversationId;
  exc.reason = input.reason ?? "mapped to person by human";
  exc.resolvedAt = new Date();
  await emitAndEnqueue(ctx, {
    eventType: "conversation.started.v1",
    aggregateType: "conversation",
    aggregateId: conversationId,
    data: { conversation_id: conversationId, person_id: input.personId, via_exception: exc.id },
  });
  return { ok: true, data: { id: exc.id, status: "RESOLVED", conversationId } };
}

export function registerCommunicationCommands(bus: CommandBus): void {
  bus.register<StartManualInput, { id: string }>({
    name: "conversation.start_manual",
    permission: "conversation.reply",
    auditAction: "conversation.start_manual",
    auditResource: "conversation",
    input: startManualInput,
    handler: handleStartManual,
  });
  bus.register<SendManualInput, { messageId: string; deliveryStatus: string; providerMessageId: string | null }>({
    name: "message.send_manual",
    permission: "conversation.reply",
    auditAction: "message.send_manual",
    auditResource: "message",
    input: sendManualInput,
    handler: handleSendManual,
  });
  bus.register<
    IngestMessageInput,
    { messageId: string | null; conversationId: string | null; exceptionId: string | null; duplicate: boolean }
  >({
    name: "message.ingest",
    permission: "conversation.reply",
    auditAction: "message.ingest",
    auditResource: "message",
    input: ingestMessageInput,
    handler: handleIngest,
  });
  bus.register<ConversationIdInput, { id: string; controlMode: string; already: boolean }>({
    name: "conversation.assign",
    permission: "conversation.reply",
    auditAction: "conversation.assign",
    auditResource: "conversation",
    input: conversationIdInput,
    handler: controlHandler("HUMAN_CONTROL", "takeover", "conversation.human_takeover_started.v1"),
  });
  bus.register<ConversationIdInput, { id: string; controlMode: string; already: boolean }>({
    name: "conversation.release",
    permission: "conversation.reply",
    auditAction: "conversation.release",
    auditResource: "conversation",
    input: conversationIdInput,
    handler: controlHandler("AI_CONTROL", "returned_to_ai", "conversation.returned_to_ai.v1"),
  });
  bus.register<ConversationIdInput, { id: string; status: string }>({
    name: "conversation.close",
    permission: "conversation.reply",
    auditAction: "conversation.close",
    auditResource: "conversation",
    input: conversationIdInput,
    handler: handleClose,
  });
  bus.register<ResolveExceptionInput, { id: string; status: string; conversationId: string | null }>({
    name: "exception.resolve",
    permission: "conversation.reply",
    auditAction: "communication.exception.resolve",
    auditResource: "communication_exception",
    input: resolveExceptionInput,
    handler: handleResolveException,
  });
}
