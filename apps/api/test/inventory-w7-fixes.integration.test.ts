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
import {
  EchoProviderOpsAdapter,
  type ProviderOperationRequest,
  type AdapterResult,
  type ProviderOpsPort,
} from "../src/provider/provider-port.js";
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

/**
 * Simulates a crash AFTER a possible external charge: records the charge
 * attempt in an out-of-transaction store, then throws so the execute
 * transaction rolls back. The retry must reconcile (readback) before any
 * second charge — charges.length stays 1.
 */
class CrashAfterChargePort implements ProviderOpsPort {
  readonly name = "manual";
  readonly charges: string[] = [];

  async requestOperation(input: ProviderOperationRequest): Promise<AdapterResult> {
    this.charges.push(input.idempotencyKey);
    throw new Error("simulated crash after charge");
  }
}

describe.skipIf(!hasDb)("Wave 7 review fixes iptv-w7-fixes (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  const bus = new CommandBus(new KyselyCommandDb(db));
  const crasher = new CrashAfterChargePort();
  const crashBus = new CommandBus(new KyselyCommandDb(db));

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
        slug: `w7f-${suffix}`,
        name: "Wave7 Fixes Tenant",
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
        canonical_name: "Wave7 Fixes Person",
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

  async function makeSupplier(tenantId: string): Promise<string> {
    const supplierId = newId();
    await db
      .insertInto("inventory.suppliers")
      .values({
        id: supplierId,
        tenant_id: tenantId,
        name: "Wave7 Fixes Supplier",
        supplier_type: "APP_CATALOG",
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    return supplierId;
  }

  async function makeSettledOrder(tenantId: string, personId: string, customerId: string): Promise<string> {
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
        status: "SETTLED",
        currency: "BRL",
        gross_amount_minor: "2000",
        discount_amount_minor: "0",
        reward_amount_minor: "0",
        net_amount_minor: "2000",
        settled_amount_minor: "2000",
        created_at: new Date(),
        awaiting_payment_at: new Date(),
        settled_at: new Date(),
        cancelled_at: null,
        expires_at: null,
      })
      .execute();
    return orderId;
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

  async function makeReadyProcurement(): Promise<ReadyFixture> {
    const tenantId = await makeTenant();
    const personId = await makePerson(tenantId);
    const customerId = await makeCustomer(tenantId, personId);
    const supplierId = await makeSupplier(tenantId);
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
    const validated = await bus.execute(actor(tenantId), "inventory.validate_app_trial", {
      trialId: requested.data.id,
      outcome: "VALIDATED",
    });
    if (!validated.ok) {
      throw new Error(`trial validate failed: ${JSON.stringify(validated)}`);
    }
    const orderId = await makeSettledOrder(tenantId, personId, customerId);
    const refreshed = await bus.execute(actor(tenantId), "inventory.refresh_supplier_balance", {
      supplierId,
      adapter: "manual",
      balanceMinor: "100000",
      currency: "BRL",
      evidenceRef: `test:fix:${supplierId}`,
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
        idempotencyKey: `w7f-${newId()}`,
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

  async function purchaseIntent(
    tenantId: string,
    procurementOrderId: string,
    customerId: string,
  ): Promise<Record<string, unknown>> {
    const intent = await bus.execute<Record<string, unknown>>(actor(tenantId), "inventory.purchase_app_license", {
      procurementOrderId,
      customerId,
    });
    if (!intent.ok) {
      throw new Error(`purchase intent failed: ${JSON.stringify(intent)}`);
    }
    return intent.data;
  }

  async function providerOpsForLicense(tenantId: string, licenseId: string): Promise<number> {
    const rows = await db
      .selectFrom("provider.provider_operations")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("entity_type", "=", "app_license")
      .where("entity_id", "=", licenseId)
      .execute();
    return rows.length;
  }

  async function openFindingFor(tenantId: string, licenseId: string): Promise<{ id: string; status: string } | null> {
    const row = await db
      .selectFrom("inventory.reconciliation_findings")
      .select(["id", "status"])
      .where("tenant_id", "=", tenantId)
      .where("entity_type", "=", "app_license")
      .where("entity_id", "=", licenseId)
      .where("status", "=", "OPEN")
      .executeTakeFirst();
    return row === undefined ? null : { id: row.id, status: row.status };
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
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
    registerAppTrialCommands(crashBus);
    registerSupplierCreditCommands(crashBus, { balancePort: new EchoSupplierBalanceAdapter() });
    registerLicenseCommands(crashBus, { opsPort: crasher });
    delete process.env["PROVIDER_ECHO_OUTCOME"];
    delete process.env["PROVIDER_READBACK_EFFECT"];
  });

  afterAll(async () => {
    delete process.env["PROVIDER_READBACK_EFFECT"];
    await db.destroy().catch(() => undefined);
  });

  it("(a) crash-path: simulated post-intent failure leaves a recoverable VERIFYING and the retry never re-charges", async () => {
    crasher.charges.length = 0;
    const fx = await makeReadyProcurement();
    const intent = await purchaseIntent(fx.tenantId, fx.procurementOrderId, fx.customerId);
    const licenseId = intent["id"] as string;

    const crashed = await crashBus.execute<Record<string, unknown>>(
      actor(fx.tenantId),
      "inventory.execute_app_license_charge",
      { licenseId },
    );
    if (!crashed.ok) {
      throw new Error(`crash execute failed: ${JSON.stringify(crashed)}`);
    }
    expect(crashed.data["effectCertainty"]).toBe("UNKNOWN");
    expect(crasher.charges.length).toBe(1);

    const opRow = await db
      .selectFrom("provider.provider_operations")
      .select(["status", "effect_certainty"])
      .where("tenant_id", "=", fx.tenantId)
      .where("entity_type", "=", "app_license")
      .where("entity_id", "=", licenseId)
      .executeTakeFirstOrThrow();
    expect(opRow.status).toBe("VERIFYING");
    expect(opRow.effect_certainty).toBe("UNKNOWN");
    expect(await openFindingFor(fx.tenantId, licenseId)).not.toBeNull();

    // Retry under an inconclusive readback: no new charge, stays VERIFYING, finding stays OPEN.
    process.env["PROVIDER_READBACK_EFFECT"] = "UNKNOWN";
    try {
      const retried = await crashBus.execute<Record<string, unknown>>(
        actor(fx.tenantId),
        "inventory.execute_app_license_charge",
        { licenseId },
      );
      if (!retried.ok) {
        throw new Error(`inconclusive retry failed: ${JSON.stringify(retried)}`);
      }
      expect(retried.data["conclusive"]).toBe(false);
      expect(retried.data["retried"]).toBe(false);
    } finally {
      delete process.env["PROVIDER_READBACK_EFFECT"];
    }
    expect(crasher.charges.length).toBe(1);
    const stillVerifying = await db
      .selectFrom("provider.provider_operations")
      .select(["status"])
      .where("tenant_id", "=", fx.tenantId)
      .where("entity_type", "=", "app_license")
      .where("entity_id", "=", licenseId)
      .executeTakeFirstOrThrow();
    expect(stillVerifying.status).toBe("VERIFYING");
    expect(await openFindingFor(fx.tenantId, licenseId)).not.toBeNull();

    // Retry under a conclusive NOT_APPLIED readback: finalizes without any new charge.
    const settled = await crashBus.execute<Record<string, unknown>>(
      actor(fx.tenantId),
      "inventory.execute_app_license_charge",
      { licenseId },
    );
    if (!settled.ok) {
      throw new Error(`conclusive retry failed: ${JSON.stringify(settled)}`);
    }
    expect(settled.data["effectCertainty"]).toBe("KNOWN_NOT_APPLIED");
    expect(crasher.charges.length).toBe(1);
    expect(await providerOpsForLicense(fx.tenantId, licenseId)).toBe(1);
    const hold = await db
      .selectFrom("inventory.credit_reservations")
      .select(["status"])
      .where("tenant_id", "=", fx.tenantId)
      .where("id", "=", fx.reservationId)
      .executeTakeFirstOrThrow();
    expect(hold.status).toBe("RELEASED");
  });

  it("(b) purchase vs release race on one reservation ends in exactly one consistent terminal state", async () => {
    const fx = await makeReadyProcurement();
    const intent = await purchaseIntent(fx.tenantId, fx.procurementOrderId, fx.customerId);
    const licenseId = intent["id"] as string;

    const [charged, released] = await Promise.all([
      bus.execute<Record<string, unknown>>(actor(fx.tenantId), "inventory.execute_app_license_charge", {
        licenseId,
      }),
      bus.execute<Record<string, unknown>>(actor(fx.tenantId), "inventory.release_app_credit", {
        reservationId: fx.reservationId,
      }),
    ]);

    const hold = await db
      .selectFrom("inventory.credit_reservations")
      .select(["status"])
      .where("tenant_id", "=", fx.tenantId)
      .where("id", "=", fx.reservationId)
      .executeTakeFirstOrThrow();
    const procurement = await db
      .selectFrom("inventory.procurement_orders")
      .select(["status"])
      .where("tenant_id", "=", fx.tenantId)
      .where("id", "=", fx.procurementOrderId)
      .executeTakeFirstOrThrow();
    const ops = await providerOpsForLicense(fx.tenantId, licenseId);

    if (hold.status === "CONSUMED") {
      // Charge won: exactly one charge, hold spent, procurement purchased.
      expect(charged.ok).toBe(true);
      expect(released.ok).toBe(false);
      expect(procurement.status).toBe("PURCHASED");
      expect(ops).toBe(1);
    } else {
      // Release won: hold freed, procurement failed, charge refused before any effect.
      expect(hold.status).toBe("RELEASED");
      expect(released.ok).toBe(true);
      expect(procurement.status).toBe("FAILED");
      expect(charged.ok).toBe(false);
      expect(ops).toBe(0);
    }
  });

  it("(c) two concurrent reserves with room for both yield exactly 1 procurement and 1 charge", async () => {
    const tenantId = await makeTenant();
    const personId = await makePerson(tenantId);
    const customerId = await makeCustomer(tenantId, personId);
    const supplierId = await makeSupplier(tenantId);
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
    const validated = await bus.execute(actor(tenantId), "inventory.validate_app_trial", {
      trialId: requested.data.id,
      outcome: "VALIDATED",
    });
    if (!validated.ok) {
      throw new Error(`trial validate failed: ${JSON.stringify(validated)}`);
    }
    const orderId = await makeSettledOrder(tenantId, personId, customerId);
    const refreshed = await bus.execute(actor(tenantId), "inventory.refresh_supplier_balance", {
      supplierId,
      adapter: "manual",
      balanceMinor: "100000",
      currency: "BRL",
      evidenceRef: `test:fix-c:${supplierId}`,
    });
    if (!refreshed.ok) {
      throw new Error(`balance refresh failed: ${JSON.stringify(refreshed)}`);
    }

    const base = {
      supplierId,
      commerceOrderId: orderId,
      appTrialId: requested.data.id,
      amountMinor: "2000",
      currency: "BRL",
    };
    const [first, second] = await Promise.all([
      bus.execute<Record<string, unknown>>(actor(tenantId), "inventory.reserve_app_credit", {
        ...base,
        idempotencyKey: `w7f-c1-${newId()}`,
      }),
      bus.execute<Record<string, unknown>>(actor(tenantId), "inventory.reserve_app_credit", {
        ...base,
        idempotencyKey: `w7f-c2-${newId()}`,
      }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const flags = [first, second].map((r) => (r.ok ? (r.data as Record<string, unknown>)["already"] : null));
    expect(flags.filter((f) => f === false).length).toBe(1);
    expect(flags.filter((f) => f === true).length).toBe(1);

    const procurements = await db
      .selectFrom("inventory.procurement_orders")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("commerce_order_id", "=", orderId)
      .where("status", "<>", "FAILED")
      .execute();
    expect(procurements.length).toBe(1);

    const winner = [first, second].find((r) => r.ok && (r.data as Record<string, unknown>)["already"] === false);
    if (winner === undefined || !winner.ok) {
      throw new Error("no winning reserve found");
    }
    const winnerData = winner.data as Record<string, unknown>;
    const intent = await purchaseIntent(tenantId, winnerData["procurementOrderId"] as string, customerId);
    const licenseId = intent["id"] as string;
    const charged = await bus.execute<Record<string, unknown>>(
      actor(tenantId),
      "inventory.execute_app_license_charge",
      { licenseId },
    );
    if (!charged.ok) {
      throw new Error(`charge failed: ${JSON.stringify(charged)}`);
    }
    expect(await providerOpsForLicense(tenantId, licenseId)).toBe(1);
  });

  it("(d) an order from another customer (or a foreign-supplier trial) does not authorize purchase", async () => {
    const tenantId = await makeTenant();
    const personA = await makePerson(tenantId);
    const customerA = await makeCustomer(tenantId, personA);
    const personB = await makePerson(tenantId);
    const customerB = await makeCustomer(tenantId, personB);
    const supplierId = await makeSupplier(tenantId);
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
      personId: personA,
      customerId: customerA,
      supplierId,
      supplierAppExternalId: "app-pro-01",
    });
    if (!requested.ok) {
      throw new Error(`trial request failed: ${JSON.stringify(requested)}`);
    }
    const trialA = requested.data.id;
    const validated = await bus.execute(actor(tenantId), "inventory.validate_app_trial", {
      trialId: trialA,
      outcome: "VALIDATED",
    });
    if (!validated.ok) {
      throw new Error(`trial validate failed: ${JSON.stringify(validated)}`);
    }
    const orderB = await makeSettledOrder(tenantId, personB, customerB);
    const refreshed = await bus.execute(actor(tenantId), "inventory.refresh_supplier_balance", {
      supplierId,
      adapter: "manual",
      balanceMinor: "100000",
      currency: "BRL",
      evidenceRef: `test:fix-d:${supplierId}`,
    });
    if (!refreshed.ok) {
      throw new Error(`balance refresh failed: ${JSON.stringify(refreshed)}`);
    }

    // Procurement binding customer-A's trial to customer-B's order.
    const mixed = await bus.execute(actor(tenantId), "inventory.reserve_app_credit", {
      supplierId,
      commerceOrderId: orderB,
      appTrialId: trialA,
      amountMinor: "2000",
      currency: "BRL",
      idempotencyKey: `w7f-d-${newId()}`,
    });
    if (!mixed.ok) {
      throw new Error(`mixed reserve failed: ${JSON.stringify(mixed)}`);
    }
    const mixedProcurementId = (mixed.data as Record<string, unknown>)["procurementOrderId"] as string;
    const denied = await bus.execute(actor(tenantId), "inventory.purchase_app_license", {
      procurementOrderId: mixedProcurementId,
      customerId: customerA,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) {
      throw new Error("cross-customer purchase unexpectedly succeeded");
    }
    expect(denied.message).toMatch(/customer|person|trial/i);

    // Procurement binding a foreign-supplier trial to this supplier.
    const supplier2 = await makeSupplier(tenantId);
    const trial2 = await bus.execute<{ id: string }>(actor(tenantId), "inventory.request_app_trial", {
      personId: personA,
      supplierId: supplier2,
      supplierAppExternalId: "app-pro-01",
    });
    if (!trial2.ok) {
      throw new Error(`second trial failed: ${JSON.stringify(trial2)}`);
    }
    const orderA2 = await makeSettledOrder(tenantId, personA, customerA);
    const foreignTrial = await bus.execute(actor(tenantId), "inventory.reserve_app_credit", {
      supplierId,
      commerceOrderId: orderA2,
      appTrialId: trial2.data.id,
      amountMinor: "2000",
      currency: "BRL",
      idempotencyKey: `w7f-d2-${newId()}`,
    });
    if (!foreignTrial.ok) {
      throw new Error(`foreign-trial reserve failed: ${JSON.stringify(foreignTrial)}`);
    }
    const deniedTrial = await bus.execute(actor(tenantId), "inventory.purchase_app_license", {
      procurementOrderId: (foreignTrial.data as Record<string, unknown>)["procurementOrderId"] as string,
      customerId: customerA,
    });
    expect(deniedTrial.ok).toBe(false);
    if (deniedTrial.ok) {
      throw new Error("foreign-supplier purchase unexpectedly succeeded");
    }
    expect(deniedTrial.message).toMatch(/supplier/i);
  });

  it("(e) UNKNOWN readback stays INCONCLUSIVE: finding OPEN, license untouched, no failure", async () => {
    const fx = await makeReadyProcurement();
    const intent = await purchaseIntent(fx.tenantId, fx.procurementOrderId, fx.customerId);
    const licenseId = intent["id"] as string;
    const charged = await bus.execute<Record<string, unknown>>(
      actor(fx.tenantId),
      "inventory.execute_app_license_charge",
      { licenseId, echoOutcome: "unknown" },
    );
    if (!charged.ok) {
      throw new Error(`unknown charge failed: ${JSON.stringify(charged)}`);
    }
    expect(charged.data["effectCertainty"]).toBe("UNKNOWN");

    process.env["PROVIDER_READBACK_EFFECT"] = "UNKNOWN";
    try {
      const reconciled = await bus.execute<Record<string, unknown>>(
        actor(fx.tenantId),
        "inventory.reconcile_supplier_purchase",
        { licenseId },
      );
      if (!reconciled.ok) {
        throw new Error(`reconcile failed: ${JSON.stringify(reconciled)}`);
      }
      expect(reconciled.data["status"]).toBe("OPEN");
      expect(reconciled.data["conclusive"]).toBe(false);

      const activated = await bus.execute<Record<string, unknown>>(
        actor(fx.tenantId),
        "inventory.activate_app_license",
        { licenseId },
      );
      if (!activated.ok) {
        throw new Error(`activate failed: ${JSON.stringify(activated)}`);
      }
      expect(activated.data["activationDeferred"]).toBe(true);
      expect(activated.data["conclusive"]).toBe(false);
    } finally {
      delete process.env["PROVIDER_READBACK_EFFECT"];
    }

    const opRow = await db
      .selectFrom("provider.provider_operations")
      .select(["status", "effect_certainty"])
      .where("tenant_id", "=", fx.tenantId)
      .where("entity_type", "=", "app_license")
      .where("entity_id", "=", licenseId)
      .executeTakeFirstOrThrow();
    expect(opRow.status).toBe("VERIFYING");
    expect(opRow.effect_certainty).toBe("UNKNOWN");
    expect(await openFindingFor(fx.tenantId, licenseId)).not.toBeNull();
    const licenseRows = await db
      .selectFrom("inventory.license_assets")
      .select(["status"])
      .where("tenant_id", "=", fx.tenantId)
      .where("procurement_order_id", "=", fx.procurementOrderId)
      .execute();
    expect(licenseRows.length).toBe(1);
    expect(licenseRows[0]?.status).toBe("PROVISIONING");
    expect(await providerOpsForLicense(fx.tenantId, licenseId)).toBe(1);
  });
});
