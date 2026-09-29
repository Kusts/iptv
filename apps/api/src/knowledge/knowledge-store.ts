import type { Transaction } from "kysely";
import { newId, now } from "@iptv/domain";
import type { Database } from "@iptv/database";
import type { CommandHandlerContext } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";

/**
 * Wave 8 Knowledge store accessors (Kysely only).
 *
 * Storage truth is migration 010: `knowledge_items` carry the lifecycle
 * status + `current_version_id` read-model pointer; `knowledge_versions`
 * are append-only (trigger rejects UPDATE/DELETE — updates insert a new
 * row and repoint the item, never touch old rows); `solutions` rows exist
 * only for `SOLUTION`-type items.
 */

export function requireTrx(ctx: CommandHandlerContext): Transaction<Database> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("knowledge commands require a database transaction");
  }
  return trx;
}

export interface KnowledgeItemRow {
  id: string;
  status: string;
  knowledgeType: string;
  canonicalKey: string | null;
  currentVersionId: string | null;
  currentVersionNo: number | null;
  contentText: string | null;
  structuredContent: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export async function getItem(ctx: CommandHandlerContext, itemId: string): Promise<KnowledgeItemRow | null> {
  const trx = requireTrx(ctx);
  const item = await trx
    .selectFrom("knowledge.knowledge_items")
    .select([
      "id",
      "status",
      "knowledge_type",
      "canonical_key",
      "current_version_id",
      "created_at",
      "updated_at",
    ])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (item === undefined) {
    return null;
  }
  let versionNo: number | null = null;
  let contentText: string | null = null;
  let structured: unknown = {};
  if (item.current_version_id !== null) {
    const version = await trx
      .selectFrom("knowledge.knowledge_versions")
      .select(["version_no", "content_text", "structured_content_json"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", item.current_version_id)
      .executeTakeFirst();
    if (version !== undefined) {
      versionNo = Number(version.version_no);
      contentText = version.content_text;
      structured = version.structured_content_json;
    }
  }
  return {
    id: item.id,
    status: item.status,
    knowledgeType: item.knowledge_type,
    canonicalKey: item.canonical_key,
    currentVersionId: item.current_version_id,
    currentVersionNo: versionNo,
    contentText,
    structuredContent: structured,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

export async function canonicalKeyExists(ctx: CommandHandlerContext, canonicalKey: string): Promise<boolean> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("knowledge.knowledge_items")
    .select("id")
    .where("tenant_id", "=", ctx.tenantId)
    .where("canonical_key", "=", canonicalKey)
    .where("status", "!=", "REJECTED")
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export async function insertItemWithVersion(
  ctx: CommandHandlerContext,
  input: {
    knowledgeType: string;
    canonicalKey?: string | null;
    contentText: string;
    structuredContent?: Record<string, unknown>;
    confidenceScore?: number | null;
  },
): Promise<KnowledgeItemRow> {
  const trx = requireTrx(ctx);
  const at = now();
  const itemId = newId();
  await trx
    .insertInto("knowledge.knowledge_items")
    .values({
      id: itemId,
      tenant_id: ctx.tenantId,
      status: "CANDIDATE",
      knowledge_type: input.knowledgeType,
      canonical_key: input.canonicalKey ?? null,
      current_version_id: null,
      confidence_score: input.confidenceScore ?? null,
      freshness_score: null,
      created_at: at,
      updated_at: at,
    })
    .execute();
  const versionId = newId();
  await trx
    .insertInto("knowledge.knowledge_versions")
    .values({
      id: versionId,
      tenant_id: ctx.tenantId,
      knowledge_item_id: itemId,
      version_no: 1,
      content_text: input.contentText,
      structured_content_json: input.structuredContent ?? {},
      source_refs_json: [],
      valid_from: at,
      valid_until: null,
      created_at: at,
    })
    .execute();
  await trx
    .updateTable("knowledge.knowledge_items")
    .set({ current_version_id: versionId, updated_at: at })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", itemId)
    .execute();
  if (input.knowledgeType === "SOLUTION") {
    const structured = input.structuredContent ?? {};
    const procedure = (structured as Record<string, unknown>)["procedure"];
    await trx
      .insertInto("knowledge.solutions")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        knowledge_item_id: itemId,
        problem_signature_json: (structured as Record<string, unknown>)["problem_signature"] ?? {},
        procedure_json: procedure !== undefined && procedure !== null ? procedure : {},
        status: "ACTIVE",
        created_at: at,
        updated_at: at,
      })
      .execute();
  }
  const created = await getItem(ctx, itemId);
  if (created === null) {
    throw new Error("knowledge item vanished after insert");
  }
  return created;
}

export async function appendVersion(
  ctx: CommandHandlerContext,
  input: { itemId: string; contentText?: string; structuredContent?: Record<string, unknown> },
  expectedVersion?: number,
): Promise<KnowledgeItemRow | { stale: true; current: number } | null> {
  const trx = requireTrx(ctx);
  const current = await trx
    .selectFrom("knowledge.knowledge_versions")
    .select((eb) => eb.fn.max("version_no").as("max_no"))
    .where("tenant_id", "=", ctx.tenantId)
    .where("knowledge_item_id", "=", input.itemId)
    .executeTakeFirst();
  const maxRaw = current?.max_no;
  const maxNo = typeof maxRaw === "number" ? maxRaw : Number(maxRaw ?? 0);
  if (maxNo === 0) {
    return null;
  }
  if (expectedVersion !== undefined && maxNo !== expectedVersion) {
    return { stale: true, current: maxNo };
  }
  const item = await getItem(ctx, input.itemId);
  if (item === null) {
    return null;
  }
  const at = now();
  const versionId = newId();
  await trx
    .insertInto("knowledge.knowledge_versions")
    .values({
      id: versionId,
      tenant_id: ctx.tenantId,
      knowledge_item_id: input.itemId,
      version_no: maxNo + 1,
      content_text: input.contentText ?? item.contentText,
      structured_content_json: input.structuredContent ?? item.structuredContent ?? {},
      source_refs_json: [],
      valid_from: at,
      valid_until: null,
      created_at: at,
    })
    .execute();
  // Old version rows are append-only (trigger) — only the item pointer moves.
  await trx
    .updateTable("knowledge.knowledge_items")
    .set({ current_version_id: versionId, updated_at: at })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.itemId)
    .execute();
  const updated = await getItem(ctx, input.itemId);
  if (updated === null) {
    throw new Error("knowledge item vanished after version append");
  }
  return updated;
}

export async function setItemStatus(
  ctx: CommandHandlerContext,
  itemId: string,
  status: string,
  expectedStatus?: string,
): Promise<KnowledgeItemRow | null> {
  const trx = requireTrx(ctx);
  let query = trx
    .updateTable("knowledge.knowledge_items")
    .set({ status, updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", itemId);
  if (expectedStatus !== undefined) {
    query = query.where("status", "=", expectedStatus);
  }
  const affected = await query.returning("id").executeTakeFirst();
  if (affected === undefined) {
    return null;
  }
  return getItem(ctx, itemId);
}

export async function findSolutionForItem(
  ctx: CommandHandlerContext,
  itemId: string,
): Promise<{ id: string } | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("knowledge.solutions")
    .select("id")
    .where("tenant_id", "=", ctx.tenantId)
    .where("knowledge_item_id", "=", itemId)
    .executeTakeFirst();
  return row === undefined ? null : { id: row.id };
}

// ---------------------------------------------------------------------------
// Wave 15 maturation: corrections / gaps / research candidates.
// ---------------------------------------------------------------------------

export interface CorrectionRow {
  id: string;
  itemId: string;
  targetVersionId: string | null;
  proposedText: string;
  proposedStructured: unknown;
  status: string;
  appliedInVersionId: string | null;
}

export interface GapRow {
  id: string;
  question: string;
  supportTicketId: string | null;
  status: string;
}

export interface ResearchCandidateRow {
  id: string;
  gapId: string;
  itemId: string;
  status: string;
}

export async function getCorrection(ctx: CommandHandlerContext, correctionId: string): Promise<CorrectionRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("knowledge.knowledge_corrections")
    .select([
      "id",
      "knowledge_item_id",
      "target_version_id",
      "proposed_text",
      "proposed_structured_json",
      "status",
      "applied_in_version_id",
    ])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", correctionId)
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    itemId: row.knowledge_item_id,
    targetVersionId: row.target_version_id,
    proposedText: row.proposed_text,
    proposedStructured: row.proposed_structured_json,
    status: row.status,
    appliedInVersionId: row.applied_in_version_id,
  };
}

export async function insertCorrection(
  ctx: CommandHandlerContext,
  input: { itemId: string; targetVersionId?: string | null; proposedText: string; proposedStructured?: unknown },
): Promise<CorrectionRow> {
  const trx = requireTrx(ctx);
  const at = now();
  const id = newId();
  await trx
    .insertInto("knowledge.knowledge_corrections")
    .values({
      id,
      tenant_id: ctx.tenantId,
      knowledge_item_id: input.itemId,
      target_version_id: input.targetVersionId ?? null,
      proposed_text: input.proposedText,
      proposed_structured_json: input.proposedStructured ?? {},
      status: "OPEN",
      applied_in_version_id: null,
      decided_at: null,
      created_at: at,
      updated_at: at,
    })
    .execute();
  const created = await getCorrection(ctx, id);
  if (created === null) {
    throw new Error("knowledge correction vanished after insert");
  }
  return created;
}

export async function setCorrectionStatus(
  ctx: CommandHandlerContext,
  correctionId: string,
  status: "APPLIED" | "REJECTED",
  expectedStatus: string,
  appliedInVersionId?: string | null,
): Promise<CorrectionRow | null> {
  const trx = requireTrx(ctx);
  const affected = await trx
    .updateTable("knowledge.knowledge_corrections")
    .set({
      status,
      applied_in_version_id: appliedInVersionId ?? null,
      decided_at: now(),
      updated_at: now(),
    })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", correctionId)
    .where("status", "=", expectedStatus)
    .returning("id")
    .executeTakeFirst();
  if (affected === undefined) {
    return null;
  }
  return getCorrection(ctx, correctionId);
}

export async function getGap(ctx: CommandHandlerContext, gapId: string): Promise<GapRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("knowledge.knowledge_gaps")
    .select(["id", "question", "support_ticket_id", "status"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", gapId)
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return { id: row.id, question: row.question, supportTicketId: row.support_ticket_id, status: row.status };
}

export async function insertGap(
  ctx: CommandHandlerContext,
  input: { question: string; supportTicketId?: string | null },
): Promise<GapRow> {
  const trx = requireTrx(ctx);
  const at = now();
  const id = newId();
  await trx
    .insertInto("knowledge.knowledge_gaps")
    .values({
      id,
      tenant_id: ctx.tenantId,
      question: input.question,
      support_ticket_id: input.supportTicketId ?? null,
      status: "OPEN",
      closed_at: null,
      created_at: at,
      updated_at: at,
    })
    .execute();
  const created = await getGap(ctx, id);
  if (created === null) {
    throw new Error("knowledge gap vanished after insert");
  }
  return created;
}

export async function setGapStatus(
  ctx: CommandHandlerContext,
  gapId: string,
  status: "RESEARCHING" | "CLOSED",
  expectedStatuses: string[],
): Promise<GapRow | null> {
  const trx = requireTrx(ctx);
  const affected = await trx
    .updateTable("knowledge.knowledge_gaps")
    .set({
      status,
      closed_at: status === "CLOSED" ? now() : null,
      updated_at: now(),
    })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", gapId)
    .where("status", "in", expectedStatuses)
    .returning("id")
    .executeTakeFirst();
  if (affected === undefined) {
    return null;
  }
  return getGap(ctx, gapId);
}

export async function getResearchCandidate(
  ctx: CommandHandlerContext,
  candidateId: string,
): Promise<ResearchCandidateRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("knowledge.knowledge_research_candidates")
    .select(["id", "knowledge_gap_id", "knowledge_item_id", "status"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", candidateId)
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return { id: row.id, gapId: row.knowledge_gap_id, itemId: row.knowledge_item_id, status: row.status };
}

export async function insertResearchCandidate(
  ctx: CommandHandlerContext,
  input: { gapId: string; itemId: string },
): Promise<ResearchCandidateRow> {
  const trx = requireTrx(ctx);
  const at = now();
  const id = newId();
  await trx
    .insertInto("knowledge.knowledge_research_candidates")
    .values({
      id,
      tenant_id: ctx.tenantId,
      knowledge_gap_id: input.gapId,
      knowledge_item_id: input.itemId,
      status: "PROPOSED",
      decided_at: null,
      created_at: at,
      updated_at: at,
    })
    .execute();
  const created = await getResearchCandidate(ctx, id);
  if (created === null) {
    throw new Error("research candidate vanished after insert");
  }
  return created;
}

export async function setResearchCandidateStatus(
  ctx: CommandHandlerContext,
  candidateId: string,
  status: "ACCEPTED" | "REJECTED" | "PUBLISHED",
): Promise<ResearchCandidateRow | null> {
  const trx = requireTrx(ctx);
  const affected = await trx
    .updateTable("knowledge.knowledge_research_candidates")
    .set({ status, decided_at: now(), updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", candidateId)
    .where("status", "=", "PROPOSED")
    .returning("id")
    .executeTakeFirst();
  if (affected === undefined) {
    return null;
  }
  return getResearchCandidate(ctx, candidateId);
}

/** Tickets whose attempts never reached a usable outcome feed gap recording. */
export async function ticketHasUsableSolution(ctx: CommandHandlerContext, ticketId: string): Promise<boolean | null> {
  const trx = requireTrx(ctx);
  const ticket = await trx
    .selectFrom("support.support_tickets")
    .select("id")
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", ticketId)
    .executeTakeFirst();
  if (ticket === undefined) {
    return null;
  }
  const hit = await trx
    .selectFrom("support.solution_attempts")
    .select("id")
    .where("tenant_id", "=", ctx.tenantId)
    .where("support_ticket_id", "=", ticketId)
    .where("outcome", "in", ["SUCCEEDED", "PARTIAL"])
    .limit(1)
    .executeTakeFirst();
  return hit !== undefined;
}
