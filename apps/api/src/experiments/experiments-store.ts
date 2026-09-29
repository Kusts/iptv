import type { Transaction } from "kysely";
import { newId, now } from "@iptv/domain";
import type { Database } from "@iptv/database";
import type { CommandHandlerContext } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";

/**
 * Wave 16 Experiments store accessors (Kysely only).
 *
 * Storage truth is migration 039: `experiments` carry definition +
 * lifecycle, `experiment_assignments` are unique per (tenant, experiment,
 * subject) and exist only for RUNNING-time assignments, and
 * `experiment_exposures` are append-only and idempotent by (tenant,
 * assignment, dedupe_key). Tenant isolation on every query; no FK from
 * any domain table into experiments (F14 — no coupling by construction).
 */

export function requireTrx(ctx: CommandHandlerContext): Transaction<Database> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("experiment commands require a database transaction");
  }
  return trx;
}

export interface ExperimentRow {
  id: string;
  experimentKey: string;
  name: string;
  hypothesis: string;
  status: string;
  armVariantSpec: unknown;
  assignmentVersion: number;
  primaryMetricRef: string | null;
  guardrailRefs: string[];
  minimumEvidenceExposures: number;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRow(r: {
  id: string;
  experiment_key: string;
  name: string;
  hypothesis: string;
  status: string;
  arm_variant_spec_json: unknown;
  assignment_version: number;
  primary_metric_ref: string | null;
  guardrail_refs: string[] | null;
  minimum_evidence_exposures: number;
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): ExperimentRow {
  return {
    id: r.id,
    experimentKey: r.experiment_key,
    name: r.name,
    hypothesis: r.hypothesis,
    status: r.status,
    armVariantSpec: r.arm_variant_spec_json,
    assignmentVersion: Number(r.assignment_version),
    primaryMetricRef: r.primary_metric_ref,
    guardrailRefs: (r.guardrail_refs ?? []) as string[],
    minimumEvidenceExposures: Number(r.minimum_evidence_exposures),
    startedAt: r.started_at,
    endedAt: r.ended_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const EXPERIMENT_COLUMNS = [
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
  "created_at",
  "updated_at",
] as const;

export async function getExperiment(ctx: CommandHandlerContext, id: string): Promise<ExperimentRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("experiments.experiments")
    .select(EXPERIMENT_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", id)
    .executeTakeFirst();
  return row === undefined ? null : toRow(row);
}

export async function getExperimentByKey(ctx: CommandHandlerContext, key: string): Promise<ExperimentRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("experiments.experiments")
    .select(EXPERIMENT_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("experiment_key", "=", key)
    .executeTakeFirst();
  return row === undefined ? null : toRow(row);
}

export async function insertExperiment(
  ctx: CommandHandlerContext,
  input: {
    key: string;
    name: string;
    hypothesis: string;
    armVariantSpec: unknown;
    primaryMetricRef: string | null;
    guardrailRefs: string[];
    minimumEvidenceExposures: number;
  },
): Promise<ExperimentRow> {
  const trx = requireTrx(ctx);
  const id = newId();
  const at = now();
  await trx
    .insertInto("experiments.experiments")
    .values({
      id,
      tenant_id: ctx.tenantId,
      experiment_key: input.key,
      name: input.name,
      hypothesis: input.hypothesis,
      status: "DRAFT",
      arm_variant_spec_json: JSON.stringify(input.armVariantSpec),
      assignment_version: 1,
      primary_metric_ref: input.primaryMetricRef,
      guardrail_refs: input.guardrailRefs,
      minimum_evidence_exposures: input.minimumEvidenceExposures,
      created_at: at,
      updated_at: at,
    })
    .execute();
  const created = await getExperiment(ctx, id);
  if (created === null) {
    throw new Error("experiment insert did not persist");
  }
  return created;
}

/**
 * Move lifecycle `from -> to` (optimistic: expected-from must match).
 * Returns null when the row is missing or moved concurrently. Terminal
 * states (COMPLETED/STOPPED) are idempotent sinks for their own status.
 */
export async function setExperimentStatus(
  ctx: CommandHandlerContext,
  id: string,
  from: string[],
  to: string,
  stamp: "started_at" | "ended_at" | null,
): Promise<ExperimentRow | null> {
  const trx = requireTrx(ctx);
  const now = new Date();
  let query = trx
    .updateTable("experiments.experiments")
    .set({ status: to, updated_at: now })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", id)
    .where("status", "in", from);
  if (stamp === "started_at") {
    query = query.set({ started_at: now });
  } else if (stamp === "ended_at") {
    query = query.set({ ended_at: now });
  }
  const affected = await query.returning("id").executeTakeFirst();
  if (affected === undefined) {
    return null;
  }
  return getExperiment(ctx, id);
}

export interface AssignmentRow {
  id: string;
  experimentId: string;
  subjectType: string;
  subjectId: string;
  variant: string;
  assignmentVersion: number;
  assignedAt: Date;
}

export async function getAssignment(
  ctx: CommandHandlerContext,
  experimentId: string,
  subjectType: string,
  subjectId: string,
): Promise<AssignmentRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("experiments.experiment_assignments")
    .select(["id", "experiment_id", "subject_type", "subject_id", "variant", "assignment_version", "assigned_at"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("experiment_id", "=", experimentId)
    .where("subject_type", "=", subjectType)
    .where("subject_id", "=", subjectId)
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    experimentId: row.experiment_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    variant: row.variant,
    assignmentVersion: Number(row.assignment_version),
    assignedAt: row.assigned_at,
  };
}

/**
 * Insert an assignment; concurrent replays resolve via ON CONFLICT DO
 * NOTHING (a raw unique violation would abort the command transaction,
 * so the row is never re-read after a 23505). Returns `{ inserted }`
 * so the caller emits `experiment.assigned.v1` only on first insert.
 */
export async function insertAssignment(
  ctx: CommandHandlerContext,
  input: { experimentId: string; subjectType: string; subjectId: string; variant: string; assignmentVersion: number },
): Promise<{ id: string; inserted: boolean }> {
  const trx = requireTrx(ctx);
  const id = newId();
  const result = await trx
    .insertInto("experiments.experiment_assignments")
    .values({
      id,
      tenant_id: ctx.tenantId,
      experiment_id: input.experimentId,
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      variant: input.variant,
      assignment_version: input.assignmentVersion,
      assigned_at: now(),
    })
    .onConflict((oc) =>
      oc.columns(["tenant_id", "experiment_id", "subject_type", "subject_id"]).doNothing(),
    )
    .executeTakeFirst();
  if (result.numInsertedOrUpdatedRows === 1n) {
    return { id, inserted: true };
  }
  const existing = await getAssignment(ctx, input.experimentId, input.subjectType, input.subjectId);
  if (existing === null) {
    throw new Error("assignment conflict without a readable row");
  }
  return { id: existing.id, inserted: false };
}

export interface ExposureRow {
  id: string;
  assignmentId: string;
  exposurePoint: string;
  dedupeKey: string;
  exposedAt: Date;
}

/**
 * Append-only exposure insert; idempotent by (tenant, assignment,
 * dedupe_key) via ON CONFLICT DO NOTHING (a raw unique violation would
 * abort the command transaction, so the row is never re-read after a
 * 23505). A replay returns the existing row with `{ inserted: false }`
 * so no duplicate `experiment.exposed.v1` fires.
 */
export async function insertExposureIdempotent(
  ctx: CommandHandlerContext,
  input: { assignmentId: string; exposurePoint: string; dedupeKey: string; context: Record<string, unknown> },
): Promise<{ id: string; inserted: boolean }> {
  const trx = requireTrx(ctx);
  const id = newId();
  const at = now();
  const result = await trx
    .insertInto("experiments.experiment_exposures")
    .values({
      id,
      tenant_id: ctx.tenantId,
      experiment_assignment_id: input.assignmentId,
      exposure_point: input.exposurePoint,
      dedupe_key: input.dedupeKey,
      context_json: JSON.stringify(input.context),
      exposed_at: at,
      created_at: at,
    })
    .onConflict((oc) => oc.columns(["tenant_id", "experiment_assignment_id", "dedupe_key"]).doNothing())
    .executeTakeFirst();
  if (result.numInsertedOrUpdatedRows === 1n) {
    return { id, inserted: true };
  }
  const existing = await trx
    .selectFrom("experiments.experiment_exposures")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("experiment_assignment_id", "=", input.assignmentId)
    .where("dedupe_key", "=", input.dedupeKey)
    .executeTakeFirst();
  if (existing === undefined) {
    throw new Error("exposure conflict without a readable row");
  }
  return { id: existing.id, inserted: false };
}

export interface VariantCounts {
  variant: string;
  assignments: number;
  exposures: number;
}

/** Per-variant counts for the aggregate surface (assignments + exposures). */
export async function countByVariant(
  ctx: CommandHandlerContext,
  experimentId: string,
): Promise<{ counts: VariantCounts[]; totalAssignments: number; totalExposures: number }> {
  const trx = requireTrx(ctx);
  const assignments = await trx
    .selectFrom("experiments.experiment_assignments")
    .select(["variant", (eb) => eb.fn.countAll().as("n")])
    .where("tenant_id", "=", ctx.tenantId)
    .where("experiment_id", "=", experimentId)
    .groupBy("variant")
    .execute();
  const exposures = await trx
    .selectFrom("experiments.experiment_exposures")
    .innerJoin("experiments.experiment_assignments", (join) =>
      join
        .onRef("experiments.experiment_assignments.id", "=", "experiments.experiment_exposures.experiment_assignment_id")
        .on("experiments.experiment_assignments.tenant_id", "=", ctx.tenantId),
    )
    .select(["experiments.experiment_assignments.variant", (eb) => eb.fn.countAll().as("n")])
    .where("experiments.experiment_exposures.tenant_id", "=", ctx.tenantId)
    .where("experiments.experiment_assignments.experiment_id", "=", experimentId)
    .groupBy("experiments.experiment_assignments.variant")
    .execute();
  const exposureByVariant = new Map<string, number>();
  for (const row of exposures) {
    exposureByVariant.set(row.variant, Number(row.n));
  }
  const counts: VariantCounts[] = assignments.map((row) => ({
    variant: row.variant,
    assignments: Number(row.n),
    exposures: exposureByVariant.get(row.variant) ?? 0,
  }));
  counts.sort((a, b) => (a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0));
  return {
    counts,
    totalAssignments: counts.reduce((acc, c) => acc + c.assignments, 0),
    totalExposures: counts.reduce((acc, c) => acc + c.exposures, 0),
  };
}
