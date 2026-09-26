import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  idempotencyScopeOf,
  type CommandActor,
  type CommandResult,
} from "@iptv/domain";
import type { EventEnvelope } from "@iptv/domain";
import type { AuditEventInput } from "@iptv/auth";

/** New domain-event persistence input (envelope already validated). */
export interface NewDomainEvent {
  envelope: EventEnvelope;
}

/** New outbox message persistence input. */
export interface NewOutboxMessage {
  domainEventId: string;
  topic: string;
  messageKey?: string | null;
  payload: EventEnvelope;
  headers?: Record<string, unknown>;
}

/** Stored review-request projection shared by the Kysely and memory txs. */
export interface StoredReviewRequest {
  id: string;
  tenantId: string;
  status: string;
  reviewMode: string;
  reason: string;
  riskClass: string;
  priority: string;
  resourceType: string;
  resourceId: string;
  requestedByType: string;
  requestedById: string | null;
  summary: string;
  contextJson: unknown;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface NewReviewRequest {
  resourceType: string;
  resourceId: string;
  reviewMode: string;
  reason: string;
  riskClass: string;
  priority: string;
  summary: string;
  contextJson: Record<string, unknown>;
  requestedByType: string;
  requestedById: string | null;
}

/** Stored policy document row shared by the Kysely and memory txs. */
export interface StoredPolicyDocument {
  id: string;
  tenantId: string | null;
  family: string;
  scope: string;
  class: string;
  version: number;
  status: string;
  document: Record<string, unknown>;
  publishedAt: Date | null;
}

export interface NewPolicyDocument {
  tenantId: string | null;
  family: string;
  scope: string;
  class: string;
  version: number;
  status: string;
  document: Record<string, unknown>;
  publishedAt: Date | null;
}

/** Stored capability row shared by the Kysely and memory txs. */
export interface StoredCapability {
  key: string;
  ownerContext: string;
  availability: string;
  certificationStatus: string;
  riskLevel: string;
  mvpPhase: string;
  manualEquivalent: string;
  policyFamily: string;
  degradation: string;
  permissions: string[];
}

export interface NewCapability {
  key: string;
  ownerContext: string;
  availability: string;
  certificationStatus: string;
  riskLevel: string;
  mvpPhase: string;
  manualEquivalent: string;
  policyFamily: string;
  degradation: string;
  permissions: string[];
}

/**
 * Transactional port handlers program against. The Kysely implementation
 * runs every method in ONE transaction together with the state change;
 * the memory implementation backs unit tests.
 */
export interface AppTx {
  emitDomainEvent(input: NewDomainEvent): Promise<{ domainEventId: string }>;
  enqueueOutbox(input: NewOutboxMessage): Promise<void>;
  writeAudit(input: AuditEventInput): Promise<void>;
  nextAggregateVersion(aggregateType: string, aggregateId: string): Promise<number>;
  createReviewRequest(input: NewReviewRequest): Promise<StoredReviewRequest>;
  getReviewRequest(id: string): Promise<StoredReviewRequest | null>;
  resolveReviewRequest(id: string): Promise<StoredReviewRequest | null>;
  createReviewAction(requestId: string, actionType: string, actorUserId: string, content: Record<string, unknown>): Promise<void>;
  nextPolicyVersion(family: string, scope: string, tenantId: string | null): Promise<number>;
  createPolicyDocument(input: NewPolicyDocument): Promise<StoredPolicyDocument>;
  listPublishedPolicies(family: string, tenantId: string, partnerId?: string): Promise<StoredPolicyDocument[]>;
  getCapability(key: string): Promise<StoredCapability | null>;
  listCapabilities(): Promise<StoredCapability[]>;
  createCapability(input: NewCapability): Promise<StoredCapability>;
  setCapabilityAvailability(
    key: string,
    availability: string,
    reason: string,
    actorId: string | null,
  ): Promise<StoredCapability | null>;
}

export type IdempotencyClaim =
  | { status: "claimed" }
  | { status: "replay"; responseStatus: number | null; response: CommandResult }
  | { status: "conflict" }
  | { status: "in_progress" };

/**
 * Database port: idempotency claims plus a single-transaction runner.
 * Keeps the bus unit-testable with an in-memory fake.
 */
export interface DbPort {
  withTransaction<T>(tenantId: string, fn: (tx: AppTx) => Promise<T>): Promise<T>;
  claimIdempotency(input: {
    tenantId: string;
    scope: string;
    key: string;
    requestHash: string;
  }): Promise<IdempotencyClaim>;
  finishIdempotency(input: {
    tenantId: string;
    scope: string;
    key: string;
    state: "SUCCEEDED" | "FAILED";
    responseStatus: number | null;
    response: CommandResult;
  }): Promise<void>;
}

export interface CommandHandlerContext {
  actor: CommandActor;
  tenantId: string;
  commandId: string;
  correlationId: string;
  causationId: string | null;
  tx: AppTx;
}

export interface CommandDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  permission: string;
  idempotencyScope?: string;
  /** Audit `action_key` written atomically with the command (e.g. `human_review.request`). */
  auditAction: string;
  /** Audit `resource_type` (e.g. `human_review_request`). */
  auditResource: string;
  input: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  handler: (ctx: CommandHandlerContext, input: TInput) => Promise<CommandResult<TOutput>>;
}

export interface ExecuteOptions {
  commandId?: string;
  correlationId?: string;
  causationId?: string | null;
  idempotencyKey?: string;
}

