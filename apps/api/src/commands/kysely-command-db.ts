import { Inject, Injectable } from "@nestjs/common";
import type { Kysely, Transaction } from "kysely";
import { buildAuditRow } from "@iptv/auth";
import type { Database } from "@iptv/database";
import { newId, now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type {
  AppTx,
  DbPort,
  IdempotencyClaim,
  NewDomainEvent,
  NewOutboxMessage,
  NewReviewRequest,
  StoredReviewRequest,
} from "./command-bus.js";
import type { AuditEventInput } from "@iptv/auth";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

function toStored(tenantId: string, row: {
  id: string;
  status: string;
  review_mode: string;
  reason: string;
  risk_class: string;
  priority: string;
  resource_type: string;
  resource_id: string;
  requested_by_type: string;
  requested_by_id: string | null;
  summary: string;
  context_json: unknown;
  created_at: Date;
  resolved_at: Date | null;
}): StoredReviewRequest {
  return {
    id: row.id,
    tenantId,
    status: row.status,
    reviewMode: row.review_mode,
    reason: row.reason,
    riskClass: row.risk_class,
    priority: row.priority,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    requestedByType: row.requested_by_type,
    requestedById: row.requested_by_id,
    summary: row.summary,
    contextJson: row.context_json,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/** Kysely-backed `AppTx`: every write lands in the caller's transaction. */
export class KyselyAppTx implements AppTx {
  constructor(
    private readonly trx: Transaction<Database>,
    private readonly tenantId: string,
  ) {}

  async emitDomainEvent(input: NewDomainEvent): Promise<{ domainEventId: string }> {
    const e = input.envelope;
    const version = await this.nextAggregateVersion(e.aggregate_type, e.aggregate_id);
    if (version !== e.aggregate_version) {
      throw new Error(
        `stale aggregate version for ${e.aggregate_type}/${e.aggregate_id}: expected ${version}, envelope carries ${e.aggregate_version}`,
      );
    }
    const inserted = await this.trx
      .insertInto("platform.domain_events")
      .values({
        id: newId(),
        event_id: e.event_id,
        tenant_id: this.tenantId,
        event_type: e.event_type,
        aggregate_type: e.aggregate_type,
        aggregate_id: e.aggregate_id,
        aggregate_version: e.aggregate_version,
        occurred_at: new Date(e.occurred_at),
        recorded_at: new Date(e.recorded_at),
        correlation_id: e.correlation_id,
        causation_id: e.causation_id ?? null,
        actor_type: e.actor.type,
        actor_id: e.actor.id,
        schema_version: e.schema_version,
        data_json: e.data,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { domainEventId: inserted.id };
  }

  async nextAggregateVersion(aggregateType: string, aggregateId: string): Promise<number> {
    const prev = await this.trx
      .selectFrom("platform.domain_events")
      .select("aggregate_version")
      .where("tenant_id", "=", this.tenantId)
      .where("aggregate_type", "=", aggregateType)
      .where("aggregate_id", "=", aggregateId)
      .orderBy("aggregate_version", "desc")
      .limit(1)
      .executeTakeFirst();
    // `aggregate_version` is bigint: node-pg returns it as a string.
    return Number(prev?.aggregate_version ?? 0) + 1;
  }

  async enqueueOutbox(input: NewOutboxMessage): Promise<void> {
    await this.trx
      .insertInto("platform.outbox_messages")
      .values({
        id: newId(),
        tenant_id: this.tenantId,
        domain_event_id: input.domainEventId,
        topic: input.topic,
        message_key: input.messageKey ?? null,
        payload_json: input.payload,
        headers_json: input.headers ?? {},
        state: "PENDING",
        attempt_count: 0,
        next_attempt_at: now(),
        published_at: null,
        last_error_code: null,
        created_at: now(),
      })
      .execute();
  }

  async writeAudit(input: AuditEventInput): Promise<void> {
    const row = buildAuditRow(input);
    await this.trx
      .insertInto("platform.audit_log")
      .values({
        id: newId(),
        tenant_id: row.tenant_id,
        actor_type: row.actor_type,
        actor_id: row.actor_id,
        action_key: row.action_key,
        resource_type: row.resource_type,
        resource_id: row.resource_id,
        correlation_id: row.correlation_id,
        metadata_json: row.metadata_json,
        occurred_at: now(),
      })
      .execute();
  }

  async createReviewRequest(input: NewReviewRequest): Promise<StoredReviewRequest> {
    const row = await this.trx
      .insertInto("agent.human_review_requests")
      .values({
        id: newId(),
        tenant_id: this.tenantId,
        status: "REQUESTED",
        review_mode: input.reviewMode,
        reason: input.reason,
        risk_class: input.riskClass,
        priority: input.priority,
        resource_type: input.resourceType,
        resource_id: input.resourceId,
        requested_by_type: input.requestedByType,
        requested_by_id: input.requestedById,
        assigned_to_user_id: null,
        summary: input.summary,
        context_json: input.contextJson,
        sla_due_at: null,
        escalation_policy: null,
        created_at: now(),
        resolved_at: null,
      })
      .returning([
        "id",
        "status",
        "review_mode",
        "reason",
        "risk_class",
        "priority",
        "resource_type",
        "resource_id",
        "requested_by_type",
        "requested_by_id",
        "summary",
        "context_json",
        "created_at",
        "resolved_at",
      ])
      .executeTakeFirstOrThrow();
    return toStored(this.tenantId, row);
  }

  async getReviewRequest(id: string): Promise<StoredReviewRequest | null> {
    const row = await this.trx
      .selectFrom("agent.human_review_requests")
      .select([
        "id",
        "status",
        "review_mode",
        "reason",
        "risk_class",
        "priority",
        "resource_type",
        "resource_id",
        "requested_by_type",
        "requested_by_id",
        "summary",
        "context_json",
        "created_at",
        "resolved_at",
      ])
      .where("tenant_id", "=", this.tenantId)
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    return toStored(this.tenantId, row);
  }

  async resolveReviewRequest(id: string): Promise<StoredReviewRequest | null> {
    const row = await this.trx
      .updateTable("agent.human_review_requests")
      .set({ status: "RESOLVED", resolved_at: now() })
      .where("tenant_id", "=", this.tenantId)
      .where("id", "=", id)
      .returning([
        "id",
        "status",
        "review_mode",
        "reason",
        "risk_class",
        "priority",
        "resource_type",
        "resource_id",
        "requested_by_type",
        "requested_by_id",
        "summary",
        "context_json",
        "created_at",
        "resolved_at",
      ])
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    return toStored(this.tenantId, row);
  }

  async createReviewAction(
    requestId: string,
    actionType: string,
    actorUserId: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    await this.trx
      .insertInto("agent.human_review_actions")
      .values({
        id: newId(),
        tenant_id: this.tenantId,
        human_review_request_id: requestId,
        action_type: actionType,
        actor_user_id: actorUserId,
        content_json: content,
        created_at: now(),
      })
      .execute();
  }
}

/** Production `DbPort` over Kysely/Postgres. */
@Injectable()
export class KyselyCommandDb implements DbPort {
  constructor(@Inject("DB") private readonly db: Kysely<Database> | null) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new Error("database is not configured");
    }
    return this.db;
  }

  async withTransaction<T>(tenantId: string, fn: (tx: AppTx) => Promise<T>): Promise<T> {
    return this.requireDb()
      .transaction()
      .execute(async (trx) => fn(new KyselyAppTx(trx, tenantId)));
  }

  async claimIdempotency(input: {
    tenantId: string;
    scope: string;
    key: string;
    requestHash: string;
  }): Promise<IdempotencyClaim> {
    const db = this.requireDb();
    try {
      await db
        .insertInto("platform.idempotency_keys")
        .values({
          id: newId(),
          tenant_id: input.tenantId,
          scope: input.scope,
          idempotency_key: input.key,
          request_hash: input.requestHash,
          resource_type: null,
          resource_id: null,
          response_status: null,
          response_json: null,
          state: "IN_PROGRESS",
          locked_until: null,
          created_at: now(),
          completed_at: null,
          expires_at: null,
        })
        .execute();
      return { status: "claimed" };
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
    }
    const row = await db
      .selectFrom("platform.idempotency_keys")
      .select(["state", "request_hash", "response_status", "response_json"])
      .where("tenant_id", "=", input.tenantId)
      .where("scope", "=", input.scope)
      .where("idempotency_key", "=", input.key)
      .executeTakeFirst();
    if (row === undefined) {
      throw new Error("idempotency claim lost race");
    }
    if (row.state === "SUCCEEDED") {
      if (row.request_hash === input.requestHash) {
        return {
          status: "replay",
          responseStatus: row.response_status,
          response: row.response_json as CommandResult,
        };
      }
      return { status: "conflict" };
    }
    if (row.state === "FAILED" && row.request_hash === input.requestHash) {
      // Retry after a failed attempt reclaims the key.
      await db
        .updateTable("platform.idempotency_keys")
        .set({ state: "IN_PROGRESS", response_status: null, response_json: null, completed_at: null })
        .where("tenant_id", "=", input.tenantId)
        .where("scope", "=", input.scope)
        .where("idempotency_key", "=", input.key)
        .execute();
      return { status: "claimed" };
    }
    if (row.state === "FAILED") {
      return { status: "conflict" };
    }
    return { status: "in_progress" };
  }

  async finishIdempotency(input: {
    tenantId: string;
    scope: string;
    key: string;
    state: "SUCCEEDED" | "FAILED";
    responseStatus: number | null;
    response: CommandResult;
  }): Promise<void> {
    await this.requireDb()
      .updateTable("platform.idempotency_keys")
      .set({
        state: input.state,
        response_status: input.responseStatus,
        response_json: input.response,
        completed_at: now(),
      })
      .where("tenant_id", "=", input.tenantId)
      .where("scope", "=", input.scope)
      .where("idempotency_key", "=", input.key)
      .execute();
  }
}
