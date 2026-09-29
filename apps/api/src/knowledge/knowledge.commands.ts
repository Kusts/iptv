import { z } from "zod";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue } from "../crm/wave2-store.js";
import {
  appendVersion,
  canonicalKeyExists,
  getCorrection,
  getGap,
  getItem,
  getResearchCandidate,
  insertCorrection,
  insertGap,
  insertItemWithVersion,
  insertResearchCandidate,
  requireTrx,
  setCorrectionStatus,
  setGapStatus,
  setItemStatus,
  setResearchCandidateStatus,
  ticketHasUsableSolution,
} from "./knowledge-store.js";
import { computeFreshnessScore, isDegradedScore } from "./knowledge-policy.js";

/**
 * Wave 8 Knowledge commands (owning context for KnowledgeItem lifecycle).
 *
 * Minimal tenant-scoped surface: create (CANDIDATE + version 1, with a
 * `solutions` row for SOLUTION types so tickets can link outcomes),
 * update (append-only version insert + pointer move — old rows are never
 * touched, per the 010 trigger), archive (→ DEPRECATED).
 * Events: registry-listed `knowledge.candidate_created.v1` /
 * `knowledge.deprecated.v1`; version appends stay audit-only.
 */

export const KNOWLEDGE_TYPES = [
  "PROCEDURE",
  "SOLUTION",
  "FACT",
  "POLICY_REFERENCE",
  "COMPATIBILITY_EVIDENCE",
  "INCIDENT_NOTE",
  "FAQ",
] as const;

export const itemCreateInput = z.object({
  knowledgeType: z.enum(KNOWLEDGE_TYPES),
  canonicalKey: z.string().trim().min(1).max(200).optional(),
  contentText: z.string().trim().min(1).max(20000),
  structuredContent: z.record(z.string(), z.unknown()).default({}),
  confidenceScore: z.number().min(0).max(1).optional(),
});
export type ItemCreateInput = z.infer<typeof itemCreateInput>;

export const itemUpdateInput = z.object({
  itemId: z.string().uuid(),
  contentText: z.string().trim().min(1).max(20000).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  expectedVersion: z.number().int().positive().optional(),
});
export type ItemUpdateInput = z.infer<typeof itemUpdateInput>;

export const itemIdInput = z.object({ itemId: z.string().uuid() });
export type ItemIdInput = z.infer<typeof itemIdInput>;

async function handleCreate(
  ctx: CommandHandlerContext,
  input: ItemCreateInput,
): Promise<CommandResult<{ id: string; version: number; status: string }>> {
  // Pre-check (not try/catch): a unique-violation statement would abort
  // the command transaction, taking the bus audit down with it.
  if (input.canonicalKey !== undefined && (await canonicalKeyExists(ctx, input.canonicalKey))) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "canonical key already exists in this tenant",
    };
  }
  let created;
  try {
    created = await insertItemWithVersion(ctx, {
      knowledgeType: input.knowledgeType,
      canonicalKey: input.canonicalKey,
      contentText: input.contentText,
      structuredContent: input.structuredContent,
      confidenceScore: input.confidenceScore,
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      return {
        ok: false,
        code: "precondition_failed",
        message: "canonical key already exists in this tenant",
      };
    }
    throw err;
  }
  await emitAndEnqueue(ctx, {
    eventType: "knowledge.candidate_created.v1",
    aggregateType: "knowledge_item",
    aggregateId: created.id,
    data: { knowledge_item_id: created.id, knowledge_type: created.knowledgeType },
  });
  return { ok: true, data: { id: created.id, version: created.currentVersionNo ?? 1, status: created.status } };
}

async function handleUpdate(
  ctx: CommandHandlerContext,
  input: ItemUpdateInput,
): Promise<CommandResult<{ id: string; version: number }>> {
  const item = await getItem(ctx, input.itemId);
  if (item === null) {
    return { ok: false, code: "not_found", message: "knowledge item not found in this tenant" };
  }
  if (item.status === "DEPRECATED" || item.status === "REJECTED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `item is ${item.status}; archived items are immutable`,
    };
  }
  if (input.contentText === undefined && input.structuredContent === undefined) {
    return { ok: false, code: "validation_failed", message: "nothing to update" };
  }
  const result = await appendVersion(
    ctx,
    { itemId: input.itemId, contentText: input.contentText, structuredContent: input.structuredContent },
    input.expectedVersion,
  );
  if (result === null) {
    return { ok: false, code: "not_found", message: "knowledge item not found in this tenant" };
  }
  if ("stale" in result) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `stale update rejected: expected version ${input.expectedVersion}, current ${result.current}`,
    };
  }
  // Audit-only: version appends have no registry-listed v1 of their own.
  return { ok: true, data: { id: result.id, version: result.currentVersionNo ?? 0 } };
}