export function commandActorFromRequestParts(input: {
  userId: string;
  isPlatformAdmin: boolean;
  tenantId: string | null;
  roleKeys: string[];
  permissions: string[];
  actorType?: CommandActor["actorType"];
}): CommandActor {
  return {
    userId: input.userId,
    isPlatformAdmin: input.isPlatformAdmin,
    tenantId: input.tenantId,
    roleKeys: input.roleKeys,
    permissions: input.permissions,
    actorType: input.actorType ?? "human",
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Hand-rolled minimal command bus (W1-06). No CQRS framework.
 *
 * `execute` flow: registry lookup → server-side permission check (tenant
 * from the actor context, never from input) → Zod input parse →
 * idempotency claim → handler inside ONE transaction (state change +
 * domain event + outbox + audit atomically) → idempotency completion.
 * Known failures return the `CommandResult` union; unexpected throws are
 * programmer bugs and propagate (idempotency marked FAILED).
 */
@Injectable()
export class CommandBus {
  private readonly registry = new Map<string, CommandDefinition<unknown, unknown>>();

  constructor(@Inject("COMMAND_DB") private readonly db: DbPort | null) {}

  register<TInput, TOutput>(def: CommandDefinition<TInput, TOutput>): void {
    if (this.registry.has(def.name)) {
      throw new Error(`command already registered: ${def.name}`);
    }
    this.registry.set(def.name, def as CommandDefinition<unknown, unknown>);
  }

  names(): string[] {
    return [...this.registry.keys()];
  }

  async execute<TOutput>(
    actor: CommandActor,
    name: string,
    rawInput: unknown,
    opts: ExecuteOptions = {},
  ): Promise<CommandResult<TOutput>> {
    const def = this.registry.get(name) as CommandDefinition<unknown, TOutput> | undefined;
    if (def === undefined) {
      return { ok: false, code: "not_found", message: `unknown command: ${name}` };
    }
    if (this.db === null) {
      throw new Error("database is not configured");
    }
    const db = this.db;
    const tenantId = actor.tenantId;
    if (tenantId === null && !actor.isPlatformAdmin) {
      return { ok: false, code: "forbidden", message: "no active tenant selected" };
    }
    // Platform admins act within an explicit tenant context; commands are
    // always tenant-scoped (outbox drain stays the platform-only exception).
    const scopeTenant = tenantId as string;
    if (!actor.isPlatformAdmin) {
      if (!actor.permissions.includes(def.permission)) {
        return { ok: false, code: "forbidden", message: `missing permission: ${def.permission}` };
      }
    }
    const parsed = (def.input as z.ZodType<unknown, z.ZodTypeDef, unknown>).safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok: false,
        code: "validation_failed",
        message: `invalid input for command ${name}`,
        issues: parsed.error.flatten(),
      };
    }
    const input = parsed.data as unknown;
    const commandId = opts.commandId ?? crypto.randomUUID();
    const correlationId = opts.correlationId ?? crypto.randomUUID();
    const causationId = opts.causationId ?? null;

    const scope = idempotencyScopeOf({ name: def.name, permission: def.permission });
    let idempotency: { tenantId: string; scope: string; key: string } | null = null;
    if (opts.idempotencyKey !== undefined) {
      const key = opts.idempotencyKey;
      const requestHash = sha256Hex(JSON.stringify({ name, input }));
      const claim = await db.claimIdempotency({ tenantId: scopeTenant, scope, key, requestHash });
      if (claim.status === "replay") {
        return claim.response as CommandResult<TOutput>;
      }
      if (claim.status === "conflict") {
        return {
          ok: false,
          code: "validation_failed",
          message: "idempotency key already used with a different payload",
        };
      }
      if (claim.status === "in_progress") {
        return {
          ok: false,
          code: "precondition_failed",
          message: "command with this idempotency key is already in progress",
        };
      }
      idempotency = { tenantId: scopeTenant, scope, key };
    }

    let result: CommandResult<TOutput>;
    try {
      result = await db.withTransaction<CommandResult<TOutput>>(scopeTenant, async (tx) => {
        const invoke = def.handler as (
          ctx: CommandHandlerContext,
          input: unknown,
        ) => Promise<CommandResult<TOutput>>;
        const handlerResult = await invoke(
          { actor, tenantId: scopeTenant, commandId, correlationId, causationId, tx },
          input,
        );
        await tx.writeAudit({
          tenantId: scopeTenant,
          actorType: actor.actorType,
          actorId: actor.userId,
          action: def.auditAction,
          resourceType: def.auditResource,
          resourceId: extractResourceId(handlerResult),
          correlationId,
          metadata: { command: name, command_id: commandId, result: handlerResult.ok ? "ok" : handlerResult.code },
        });
        return handlerResult;
      });
    } catch (err) {
      if (idempotency !== null) {
        await db.finishIdempotency({
          ...idempotency,
          state: "FAILED",
          responseStatus: null,
          response: { ok: false, code: "precondition_failed", message: "command failed" },
        });
      }
      throw err;
    }
    if (idempotency !== null) {
      await db.finishIdempotency({
        ...idempotency,
        state: "SUCCEEDED",
        responseStatus: result.ok ? 200 : httpStatusOf(result),
        response: result,
      });
    }
    return result;
  }
}

function httpStatusOf(result: CommandResult): number {
  if (result.ok) {
    return 200;
  }
  switch (result.code) {
    case "validation_failed":
      return 400;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "precondition_failed":
      return 409;
  }
}

function extractResourceId(result: CommandResult): string | null {
  if (!result.ok) {
    return null;
  }
  const data = result.data as { id?: unknown } | null;
  if (data !== null && typeof data === "object" && typeof data.id === "string") {
    return data.id;
  }
  return null;
}
