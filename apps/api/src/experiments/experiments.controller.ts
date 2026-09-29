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
import type { CommandActor, CommandResult } from "@iptv/domain";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { CommandBus, commandActorFromRequestParts } from "../commands/command-bus.js";
import { CONTROL_VARIANT, assignVariant, parseVariantSpec, subjectKeyOf } from "./experiments-hash.js";

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

function idempotencyKeyOf(req: FastifyRequest): string | undefined {
  const header = req.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

interface MetricPoint {
  key: string;
  bucket: string | null;
  value: Record<string, unknown>;
  valueMinor: string | null;
  computedAt: string | null;
  dataQuality: string | null;
}

/**
 * Wave 16 minimal tenant-scoped experiments surface.
 *
 * Writes go through the `CommandBus` (experiments.* commands); the
 * aggregate is a read-model over assignment/exposure counts plus the
 * W14-A analytics snapshots for the declared primary/guardrail metrics.
 * The aggregate NEVER invents statistics: below the experiment's
 * `minimum_evidence_exposures` it answers `INSUFFICIENT_EVIDENCE`, and
 * even above it returns counts only (`comparisons: null` — POST-MVP).
 * Every analytics read degrades (metrics listed as degraded) instead of
 * failing the request (F14). An experiment NEVER authorizes
 * price/discount changes — the aggregate is evidence, not permission.
 */
@Controller("v1")
export class ExperimentsController {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject(CommandBus) private readonly bus: CommandBus,
  ) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    return this.db;
  }

  private async run<T>(req: FastifyRequest, command: string, payload: unknown): Promise<T> {
    const result = await this.bus.execute<T>(actorFromRequest(req), command, payload, {
      correlationId: req.id,
      idempotencyKey: idempotencyKeyOf(req),
    });
    return send(result);
  }

  @Post("experiments")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("experiments.write")
  async create(@Body() body: unknown, @Req() req: FastifyRequest) {
    return this.run(req, "experiments.create", body);
  }

  @Get("experiments")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("experiments.read")
  async list(@Query() query: { status?: string; limit?: string }, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    let select = this.requireDb()
      .selectFrom("experiments.experiments")
      .select(["id", "experiment_key", "name", "status", "primary_metric_ref", "started_at", "ended_at"])
      .where("tenant_id", "=", tenant.id)
      .orderBy("created_at", "desc")
      .limit(limit);
    if (query.status !== undefined) {
      select = select.where("status", "=", query.status);
    }
    const rows = await select.execute();
    return {
      experiments: rows.map((r) => ({
        id: r.id,
        key: r.experiment_key,
        name: r.name,
        status: r.status,
        primaryMetricRef: r.primary_metric_ref,
        startedAt: r.started_at?.toISOString() ?? null,
        endedAt: r.ended_at?.toISOString() ?? null,
      })),
    };
  }

  @Get("experiments/:id")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("experiments.read")
  async get(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const row = await this.requireDb()
      .selectFrom("experiments.experiments")
      .select([
        "id",
        "experiment_key",
        "name",
        "hypothesis",
        "status",
        "arm_variant_spec_json",
        "assignment_version",
        "primary_metric_ref",
        "guardrail_refs",
        "minimum_evidence_exposures",
        "started_at",
        "ended_at",
      ])
      .where("tenant_id", "=", tenant.id)
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "experiment not found in this tenant" }, 404);
    }
    return {
      experiment: {
        id: row.id,
        key: row.experiment_key,
        name: row.name,
        hypothesis: row.hypothesis,
        status: row.status,
        variants: row.arm_variant_spec_json,
        assignmentVersion: Number(row.assignment_version),
        primaryMetricRef: row.primary_metric_ref,
        guardrailRefs: (row.guardrail_refs ?? []) as string[],
        minimumEvidenceExposures: Number(row.minimum_evidence_exposures),
        startedAt: row.started_at?.toISOString() ?? null,
        endedAt: row.ended_at?.toISOString() ?? null,
      },
    };
  }

  @Post("experiments/:id/start")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("experiments.write")
  async start(@Param("id") id: string, @Req() req: FastifyRequest) {
    return this.run(req, "experiments.start", { experimentId: id });
  }

  @Post("experiments/:id/stop")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("experiments.write")
  async stop(@Param("id") id: string, @Body() body: Record<string, unknown>, @Req() req: FastifyRequest) {
    return this.run(req, "experiments.stop", { ...body, experimentId: id });
  }

  @Post("experiments/:id/complete")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("experiments.write")
  async complete(@Param("id") id: string, @Req() req: FastifyRequest) {
    return this.run(req, "experiments.complete", { experimentId: id });
  }

  @Post("experiments/:id/assign")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("experiments.write")
  async assign(@Param("id") id: string, @Body() body: Record<string, unknown>, @Req() req: FastifyRequest) {
    return this.run(req, "experiments.assign", { ...body, experimentId: id });
  }

  @Post("experiments/:id/exposures")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("experiments.write")
  async recordExposure(@Param("id") id: string, @Body() body: Record<string, unknown>, @Req() req: FastifyRequest) {
    return this.run(req, "experiments.record_exposure", { ...body, experimentId: id });
  }

  @Get("experiments/:id/aggregate")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("experiments.read")
  async aggregate(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const db = this.requireDb();
    const experiment = await db
      .selectFrom("experiments.experiments")
      .select(["id", "experiment_key", "status", "primary_metric_ref", "guardrail_refs", "minimum_evidence_exposures"])
      .where("tenant_id", "=", tenant.id)
      .where("id", "=", id)
      .executeTakeFirst();
    if (experiment === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "experiment not found in this tenant" }, 404);
    }
    const assignments = await db
      .selectFrom("experiments.experiment_assignments")
      .select(["variant", (eb) => eb.fn.countAll().as("n")])
      .where("tenant_id", "=", tenant.id)
      .where("experiment_id", "=", id)
      .groupBy("variant")
      .execute();
    const exposures = await db
      .selectFrom("experiments.experiment_exposures")
      .innerJoin("experiments.experiment_assignments", (join) =>
        join
          .onRef("experiments.experiment_assignments.id", "=", "experiments.experiment_exposures.experiment_assignment_id")
          .on("experiments.experiment_assignments.tenant_id", "=", tenant.id),
      )
      .select(["experiments.experiment_assignments.variant", (eb) => eb.fn.countAll().as("n")])
      .where("experiments.experiment_exposures.tenant_id", "=", tenant.id)
      .where("experiments.experiment_assignments.experiment_id", "=", id)
      .groupBy("experiments.experiment_assignments.variant")
      .execute();
    const exposuresByVariant = new Map<string, number>();
    for (const row of exposures) {
      exposuresByVariant.set(row.variant, Number(row.n));
    }
    const byVariant = assignments
      .map((row) => ({
        variant: row.variant,
        assignments: Number(row.n),
        exposures: exposuresByVariant.get(row.variant) ?? 0,
      }))
      .sort((a, b) => (a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0));
    const totalExposures = byVariant.reduce((acc, c) => acc + c.exposures, 0);
    const minimum = Number(experiment.minimum_evidence_exposures);
    const degradedMetrics: string[] = [];
    const metricKeys = [
      ...(experiment.primary_metric_ref === null ? [] : [experiment.primary_metric_ref]),
      ...((experiment.guardrail_refs ?? []) as string[]),
    ];
    const metrics: Record<string, MetricPoint | null> = {};
    for (const key of metricKeys) {
      metrics[key] = await this.latestMetricPoint(tenant.id, key, degradedMetrics);
    }
    return {
      experimentId: experiment.id,
      experimentKey: experiment.experiment_key,
      status: experiment.status,
      evidence:
        totalExposures < minimum
          ? ("INSUFFICIENT_EVIDENCE" as const)
          : ("READY_FOR_REVIEW" as const),
      minimumEvidenceExposures: minimum,
      totalAssignments: byVariant.reduce((acc, c) => acc + c.assignments, 0),
      totalExposures,
      byVariant,
      // Overall (non-per-variant) read-model values for context only.
      // Per-variant metric comparison is POST-MVP: `comparisons` stays
      // null rather than inventing statistics.
      primaryMetric: experiment.primary_metric_ref,
      guardrails: (experiment.guardrail_refs ?? []) as string[],
      metrics,
      comparisons: null,
      degradedMetrics,
    };
  }

  private async latestMetricPoint(
    tenantId: string,
    metricKey: string,
    degradedMetrics: string[],
  ): Promise<MetricPoint | null> {
    try {
      const row = await this.requireDb()
        .selectFrom("analytics.metric_snapshots")
        .select(["bucket_start", "value_json", "value_minor", "computed_at", "data_quality"])
        .where("tenant_id", "=", tenantId)
        .where("metric_key", "=", metricKey)
        .orderBy("bucket_start", "desc")
        .limit(1)
        .executeTakeFirst();
      if (row === undefined) {
        return null;
      }
      if (row.data_quality === "DEGRADED") {
        degradedMetrics.push(metricKey);
      }
      return {
        key: metricKey,
        bucket: row.bucket_start.toISOString(),
        value: (row.value_json ?? {}) as Record<string, unknown>,
        valueMinor: row.value_minor === null ? null : String(row.value_minor),
        computedAt: row.computed_at.toISOString(),
        dataQuality: row.data_quality,
      };
    } catch {
      degradedMetrics.push(metricKey);
      return null;
    }
  }

  /**
   * Feature-flag bridge (read-only, fail-open).
   *
   * A flag whose `config_json` carries `{experimentKey, experimentVariant?}`
   * resolves against the referenced experiment: enabled iff the experiment
   * is RUNNING and the subject hashes into the configured variant (pure
   * hash — evaluation never persists assignments; exposure is recorded
   * separately when the treatment actually reaches the subject).
   * Any failure (missing flag/experiment, non-RUNNING experiment,
   * unparsable spec) answers the flag default — the experiment surface
   * NEVER breaks the flag read (G18), and an unavailable experiment NEVER
   * enables something the flag left disabled (fail-closed for grants:
   * `enabled` can only come from an explicit RUNNING-variant match, or
   * from the flag's own stored `enabled` when no bridge is configured).
   */
  @Get("feature-flags/:key/evaluate")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("experiments.read")
  async evaluateFlag(
    @Param("key") key: string,
    @Query() query: { subjectType?: string; subjectId?: string },
    @Req() req: FastifyRequest,
  ) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const db = this.requireDb();
    // Tenant-specific flags shadow global (null-tenant) ones.
    const flag =
      (await db
        .selectFrom("control.feature_flags")
        .select(["flag_key", "enabled", "config_json"])
        .where("flag_key", "=", key)
        .where("tenant_id", "=", tenant.id)
        .executeTakeFirst()) ??
      (await db
        .selectFrom("control.feature_flags")
        .select(["flag_key", "enabled", "config_json"])
        .where("flag_key", "=", key)
        .where("tenant_id", "is", null)
        .executeTakeFirst());
    if (flag === undefined) {
      throw new HttpException({ code: "NOT_FOUND", message: "feature flag not found" }, 404);
    }
    const storedDefault = flag.enabled;
    const config = (flag.config_json ?? {}) as Record<string, unknown>;
    const experimentKey = typeof config["experimentKey"] === "string" ? (config["experimentKey"] as string) : null;
    const experimentVariant =
      typeof config["experimentVariant"] === "string" ? (config["experimentVariant"] as string) : CONTROL_VARIANT;
    if (experimentKey === null || experimentKey.length === 0) {
      return { key: flag.flag_key, enabled: storedDefault, source: "flag", variant: null, fallback: false };
    }
    if (query.subjectType === undefined || query.subjectId === undefined) {
      return { key: flag.flag_key, enabled: storedDefault, source: "flag-default", variant: null, fallback: true };
    }
    try {
      const experiment = await db
        .selectFrom("experiments.experiments")
        .select(["experiment_key", "status", "arm_variant_spec_json", "assignment_version"])
        .where("tenant_id", "=", tenant.id)
        .where("experiment_key", "=", experimentKey)
        .executeTakeFirst();
      if (experiment === undefined || experiment.status !== "RUNNING") {
        return { key: flag.flag_key, enabled: storedDefault, source: "flag-default", variant: CONTROL_VARIANT, fallback: true };
      }
      const variants = parseVariantSpec(experiment.arm_variant_spec_json);
      const variant = assignVariant(
        experiment.experiment_key,
        subjectKeyOf(query.subjectType, query.subjectId),
        Number(experiment.assignment_version),
        variants,
      );
      return {
        key: flag.flag_key,
        enabled: variant === experimentVariant,
        source: "experiment",
        variant,
        fallback: false,
      };
    } catch {
      return { key: flag.flag_key, enabled: storedDefault, source: "flag-default", variant: null, fallback: true };
    }
  }
}
