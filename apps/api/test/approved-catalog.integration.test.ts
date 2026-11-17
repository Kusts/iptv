import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDb } from "@iptv/database";
import { newId } from "@iptv/domain";
import { listActiveSellablePlans } from "../src/commerce/catalog-queries.js";

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");
const SCRIPT_PATH = join(here, "..", "..", "..", "scripts", "seed-approved-catalog.mjs");
const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function isApproved(metadata: unknown): boolean {
  if (typeof metadata !== "object" || metadata === null) return false;
  return (metadata as { approved?: unknown }).approved === true;
}

describe.skipIf(!hasDb)("approved commercial catalog integration (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  let tenantId: string;

  async function runSeed() {
    const { stdout } = await execFile("node", [SCRIPT_PATH, "--tenant-id", tenantId, "--apply"], {
      env: { ...process.env, DATABASE_URL: connectionString as string },
    });
    return JSON.parse(stdout) as { created: number; updated: number; unchanged: number };
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    tenantId = newId();
    const suffix = tenantId.replace(/-/g, "").slice(-8);
    await db.insertInto("control.tenants").values({
      id: tenantId,
      slug: `approved-catalog-${suffix}`,
      name: "Approved Catalog Test Tenant",
      status: "ACTIVE",
      default_currency: "BRL",
      timezone: "America/Sao_Paulo",
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
  });

  afterAll(async () => {
    if (tenantId) {
      await db.deleteFrom("catalog.prices").where("tenant_id", "=", tenantId).execute().catch(() => undefined);
      await db.deleteFrom("catalog.plans").where("tenant_id", "=", tenantId).execute().catch(() => undefined);
      await db.deleteFrom("catalog.addons").where("tenant_id", "=", tenantId).execute().catch(() => undefined);
      await db.deleteFrom("catalog.products").where("tenant_id", "=", tenantId).execute().catch(() => undefined);
      await db.deleteFrom("control.tenants").where("id", "=", tenantId).execute().catch(() => undefined);
    }
    await db.destroy().catch(() => undefined);
  });

  it("loads approved prices, exposes active plans, and is idempotent on rerun", async () => {
    const firstRun = await runSeed();
    expect(firstRun).toMatchObject({ created: 14, updated: 0, unchanged: 0 });
    const plans = await db.selectFrom("catalog.plans as plan")
      .innerJoin("catalog.prices as price", (join) => join
        .onRef("price.sellable_id", "=", "plan.id")
        .onRef("price.tenant_id", "=", "plan.tenant_id")
        .on("price.sellable_type", "=", "PLAN"))
      .select(["plan.plan_key", "plan.billing_interval_count", "plan.status", "plan.metadata_json",
        "price.amount_minor", "price.currency", "price.status as price_status"])
      .where("plan.tenant_id", "=", tenantId)
      .orderBy("plan.billing_interval_count")
      .execute();
    expect(plans).toHaveLength(4);
    expect(plans.map((row) => [row.billing_interval_count, Number(row.amount_minor)])).toEqual([
      [1, 3000], [3, 7500], [6, 15000], [12, 30000],
    ]);
    expect(plans.every((row) => row.status === "ACTIVE" && row.price_status === "ACTIVE" &&
      row.currency.trim() === "BRL" && isApproved(row.metadata_json))).toBe(true);

    const addonRows = await db.selectFrom("catalog.addons")
      .select(["addon_key", "status", "billing_type", "entitlement_feature_key", "metadata_json"])
      .where("tenant_id", "=", tenantId)
      .execute();
    expect(addonRows).toHaveLength(1);
    expect(addonRows[0]).toMatchObject({
      addon_key: "additional-connection",
      status: "ACTIVE",
      billing_type: "RECURRING",
      entitlement_feature_key: "CONNECTIONS",
    });
    expect(addonRows[0] ? isApproved(addonRows[0].metadata_json) : false).toBe(true);

    const addonPrices = await db.selectFrom("catalog.prices as price")
      .innerJoin("catalog.addons as addon", (join) => join
        .onRef("price.sellable_id", "=", "addon.id")
        .onRef("price.tenant_id", "=", "addon.tenant_id"))
      .select(["price.segment_key", "price.amount_minor", "price.currency", "price.status", "price.metadata_json"])
      .where("price.tenant_id", "=", tenantId)
      .where("price.sellable_type", "=", "ADDON")
      .orderBy("price.segment_key")
      .execute();
    expect(addonPrices).toHaveLength(4);
    expect(addonPrices.map((row) => [row.segment_key, Number(row.amount_minor)])).toEqual([
      ["P12M", 15000], ["P1M", 2000], ["P3M", 6000], ["P6M", 10000],
    ]);
    expect(addonPrices.every((row) => row.status === "ACTIVE" && row.currency.trim() === "BRL" &&
      isApproved(row.metadata_json))).toBe(true);

    const visiblePlans = await listActiveSellablePlans(db, tenantId);
    expect(visiblePlans).toHaveLength(4);
    expect(visiblePlans
      .map((row) => [row.billingIntervalCount, row.price?.amountMinor] as const)
      .sort(([left], [right]) => left - right)).toEqual([
      [1, 3000n], [3, 7500n], [6, 15000n], [12, 30000n],
    ]);

    const secondRun = await runSeed();
    expect(secondRun).toMatchObject({ created: 0, updated: 0, unchanged: 14 });
    const counts = await Promise.all([
      db.selectFrom("catalog.products").select(({ fn }) => fn.countAll<number>().as("count")).where("tenant_id", "=", tenantId).executeTakeFirstOrThrow(),
      db.selectFrom("catalog.plans").select(({ fn }) => fn.countAll<number>().as("count")).where("tenant_id", "=", tenantId).executeTakeFirstOrThrow(),
      db.selectFrom("catalog.addons").select(({ fn }) => fn.countAll<number>().as("count")).where("tenant_id", "=", tenantId).executeTakeFirstOrThrow(),
      db.selectFrom("catalog.prices").select(({ fn }) => fn.countAll<number>().as("count")).where("tenant_id", "=", tenantId).executeTakeFirstOrThrow(),
    ]);
    expect(counts.map((row) => Number(row.count))).toEqual([1, 4, 1, 8]);
  });
});
