import { withTenantTransaction, type Database } from "@iptv/database";
import type { Kysely } from "kysely";

export async function listActiveSellablePlans(db: Kysely<Database>, tenantId: string) {
  return withTenantTransaction(db, tenantId, async (trx) => {
    const rows = await trx
      .selectFrom("catalog.plans as pl")
      .leftJoin("catalog.prices as pr", (join) =>
        join
          .onRef("pr.sellable_id", "=", "pl.id")
          .on("pr.sellable_type", "=", "PLAN")
          .on("pr.status", "=", "ACTIVE")
          .onRef("pr.tenant_id", "=", "pl.tenant_id"),
      )
      .select([
        "pl.id", "pl.plan_key as planKey", "pl.name",
        "pl.billing_interval_unit as billingIntervalUnit",
        "pl.billing_interval_count as billingIntervalCount",
        "pl.status as planStatus", "pr.amount_minor as priceMinor",
        "pr.currency", "pr.status as priceStatus",
      ])
      .where("pl.tenant_id", "=", tenantId)
      .where("pl.status", "=", "ACTIVE")
      .orderBy("pl.name", "asc")
      .execute();
    return rows.map((row) => ({
      planId: row.id,
      planKey: row.planKey,
      name: row.name,
      billingIntervalUnit: row.billingIntervalUnit,
      billingIntervalCount: row.billingIntervalCount,
      active: row.planStatus === "ACTIVE",
      price: row.priceMinor === null ? null : {
        amountMinor: BigInt(row.priceMinor),
        currency: row.currency ?? "BRL",
        active: row.priceStatus === "ACTIVE",
      },
    }));
  });
}
