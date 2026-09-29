import { newId } from "@iptv/domain";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "@iptv/database";
import { toMinorStrict } from "./finance-math.js";

type Exec = Kysely<Database> | Transaction<Database>;

/**
 * Wave 10 cost-allocation ingest (derived managerial costs, never a source
 * of truth — the financial ledger is; canonical domain §87-89).
 *
 * Derives `finance.cost_allocations` rows from facts that already carry
 * money, one row per fact per cost type:
 * - `SUPPLIER_COGS` — settled orders: Σ `price_snapshots.supplier_cost_minor`
 *   over the order items, linked to the `ORDER_SETTLEMENT` ledger
 *   transaction (migration 031 source-linked dedupe).
 * - `PROVIDER_COGS` — `subscription_cycles.base_provider_cost_minor`
 *   (recurs per cycle while the subscription is active, per ADDON-03 rule).
 * - `MESSAGING_COST` — `scheduled_contacts` with status SENT (realized
 *   spend only; SCHEDULED/DEFERRED/BLOCKED never allocate) at the
 *   authoritative `estimated_cost_minor` (campaign version unit cost).
 * - `ACQUISITION_TOUCH` — first-touch attribution touches (non
 *   REFERRAL_ASSIST) × the resolving campaign version's `unit_cost_minor`.
 * - `REFERRAL_REWARD` — referral-linked `loyalty.rewards` at
 *   `estimated_cost_minor` (economic cost, per REF-06 — never mixed into
 *   Paid CAC).
 *
 * Deliberately NOT allocated (no money authority — never estimated):
 * - AI cost: `agent_runs.usage_json` carries only token counts
 *   (`@iptv/ai-runtime` types), no price schedule exists.
 * - Payment fees: charges/payments carry no fee facts.
 * Read-models surface `BASELINE_UNAVAILABLE` for those slices instead of
 * inventing numbers.
 *
 * Idempotent: existence pre-check per dedupe key + 23505 catch on the
 * migration-031 keys, so replay (scheduler tick, manual rerun) never
 * duplicates. Writes ONLY to `finance.cost_allocations` — ledger tables
 * are append-only and are never UPDATE/DELETEd here.
 */

export const COST_SUPPLIER_COGS = "SUPPLIER_COGS";
export const COST_PROVIDER_COGS = "PROVIDER_COGS";
export const COST_MESSAGING = "MESSAGING_COST";
export const COST_ACQUISITION_TOUCH = "ACQUISITION_TOUCH";
export const COST_REFERRAL_REWARD = "REFERRAL_REWARD";

export interface RecomputeWindow {
  from?: Date;
  to?: Date;
  /** Max facts per cost type per run (default 500). */
  limit?: number;
}

export interface CostTypeCounts {
  inserted: number;
  skipped: number;
}

export interface RecomputeResult {
  inserted: number;
  skipped: number;
  byCostType: Record<string, CostTypeCounts>;
}