async function handleArchive(
  ctx: CommandHandlerContext,
  input: ItemIdInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const item = await getItem(ctx, input.itemId);
  if (item === null) {
    return { ok: false, code: "not_found", message: "knowledge item not found in this tenant" };
  }
  if (item.status === "DEPRECATED") {
    return { ok: true, data: { id: item.id, status: item.status } };
  }
  if (item.status === "REJECTED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: "rejected items stay rejected; they are never re-archived",
    };
  }
  const updated = await setItemStatus(ctx, item.id, "DEPRECATED", item.status);
  if (updated === null) {
    return { ok: false, code: "precondition_failed", message: "knowledge item changed concurrently" };
  }
  await emitAndEnqueue(ctx, {
    eventType: "knowledge.deprecated.v1",
    aggregateType: "knowledge_item",
    aggregateId: item.id,
    data: { knowledge_item_id: item.id, from_status: item.status, to_status: "DEPRECATED" },
  });
  return { ok: true, data: { id: updated.id, status: updated.status } };
}

// ---------------------------------------------------------------------------
// Wave 15 maturation: verify / supersede / corrections / gaps / candidates /
// freshness. Provenance and lifecycle stay on the Wave 8 substrate:
// versions remain append-only (only new INSERTs + pointer moves), every
// lifecycle move is idempotent, and knowledge failures never touch sales
// aggregates (F14 — no coupling by construction).
// ---------------------------------------------------------------------------

const VERIFIABLE_FROM = ["DISCOVERED", "CANDIDATE", "VALIDATING", "DEGRADED"] as const;

export const itemVerifyInput = z.object({
  itemId: z.string().uuid(),
  evidence: z.string().trim().min(1).max(2000).optional(),
});
export type ItemVerifyInput = z.infer<typeof itemVerifyInput>;

export const itemSupersedeInput = z.object({
  itemId: z.string().uuid(),
  contentText: z.string().trim().min(1).max(20000).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  supersededByItemId: z.string().uuid().optional(),
  evidence: z.string().trim().min(1).max(2000).optional(),
});
export type ItemSupersedeInput = z.infer<typeof itemSupersedeInput>;

export const correctionProposeInput = z.object({
  itemId: z.string().uuid(),
  targetVersionId: z.string().uuid().optional(),
  proposedText: z.string().trim().min(1).max(20000),
  proposedStructured: z.record(z.string(), z.unknown()).default({}),
});
export type CorrectionProposeInput = z.infer<typeof correctionProposeInput>;

export const correctionIdInput = z.object({ correctionId: z.string().uuid() });
export type CorrectionIdInput = z.infer<typeof correctionIdInput>;

export const correctionRejectInput = z.object({
  correctionId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000).optional(),
});
export type CorrectionRejectInput = z.infer<typeof correctionRejectInput>;

export const gapRecordInput = z.object({
  question: z.string().trim().min(3).max(2000),
  supportTicketId: z.string().uuid().optional(),
});
export type GapRecordInput = z.infer<typeof gapRecordInput>;

export const gapIdInput = z.object({ gapId: z.string().uuid() });
export type GapIdInput = z.infer<typeof gapIdInput>;

export const candidateFromGapInput = z.object({
  gapId: z.string().uuid(),
  knowledgeType: z.enum(KNOWLEDGE_TYPES),
  contentText: z.string().trim().min(1).max(20000),
  structuredContent: z.record(z.string(), z.unknown()).default({}),
  canonicalKey: z.string().trim().min(1).max(200).optional(),
});
export type CandidateFromGapInput = z.infer<typeof candidateFromGapInput>;

export const candidateDecideInput = z.object({
  candidateId: z.string().uuid(),
  decision: z.enum(["ACCEPTED", "REJECTED", "PUBLISHED"]),
});
export type CandidateDecideInput = z.infer<typeof candidateDecideInput>;

export const freshnessRefreshInput = z.object({});
export type FreshnessRefreshInput = z.infer<typeof freshnessRefreshInput>;

