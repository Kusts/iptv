import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDb } from "@iptv/database";
import { sql } from "kysely";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "db", "migrations");
const connectionString = process.env.TEST_DATABASE_URL;
const db = connectionString ? createDb({ connectionString }) : null;

describe.skipIf(!process.env.TEST_DATABASE_URL)("subscription add-on materialization", () => {
  const tenantId = randomUUID();
  const personId = randomUUID();
  const customerId = randomUUID();
  const productId = randomUUID();
  const planId = randomUUID();
  const subscriptionId = randomUUID();
  const addonId = randomUUID();
  const addonLinkId = randomUUID();

  beforeAll(async () => {
    if (!db || !connectionString) return;
    await applyMigrations(connectionString, { migrationsDir });
    await sql`insert into control.tenants (id, slug, name)
      values (${tenantId}::uuid, ${`test-${tenantId}`}, 'Test tenant')`.execute(db);
    await sql`insert into identity.persons (id, tenant_id, canonical_name)
      values (${personId}::uuid, ${tenantId}::uuid, 'Test person')`.execute(db);
    await sql`insert into crm.customers (id, tenant_id, person_id)
      values (${customerId}::uuid, ${tenantId}::uuid, ${personId}::uuid)`.execute(db);
    await sql`insert into catalog.products (id, tenant_id, product_key, name, product_type)
      values (${productId}::uuid, ${tenantId}::uuid, ${`product-${productId}`}, 'Test product', 'SERVICE')`.execute(db);
    await sql`insert into catalog.plans (id, tenant_id, product_id, plan_key, name, billing_interval_unit)
      values (${planId}::uuid, ${tenantId}::uuid, ${productId}::uuid, ${`plan-${planId}`}, 'Test plan', 'MONTH')`.execute(db);
    await sql`insert into subscription.subscriptions (id, tenant_id, customer_id, plan_id)
      values (${subscriptionId}::uuid, ${tenantId}::uuid, ${customerId}::uuid, ${planId}::uuid)`.execute(db);
    await sql`insert into catalog.addons (id, tenant_id, addon_key, name, billing_type)
      values (${addonId}::uuid, ${tenantId}::uuid, 'additional-connection', 'Additional connection', 'RECURRING')`.execute(db);
  });

  it("stores an active additional-connection add-on with quantity two", async () => {
    if (!db) throw new Error("TEST_DATABASE_URL is required");
    await sql`insert into subscription.subscription_addons
      (id, tenant_id, subscription_id, addon_id, quantity, status, effective_from)
      values (${addonLinkId}::uuid, ${tenantId}::uuid, ${subscriptionId}::uuid,
        ${addonId}::uuid, 2, 'ACTIVE', now())`.execute(db);

    const row = await db
      .selectFrom("subscription.subscription_addons")
      .select(["quantity", "status"])
      .where("id", "=", addonLinkId)
      .executeTakeFirstOrThrow();
    expect(Number(row.quantity)).toBe(2);
    expect(row.status).toBe("ACTIVE");
  });

  afterAll(async () => {
    await db?.destroy();
  });
});
