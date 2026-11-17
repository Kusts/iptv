import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let pg;
try {
  pg = require("pg");
} catch {
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const pnpmDir = join(scriptDir, "..", "node_modules", ".pnpm");
    const pgPackage = readdirSync(pnpmDir).find((entry) => entry.startsWith("pg@"));
    if (!pgPackage) throw new Error();
    pg = require(join(pnpmDir, pgPackage, "node_modules", "pg"));
  } catch {
    console.error("Unable to load the pg package.");
    process.exit(1);
  }
}

const APPROVAL = {
  approved: true,
  approved_by: "Proprietário do StreamMax",
  approved_at: "2026-11-17",
  catalog_version: "V1.0",
  source: "CATALOGO-COMERCIAL.md",
};
const STARTS_AT = "2026-11-17T00:00:00-03:00";
const plans = [
  { key: "monthly", name: "Mensal", interval: 1, amount: 3000, segment: "P1M" },
  { key: "quarterly", name: "Trimestral", interval: 3, amount: 7500, segment: "P3M" },
  { key: "semiannual", name: "Semestral", interval: 6, amount: 15000, segment: "P6M" },
  { key: "annual", name: "Anual", interval: 12, amount: 30000, segment: "P12M" },
];
const addonPrices = [
  { segment: "P1M", amount: 2000 },
  { segment: "P3M", amount: 6000 },
  { segment: "P6M", amount: 10000 },
  { segment: "P12M", amount: 15000 },
];

function parseArgs(args) {
  let tenantId;
  let apply = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--tenant-id" && args[i + 1]) {
      tenantId = args[i + 1];
      i += 1;
    } else if (args[i] === "--apply") {
      apply = true;
    } else if (args[i] === "--dry-run") {
      apply = false;
    } else {
      throw new Error("Usage: node scripts/seed-approved-catalog.mjs --tenant-id <uuid> [--dry-run|--apply]");
    }
  }
  if (!tenantId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(tenantId)) {
    throw new Error("A valid --tenant-id UUID is required.");
  }
  return { tenantId, apply };
}