async function handleVerify(
  ctx: CommandHandlerContext,
  input: ItemVerifyInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const item = await getItem(ctx, input.itemId);
  if (item === null) {
    return { ok: false, code: "not_found", message: "knowledge item not found in this tenant" };
  }
  if (item.status === "VERIFIED") {
    return { ok: true, data: { id: item.id, status: item.status } };
  }
  if (!(VERIFIABLE_FROM as readonly string[]).includes(item.status)) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `item is ${item.status}; only DISCOVERED/CANDIDATE/VALIDATING/DEGRADED can be verified`,
    };
  }
  const updated = await setItemStatus(ctx, item.id, "VERIFIED", item.status);
  if (updated === null) {
    return { ok: false, code: "precondition_failed", message: "knowledge item changed concurrently" };
  }
  await emitAndEnqueue(ctx, {
    eventType: "knowledge.item.verified.v1",
    aggregateType: "knowledge_item",
    aggregateId: item.id,
    data: {
      knowledge_item_id: item.id,
      from_status: item.status,
      to_status: "VERIFIED",
      evidence: input.evidence ?? null,
    },
  });
  return { ok: true, data: { id: updated.id, status: updated.status } };
}

async function handleSupersede(
  ctx: CommandHandlerContext,
  input: ItemSupersedeInput,
): Promise<CommandResult<{ id: string; version: number; status: string }>> {
  const item = await getItem(ctx, input.itemId);
  if (item === null) {
    return { ok: false, code: "not_found", message: "knowledge item not found in this tenant" };
  }
  if (item.status === "SUPERSEDED") {
    return { ok: true, data: { id: item.id, version: item.currentVersionNo ?? 0, status: item.status } };
  }
  if (item.status !== "VERIFIED" && item.status !== "DEGRADED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `item is ${item.status}; only VERIFIED/DEGRADED can be superseded`,
    };
  }
  if (input.supersededByItemId !== undefined) {
    const replacement = await getItem(ctx, input.supersededByItemId);
    if (replacement === null) {
      return { ok: false, code: "not_found", message: "replacement item not found in this tenant" };
    }
    if (replacement.id === item.id) {
      return { ok: false, code: "validation_failed", message: "an item cannot supersede itself" };
    }
  }
  // The substitute content becomes a new append-only version first (old
  // rows are never touched); only then does the lifecycle pointer move.
  let version = item.currentVersionNo ?? 0;
  if (input.contentText !== undefined || input.structuredContent !== undefined) {
    const appended = await appendVersion(
      ctx,
      { itemId: item.id, contentText: input.contentText, structuredContent: input.structuredContent },
    );
    if (appended === null || "stale" in appended) {
      return { ok: false, code: "precondition_failed", message: "knowledge item changed concurrently" };
    }
    version = appended.currentVersionNo ?? version;
  }
  const updated = await setItemStatus(ctx, item.id, "SUPERSEDED", item.status);
  if (updated === null) {
    return { ok: false, code: "precondition_failed", message: "knowledge item changed concurrently" };
  }
  await emitAndEnqueue(ctx, {
    eventType: "knowledge.superseded.v1",
    aggregateType: "knowledge_item",
    aggregateId: item.id,
    data: {
      knowledge_item_id: item.id,
      from_status: item.status,
      to_status: "SUPERSEDED",
      superseded_by_item_id: input.supersededByItemId ?? null,
      evidence: input.evidence ?? null,
    },
  });
  return { ok: true, data: { id: updated.id, version, status: updated.status } };
}

const CORRECTABLE_FROM = ["DISCOVERED", "CANDIDATE", "VALIDATING", "VERIFIED", "DEGRADED"] as const;

async function handleProposeCorrection(
  ctx: CommandHandlerContext,
  input: CorrectionProposeInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const item = await getItem(ctx, input.itemId);
  if (item === null) {
    return { ok: false, code: "not_found", message: "knowledge item not found in this tenant" };
  }
  if (!(CORRECTABLE_FROM as readonly string[]).includes(item.status)) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `item is ${item.status}; archived items cannot receive corrections`,
    };
  }
  const created = await insertCorrection(ctx, {
    itemId: item.id,
    targetVersionId: input.targetVersionId ?? item.currentVersionId,
    proposedText: input.proposedText,
    proposedStructured: input.proposedStructured,
  });
  return { ok: true, data: { id: created.id, status: created.status } };
}

