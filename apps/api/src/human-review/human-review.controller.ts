import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import type { Database } from "@iptv/database";
import { commandResultHttpStatus } from "@iptv/domain";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { CommandBus, commandActorFromRequestParts } from "../commands/command-bus.js";
import type { CommandActor, CommandResult } from "@iptv/domain";
import { OPEN_REVIEW_STATUSES } from "./human-review.commands.js";
import {
  PROVIDER_OPERATION_CENTER_PERMISSION,
  PROVIDER_OPERATION_HUMAN_REQUIRED_STATUS,
  normalizeCenterItem,
  planCenterSources,
  providerOperationCenterItem,
  resolveSlaPolicy,
  type CenterItemInput,
} from "./center-policy.js";
import { HITL_SLA_POLICY_FAMILY } from "../support/support-policy.js";
import { PolicyResolver } from "../policy/policy-resolver.js";

const ALL_STATUSES = [
  "REQUESTED",
  "QUEUED",
  "ACKNOWLEDGED",
  "IN_REVIEW",
  "GUIDANCE_PROVIDED",
  "ACTION_TAKEN",
  "RESOLVED",
  "EXPIRED",
  "CANCELLED",
] as const;

function actorFromRequest(req: FastifyRequest): CommandActor {
  const auth = req.auth as NonNullable<FastifyRequest["auth"]>;
  const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
  return commandActorFromRequestParts({
    userId: auth.userId,
    isPlatformAdmin: auth.isPlatformAdmin,
    tenantId: tenant.id,
    roleKeys: tenant.roleKeys,
    permissions: tenant.permissions,
    actorType: "human",
  });
}

function send<T>(result: CommandResult<T>): T {
  if (result.ok) {
    return result.data;
  }
  throw new HttpException(
    { code: result.code.toUpperCase(), message: result.message },
    commandResultHttpStatus(result),
  );
}

/**
 * Tenant-scoped HumanReview queue + decision endpoints. Every write goes
 * through the `CommandBus` (permission-gated, validated, audited, with
 * domain event + outbox in the same transaction). Queue reads are plain
 * tenant-scoped selects — no command needed for reads.
 */
