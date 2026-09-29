import { z } from "zod";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { requireTrx } from "../growth/growth-store.js";
import { recomputeAllocations, type RecomputeResult } from "./finance-ingest.js";

/**
 * Wave 10 finance maintenance command (owning context for derived cost
 * allocations; the ledger itself stays append-only and is never written
 * here — ingest touches `finance.cost_allocations` only).
 *
 * Permission reuse (no new migration): `billing.charge.write` is the
 * existing financial-write surface held by owner/admin/operator. The
 * command is idempotent (migration-031 dedupe keys), so scheduler reruns
 * and manual replays converge. NOT in the scheduler auto-tick list: it is
 * invoked explicitly (POST /v1/finance/recompute or manual scheduler run)
 * to avoid per-tick scan cost on every tenant.
 */

const datetimeString = z.string().datetime({ offset: true });

export const recomputeAllocationsInput = z.object({
  from: datetimeString.optional(),
  to: datetimeString.optional(),
  limit: z.number().int().min(1).max(5000).optional(),
});
export type RecomputeAllocationsInput = z.infer<typeof recomputeAllocationsInput>;

async function handleRecomputeAllocations(
  ctx: CommandHandlerContext,
  input: RecomputeAllocationsInput,
): Promise<CommandResult<RecomputeResult>> {
  const trx = requireTrx(ctx);
  if (input.from !== undefined && input.to !== undefined && new Date(input.from) >= new Date(input.to)) {
    return { ok: false, code: "validation_failed", message: "window `from` must be before `to`" };
  }
  const result = await recomputeAllocations(trx, ctx.tenantId, {
    ...(input.from !== undefined ? { from: new Date(input.from) } : {}),
    ...(input.to !== undefined ? { to: new Date(input.to) } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  return { ok: true, data: result };
}

export function registerFinanceCommands(bus: CommandBus): void {
  bus.register<RecomputeAllocationsInput, RecomputeResult>({
    name: "finance.recompute_allocations",
    permission: "billing.charge.write",
    auditAction: "finance.recompute_allocations",
    auditResource: "cost_allocation",
    input: recomputeAllocationsInput,
    handler: handleRecomputeAllocations,
  });
}
