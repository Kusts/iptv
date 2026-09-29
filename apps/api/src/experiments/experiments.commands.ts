import { z } from "zod";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue } from "../crm/wave2-store.js";
import {
  CONTROL_VARIANT,
  SUBJECT_TYPES,
  assignVariant,
  parseVariantSpec,
  subjectKeyOf,
} from "./experiments-hash.js";
import {
  getAssignment,
  getExperiment,
  getExperimentByKey,
  insertAssignment,
  insertExperiment,
  insertExposureIdempotent,
  setExperimentStatus,
} from "./experiments-store.js";

/**
 * Wave 16 Experiment commands (owning context for the experiment lifecycle).
 *
 * Minimal tenant-scoped MVP surface: create (DRAFT) / start (→ RUNNING) /
 * stop (→ STOPPED) / complete (→ COMPLETED), all idempotent; assign
 * (deterministic hash while RUNNING, persisted once — replays read the
 * row back; fallback `control` without persistence otherwise); and
 * record_exposure (append-only, idempotent by assignment + dedupe_key).
 *
 * Guardrails by construction: no statistics are computed here (POST-MVP),
 * an experiment NEVER authorizes price/discount changes (human-gated —
 * experimentation.md §11), and every failure degrades to control instead
 * of failing the caller (G18/F14).
 */

const keySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "key must be lowercase slug (letters, digits, _-)");

const variantEntrySchema = z.object({
  key: z.string().trim().min(1).max(80),
  weightBps: z.number().int().positive(),
});

export const experimentCreateInput = z.object({
  key: keySchema,
  name: z.string().trim().min(1).max(200),
  hypothesis: z.string().trim().max(2000).default(""),
  variants: z.array(variantEntrySchema).min(1).max(16),
  primaryMetricRef: z.string().trim().min(1).max(120).optional(),
  guardrailRefs: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
  minimumEvidenceExposures: z.number().int().min(1).max(1_000_000).default(100),
});
export type ExperimentCreateInput = z.infer<typeof experimentCreateInput>;

export const experimentIdInput = z.object({ experimentId: z.string().uuid() });
export type ExperimentIdInput = z.infer<typeof experimentIdInput>;

