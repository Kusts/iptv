import { Inject, Injectable } from "@nestjs/common";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import { buildAuditRow } from "@iptv/auth";
import type { Database } from "@iptv/database";
import { readTenantSetting, withTenantTransaction } from "@iptv/database";
import { newId, now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type {
  AppTx,
  DbPort,
  IdempotencyClaim,
  NewCapability,
  NewDomainEvent,
  NewOutboxMessage,
  NewPolicyDocument,
  NewReviewRequest,
  StoredCapability,
  StoredPolicyDocument,
  StoredReviewRequest,
} from "./command-bus.js";
import type { AuditEventInput } from "@iptv/auth";

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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toStoredPolicy(row: {
  id: string;
  tenant_id: string | null;
  family: string;
  scope: string;
  class: string;
  version: number;
  status: string;
  document: unknown;
  published_at: Date | null;
}): StoredPolicyDocument {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    family: row.family,
    scope: row.scope,
    class: row.class,
    // `version` is an integer; node-pg may still hand it back as a string.
    version: Number(row.version),
    status: row.status,
    document: asRecord(row.document),
    publishedAt: row.published_at,
  };
}

function toStoredCapability(row: {
  key: string;
  owner_context: string;
  availability: string;
  certification_status: string;
  risk_level: string;
  mvp_phase: string;
  manual_equivalent: string;
  policy_family: string;
  degradation: string;
  permissions: unknown;
}): StoredCapability {
  return {
    key: row.key,
    ownerContext: row.owner_context,
    availability: row.availability,
    certificationStatus: row.certification_status,
    riskLevel: row.risk_level,
    mvpPhase: row.mvp_phase,
    manualEquivalent: row.manual_equivalent,
    policyFamily: row.policy_family,
    degradation: row.degradation,
    permissions: asStringArray(row.permissions),
  };
}

/** Kysely-backed `AppTx`: every write lands in the caller's transaction. */
export class KyselyAppTx implements AppTx {
  /**
   * Buffered bus triples (053): `emitDomainEvent` + `enqueueOutbox` only
   * stage rows in memory; the single `platform.append_bus_rows` producer call
   * per triple happens in `writeAudit` (the bus always audits after the
   * handler, in the same transaction) or audit-less at `withTransaction`
   * commit for direct-applier flows without the bus. Buffering keeps the
   * event/outbox/audit triple atomic in ONE producer call while preserving
   * the pass-through `domainEventId` handlers rely on (client-generated, no
   * round trip). `nextAggregateVersion` sees staged versions, so N emits for
   * one aggregate in one transaction sequence correctly.
   */
  private readonly pendingEvents = new Map<string, NewDomainEvent>();
  private readonly pendingOutbox: NewOutboxMessage[] = [];

  constructor(
    private readonly trx: Transaction<Database>,
    private readonly tenantId: string,
  ) {}

  innerDb(): Transaction<Database> {
    return this.trx;
  }

  /**
   * Narrow cross-tenant exception for PARTNER policy (053 split): the command
   * bus always runs under the ACTOR's tenant, but an authorized PARTNER
   * publish targets ANOTHER tenant's row. RLS `WITH CHECK` would refuse that
   * insert (and the version lookup would go blind and restart at 1), so the
   * target-scoped statements run with `app.tenant_id` temporarily set to the
   * TARGET tenant -- restored in `finally` before any bus producer runs, so
   * the audit/outbox triple still lands under the command tenant. Refuses
   * loudly for any other scope: only PARTNER documents may name a tenant
   * other than the command's (no generic cross-tenant opening).
   */
  private async runAsPolicyTargetTenant<T>(
    scope: string,
    targetTenantId: string | null,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (targetTenantId === null || targetTenantId === this.tenantId) {
      return fn();
    }
    if (scope !== "PARTNER") {
      throw new Error(
        `refusing cross-tenant policy access for scope ${scope}: only PARTNER documents may target another tenant`,
      );
    }
    const prior = (await readTenantSetting(this.trx)) ?? this.tenantId;
    await sql`SELECT set_config('app.tenant_id', ${targetTenantId}, true)`.execute(this.trx);
    try {
      return await fn();
    } finally {
      await sql`SELECT set_config('app.tenant_id', ${prior}, true)`.execute(this.trx);
    }
  }