function tally(result: RecomputeResult, costType: string, inserted: boolean): void {
  const slot = result.byCostType[costType] ?? { inserted: 0, skipped: 0 };
  if (inserted) {
    slot.inserted += 1;
    result.inserted += 1;
  } else {
    slot.skipped += 1;
    result.skipped += 1;
  }
  result.byCostType[costType] = slot;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

function windowed<T>(qb: T, column: string, window: RecomputeWindow): T {
  // Kysely `where` is structurally typed per table; apply via a minimal
  // dynamic bridge to share window logic across fact tables.
  type WhereBridge = {
    where: (col: string, op: string, val: Date) => WhereBridge;
  };
  let out = qb as unknown as WhereBridge;
  if (window.from !== undefined) {
    out = out.where(column, ">=", window.from);
  }
  if (window.to !== undefined) {
    out = out.where(column, "<", window.to);
  }
  return out as unknown as T;
}

async function existsSourceLinked(
  exec: Exec,
  tenantId: string,
  costType: string,
  sourceTransactionId: string,
  targetId: string,
): Promise<boolean> {
  const row = await exec
    .selectFrom("finance.cost_allocations")
    .select(["id"])
    .where("tenant_id", "=", tenantId)
    .where("cost_type", "=", costType)
    .where("source_transaction_id", "=", sourceTransactionId)
    .where("allocation_target_id", "=", targetId)
    .executeTakeFirst();
  return row !== undefined;
}

async function existsFactLinked(
  exec: Exec,
  tenantId: string,
  costType: string,
  targetType: string,
  targetId: string,
): Promise<boolean> {
  const row = await exec
    .selectFrom("finance.cost_allocations")
    .select(["id"])
    .where("tenant_id", "=", tenantId)
    .where("cost_type", "=", costType)
    .where("allocation_target_type", "=", targetType)
    .where("allocation_target_id", "=", targetId)
    .executeTakeFirst();
  return row !== undefined;
}

async function insertAllocation(
  exec: Exec,
  tenantId: string,
  input: {
    costType: string;
    amountMinor: bigint;
    currency: string;
    targetType: string;
    targetId: string;
    sourceTransactionId: string | null;
    occurredAt: Date;
  },
): Promise<boolean> {
  try {
    await exec
      .insertInto("finance.cost_allocations")
      .values({
        id: newId(),
        tenant_id: tenantId,
        cost_type: input.costType,
        amount_minor: input.amountMinor.toString(),
        currency: input.currency,
        allocation_target_type: input.targetType,
        allocation_target_id: input.targetId,
        allocation_method: "DIRECT_FACT",
        source_transaction_id: input.sourceTransactionId,
        occurred_at: input.occurredAt,
        created_at: new Date(),
      })
      .execute();
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) {
      return false;
    }
    throw err;
  }
}

async function ingestSupplierCogs(exec: Exec, tenantId: string, window: RecomputeWindow, result: RecomputeResult): Promise<void> {
  const limit = window.limit ?? 500;
  let query = exec
    .selectFrom("commerce.orders")
    .select(["id", "currency", "settled_at"])
    .where("tenant_id", "=", tenantId)
    .where("status", "=", "SETTLED")
    .orderBy("settled_at", "asc")
    .limit(limit);
  query = windowed(query, "settled_at", window);
  const orders = await query.execute();
  for (const order of orders) {
    if (order.settled_at === null) {
      continue;
    }
    const snapshots = await exec
      .selectFrom("commerce.price_snapshots")
      .innerJoin("commerce.order_items", (join) =>
        join
          .onRef("commerce.order_items.tenant_id", "=", "commerce.price_snapshots.tenant_id")
          .onRef("commerce.order_items.id", "=", "commerce.price_snapshots.order_item_id"),
      )
      .select(["commerce.price_snapshots.supplier_cost_minor"])
      .where("commerce.price_snapshots.tenant_id", "=", tenantId)
      .where("commerce.order_items.order_id", "=", order.id)
      .execute();
    const costs = snapshots
      .map((s) => s.supplier_cost_minor)
      .filter((v): v is string => v !== null)
      .map((v) => toMinorStrict(v));
    if (costs.length === 0) {
      continue;
    }
    const total = costs.reduce((acc, v) => acc + v, 0n);
    const settlement = await exec
      .selectFrom("finance.financial_transactions")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("transaction_type", "=", "ORDER_SETTLEMENT")
      .where("reference_type", "=", "order")
      .where("reference_id", "=", order.id)
      .executeTakeFirst();
    if (settlement === undefined) {
      continue;
    }
    if (await existsSourceLinked(exec, tenantId, COST_SUPPLIER_COGS, settlement.id, order.id)) {
      tally(result, COST_SUPPLIER_COGS, false);
      continue;
    }
    const inserted = await insertAllocation(exec, tenantId, {
      costType: COST_SUPPLIER_COGS,
      amountMinor: total,
      currency: order.currency,
      targetType: "ORDER",
      targetId: order.id,
      sourceTransactionId: settlement.id,
      occurredAt: order.settled_at,
    });
    tally(result, COST_SUPPLIER_COGS, inserted);
  }
}