export const experimentStopInput = z.object({
  experimentId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type ExperimentStopInput = z.infer<typeof experimentStopInput>;

export const experimentAssignInput = z.object({
  experimentId: z.string().uuid(),
  subjectType: z.enum(SUBJECT_TYPES),
  subjectId: z.string().trim().min(1).max(120),
});
export type ExperimentAssignInput = z.infer<typeof experimentAssignInput>;

export const experimentExposeInput = z.object({
  experimentId: z.string().uuid(),
  subjectType: z.enum(SUBJECT_TYPES),
  subjectId: z.string().trim().min(1).max(120),
  exposurePoint: z.string().trim().min(1).max(120),
  dedupeKey: z.string().trim().min(1).max(200).optional(),
  context: z.record(z.string(), z.unknown()).default({}),
});
export type ExperimentExposeInput = z.infer<typeof experimentExposeInput>;

export interface ExperimentShape {
  id: string;
  key: string;
  name: string;
  status: string;
  variants: Array<{ key: string; weightBps: number }>;
  primaryMetricRef: string | null;
  guardrailRefs: string[];
  minimumEvidenceExposures: number;
  startedAt: string | null;
  endedAt: string | null;
}

function shapeOf(row: {
  id: string;
  experimentKey: string;
  name: string;
  status: string;
  armVariantSpec: unknown;
  primaryMetricRef: string | null;
  guardrailRefs: string[];
  minimumEvidenceExposures: number;
  startedAt: Date | null;
  endedAt: Date | null;
}): ExperimentShape {
  return {
    id: row.id,
    key: row.experimentKey,
    name: row.name,
    status: row.status,
    variants: parseVariantSpec(row.armVariantSpec),
    primaryMetricRef: row.primaryMetricRef,
    guardrailRefs: row.guardrailRefs,
    minimumEvidenceExposures: row.minimumEvidenceExposures,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

async function handleCreate(
  ctx: CommandHandlerContext,
  input: ExperimentCreateInput,
): Promise<CommandResult<ExperimentShape>> {
  // Pre-check (not try/catch): a unique-violation statement would abort
  // the command transaction, taking the bus audit down with it.
  if (await getExperimentByKey(ctx, input.key)) {
    return { ok: false, code: "precondition_failed", message: "experiment key already exists in this tenant" };
  }
  let created;
  try {
    created = await insertExperiment(ctx, {
      key: input.key,
      name: input.name,
      hypothesis: input.hypothesis,
      armVariantSpec: input.variants,
      primaryMetricRef: input.primaryMetricRef ?? null,
      guardrailRefs: input.guardrailRefs,
      minimumEvidenceExposures: input.minimumEvidenceExposures,
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      return { ok: false, code: "precondition_failed", message: "experiment key already exists in this tenant" };
    }
    throw err;
  }
  await emitAndEnqueue(ctx, {
    eventType: "experiment.created.v1",
    aggregateType: "experiment",
    aggregateId: created.id,
    data: { experiment_id: created.id, experiment_key: created.experimentKey, status: created.status },
  });
  return { ok: true, data: shapeOf(created) };
}

async function handleStart(
  ctx: CommandHandlerContext,
  input: ExperimentIdInput,
): Promise<CommandResult<ExperimentShape>> {
  const current = await getExperiment(ctx, input.experimentId);
  if (current === null) {
    return { ok: false, code: "not_found", message: "experiment not found in this tenant" };
  }
  if (current.status === "RUNNING") {
    return { ok: true, data: shapeOf(current) };
  }
  if (current.status !== "DRAFT") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `experiment is ${current.status}; only DRAFT experiments can start`,
    };
  }
  const moved = await setExperimentStatus(ctx, current.id, ["DRAFT"], "RUNNING", "started_at");
  if (moved === null) {
    return { ok: false, code: "precondition_failed", message: "experiment changed concurrently" };
  }
  await emitAndEnqueue(ctx, {
    eventType: "experiment.started.v1",
    aggregateType: "experiment",
    aggregateId: moved.id,
    data: { experiment_id: moved.id, experiment_key: moved.experimentKey },
  });
  return { ok: true, data: shapeOf(moved) };
}

async function handleStop(
  ctx: CommandHandlerContext,
  input: ExperimentStopInput,
): Promise<CommandResult<ExperimentShape>> {
  const current = await getExperiment(ctx, input.experimentId);
  if (current === null) {
    return { ok: false, code: "not_found", message: "experiment not found in this tenant" };
  }
  if (current.status === "STOPPED") {
    return { ok: true, data: shapeOf(current) };
  }
  if (current.status !== "RUNNING") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `experiment is ${current.status}; only RUNNING experiments can stop`,
    };
  }
  const moved = await setExperimentStatus(ctx, current.id, ["RUNNING"], "STOPPED", "ended_at");
  if (moved === null) {
    return { ok: false, code: "precondition_failed", message: "experiment changed concurrently" };
  }
  await emitAndEnqueue(ctx, {
    eventType: "experiment.stopped.v1",
    aggregateType: "experiment",
    aggregateId: moved.id,
    data: { experiment_id: moved.id, experiment_key: moved.experimentKey, reason: input.reason ?? null },
  });
  return { ok: true, data: shapeOf(moved) };
}

async function handleComplete(
  ctx: CommandHandlerContext,
  input: ExperimentIdInput,
): Promise<CommandResult<ExperimentShape>> {
  const current = await getExperiment(ctx, input.experimentId);
  if (current === null) {
    return { ok: false, code: "not_found", message: "experiment not found in this tenant" };
  }
  if (current.status === "COMPLETED") {
    return { ok: true, data: shapeOf(current) };
  }
  if (current.status !== "RUNNING") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `experiment is ${current.status}; only RUNNING experiments can complete`,
    };
  }
  const moved = await setExperimentStatus(ctx, current.id, ["RUNNING"], "COMPLETED", "ended_at");
  if (moved === null) {
    return { ok: false, code: "precondition_failed", message: "experiment changed concurrently" };
  }
  await emitAndEnqueue(ctx, {
    eventType: "experiment.completed.v1",
    aggregateType: "experiment",
    aggregateId: moved.id,
    data: { experiment_id: moved.id, experiment_key: moved.experimentKey },
  });
  return { ok: true, data: shapeOf(moved) };
}

export interface AssignShape {
  experimentId: string;
  subjectType: string;
  subjectId: string;
  variant: string;
  persisted: boolean;
  fallback: boolean;
  assignmentId: string | null;
}