async function handleApplyCorrection(
  ctx: CommandHandlerContext,
  input: CorrectionIdInput,
): Promise<CommandResult<{ id: string; status: string; version: number | null }>> {
  const correction = await getCorrection(ctx, input.correctionId);
  if (correction === null) {
    return { ok: false, code: "not_found", message: "knowledge correction not found in this tenant" };
  }
  if (correction.status === "APPLIED") {
    const item = await getItem(ctx, correction.itemId);
    return { ok: true, data: { id: correction.id, status: correction.status, version: item?.currentVersionNo ?? null } };
  }
  if (correction.status !== "OPEN") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `correction is ${correction.status}; only OPEN corrections can be applied`,
    };
  }
  const item = await getItem(ctx, correction.itemId);
  if (item === null) {
    return { ok: false, code: "not_found", message: "knowledge item not found in this tenant" };
  }
  const appended = await appendVersion(ctx, {
    itemId: item.id,
    contentText: correction.proposedText,
    structuredContent: (correction.proposedStructured ?? {}) as Record<string, unknown>,
  });
  if (appended === null || "stale" in appended) {
    return { ok: false, code: "precondition_failed", message: "knowledge item changed concurrently" };
  }
  const decided = await setCorrectionStatus(ctx, correction.id, "APPLIED", "OPEN", appended.currentVersionId);
  if (decided === null) {
    return { ok: false, code: "precondition_failed", message: "knowledge correction changed concurrently" };
  }
  await emitAndEnqueue(ctx, {
    eventType: "knowledge.correction.applied.v1",
    aggregateType: "knowledge_item",
    aggregateId: item.id,
    data: {
      knowledge_item_id: item.id,
      correction_id: correction.id,
      applied_in_version: appended.currentVersionNo,
    },
  });
  return { ok: true, data: { id: decided.id, status: decided.status, version: appended.currentVersionNo } };
}

async function handleRejectCorrection(
  ctx: CommandHandlerContext,
  input: CorrectionRejectInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const correction = await getCorrection(ctx, input.correctionId);
  if (correction === null) {
    return { ok: false, code: "not_found", message: "knowledge correction not found in this tenant" };
  }
  if (correction.status === "REJECTED") {
    return { ok: true, data: { id: correction.id, status: correction.status } };
  }
  if (correction.status !== "OPEN") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `correction is ${correction.status}; only OPEN corrections can be rejected`,
    };
  }
  const decided = await setCorrectionStatus(ctx, correction.id, "REJECTED", "OPEN", null);
  if (decided === null) {
    return { ok: false, code: "precondition_failed", message: "knowledge correction changed concurrently" };
  }
  return { ok: true, data: { id: decided.id, status: decided.status } };
}

async function handleRecordGap(
  ctx: CommandHandlerContext,
  input: GapRecordInput,
): Promise<CommandResult<{ id: string; status: string; ticketHadSolution: boolean | null }>> {
  let ticketHadSolution: boolean | null = null;
  if (input.supportTicketId !== undefined) {
    const usable = await ticketHasUsableSolution(ctx, input.supportTicketId);
    if (usable === null) {
      return { ok: false, code: "not_found", message: "support ticket not found in this tenant" };
    }
    ticketHadSolution = usable;
  }
  const created = await insertGap(ctx, { question: input.question, supportTicketId: input.supportTicketId });
  return { ok: true, data: { id: created.id, status: created.status, ticketHadSolution } };
}

async function handleCloseGap(
  ctx: CommandHandlerContext,
  input: GapIdInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const gap = await getGap(ctx, input.gapId);
  if (gap === null) {
    return { ok: false, code: "not_found", message: "knowledge gap not found in this tenant" };
  }
  if (gap.status === "CLOSED") {
    return { ok: true, data: { id: gap.id, status: gap.status } };
  }
  const closed = await setGapStatus(ctx, gap.id, "CLOSED", ["OPEN", "RESEARCHING"]);
  if (closed === null) {
    return { ok: false, code: "precondition_failed", message: "knowledge gap changed concurrently" };
  }
  return { ok: true, data: { id: closed.id, status: closed.status } };
}