async function ingestProviderCogs(exec: Exec, tenantId: string, window: RecomputeWindow, result: RecomputeResult): Promise<void> {
  const limit = window.limit ?? 500;
  let query = exec
    .selectFrom("subscription.subscription_cycles")
    .select(["id", "currency", "starts_at", "base_provider_cost_minor"])
    .where("tenant_id", "=", tenantId)
    .where("base_provider_cost_minor", "is not", null)
    .orderBy("starts_at", "asc")
    .limit(limit);
  query = windowed(query, "starts_at", window);
  const cycles = await query.execute();
  for (const cycle of cycles) {
    if (cycle.base_provider_cost_minor === null) {
      continue;
    }
    if (await existsFactLinked(exec, tenantId, COST_PROVIDER_COGS, "SUBSCRIPTION_CYCLE", cycle.id)) {
      tally(result, COST_PROVIDER_COGS, false);
      continue;
    }
    const inserted = await insertAllocation(exec, tenantId, {
      costType: COST_PROVIDER_COGS,
      amountMinor: toMinorStrict(cycle.base_provider_cost_minor),
      currency: cycle.currency,
      targetType: "SUBSCRIPTION_CYCLE",
      targetId: cycle.id,
      sourceTransactionId: null,
      occurredAt: cycle.starts_at,
    });
    tally(result, COST_PROVIDER_COGS, inserted);
  }
}

async function ingestMessagingCost(exec: Exec, tenantId: string, window: RecomputeWindow, result: RecomputeResult): Promise<void> {
  const limit = window.limit ?? 500;
  let query = exec
    .selectFrom("communication.scheduled_contacts")
    .select(["id", "estimated_cost_minor", "scheduled_for", "sent_at"])
    .where("tenant_id", "=", tenantId)
    .where("status", "=", "SENT")
    .orderBy("scheduled_for", "asc")
    .limit(limit);
  query = windowed(query, "scheduled_for", window);
  const contacts = await query.execute();
  for (const contact of contacts) {
    const cost = toMinorStrict(contact.estimated_cost_minor);
    if (cost <= 0n) {
      continue;
    }
    if (await existsFactLinked(exec, tenantId, COST_MESSAGING, "SCHEDULED_CONTACT", contact.id)) {
      tally(result, COST_MESSAGING, false);
      continue;
    }
    const inserted = await insertAllocation(exec, tenantId, {
      costType: COST_MESSAGING,
      amountMinor: cost,
      currency: "BRL",
      targetType: "SCHEDULED_CONTACT",
      targetId: contact.id,
      sourceTransactionId: null,
      occurredAt: contact.sent_at ?? contact.scheduled_for,
    });
    tally(result, COST_MESSAGING, inserted);
  }
}

async function ingestAcquisitionTouches(
  exec: Exec,
  tenantId: string,
  window: RecomputeWindow,
  result: RecomputeResult,
): Promise<void> {
  const limit = window.limit ?? 500;
  let query = exec
    .selectFrom("growth.attribution_touches")
    .innerJoin("growth.campaign_versions", (join) =>
      join
        .onRef("growth.campaign_versions.tenant_id", "=", "growth.attribution_touches.tenant_id")
        .onRef("growth.campaign_versions.id", "=", "growth.attribution_touches.campaign_version_id"),
    )
    .select([
      "growth.attribution_touches.id as touch_id",
      "growth.attribution_touches.occurred_at as occurred_at",
      "growth.campaign_versions.unit_cost_minor as unit_cost_minor",
      "growth.campaign_versions.currency as currency",
    ])
    .where("growth.attribution_touches.tenant_id", "=", tenantId)
    .where("growth.attribution_touches.touch_type", "!=", "REFERRAL_ASSIST")
    .where("growth.campaign_versions.unit_cost_minor", "is not", null)
    .orderBy("growth.attribution_touches.occurred_at", "asc")
    .limit(limit);
  query = windowed(query, "growth.attribution_touches.occurred_at", window);
  const touches = await query.execute();
  for (const touch of touches) {
    if (touch.unit_cost_minor === null) {
      continue;
    }
    const cost = toMinorStrict(touch.unit_cost_minor);
    if (cost <= 0n) {
      continue;
    }
    if (await existsFactLinked(exec, tenantId, COST_ACQUISITION_TOUCH, "ATTRIBUTION_TOUCH", touch.touch_id)) {
      tally(result, COST_ACQUISITION_TOUCH, false);
      continue;
    }
    const inserted = await insertAllocation(exec, tenantId, {
      costType: COST_ACQUISITION_TOUCH,
      amountMinor: cost,
      currency: touch.currency,
      targetType: "ATTRIBUTION_TOUCH",
      targetId: touch.touch_id,
      sourceTransactionId: null,
      occurredAt: touch.occurred_at,
    });
    tally(result, COST_ACQUISITION_TOUCH, inserted);
  }
}