async function handleAssign(
  ctx: CommandHandlerContext,
  input: ExperimentAssignInput,
): Promise<CommandResult<AssignShape>> {
  const current = await getExperiment(ctx, input.experimentId);
  // Fail-open (G18): unknown or non-RUNNING experiments answer `control`
  // without persisting anything — the operation path never breaks.
  if (current === null || current.status !== "RUNNING") {
    return {
      ok: true,
      data: {
        experimentId: input.experimentId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        variant: CONTROL_VARIANT,
        persisted: false,
        fallback: true,
        assignmentId: null,
      },
    };
  }
  const existing = await getAssignment(ctx, current.id, input.subjectType, input.subjectId);
  if (existing !== null) {
    return {
      ok: true,
      data: {
        experimentId: current.id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        variant: existing.variant,
        persisted: true,
        fallback: false,
        assignmentId: existing.id,
      },
    };
  }
  const variants = parseVariantSpec(current.armVariantSpec);
  const variant = assignVariant(
    current.experimentKey,
    subjectKeyOf(input.subjectType, input.subjectId),
    current.assignmentVersion,
    variants,
  );
  const inserted = await insertAssignment(ctx, {
    experimentId: current.id,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    variant,
    assignmentVersion: current.assignmentVersion,
  });
  if (inserted.inserted) {
    await emitAndEnqueue(ctx, {
      eventType: "experiment.assigned.v1",
      aggregateType: "experiment_assignment",
      aggregateId: inserted.id,
      data: {
        experiment_id: current.id,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        variant,
        assignment_version: current.assignmentVersion,
      },
    });
  }
  // A lost race re-reads the winner's row (same inputs → same hash, so
  // the variant agrees even then); only the first insert emits.
  const stored = inserted.inserted
    ? { id: inserted.id, variant }
    : await getAssignment(ctx, current.id, input.subjectType, input.subjectId).then((row) => {
        if (row === null) {
          throw new Error("assignment conflict without a readable row");
        }
        return { id: row.id, variant: row.variant };
      });
  return {
    ok: true,
    data: {
      experimentId: current.id,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      variant: stored.variant,
      persisted: true,
      fallback: false,
      assignmentId: stored.id,
    },
  };
}

export interface ExposureShape {
  experimentId: string;
  assignmentId: string;
  variant: string;
  exposureId: string;
  already: boolean;
}

async function handleRecordExposure(
  ctx: CommandHandlerContext,
  input: ExperimentExposeInput,
): Promise<CommandResult<ExposureShape>> {
  const current = await getExperiment(ctx, input.experimentId);
  if (current === null) {
    return { ok: false, code: "not_found", message: "experiment not found in this tenant" };
  }
  const assignment = await getAssignment(ctx, current.id, input.subjectType, input.subjectId);
  if (assignment === null) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "subject has no assignment in this experiment; assign first",
    };
  }
  const dedupeKey = input.dedupeKey ?? input.exposurePoint;
  const stored = await insertExposureIdempotent(ctx, {
    assignmentId: assignment.id,
    exposurePoint: input.exposurePoint,
    dedupeKey,
    context: input.context,
  });
  if (stored.inserted) {
    await emitAndEnqueue(ctx, {
      eventType: "experiment.exposed.v1",
      aggregateType: "experiment_assignment",
      aggregateId: assignment.id,
      data: {
        experiment_id: current.id,
        subject_id: input.subjectId,
        variant: assignment.variant,
        exposure_point: input.exposurePoint,
      },
    });
  }
  return {
    ok: true,
    data: {
      experimentId: current.id,
      assignmentId: assignment.id,
      variant: assignment.variant,
      exposureId: stored.id,
      already: !stored.inserted,
    },
  };
}

export function registerExperimentCommands(bus: CommandBus): void {
  bus.register<ExperimentCreateInput, ExperimentShape>({
    name: "experiments.create",
    permission: "experiments.write",
    auditAction: "experiments.create",
    auditResource: "experiment",
    input: experimentCreateInput,
    handler: handleCreate,
  });
  bus.register<ExperimentIdInput, ExperimentShape>({
    name: "experiments.start",
    permission: "experiments.write",
    auditAction: "experiments.start",
    auditResource: "experiment",
    input: experimentIdInput,
    handler: handleStart,
  });
  bus.register<ExperimentStopInput, ExperimentShape>({
    name: "experiments.stop",
    permission: "experiments.write",
    auditAction: "experiments.stop",
    auditResource: "experiment",
    input: experimentStopInput,
    handler: handleStop,
  });
  bus.register<ExperimentIdInput, ExperimentShape>({
    name: "experiments.complete",
    permission: "experiments.write",
    auditAction: "experiments.complete",
    auditResource: "experiment",
    input: experimentIdInput,
    handler: handleComplete,
  });
  bus.register<ExperimentAssignInput, AssignShape>({
    name: "experiments.assign",
    permission: "experiments.write",
    auditAction: "experiments.assign",
    auditResource: "experiment_assignment",
    input: experimentAssignInput,
    handler: handleAssign,
  });
  bus.register<ExperimentExposeInput, ExposureShape>({
    name: "experiments.record_exposure",
    permission: "experiments.write",
    auditAction: "experiments.record_exposure",
    auditResource: "experiment_exposure",
    input: experimentExposeInput,
    handler: handleRecordExposure,
  });
}
