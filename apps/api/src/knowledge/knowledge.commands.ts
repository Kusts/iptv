import { z } from "zod";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue } from "../crm/wave2-store.js";
import {
  appendVersion,
  canonicalKeyExists,
  getItem,
  insertItemWithVersion,
  setItemStatus,
} from "./knowledge-store.js";

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
}