async function handleProposeCandidateFromGap(
  ctx: CommandHandlerContext,
  input: CandidateFromGapInput,
): Promise<CommandResult<{ candidateId: string; itemId: string; status: string }>> {
  const gap = await getGap(ctx, input.gapId);
  if (gap === null) {
    return { ok: false, code: "not_found", message: "knowledge gap not found in this tenant" };
  }
  if (gap.status === "CLOSED") {
    return { ok: false, code: "precondition_failed", message: "closed gaps no longer accept candidates" };
  }
  if (input.canonicalKey !== undefined && (await canonicalKeyExists(ctx, input.canonicalKey))) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "canonical key already exists in this tenant",
    };
  }
  let created;
  try {
    created = await insertItemWithVersion(ctx, {
      knowledgeType: input.knowledgeType,
      canonicalKey: input.canonicalKey,
      contentText: input.contentText,
      structuredContent: input.structuredContent,
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      return {
        ok: false,
        code: "precondition_failed",
        message: "canonical key already exists in this tenant",
      };
    }
    throw err;
  }
  await emitAndEnqueue(ctx, {
    eventType: "knowledge.candidate_created.v1",
    aggregateType: "knowledge_item",
    aggregateId: created.id,
    data: { knowledge_item_id: created.id, knowledge_type: created.knowledgeType, knowledge_gap_id: gap.id },
  });
  const candidate = await insertResearchCandidate(ctx, { gapId: gap.id, itemId: created.id });
  if (gap.status === "OPEN") {
    await setGapStatus(ctx, gap.id, "RESEARCHING", ["OPEN"]);
  }
  return { ok: true, data: { candidateId: candidate.id, itemId: created.id, status: candidate.status } };
}

async function handleDecideCandidate(
  ctx: CommandHandlerContext,
  input: CandidateDecideInput,
): Promise<CommandResult<{ candidateId: string; status: string }>> {
  const candidate = await getResearchCandidate(ctx, input.candidateId);
  if (candidate === null) {
    return { ok: false, code: "not_found", message: "research candidate not found in this tenant" };
  }
  if (candidate.status !== "PROPOSED") {
    if (candidate.status === input.decision) {
      return { ok: true, data: { candidateId: candidate.id, status: candidate.status } };
    }
    return {
      ok: false,
      code: "precondition_failed",
      message: `candidate is ${candidate.status}; only PROPOSED candidates can be decided`,
    };
  }
  if (input.decision === "PUBLISHED") {
    // Publishing validates the linked item through the same verify path
    // (emits knowledge.item.verified.v1) so the queue and the lifecycle
    // never diverge.
    const item = await getItem(ctx, candidate.itemId);
    if (item === null) {
      return { ok: false, code: "not_found", message: "linked knowledge item not found in this tenant" };
    }
    if (item.status !== "VERIFIED") {
      if (!(VERIFIABLE_FROM as readonly string[]).includes(item.status)) {
        return {
          ok: false,
          code: "precondition_failed",
          message: `linked item is ${item.status}; it cannot be published`,
        };
      }
      const verified = await setItemStatus(ctx, item.id, "VERIFIED", item.status);
      if (verified === null) {
        return { ok: false, code: "precondition_failed", message: "knowledge item changed concurrently" };
      }
      await emitAndEnqueue(ctx, {
        eventType: "knowledge.item.verified.v1",
        aggregateType: "knowledge_item",
        aggregateId: item.id,
        data: {
          knowledge_item_id: item.id,
          from_status: item.status,
          to_status: "VERIFIED",
          research_candidate_id: candidate.id,
        },
      });
    }
  }
  const decided = await setResearchCandidateStatus(ctx, candidate.id, input.decision);
  if (decided === null) {
    return { ok: false, code: "precondition_failed", message: "research candidate changed concurrently" };
  }
  return { ok: true, data: { candidateId: decided.id, status: decided.status } };
}