function equalJson(value, expected) {
  const stable = (object) => JSON.stringify(Object.fromEntries(Object.entries(object).sort(([left], [right]) => left.localeCompare(right))));
  return stable(value) === stable(expected);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  const plan = [
    { type: "product", key: "streaming-service", status: "ACTIVE" },
    ...plans.map(({ key, interval, amount }) => ({ type: "plan", key, interval, amount, currency: "BRL" })),
    { type: "addon", key: "additional-connection", status: "ACTIVE" },
    ...addonPrices.map(({ segment, amount }) => ({ type: "addon-price", segment, amount, currency: "BRL" })),
  ];
  if (!options.apply) {
    console.log(JSON.stringify({ mode: "dry-run", tenantId: options.tenantId, plan }, null, 2));
    return;
  }
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    console.error("DATABASE_URL is required with --apply; its value will not be displayed.");
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString });
  const counts = { created: 0, updated: 0, unchanged: 0 };
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`approved-catalog:${options.tenantId}`]);

    async function upsertSimple({ select, insert, update, values, same }) {
      const existing = await client.query(select, values.slice(0, 1));
      if (existing.rowCount === 0) {
        const created = await client.query(insert, values);
        counts.created += 1;
        return created;
      } else if (!same(existing.rows[0])) {
        await client.query(update, values);
        counts.updated += 1;
      } else {
        counts.unchanged += 1;
      }
      return existing;
    }

    let product = await client.query(
      "SELECT id, name, product_type, status, metadata_json FROM catalog.products WHERE tenant_id = $1 AND product_key = 'streaming-service'",
      [options.tenantId],
    );
    if (product.rowCount === 0) {
      product = await client.query(
        `INSERT INTO catalog.products (tenant_id, product_key, name, product_type, status, metadata_json)
         VALUES ($1, 'streaming-service', 'StreamMax', 'SERVICE', 'ACTIVE', $2::jsonb) RETURNING id`,
        [options.tenantId, JSON.stringify(APPROVAL)],
      );
      counts.created += 1;
    } else {
      const row = product.rows[0];
      if (row.name !== "StreamMax" || row.product_type !== "SERVICE" || row.status !== "ACTIVE" || !equalJson(row.metadata_json, APPROVAL)) {
        await client.query(
          `UPDATE catalog.products SET name='StreamMax', product_type='SERVICE', status='ACTIVE',
           metadata_json=$2::jsonb, updated_at=now() WHERE tenant_id=$1 AND product_key='streaming-service'`,
          [options.tenantId, JSON.stringify(APPROVAL)],
        );
        counts.updated += 1;
      } else counts.unchanged += 1;
    }
    const productId = product.rows[0].id;

    for (const item of plans) {
      const result = await client.query(
        "SELECT id, product_id, name, billing_interval_unit, billing_interval_count, status, metadata_json FROM catalog.plans WHERE tenant_id=$1 AND plan_key=$2",
        [options.tenantId, item.key],
      );
      const values = [options.tenantId, productId, item.key, item.name, item.interval, JSON.stringify(APPROVAL)];
      const upserted = await client.query(
        `INSERT INTO catalog.plans (tenant_id, product_id, plan_key, name, billing_interval_unit, billing_interval_count, status, metadata_json)
         VALUES ($1,$2,$3,$4,'MONTH',$5,'ACTIVE',$6::jsonb)
         ON CONFLICT (tenant_id, plan_key) DO UPDATE SET product_id=EXCLUDED.product_id, name=EXCLUDED.name,
         billing_interval_unit=EXCLUDED.billing_interval_unit, billing_interval_count=EXCLUDED.billing_interval_count,
         status=EXCLUDED.status, metadata_json=EXCLUDED.metadata_json, updated_at=now()
         WHERE catalog.plans.product_id IS DISTINCT FROM EXCLUDED.product_id
         OR catalog.plans.name IS DISTINCT FROM EXCLUDED.name
         OR catalog.plans.billing_interval_unit IS DISTINCT FROM EXCLUDED.billing_interval_unit
         OR catalog.plans.billing_interval_count IS DISTINCT FROM EXCLUDED.billing_interval_count
         OR catalog.plans.status IS DISTINCT FROM EXCLUDED.status
         OR catalog.plans.metadata_json IS DISTINCT FROM EXCLUDED.metadata_json
         RETURNING id`,
        values,
      );
      if (result.rowCount === 0) {
        counts.created += 1;
        item.id = upserted.rows[0].id;
      } else {
        item.id = result.rows[0].id;
        if (upserted.rowCount > 0) {
          counts.updated += 1;
        } else counts.unchanged += 1;
      }
      await syncPrice("PLAN", item.id, null, item.amount, options.tenantId);
    }

    const addon = await upsertSimple({
      select: "SELECT id, name, billing_type, entitlement_feature_key, status, metadata_json FROM catalog.addons WHERE tenant_id=$1 AND addon_key='additional-connection'",
      insert: `INSERT INTO catalog.addons (tenant_id, addon_key, name, billing_type, entitlement_feature_key, status, metadata_json)
        VALUES ($1,'additional-connection','Tela adicional','RECURRING','CONNECTIONS','ACTIVE',$2::jsonb) RETURNING id`,
      update: `UPDATE catalog.addons SET name='Tela adicional', billing_type='RECURRING', entitlement_feature_key='CONNECTIONS',
        status='ACTIVE', metadata_json=$2::jsonb, updated_at=now() WHERE tenant_id=$1 AND addon_key='additional-connection'`,
      values: [options.tenantId, JSON.stringify(APPROVAL)],
      same: (row) => row.name === "Tela adicional" && row.billing_type === "RECURRING" &&
        row.entitlement_feature_key === "CONNECTIONS" && row.status === "ACTIVE" && equalJson(row.metadata_json, APPROVAL),
    });
    const addonId = addon.rows[0].id;
    for (const item of addonPrices) await syncPrice("ADDON", addonId, item.segment, item.amount, options.tenantId);
    await client.query("COMMIT");
    console.log(JSON.stringify({ mode: "apply", tenantId: options.tenantId, ...counts }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    const code = typeof error?.code === "string" ? ` (database error ${error.code})` : "";
    const message = typeof error?.message === "string" ? error.message.replace(/(?:postgres(?:ql)?:\/\/)[^\s]+/gi, "[redacted database URL]") : "";
    console.error(`Approved catalog load failed${code}; transaction rolled back.${message ? ` ${message}` : ""}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }

  async function syncPrice(sellableType, sellableId, segment, amount, tenantId) {
    const existing = await client.query(
      `SELECT id, amount_minor, currency, starts_at, ends_at, status, metadata_json
       FROM catalog.prices WHERE tenant_id=$1 AND sellable_type=$2 AND sellable_id=$3
       AND segment_key IS NOT DISTINCT FROM $4 ORDER BY created_at, id`,
      [tenantId, sellableType, sellableId, segment],
    );
    const values = [tenantId, sellableType, sellableId, amount, STARTS_AT, segment, JSON.stringify(APPROVAL)];
    const matches = (row) => Number(row.amount_minor) === amount && row.currency.trim() === "BRL" &&
      new Date(row.starts_at).toISOString() === new Date(STARTS_AT).toISOString() && row.ends_at === null &&
      row.status === "ACTIVE" && equalJson(row.metadata_json, APPROVAL);
    if (existing.rowCount === 0) {
      await client.query(
        `INSERT INTO catalog.prices (tenant_id,sellable_type,sellable_id,amount_minor,currency,starts_at,ends_at,segment_key,status,metadata_json)
         VALUES ($1,$2,$3,$4,'BRL',$5::timestamptz,NULL,$6,'ACTIVE',$7::jsonb)`,
        values,
      );
      counts.created += 1;
    } else if (existing.rows.length !== 1 || !matches(existing.rows[0])) {
      const id = existing.rows[0].id;
      await client.query(
        `UPDATE catalog.prices SET amount_minor=$4,currency='BRL',starts_at=$5::timestamptz,ends_at=NULL,
         status='ACTIVE',metadata_json=$7::jsonb WHERE tenant_id=$1 AND sellable_type=$2
         AND sellable_id=$3 AND segment_key IS NOT DISTINCT FROM $6 AND id=$8`,
        [...values, id],
      );
      if (existing.rows.length > 1) {
        await client.query("DELETE FROM catalog.prices WHERE tenant_id=$1 AND sellable_type=$2 AND sellable_id=$3 AND segment_key IS NOT DISTINCT FROM $4 AND id<>$5",
          [tenantId, sellableType, sellableId, segment, id]);
      }
      counts.updated += 1;
    } else counts.unchanged += 1;
  }
}

await main();