  async emitDomainEvent(input: NewDomainEvent): Promise<{ domainEventId: string }> {
    const e = input.envelope;
    const version = await this.nextAggregateVersion(e.aggregate_type, e.aggregate_id);
    if (version !== e.aggregate_version) {
      throw new Error(
        `stale aggregate version for ${e.aggregate_type}/${e.aggregate_id}: expected ${version}, envelope carries ${e.aggregate_version}`,
      );
    }
    // Client-generated id, staged until the flush (writeAudit, or
    // audit-less at withTransaction commit for direct-applier flows).
    const domainEventId = newId();
    this.pendingEvents.set(domainEventId, input);
    return { domainEventId };
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
    let version = Number(prev?.aggregate_version ?? 0) + 1;
    // Staged (not yet flushed) triples are invisible to the SELECT above: a
    // handler emitting N events for one aggregate in one transaction would
    // otherwise compute version 1 N times and collide at flush. Bump past
    // anything already staged for this aggregate (053 buffering).
    for (const staged of this.pendingEvents.values()) {
      const e = staged.envelope;
      if (
        e.aggregate_type === aggregateType &&
        e.aggregate_id === aggregateId &&
        e.aggregate_version >= version
      ) {
        version = e.aggregate_version + 1;
      }
    }
    return version;
  }

  async enqueueOutbox(input: NewOutboxMessage): Promise<void> {
    if (!this.pendingEvents.has(input.domainEventId)) {
      throw new Error(
        `enqueueOutbox references an unstaged domain event: ${input.domainEventId}`,
      );
    }
    this.pendingOutbox.push(input);
  }

  async writeAudit(input: AuditEventInput): Promise<void> {
    const row = buildAuditRow(input);
    if (row.tenant_id !== this.tenantId) {
      throw new Error("audit tenant does not match the command transaction tenant");
    }
    await this.flushStagedTriples({
      id: newId(),
      actorType: row.actor_type,
      actorId: row.actor_id,
      actionKey: row.action_key,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      correlationId: row.correlation_id,
      metadataJson: row.metadata_json,
      occurredAt: now(),
    });
  }