async function handleRefreshFreshness(
  ctx: CommandHandlerContext,
): Promise<CommandResult<{ refreshed: number; degraded: string[] }>> {
  const trx = requireTrx(ctx);
  const items = await trx
    .selectFrom("knowledge.knowledge_items")
    .select(["id", "status", "updated_at"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("status", "not in", ["DEPRECATED", "REJECTED", "SUPERSEDED"])
    .execute();
  const nowMs = Date.now();
  let refreshed = 0;
  const degraded: string[] = [];
  for (const item of items) {
    const ageDays = Math.max((nowMs - item.updated_at.getTime()) / 86_400_000, 0);
    const score = computeFreshnessScore({ ageDays });
    // updated_at is intentionally untouched: it is the age signal itself.
    await trx
      .updateTable("knowledge.knowledge_items")
      .set({ freshness_score: score })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", item.id)
      .execute();
    refreshed += 1;
    if (item.status === "VERIFIED" && isDegradedScore(score)) {
      const moved = await setItemStatus(ctx, item.id, "DEGRADED", "VERIFIED");
      if (moved !== null) {
        degraded.push(item.id);
        await emitAndEnqueue(ctx, {
          eventType: "knowledge.degraded.v1",
          aggregateType: "knowledge_item",
          aggregateId: item.id,
          data: { knowledge_item_id: item.id, from_status: "VERIFIED", to_status: "DEGRADED", freshness_score: score },
        });
      }
    }
  }
  return { ok: true, data: { refreshed, degraded } };
}

export function registerKnowledgeCommands(bus: CommandBus): void {
  bus.register<ItemCreateInput, { id: string; version: number; status: string }>({
    name: "knowledge.item.create",
    permission: "knowledge.write",
    auditAction: "knowledge.item.create",
    auditResource: "knowledge_item",
    input: itemCreateInput,
    handler: handleCreate,
  });
  bus.register<ItemUpdateInput, { id: string; version: number }>({
    name: "knowledge.item.update",
    permission: "knowledge.write",
    auditAction: "knowledge.item.update",
    auditResource: "knowledge_item",
    input: itemUpdateInput,
    handler: handleUpdate,
  });
  bus.register<ItemIdInput, { id: string; status: string }>({
    name: "knowledge.item.archive",
    permission: "knowledge.write",
    auditAction: "knowledge.item.archive",
    auditResource: "knowledge_item",
    input: itemIdInput,
    handler: handleArchive,
  });
  bus.register<ItemVerifyInput, { id: string; status: string }>({
    name: "knowledge.item.verify",
    permission: "knowledge.write",
    auditAction: "knowledge.item.verify",
    auditResource: "knowledge_item",
    input: itemVerifyInput,
    handler: handleVerify,
  });
  bus.register<ItemSupersedeInput, { id: string; version: number; status: string }>({
    name: "knowledge.item.supersede",
    permission: "knowledge.write",
    auditAction: "knowledge.item.supersede",
    auditResource: "knowledge_item",
    input: itemSupersedeInput,
    handler: handleSupersede,
  });
  bus.register<CorrectionProposeInput, { id: string; status: string }>({
    name: "knowledge.correction.propose",
    permission: "knowledge.write",
    auditAction: "knowledge.correction.propose",
    auditResource: "knowledge_correction",
    input: correctionProposeInput,
    handler: handleProposeCorrection,
  });
  bus.register<CorrectionIdInput, { id: string; status: string; version: number | null }>({
    name: "knowledge.correction.apply",
    permission: "knowledge.write",
    auditAction: "knowledge.correction.apply",
    auditResource: "knowledge_correction",
    input: correctionIdInput,
    handler: handleApplyCorrection,
  });
  bus.register<CorrectionRejectInput, { id: string; status: string }>({
    name: "knowledge.correction.reject",
    permission: "knowledge.write",
    auditAction: "knowledge.correction.reject",
    auditResource: "knowledge_correction",
    input: correctionRejectInput,
    handler: handleRejectCorrection,
  });
  bus.register<GapRecordInput, { id: string; status: string; ticketHadSolution: boolean | null }>({
    name: "knowledge.gap.record",
    permission: "knowledge.write",
    auditAction: "knowledge.gap.record",
    auditResource: "knowledge_gap",
    input: gapRecordInput,
    handler: handleRecordGap,
  });
  bus.register<GapIdInput, { id: string; status: string }>({
    name: "knowledge.gap.close",
    permission: "knowledge.write",
    auditAction: "knowledge.gap.close",
    auditResource: "knowledge_gap",
    input: gapIdInput,
    handler: handleCloseGap,
  });
  bus.register<CandidateFromGapInput, { candidateId: string; itemId: string; status: string }>({
    name: "knowledge.candidate.propose_from_gap",
    permission: "knowledge.write",
    auditAction: "knowledge.candidate.propose_from_gap",
    auditResource: "knowledge_research_candidate",
    input: candidateFromGapInput,
    handler: handleProposeCandidateFromGap,
  });
  bus.register<CandidateDecideInput, { candidateId: string; status: string }>({
    name: "knowledge.candidate.decide",
    permission: "knowledge.write",
    auditAction: "knowledge.candidate.decide",
    auditResource: "knowledge_research_candidate",
    input: candidateDecideInput,
    handler: handleDecideCandidate,
  });
  bus.register<Record<string, never>, { refreshed: number; degraded: string[] }>({
    name: "knowledge.freshness.refresh",
    permission: "knowledge.write",
    auditAction: "knowledge.freshness.refresh",
    auditResource: "knowledge_item",
    input: freshnessRefreshInput,
    handler: handleRefreshFreshness,
  });
}