@Controller("v1/human-reviews")
export class HumanReviewController {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject(CommandBus) private readonly bus: CommandBus,
    @Inject(PolicyResolver) private readonly policies: PolicyResolver,
  ) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    return this.db;
  }

  /**
   * Tenant-scoped queue. `status` accepts any lifecycle state; the `PENDING`
   * alias (and omission) selects the open queue
   * (`REQUESTED|QUEUED|ACKNOWLEDGED|IN_REVIEW`).
   */
  @Get()
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.review.request")
  async queue(@Req() req: FastifyRequest, @Query("status") status?: string): Promise<{
    reviews: Array<{
      id: string;
      status: string;
      reviewMode: string;
      reason: string;
      priority: string;
      resourceType: string;
      resourceId: string;
      summary: string;
      createdAt: string;
      resolvedAt: string | null;
    }>;
  }> {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    let wanted: string[];
    if (status === undefined || status === "PENDING") {
      wanted = [...OPEN_REVIEW_STATUSES];
    } else if ((ALL_STATUSES as readonly string[]).includes(status)) {
      wanted = [status];
    } else {
      throw new HttpException({ code: "INVALID_STATUS", message: `unknown status: ${status}` }, 400);
    }
    const rows = await this.requireDb()
      .selectFrom("agent.human_review_requests")
      .select([
        "id",
        "status",
        "review_mode",
        "reason",
        "priority",
        "resource_type",
        "resource_id",
        "summary",
        "created_at",
        "resolved_at",
      ])
      .where("tenant_id", "=", tenant.id)
      .where("status", "in", wanted)
      .orderBy("created_at", "asc")
      .execute();
    return {
      reviews: rows.map((r) => ({
        id: r.id,
        status: r.status,
        reviewMode: r.review_mode,
        reason: r.reason,
        priority: r.priority,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        summary: r.summary,
        createdAt: r.created_at.toISOString(),
        resolvedAt: r.resolved_at?.toISOString() ?? null,
      })),
    };
  }

  @Post()
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.review.request")
  async request(@Body() body: unknown, @Req() req: FastifyRequest): Promise<{ id: string }> {
    const actor = actorFromRequest(req);
    const result = await this.bus.execute<{ id: string }>(actor, "human_review.request", body, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post(":id/claim")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.review.request")
  async claim(
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ): Promise<{ id: string; assigneeUserId: string; already: boolean }> {
    const actor = actorFromRequest(req);
    const result = await this.bus.execute<{ id: string; assigneeUserId: string; already: boolean }>(
      actor,
      "human_review.claim",
      { requestId: id },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  /**
   * HITL center: read-model aggregation of OPEN work across the existing
   * queues (human reviews, communications exceptions, billing exceptions,
   * recovery tasks) plus — permission-gated — provider operations parked in
   * `HUMAN_REQUIRED`. No queue table is restructured — each row below is a
   * tenant-scoped select normalized to
   * `{source, id, kind, summary, ageMinutes, sla, deepLink}`. Staleness
   * follows the `hitl.sla` policy family (safe defaults: warn ≥4h,
   * breach ≥24h).
   *
   * `provider_operation` is the security-sensitive source: it is admitted by
   * `provider.operation.read` (NOT by the `support.ticket.read` this route
   * requires), so a caller without it never sees provider rows in an
   * unfiltered center and gets a 403 when asking for that source explicitly.
   * Its rows carry only id/action/requested_at plus a fixed generic summary —
   * never payloads, results, secrets, account/customer identifiers, evidence,
   * traces or raw adapter errors.
   */
  @Get("center")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("support.ticket.read")
  async center(@Req() req: FastifyRequest, @Query("source") source?: string): Promise<{
    items: Array<{
      source: string;
      id: string;
      kind: string;
      summary: string;
      priority: string | null;
      ageMinutes: number;
      sla: string;
      deepLink: string;
      createdAt: string;
    }>;
    slaPolicy: { warnAfterHours: number; breachAfterHours: number; ref: string };
  }> {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    // `req.tenant.permissions` is the PermissionsGuard-resolved set for the
    // authenticated caller (platform admins resolve to the full catalog),
    // so a plain membership check is the whole admission — no second actor
    // resolution and no widening of this route's `support.ticket.read`.
    const canReadProviderOperations = tenant.permissions.includes(PROVIDER_OPERATION_CENTER_PERMISSION);
    // Admission before ANY provider read: unknown source → 400; explicit
    // `provider_operation` without the permission → 403.
    const plan = planCenterSources(source, canReadProviderOperations);
    if (plan.kind === "error") {
      throw new HttpException({ code: plan.code, message: plan.message }, plan.status);
    }
    const wanted = plan.wanted;
    const db = this.requireDb();
    const at = new Date();
    const decision = await this.policies.resolve(HITL_SLA_POLICY_FAMILY, { tenantId: tenant.id });
    const policy = resolveSlaPolicy(decision.configured ? (decision.value as Record<string, unknown>) : null);
    const ref = decision.configured && decision.provenance.length > 0
      ? decision.provenance.map((s) => s.ref).join("+")
      : "default-v1";

    const collected: CenterItemInput[] = [];
    if (wanted === null || wanted === "human_review") {
      const reviews = await db
        .selectFrom("agent.human_review_requests")
        .select(["id", "review_mode", "reason", "priority", "summary", "created_at", "sla_due_at"])
        .where("tenant_id", "=", tenant.id)
        .where("status", "in", [...OPEN_REVIEW_STATUSES])
        .orderBy("created_at", "asc")
        .execute();
      for (const r of reviews) {
        collected.push({
          source: "human_review",
          id: r.id,
          kind: `${r.review_mode}/${r.reason}`,
          summary: r.summary,
          priority: r.priority,
          createdAt: r.created_at,
          slaDueAt: r.sla_due_at,
          deepLink: `/v1/human-reviews/${r.id}`,
        });
      }
    }
    if (wanted === null || wanted === "comm_exception") {
      const rows = await db
        .selectFrom("communication.exceptions")
        .select(["id", "kind", "reason", "from_address", "created_at"])
        .where("tenant_id", "=", tenant.id)
        .where("status", "=", "OPEN")
        .orderBy("created_at", "asc")
        .execute();
      for (const r of rows) {
        collected.push({
          source: "comm_exception",
          id: r.id,
          kind: r.kind,
          summary: r.reason ?? (r.from_address === null ? "unmatched inbound" : `unmatched inbound from ${r.from_address}`),
          priority: null,
          createdAt: r.created_at,
          deepLink: `/v1/communications/exceptions/${r.id}`,
        });
      }
    }
    if (wanted === null || wanted === "billing_exception") {
      const rows = await db
        .selectFrom("billing.exceptions")
        .select(["id", "kind", "reason", "created_at"])
        .where("tenant_id", "=", tenant.id)
        .where("status", "=", "OPEN")
        .orderBy("created_at", "asc")
        .execute();
      for (const r of rows) {
        collected.push({
          source: "billing_exception",
          id: r.id,
          kind: r.kind,
          summary: r.reason ?? r.kind,
          priority: null,
          createdAt: r.created_at,
          deepLink: `/v1/billing/exceptions/${r.id}`,
        });
      }
    }
    if (wanted === null || wanted === "recovery_task") {
      const rows = await db
        .selectFrom("renewal.recovery_tasks")
        .select(["id", "reason", "subscription_id", "created_at"])
        .where("tenant_id", "=", tenant.id)
        .where("status", "=", "OPEN")
        .orderBy("created_at", "asc")
        .execute();
      for (const r of rows) {
        collected.push({
          source: "recovery_task",
          id: r.id,
          kind: `recovery/${r.reason}`,
          summary: `recovery ${r.reason} for subscription ${r.subscription_id}`,
          priority: null,
          createdAt: r.created_at,
          deepLink: `/v1/recovery-tasks/${r.id}`,
        });
      }
    }
    if (plan.includeProviderOperations) {
      // Minimal select on purpose: `requested_payload_json`,
      // `result_summary_json`, `provider_account_id`, `entity_id`,
      // `correlation_id` and any adapter error text are never read here.
      const rows = await db
        .selectFrom("provider.provider_operations")
        .select(["id", "action", "requested_at"])
        .where("tenant_id", "=", tenant.id)
        .where("status", "=", PROVIDER_OPERATION_HUMAN_REQUIRED_STATUS)
        .orderBy("requested_at", "asc")
        .execute();
      for (const r of rows) {
        collected.push(
          providerOperationCenterItem({ id: r.id, action: r.action, requestedAt: r.requested_at }),
        );
      }
    }
    collected.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return {
      items: collected.map((item) => {
        const normalized = normalizeCenterItem(policy, item, at);
        return {
          source: normalized.source,
          id: normalized.id,
          kind: normalized.kind,
          summary: normalized.summary,
          priority: normalized.priority ?? null,
          ageMinutes: normalized.ageMinutes,
          sla: normalized.sla,
          deepLink: normalized.deepLink,
          createdAt: normalized.createdAt.toISOString(),
        };
      }),
      slaPolicy: { warnAfterHours: policy.warnAfterHours, breachAfterHours: policy.breachAfterHours, ref },
    };
  }
  @Post(":id/approve")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.review.decide")
  async approve(
    @Param("id") id: string,
    @Body() body: { expectedStatus?: unknown; note?: unknown },
    @Req() req: FastifyRequest,
  ): Promise<{ id: string; resolution: string }> {
    const actor = actorFromRequest(req);
    const result = await this.bus.execute<{ id: string; resolution: string }>(
      actor,
      "human_review.approve",
      { requestId: id, expectedStatus: body.expectedStatus, note: body.note },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }

  @Post(":id/reject")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.review.decide")
  async reject(
    @Param("id") id: string,
    @Body() body: { expectedStatus?: unknown; note?: unknown },
    @Req() req: FastifyRequest,
  ): Promise<{ id: string; resolution: string }> {
    const actor = actorFromRequest(req);
    const result = await this.bus.execute<{ id: string; resolution: string }>(
      actor,
      "human_review.reject",
      { requestId: id, expectedStatus: body.expectedStatus, note: body.note },
      { correlationId: req.id, idempotencyKey: idempotencyKeyOf(req) },
    );
    return send(result);
  }
}

function idempotencyKeyOf(req: FastifyRequest): string | undefined {
  const header = req.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}