  /**
   * Flush staged bus triples through `platform.append_bus_rows` (one producer
   * call per triple, same transaction). The bus always passes its command
   * audit (attached to the first triple; standalone audit row when nothing
   * was emitted). Direct-applier flows (provider/trial dispatchers drive
   * `withTransaction` without the bus, so no audit exists) flush with `null`
   * at commit -- the event+PENDING-outbox pair still lands atomically.
   */
  async flushStagedTriples(
    audit: {
      id: string;
      actorType: string;
      actorId: string | null;
      actionKey: string;
      resourceType: string;
      resourceId: string | null;
      correlationId: string | null;
      metadataJson: Record<string, unknown>;
      occurredAt: Date;
    } | null,
  ): Promise<void> {
    const staged = this.pendingOutbox.map((outbox) => {
      const event = this.pendingEvents.get(outbox.domainEventId);
      if (event === undefined) {
        throw new Error(
          `enqueueOutbox references an unstaged domain event: ${outbox.domainEventId}`,
        );
      }
      return { event, outbox };
    });
    this.pendingEvents.clear();
    this.pendingOutbox.length = 0;
    if (staged.length === 0) {
      if (audit === null) {
        return;
      }
      // No emitted events (early-out / not_found paths still audit): the
      // standalone producer owns the row; no direct table write.
      await sql`select platform.audit_write(${this.tenantId}::uuid, ${audit.actorType}, ${audit.actorId}, ${audit.actionKey}, ${audit.resourceType}, ${audit.resourceId}, ${audit.correlationId}, ${JSON.stringify(audit.metadataJson)}::jsonb)`.execute(
        this.trx,
      );
      return;
    }
    let attached = audit;
    for (const { event, outbox } of staged) {
      const e = event.envelope;
      const current = attached;
      attached = null;
      // The bus triple (event + PENDING outbox + audit) in ONE producer call.
      // Direct inserts into the three tables are prohibited here: under
      // `iptv_app` the outbox table carries no grant/policy at all (050).
      await sql`select platform.append_bus_rows(${this.tenantId}::uuid, ${e.event_id}::uuid, ${e.event_type}, ${e.aggregate_type}, ${e.aggregate_id}::uuid, ${e.aggregate_version}, ${new Date(e.occurred_at).toISOString()}::timestamptz, ${new Date(e.recorded_at).toISOString()}::timestamptz, ${e.correlation_id}::uuid, ${e.causation_id ?? null}, ${e.actor.type}, ${e.actor.id ?? null}, ${e.schema_version}, ${JSON.stringify(e.data)}::jsonb, ${newId()}::uuid, ${outbox.topic}, ${outbox.messageKey ?? null}, ${JSON.stringify(outbox.payload)}::jsonb, ${JSON.stringify(outbox.headers ?? {})}::jsonb, ${current?.id ?? null}, ${current?.actorType ?? null}, ${current?.actorId ?? null}, ${current?.actionKey ?? null}, ${current?.resourceType ?? null}, ${current?.resourceId ?? null}, ${current?.correlationId ?? null}, ${current !== null ? JSON.stringify(current.metadataJson) : null}, ${current?.occurredAt.toISOString() ?? null})`.execute(
        this.trx,
      );
    }
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

  async nextPolicyVersion(family: string, scope: string, tenantId: string | null): Promise<number> {
    // PARTNER publishes targeting another tenant read the version counter
    // under the TARGET tenant (own-tenant rows are invisible cross-tenant
    // under RLS, so an unscoped read would restart at 1 and collide).
    return this.runAsPolicyTargetTenant(scope, tenantId, async () => {
    let query = this.trx
      .selectFrom("platform.policy_documents")
      .select("version")
      .where("family", "=", family)
      .where("scope", "=", scope)
      .orderBy("version", "desc")
      .limit(1);
    query =
      tenantId === null
        ? query.where("tenant_id", "is", null)
        : query.where("tenant_id", "=", tenantId);
    const prev = await query.executeTakeFirst();
    return Number(prev?.version ?? 0) + 1;
    });
  }

  async createPolicyDocument(input: NewPolicyDocument): Promise<StoredPolicyDocument> {
    // PARTNER publishes targeting another tenant insert under the TARGET
    // tenant (RLS WITH CHECK refuses cross-tenant inserts in the command
    // tenant's context). Any non-PARTNER cross-tenant target throws inside.
    return this.runAsPolicyTargetTenant(input.scope, input.tenantId, async () => {
    const row = await this.trx
      .insertInto("platform.policy_documents")
      .values({
        id: newId(),
        tenant_id: input.tenantId,
        family: input.family,
        scope: input.scope,
        class: input.class,
        version: input.version,
        status: input.status,
        document: input.document,
        published_at: input.publishedAt,
        created_at: now(),
        updated_at: now(),
      })
      .returning([
        "id",
        "tenant_id",
        "family",
        "scope",
        "class",
        "version",
        "status",
        "document",
        "published_at",
      ])
      .executeTakeFirstOrThrow();
    return toStoredPolicy(row);
    });
  }

  async listPublishedPolicies(
    family: string,
    tenantId: string,
    partnerId?: string,
  ): Promise<StoredPolicyDocument[]> {
    const partner = partnerId ?? tenantId;
    if (partner !== tenantId) {
      // Named-partner layer under RLS: another tenant's PARTNER rows are
      // invisible in the command tenant's context, so the own layers
      // (PLATFORM globals + TENANT rows) read here and the exact named
      // partner's PARTNER layer (PUBLISHED, same family) reads under the
      // PARTNER's tenant instead -- never a cross-tenant wildcard. Any
      // non-PARTNER misuse throws inside.
      const own = await this.trx
        .selectFrom("platform.policy_documents")
        .select([
          "id",
          "tenant_id",
          "family",
          "scope",
          "class",
          "version",
          "status",
          "document",
          "published_at",
        ])
        .where("family", "=", family)
        .where("status", "=", "PUBLISHED")
        .where((eb) =>
          eb.or([
            eb.and([eb("scope", "=", "PLATFORM"), eb("tenant_id", "is", null)]),
            eb.and([eb("scope", "=", "TENANT"), eb("tenant_id", "=", tenantId)]),
          ]),
        )
        .orderBy("version", "desc")
        .execute();
      const partnerRows = await this.runAsPolicyTargetTenant("PARTNER", partner, () =>
        this.trx
          .selectFrom("platform.policy_documents")
          .select([
            "id",
            "tenant_id",
            "family",
            "scope",
            "class",
            "version",
            "status",
            "document",
            "published_at",
          ])
          .where("family", "=", family)
          .where("status", "=", "PUBLISHED")
          .where("scope", "=", "PARTNER")
          .where("tenant_id", "=", partner)
          .orderBy("version", "desc")
          .execute(),
      );
      return [...own, ...partnerRows].map(toStoredPolicy);
    }
    const rows = await this.trx
      .selectFrom("platform.policy_documents")
      .select([
        "id",
        "tenant_id",
        "family",
        "scope",
        "class",
        "version",
        "status",
        "document",
        "published_at",
      ])
      .where("family", "=", family)
      .where("status", "=", "PUBLISHED")
      .where((eb) =>
        eb.or([
          eb.and([eb("scope", "=", "PLATFORM"), eb("tenant_id", "is", null)]),
          eb.and([eb("scope", "=", "TENANT"), eb("tenant_id", "=", tenantId)]),
          eb.and([eb("scope", "=", "PARTNER"), eb("tenant_id", "=", partner)]),
        ]),
      )
      .orderBy("version", "desc")
      .execute();
    return rows.map(toStoredPolicy);
  }

  async getCapability(key: string): Promise<StoredCapability | null> {
    const row = await this.trx
      .selectFrom("platform.capabilities")
      .select([
        "key",
        "owner_context",
        "availability",
        "certification_status",
        "risk_level",
        "mvp_phase",
        "manual_equivalent",
        "policy_family",
        "degradation",
        "permissions",
      ])
      .where("key", "=", key)
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    return toStoredCapability(row);
  }

  async listCapabilities(): Promise<StoredCapability[]> {
    const rows = await this.trx
      .selectFrom("platform.capabilities")
      .select([
        "key",
        "owner_context",
        "availability",
        "certification_status",
        "risk_level",
        "mvp_phase",
        "manual_equivalent",
        "policy_family",
        "degradation",
        "permissions",
      ])
      .orderBy("key", "asc")
      .execute();
    return rows.map(toStoredCapability);
  }

  async createCapability(input: NewCapability): Promise<StoredCapability> {
    const row = await this.trx
      .insertInto("platform.capabilities")
      .values({
        id: newId(),
        key: input.key,
        owner_context: input.ownerContext,
        availability: input.availability,
        certification_status: input.certificationStatus,
        risk_level: input.riskLevel,
        mvp_phase: input.mvpPhase,
        manual_equivalent: input.manualEquivalent,
        policy_family: input.policyFamily,
        degradation: input.degradation,
        // node-pg serializes top-level arrays as Postgres arrays; a jsonb
        // column needs the explicit JSON text instead.
        permissions: JSON.stringify(input.permissions),
        created_at: now(),
        updated_at: now(),
      })
      .returning([
        "key",
        "owner_context",
        "availability",
        "certification_status",
        "risk_level",
        "mvp_phase",
        "manual_equivalent",
        "policy_family",
        "degradation",
        "permissions",
      ])
      .executeTakeFirstOrThrow();
    return toStoredCapability(row);
  }

  async setCapabilityAvailability(
    key: string,
    availability: string,
    reason: string,
    actorId: string | null,
  ): Promise<StoredCapability | null> {
    const current = await this.getCapability(key);
    if (current === null) {
      return null;
    }
    const row = await this.trx
      .updateTable("platform.capabilities")
      .set({ availability, updated_at: now() })
      .where("key", "=", key)
      .returning([
        "key",
        "owner_context",
        "availability",
        "certification_status",
        "risk_level",
        "mvp_phase",
        "manual_equivalent",
        "policy_family",
        "degradation",
        "permissions",
      ])
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    await this.trx
      .insertInto("platform.capability_events")
      .values({
        id: newId(),
        capability_key: key,
        from_availability: current.availability,
        to_availability: availability,
        reason,
        actor_id: actorId,
        occurred_at: now(),
      })
      .execute();
    return toStoredCapability(row);
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
    return withTenantTransaction(this.requireDb(), tenantId, async (trx) => {
      const tx = new KyselyAppTx(trx, tenantId);
      const out = await fn(tx);
      // Direct-applier flows (dispatchers drive `withTransaction` without
      // the bus) never call writeAudit: flush their staged triples audit-less
      // here, in the same transaction. Bus flows already flushed (no-op).
      // When `fn` throws, this line is skipped and staged rows die with the
      // rollback -- the original error propagates untouched.
      await tx.flushStagedTriples(null);
      return out;
    });
  }

  async claimIdempotency(input: {
    tenantId: string;
    scope: string;
    key: string;
    requestHash: string;
  }): Promise<IdempotencyClaim> {
    // Pool-level (no tenant context yet): the SECURITY DEFINER producer owns
    // the read-modify-write; no direct table access under `iptv_app`.
    const result = await sql<{
      o_status: string;
      o_response_status: number | null;
      o_response_json: CommandResult;
    }>`select * from platform.idempotency_claim(${input.tenantId}::uuid, ${input.scope}, ${input.key}, ${input.requestHash})`.execute(
      this.requireDb(),
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("idempotency claim returned no row");
    }
    if (row.o_status === "replay") {
      return {
        status: "replay",
        responseStatus: row.o_response_status,
        response: row.o_response_json,
      };
    }
    if (row.o_status === "conflict") {
      return { status: "conflict" };
    }
    if (row.o_status === "in_progress") {
      return { status: "in_progress" };
    }
    return { status: "claimed" };
  }

  async finishIdempotency(input: {
    tenantId: string;
    scope: string;
    key: string;
    state: "SUCCEEDED" | "FAILED";
    responseStatus: number | null;
    response: CommandResult;
  }): Promise<void> {
    await sql`select platform.idempotency_finish(${input.tenantId}::uuid, ${input.scope}, ${input.key}, ${input.state}, ${input.responseStatus}, ${JSON.stringify(input.response)}::jsonb)`.execute(
      this.requireDb(),
    );
  }
}
