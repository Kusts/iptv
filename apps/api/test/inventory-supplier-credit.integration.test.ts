import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDb } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import { KyselyCommandDb } from "../src/commands/kysely-command-db.js";
import { registerAppTrialCommands } from "../src/inventory/app-trial.commands.js";
import { registerSupplierCreditCommands } from "../src/inventory/supplier-credit.commands.js";
import { EchoSupplierBalanceAdapter } from "../src/inventory/supplier-balance.port.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const PERMISSIONS = ["trial.read", "trial.write", "provider.operation.write", "commerce.order.write"];

describe.skipIf(!hasDb)("Wave 7 supplier credit reservations (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  const bus = new CommandBus(new KyselyCommandDb(db));

  function actor(tenantId: string): CommandActor {
    return {
      userId: newId(),
      isPlatformAdmin: false,
      tenantId,
      roleKeys: ["tenant_owner"],
      permissions: PERMISSIONS,
      actorType: "human",
    };
  }

  async function makeTenant(): Promise<string> {
    const id = newId();
    const suffix = id.replace(/-/g, "").slice(-8);
    await db
      .insertInto("control.tenants")
      .values({
        id,
        slug: `w7c-${suffix}`,
        name: "Wave7 Credit Tenant",
        status: "ACTIVE",
        default_currency: "BRL",
        timezone: "America/Sao_Paulo",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    return id;
  }

  async function makePerson(tenantId: string): Promise<string> {
    const id = newId();
    await db
      .insertInto("identity.persons")
      .values({
        id,
        tenant_id: tenantId,
        status: "ACTIVE",
        canonical_name: "Wave7 Person",
        locale: null,
        timezone: null,
        created_at: new Date(),
        updated_at: new Date(),
        anonymized_at: null,
      })
      .execute();
    return id;
  }

  async function makeSupplier(tenantId: string): Promise<string> {
    const id = newId();
    await db
      .insertInto("inventory.suppliers")
      .values({
        id,
        tenant_id: tenantId,
        name: "Wave7 MK Supplier",
        supplier_type: "APP_CATALOG",
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    return id;
  }

  async function makeTrial(tenantId: string, personId: string, supplierId: string): Promise<string> {
    const requested = await bus.execute<{ id: string }>(actor(tenantId), "inventory.request_app_trial", {
      personId,
      supplierId,
      supplierAppExternalId: "app-pro-01",
    });
    if (!requested.ok) {
      throw new Error(`trial request failed: ${JSON.stringify(requested)}`);
    }
    return requested.data.id;
  }

  async function makeOrder(tenantId: string, personId: string): Promise<string> {
    const id = newId();
    await db
      .insertInto("commerce.orders")
      .values({
        id,
        tenant_id: tenantId,
        person_id: personId,
        customer_id: null,
        source_offer_id: null,
        order_type: "APP",
        status: "DRAFT",
        currency: "BRL",
        gross_amount_minor: "2000",
        discount_amount_minor: "0",
        reward_amount_minor: "0",
        net_amount_minor: "2000",
        settled_amount_minor: "0",
        created_at: new Date(),
        awaiting_payment_at: null,
        settled_at: null,
        cancelled_at: null,
        expires_at: null,
      })
      .execute();
    return id;
  }

  async function refreshEcho(tenantId: string, supplierId: string, minor: string): Promise<void> {
    process.env["SUPPLIER_BALANCE_ECHO_MINOR"] = minor;
    process.env["SUPPLIER_BALANCE_ECHO_CURRENCY"] = "BRL";
    const result = await bus.execute(actor(tenantId), "inventory.refresh_supplier_balance", {
      supplierId,
      adapter: "echo",
    });
    if (!result.ok) {
      throw new Error(`refresh failed: ${JSON.stringify(result)}`);
    }
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    registerAppTrialCommands(bus);
    registerSupplierCreditCommands(bus, { balancePort: new EchoSupplierBalanceAdapter() });
  });

  afterAll(async () => {
    delete process.env["SUPPLIER_BALANCE_ECHO_MINOR"];
    delete process.env["SUPPLIER_BALANCE_ECHO_CURRENCY"];
    await db.destroy().catch(() => undefined);
  });

  it("refreshes the balance and walks reserve -> release with the pool restored", async () => {
    const tenantId = await makeTenant();
    const personId = await makePerson(tenantId);
    const supplierId = await makeSupplier(tenantId);
    const trialId = await makeTrial(tenantId, personId, supplierId);
    const orderId = await makeOrder(tenantId, personId);
    await refreshEcho(tenantId, supplierId, "100000");

    const reserved = await bus.execute<Record<string, unknown>>(actor(tenantId), "inventory.reserve_app_credit", {
      supplierId,
      commerceOrderId: orderId,
      appTrialId: trialId,
      amountMinor: "40000",
      currency: "BRL",
      idempotencyKey: `w7c-${newId()}`,
    });
    if (!reserved.ok) {
      throw new Error(`reserve failed: ${JSON.stringify(reserved)}`);
    }
    expect(reserved.data["status"]).toBe("ACTIVE");
    expect(reserved.data["procurementOrderId"]).toEqual(expect.any(String));

    const released = await bus.execute<Record<string, unknown>>(actor(tenantId), "inventory.release_app_credit", {
      reservationId: reserved.data["id"] as string,
    });
    if (!released.ok) {
      throw new Error(`release failed: ${JSON.stringify(released)}`);
    }
    expect(released.data["status"]).toBe("RELEASED");

    // Pool restored: the full balance is reservable again.
    const again = await bus.execute<Record<string, unknown>>(actor(tenantId), "inventory.reserve_app_credit", {
      supplierId,
      commerceOrderId: orderId,
      appTrialId: trialId,
      amountMinor: "100000",
      currency: "BRL",
      idempotencyKey: `w7c-${newId()}`,
    });
    if (!again.ok) {
      throw new Error(`second reserve failed: ${JSON.stringify(again)}`);
    }
    expect(again.data["status"]).toBe("ACTIVE");
  });

  it("blocks an over-balance reservation with the F15 signal and refuses manual refresh without a reading", async () => {
    const tenantId = await makeTenant();
    const personId = await makePerson(tenantId);
    const supplierId = await makeSupplier(tenantId);
    const trialId = await makeTrial(tenantId, personId, supplierId);
    const orderId = await makeOrder(tenantId, personId);
    await refreshEcho(tenantId, supplierId, "5000");

    const blocked = await bus.execute(actor(tenantId), "inventory.reserve_app_credit", {
      supplierId,
      commerceOrderId: orderId,
      appTrialId: trialId,
      amountMinor: "9000",
      currency: "BRL",
      idempotencyKey: `w7c-${newId()}`,
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) {
      throw new Error("over-balance reserve unexpectedly succeeded");
    }
    expect(blocked.code).toBe("precondition_failed");
    expect(blocked.message).toMatch(/BLOCKED INSUFFICIENT_SUPPLIER_BALANCE/);

    const manual = await bus.execute(actor(tenantId), "inventory.refresh_supplier_balance", {
      supplierId,
      adapter: "manual",
    });
    expect(manual.ok).toBe(false);
    if (manual.ok) {
      throw new Error("manual refresh without a reading unexpectedly succeeded");
    }
    expect(manual.code).toBe("precondition_failed");
  });

  it("serializes concurrent reserves: exactly one 60k hold fits in 100k (no double-spend)", async () => {
    const tenantId = await makeTenant();
    const personA = await makePerson(tenantId);
    const personB = await makePerson(tenantId);
    const supplierId = await makeSupplier(tenantId);
    // Two DISTINCT purchase identities (order+trial each): the pool — not
    // the identity rule — is what blocks the second 60k hold here.
    // (Same-identity duplicates return already:true; see the w7-fixes suite.)
    const trialA = await makeTrial(tenantId, personA, supplierId);
    const trialB = await makeTrial(tenantId, personB, supplierId);
    const orderA = await makeOrder(tenantId, personA);
    const orderB = await makeOrder(tenantId, personB);
    await refreshEcho(tenantId, supplierId, "100000");

    const attempt = (commerceOrderId: string, appTrialId: string) =>
      bus.execute<Record<string, unknown>>(actor(tenantId), "inventory.reserve_app_credit", {
        supplierId,
        commerceOrderId,
        appTrialId,
        amountMinor: "60000",
        currency: "BRL",
        idempotencyKey: `w7c-race-${newId()}`,
      });
    const [first, second] = await Promise.all([attempt(orderA, trialA), attempt(orderB, trialB)]);
    const winners = [first, second].filter((r) => r.ok);
    const losers = [first, second].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if (!losers[0]?.ok) {
      expect(losers[0]?.message).toMatch(/BLOCKED INSUFFICIENT_SUPPLIER_BALANCE/);
    }
    const active = await db
      .selectFrom("inventory.credit_reservations")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("supplier_id", "=", supplierId)
      .where("status", "=", "ACTIVE")
      .execute();
    expect(active).toHaveLength(1);
  });

  it("replays the same idempotency key without a second hold or procurement order", async () => {
    const tenantId = await makeTenant();
    const personId = await makePerson(tenantId);
    const supplierId = await makeSupplier(tenantId);
    const trialId = await makeTrial(tenantId, personId, supplierId);
    const orderId = await makeOrder(tenantId, personId);
    await refreshEcho(tenantId, supplierId, "100000");
    const key = `w7c-idem-${newId()}`;

    const first = await bus.execute<Record<string, unknown>>(actor(tenantId), "inventory.reserve_app_credit", {
      supplierId,
      commerceOrderId: orderId,
      appTrialId: trialId,
      amountMinor: "10000",
      currency: "BRL",
      idempotencyKey: key,
    });
    if (!first.ok) {
      throw new Error(`first reserve failed: ${JSON.stringify(first)}`);
    }
    const second = await bus.execute<Record<string, unknown>>(actor(tenantId), "inventory.reserve_app_credit", {
      supplierId,
      commerceOrderId: orderId,
      appTrialId: trialId,
      amountMinor: "10000",
      currency: "BRL",
      idempotencyKey: key,
    });
    if (!second.ok) {
      throw new Error(`replay failed: ${JSON.stringify(second)}`);
    }
    expect(second.data["id"]).toBe(first.data["id"]);
    expect(second.data["already"]).toBe(true);

    const rows = await db
      .selectFrom("inventory.credit_reservations")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("supplier_id", "=", supplierId)
      .execute();
    expect(rows).toHaveLength(1);
    const procurements = await db
      .selectFrom("inventory.procurement_orders")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("supplier_id", "=", supplierId)
      .execute();
    expect(procurements).toHaveLength(1);
  });

  it("refuses to release a consumed hold and hides foreign-tenant reservations", async () => {
    const tenantId = await makeTenant();
    const personId = await makePerson(tenantId);
    const supplierId = await makeSupplier(tenantId);
    const trialId = await makeTrial(tenantId, personId, supplierId);
    const orderId = await makeOrder(tenantId, personId);
    await refreshEcho(tenantId, supplierId, "100000");

    const reserved = await bus.execute<Record<string, unknown>>(actor(tenantId), "inventory.reserve_app_credit", {
      supplierId,
      commerceOrderId: orderId,
      appTrialId: trialId,
      amountMinor: "10000",
      currency: "BRL",
      idempotencyKey: `w7c-${newId()}`,
    });
    if (!reserved.ok) {
      throw new Error(`reserve failed: ${JSON.stringify(reserved)}`);
    }
    // Simulate a spent hold (S3 consumes on purchase).
    await db
      .updateTable("inventory.credit_reservations")
      .set({ status: "CONSUMED", reserved_minor: "0", available_minor: "0", updated_at: new Date() })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", reserved.data["id"] as string)
      .execute();
    const release = await bus.execute(actor(tenantId), "inventory.release_app_credit", {
      reservationId: reserved.data["id"] as string,
    });
    expect(release.ok).toBe(false);
    if (release.ok) {
      throw new Error("release of a consumed hold unexpectedly succeeded");
    }
    expect(release.code).toBe("precondition_failed");

    const otherTenant = await makeTenant();
    const foreign = await bus.execute(actor(otherTenant), "inventory.release_app_credit", {
      reservationId: reserved.data["id"] as string,
    });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) {
      throw new Error("cross-tenant release unexpectedly succeeded");
    }
    expect(foreign.code).toBe("not_found");
  });
});