async function ingestReferralRewards(
  exec: Exec,
  tenantId: string,
  window: RecomputeWindow,
  result: RecomputeResult,
): Promise<void> {
  const limit = window.limit ?? 500;
  let query = exec
    .selectFrom("loyalty.rewards")
    .innerJoin("referral.referral_reward_links", (join) =>
      join
        .onRef("referral.referral_reward_links.tenant_id", "=", "loyalty.rewards.tenant_id")
        .onRef("referral.referral_reward_links.reward_id", "=", "loyalty.rewards.id"),
    )
    .select([
      "loyalty.rewards.id as reward_id",
      "loyalty.rewards.estimated_cost_minor as estimated_cost_minor",
      "loyalty.rewards.currency as currency",
      "loyalty.rewards.issued_at as issued_at",
      "loyalty.rewards.redeemed_at as redeemed_at",
      "loyalty.rewards.created_at as created_at",
    ])
    .where("loyalty.rewards.tenant_id", "=", tenantId)
    .where("loyalty.rewards.estimated_cost_minor", "is not", null)
    .orderBy("loyalty.rewards.created_at", "asc")
    .limit(limit);
  query = windowed(query, "loyalty.rewards.created_at", window);
  const rewards = await query.execute();
  for (const reward of rewards) {
    if (reward.estimated_cost_minor === null) {
      continue;
    }
    const cost = toMinorStrict(reward.estimated_cost_minor);
    if (cost <= 0n) {
      continue;
    }
    if (await existsFactLinked(exec, tenantId, COST_REFERRAL_REWARD, "REWARD", reward.reward_id)) {
      tally(result, COST_REFERRAL_REWARD, false);
      continue;
    }
    const inserted = await insertAllocation(exec, tenantId, {
      costType: COST_REFERRAL_REWARD,
      amountMinor: cost,
      currency: reward.currency ?? "BRL",
      targetType: "REWARD",
      targetId: reward.reward_id,
      sourceTransactionId: null,
      occurredAt: reward.issued_at ?? reward.redeemed_at ?? reward.created_at,
    });
    tally(result, COST_REFERRAL_REWARD, inserted);
  }
}

/**
 * Recompute cost allocations for one tenant (idempotent; replay-safe).
 * Reads existing facts only; writes solely to `finance.cost_allocations`.
 */
export async function recomputeAllocations(
  exec: Exec,
  tenantId: string,
  window: RecomputeWindow = {},
): Promise<RecomputeResult> {
  const result: RecomputeResult = { inserted: 0, skipped: 0, byCostType: {} };
  await ingestSupplierCogs(exec, tenantId, window, result);
  await ingestProviderCogs(exec, tenantId, window, result);
  await ingestMessagingCost(exec, tenantId, window, result);
  await ingestAcquisitionTouches(exec, tenantId, window, result);
  await ingestReferralRewards(exec, tenantId, window, result);
  return result;
}
