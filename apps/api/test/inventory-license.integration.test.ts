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
import { registerLicenseCommands } from "../src/inventory/license.commands.js";
import { captureSupplierAppSnapshot } from "../src/inventory/supplier-app-catalog.store.js";
import { EchoProviderOpsAdapter } from "../src/provider/provider-port.js";
import { EchoSupplierBalanceAdapter } from "../src/inventory/supplier-balance.port.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const PERMISSIONS = [
  "trial.read",
  "trial.write",
  "provider.operation.read",
  "provider.operation.write",
  "commerce.order.write",
];

describe.skipIf(!hasDb)("Wave 7 license purchase + reconciliation (requires TEST_DATABASE_URL)", () => {
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
        slug: `w7l-${suffix}`,
        name: "Wave7 License Tenant",
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

  async function makeCustomer(tenantId: string, personId: string): Promise<string> {
    const id = newId();
    await db
      .insertInto("crm.customers")
      .values({
        id,
        tenant_id: tenantId,
        person_id: personId,
        status: "ACTIVE",
        customer_since: new Date(),
        last_reactivated_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    return id;
  }

  interface ReadyFixture {
    tenantId: string;
    supplierId: string;
    customerId: string;
    trialId: string;
    orderId: string;
    procurementOrderId: string;
    reservationId: string;
  }

  /** Fully gated fixture: catalog item + VALIDATED trial + SETTLED order + ACTIVE hold. */
  async function makeReadyProcurement(opts: { validateTrial: boolean; settleOrder: boolean }): Promise<ReadyFixture> {
    const tenantId = await makeTenant();
    const personId = await makePerson(tenantId);
    const customerId = await makeCustomer(tenantId, personId);
    const supplierId = newId();
    await db
      .insertInto("inventory.suppliers")
      .values({
        id: supplierId,
        tenant_id: tenantId,
        name: "Wave7 MK Supplier",
        supplier_type: "APP_CATALOG",
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await captureSupplierAppSnapshot(db, {
      tenantId,
      supplierId,
      items: [
        {
          externalId: "app-pro-01",
          name: "Pro App",
          lifetimePriceMinor: "2000",
          currency: "BRL",
          availability: "AVAILABLE",
        },
      ],
    });
    const requested = await bus.execute<{ id: string }>(actor(tenantId), "inventory.request_app_trial", {
      personId,
      customerId,
      supplierId,
      supplierAppExternalId: "app-pro-01",
    });
    if (!requested.ok) {
      throw new Error(`trial request failed: ${JSON.stringify(requested)}`);
    }
    if (opts.validateTrial) {
      const validated = await bus.execute(actor(tenantId), "inventory.validate_app_trial", {
        trialId: requested.data.id,
        outcome: "VALIDATED",
      });
      if (!validated.ok) {
        throw new Error(`trial validate failed: ${JSON.stringify(validated)}`);
      }
    }
    const orderId = newId();
    await db
      .insertInto("commerce.orders")
      .values({
        id: orderId,
        tenant_id: tenantId,
        person_id: personId,
        customer_id: customerId,
        source_offer_id: null,
        order_type: "APP",
        status: opts.settleOrder ? "SETTLED" : "AWAITING_PAYMENT",
        currency: "BRL",
        gross_amount_minor: "2000",
        discount_amount_minor: "0",
        reward_amount_minor: "0",
        net_amount_minor: "2000",
        settled_amount_minor: opts.settleOrder ? "2000" : "0",
        created_at: new Date(),
        awaiting_payment_at: new Date(),
        settled_at: opts.settleOrder ? new Date() : null,
        cancelled_at: null,
        expires_at: null,
      })
      .execute();
    const refreshed = await bus.execute(actor(tenantId), "inventory.refresh_supplier_balance", {
      supplierId,
      adapter: "manual",
      balanceMinor: "100000",
      currency: "BRL",
      evidenceRef: `test:fixture:${supplierId}`,
    });
    if (!refreshed.ok) {
      throw new Error(`balance refresh failed: ${JSON.stringify(refreshed)}`);
    }
    const reserved = await bus.execute<{ id: string; procurementOrderId: string }>(
      actor(tenantId),
      "inventory.reserve_app_credit",
      {
        supplierId,
        commerceOrderId: orderId,
        appTrialId: requested.data.id,
        amountMinor: "2000",
        currency: "BRL",
        idempotencyKey: `w7l-${newId()}`,
      },
    );
    if (!reserved.ok) {
      throw new Error(`reserve failed: ${JSON.stringify(reserved)}`);
    }
    return {
      tenantId,
      supplierId,
      customerId,
      trialId: requested.data.id,
      orderId,
      procurementOrderId: reserved.data.procurementOrderId,
      reservationId: reserved.data.id,
    };
  }

  async function providerOpCount(tenantId: string, licenseId: string): Promise<number> {
    const rows = await db
      .selectFrom("provider.provider_operations")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("entity_type", "=", "app_license")
      .where("entity_id", "=", licenseId)
      .execute();
    return rows.length;
  }

  /** Two-phase purchase: intent (committed) + single charge execution. */
  async function purchaseAndExecute(
    tenantId: string,
    procurementOrderId: string,
    customerId: string,
    extra: { echoOutcome?: "success" | "failed" | "unknown"; adapter?: "echo" | "manual" } = {},
  ): Promise<Record<string, unknown>> {
    const intent = await bus.execute<Record<string, unknown>>(actor(tenantId), "inventory.purchase_app_license", {
      procurementOrderId,
      customerId,
    });
    if (!intent.ok) {
      throw new Error(`purchase intent failed: ${JSON.stringify(intent)}`);
    }
    const charged = await bus.execute<Record<string, unknown>>(
      actor(tenantId),
      "inventory.execute_app_license_charge",
      { licenseId: intent.data["id"] as string, ...extra },
    );
    if (!charged.ok) {
      throw new Error(`charge execution failed: ${JSON.stringify(charged)}`);
    }
    return charged.data;
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    // Pre-seed the global provider catalog row (idempotent): concurrent
    // suites share this table, so a bare select-then-insert would race.
    await db
      .insertInto("provider.providers")
      .values({
        id: newId(),
        provider_key: "cinevision",
        name: "CINEVISION",
        provider_type: "FULFILLMENT",
        status: "ACTIVE",
        created_at: new Date(),
      })
      .onConflict((oc) => oc.column("provider_key").doNothing())
      .execute();
    registerAppTrialCommands(bus);
    registerSupplierCreditCommands(bus, { balancePort: new EchoSupplierBalanceAdapter() });
    registerLicenseCommands(bus, { opsPort: new EchoProviderOpsAdapter() });
    delete process.env["PROVIDER_ECHO_OUTCOME"];
    delete process.env["PROVIDER_READBACK_EFFECT"];
  });

  afterAll(async () => {
    delete process.env["PROVIDER_READBACK_EFFECT"];
    await db.destroy().catch(() => undefined);
  });

  it("runs the happy path with Echo: one charge, then activation with the registry event", async () => {
    const fx = await makeReadyProcurement({ validateTrial: true, settleOrder: true });
    const purchased = await purchaseAndExecute(fx.tenantId, fx.procurementOrderId, fx.customerId);
    expect(purchased["status"]).toBe("PROVISIONING");
    expect(purchased["effectCertainty"]).toBe("KNOWN_APPLIED");
    const licenseId = purchased["id"] as string;

    const activated = await bus.execute<Record<string, unknown>>(actor(fx.tenantId), "inventory.activate_app_license", {
      licenseId,
    });
    if (!activated.ok) {
      throw new Error(`activate failed: ${JSON.stringify(activated)}`);
    }
    expect(activated.data["status"]).toBe("ACTIVE");

    // F4: the applied effect consumed the hold atomically at charge time.
    const hold = await db
      .selectFrom("inventory.credit_reservations")
      .select(["status"])
      .where("tenant_id", "=", fx.tenantId)
      .where("id", "=", fx.reservationId)
      .executeTakeFirstOrThrow();
    expect(hold.status).toBe("CONSUMED");
    const procurement = await db
      .selectFrom("inventory.procurement_orders")
      .select(["status"])
      .where("tenant_id", "=", fx.tenantId)
      .where("id", "=", fx.procurementOrderId)
      .executeTakeFirstOrThrow();
    expect(procurement.status).toBe("PURCHASED");

    // Exactly one supplier charge for this purchase (G07: no blind re-execution).
    expect(await providerOpCount(fx.tenantId, licenseId)).toBe(1);
    // Append-only: PROVISIONING + ACTIVE rows both present.
    const rows = await db
      .selectFrom("inventory.license_assets")
      .select(["status"])
      .where("tenant_id", "=", fx.tenantId)
      .where("procurement_order_id", "=", fx.procurementOrderId)
      .orderBy("created_at", "asc")
      .execute();
    expect(rows.map((r) => r.status)).toEqual(["PROVISIONING", "ACTIVE"]);

    // Only the registry-listed activation event is emitted.
    const events = await db
      .selectFrom("platform.domain_events")
      .select(["event_type"])
      .where("tenant_id", "=", fx.tenantId)
      .where("aggregate_type", "=", "license_asset")
      .where("aggregate_id", "=", activated.data["id"] as string)
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(["inventory.license.activated.v1"]);
  });

  it("parks unknown effects in VERIFYING, then reconciles and activates with no second charge", async () => {
    const fx = await makeReadyProcurement({ validateTrial: true, settleOrder: true });
    const purchased = await purchaseAndExecute(fx.tenantId, fx.procurementOrderId, fx.customerId, {
      echoOutcome: "unknown",
    });
    expect(purchased["effectCertainty"]).toBe("UNKNOWN");
    const licenseId = purchased["id"] as string;

    const openFinding = await db
      .selectFrom("inventory.reconciliation_findings")
      .select(["id", "status"])
      .where("tenant_id", "=", fx.tenantId)
      .where("entity_type", "=", "app_license")
      .where("entity_id", "=", licenseId)
      .where("status", "=", "OPEN")
      .executeTakeFirst();
    expect(openFinding?.status).toBe("OPEN");

    process.env["PROVIDER_READBACK_EFFECT"] = "APPLIED";
    try {
      const reconciled = await bus.execute<Record<string, unknown>>(
        actor(fx.tenantId),
        "inventory.reconcile_supplier_purchase",
        { licenseId },
      );
      if (!reconciled.ok) {
        throw new Error(`reconcile failed: ${JSON.stringify(reconciled)}`);
      }
      expect(reconciled.data["status"]).toBe("RESOLVED");
      expect(reconciled.data["effectApplied"]).toBe(true);

      const activated = await bus.execute<Record<string, unknown>>(
        actor(fx.tenantId),
        "inventory.activate_app_license",
        { licenseId },
      );
      if (!activated.ok) {
        throw new Error(`activate failed: ${JSON.stringify(activated)}`);
      }
      expect(activated.data["status"]).toBe("ACTIVE");
    } finally {
      delete process.env["PROVIDER_READBACK_EFFECT"];
    }

    // Still a single charge: reconcile/activate only read back.
    expect(await providerOpCount(fx.tenantId, licenseId)).toBe(1);
    const finding = await db
      .selectFrom("inventory.reconciliation_findings")
      .select(["status", "resolution_ref"])
      .where("tenant_id", "=", fx.tenantId)
      .where("id", "=", openFinding?.id as string)
      .executeTakeFirstOrThrow();
    expect(finding.status).toBe("RESOLVED");
    expect(finding.resolution_ref).not.toBeNull();
  });

  it("fails the purchase gate closed without a validated trial, a settled order, or an active hold", async () => {
    const unvalidated = await makeReadyProcurement({ validateTrial: false, settleOrder: true });
    const blockedTrial = await bus.execute(actor(unvalidated.tenantId), "inventory.purchase_app_license", {
      procurementOrderId: unvalidated.procurementOrderId,
      customerId: unvalidated.customerId,
    });
    expect(blockedTrial.ok).toBe(false);
    if (blockedTrial.ok) {
      throw new Error("purchase without a validated trial unexpectedly succeeded");
    }
    expect(blockedTrial.code).toBe("precondition_failed");
    expect(blockedTrial.message).toMatch(/BLOCKED TRIAL_NOT_VALIDATED/);

    const unsettled = await makeReadyProcurement({ validateTrial: true, settleOrder: false });
    const blockedOrder = await bus.execute(actor(unsettled.tenantId), "inventory.purchase_app_license", {
      procurementOrderId: unsettled.procurementOrderId,
      customerId: unsettled.customerId,
    });
    expect(blockedOrder.ok).toBe(false);
    if (blockedOrder.ok) {
      throw new Error("purchase without a settled order unexpectedly succeeded");
    }
    expect(blockedOrder.message).toMatch(/BLOCKED ORDER_NOT_SETTLED/);

    const released = await makeReadyProcurement({ validateTrial: true, settleOrder: true });
    const freed = await bus.execute(actor(released.tenantId), "inventory.release_app_credit", {
      reservationId: released.reservationId,
    });
    if (!freed.ok) {
      throw new Error(`release failed: ${JSON.stringify(freed)}`);
    }
    const blockedHold = await bus.execute(actor(released.tenantId), "inventory.purchase_app_license", {
      procurementOrderId: released.procurementOrderId,
      customerId: released.customerId,
    });
    expect(blockedHold.ok).toBe(false);
    if (blockedHold.ok) {
      throw new Error("purchase without an active hold unexpectedly succeeded");
    }
    // Release marks the linked procurement FAILED, so the purchase gate
    // stops at the procurement status (the hold is RELEASED either way).
    expect(blockedHold.message).toMatch(/RESERVED/);
  });

  it("never re-executes a purchase: replay returns the license with a single charge", async () => {
    const fx = await makeReadyProcurement({ validateTrial: true, settleOrder: true });
    const first = await purchaseAndExecute(fx.tenantId, fx.procurementOrderId, fx.customerId);
    const second = await bus.execute<Record<string, unknown>>(actor(fx.tenantId), "inventory.purchase_app_license", {
      procurementOrderId: fx.procurementOrderId,
      customerId: fx.customerId,
      idempotencyKey: `w7l-purchase-${newId()}`,
    });
    if (!second.ok) {
      throw new Error(`replay failed: ${JSON.stringify(second)}`);
    }
    expect(second.data["id"]).toBe(first["id"]);
    expect(second.data["already"]).toBe(true);
    expect(await providerOpCount(fx.tenantId, first["id"] as string)).toBe(1);
  });

  it("isolates licenses per tenant", async () => {
    const fx = await makeReadyProcurement({ validateTrial: true, settleOrder: true });
    const purchased = await purchaseAndExecute(fx.tenantId, fx.procurementOrderId, fx.customerId);
    const otherTenant = await makeTenant();
    const foreign = await bus.execute(actor(otherTenant), "inventory.activate_app_license", {
      licenseId: purchased["id"] as string,
    });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) {
      throw new Error("cross-tenant activation unexpectedly succeeded");
    }
    expect(foreign.code).toBe("not_found");
  });
});
