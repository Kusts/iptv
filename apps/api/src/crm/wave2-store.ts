import type { Transaction } from "kysely";
import { buildEnvelope } from "@iptv/domain";
import type { Database } from "@iptv/database";
import type { CommandHandlerContext } from "../commands/command-bus.js";

/** Narrow the `AppTx.innerDb()` escape hatch to a live Kysely transaction. */
export function kyselyTrxOf(ctx: CommandHandlerContext): Transaction<Database> | null {
  const inner = ctx.tx.innerDb() as Record<string, unknown> | null;
  if (
    inner !== null &&
    typeof inner === "object" &&
    typeof (inner as { selectFrom?: unknown }).selectFrom === "function" &&
    typeof (inner as { insertInto?: unknown }).insertInto === "function"
  ) {
    return inner as unknown as Transaction<Database>;
  }
  return null;
}

/** In-memory Wave 2 state for unit tests (keyed by tx object, tenant-checked by callers). */
export interface Wave2MemoryState {
  persons: Map<string, { id: string; tenantId: string; status: string; canonicalName: string | null; locale: string | null; timezone: string | null }>;
  identities: Map<string, { id: string; tenantId: string; personId: string; identityType: string; normalizedValue: string; detachedAt: Date | null }>;
  leads: Map<string, { id: string; tenantId: string; personId: string; status: string; stage: string | null; createdAt: Date; qualifiedAt: Date | null; lostAt: Date | null; closedReason: string | null }>;
  conversations: Map<string, { id: string; tenantId: string; personId: string; channel: string; externalThreadId: string | null; status: string; controlMode: string; lastMessageAt: Date | null; resolvedAt: Date | null; archivedAt: Date | null }>;
  messages: Map<string, { id: string; tenantId: string; conversationId: string; personId: string; direction: string; channel: string; senderType: string; externalMessageId: string | null; bodyText: string | null; occurredAt: Date }>;
  deliveries: Array<{ id: string; tenantId: string; messageId: string; provider: string; status: string; attemptNo: number; externalDeliveryId: string | null; errorCode: string | null }>;
  preferences: Array<{ tenantId: string; personId: string; purposeKey: string; channel: string; status: string }>;
  suppressions: Array<{ tenantId: string; personId: string | null; channel: string | null; purposeKey: string | null; reason: string; startsAt: Date; endsAt: Date | null }>;
  controlEvents: Array<{ id: string; tenantId: string; conversationId: string; fromMode: string | null; toMode: string; reason: string | null; actorType: string; actorId: string | null }>;
  exceptions: Map<string, { id: string; tenantId: string; kind: string; status: string; channel: string | null; externalMessageId: string | null; fromAddress: string | null; reason: string | null; conversationId: string | null; personId: string | null; resolvedAt: Date | null }>;
  channels: Map<string, { tenantId: string; channel: string; tenantKey: string; status: string }>;
}

const memoryStates = new WeakMap<object, Wave2MemoryState>();

function emptyState(): Wave2MemoryState {
  return {
    persons: new Map(),
    identities: new Map(),
    leads: new Map(),
    conversations: new Map(),
    messages: new Map(),
    deliveries: [],
    preferences: [],
    suppressions: [],
    controlEvents: [],
    exceptions: new Map(),
    channels: new Map(),
  };
}

/** Memory state for the unit-test path (`innerDb()` is the MemoryAppTx itself). */
export function memoryStateOf(ctx: CommandHandlerContext): Wave2MemoryState | null {
  if (kyselyTrxOf(ctx) !== null) {
    return null;
  }
  const key = ctx.tx.innerDb() as object;
  let state = memoryStates.get(key);
  if (state === undefined) {
    state = emptyState();
    memoryStates.set(key, state);
  }
  return state;
}

export async function emitAndEnqueue(
  ctx: CommandHandlerContext,
  input: { eventType: string; aggregateType: string; aggregateId: string; data: Record<string, unknown> },
): Promise<void> {
  const version = await ctx.tx.nextAggregateVersion(input.aggregateType, input.aggregateId);
  const envelope = buildEnvelope({
    event_type: input.eventType,
    tenant_id: ctx.tenantId,
    aggregate_type: input.aggregateType,
    aggregate_id: input.aggregateId,
    aggregate_version: version,
    data: input.data,
    actor: { type: ctx.actor.actorType, id: ctx.actor.userId },
    correlation_id: ctx.correlationId,
    causation_id: ctx.causationId,
  });
  const { domainEventId } = await ctx.tx.emitDomainEvent({ envelope });
  await ctx.tx.enqueueOutbox({
    domainEventId,
    topic: input.eventType,
    messageKey: input.aggregateId,
    payload: envelope,
    headers: { correlation_id: ctx.correlationId },
  });
}
