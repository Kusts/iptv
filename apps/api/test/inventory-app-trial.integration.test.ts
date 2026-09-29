import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDb } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import { KyselyCommandDb } from "../src/commands/kysely-command-db.js";
import { registerAppTrialCommands } from "../src/inventory/app-trial.commands.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const PERMISSIONS = ["trial.read", "trial.write"];

describe.skipIf(!hasDb)("Wave 7 AppTrial lifecycle (requires TEST_DATABASE_URL)", () => {
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
        slug: `w7t-${suffix}`,
        name: "Wave7 Trial Tenant",
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

  async function makeSupplier(tenantId: string): Promise<string> {
    const id = newId();
    await db
      .insertInto("inventory.suppliers")
      .values({
        id,
        tenant_id: tenantId,
        name: "Wave7 Trial Supplier",
        supplier_type: "APP_CATALOG",
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    return id;
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    registerAppTrialCommands(bus);
  });

  afterAll(async () => {
    await db.destroy().catch(() => undefined);
  });

  it("requests and validates a trial in one tenant", async () => {
    const tenantId = await makeTenant();
    const personId = await makePerson(tenantId);
    const customerId = await makeCustomer(tenantId, personId);
    const supplierId = await makeSupplier(tenantId);

    const requested = await bus.execute<{ id: string; status: string; already: boolean }>(
      actor(tenantId),
      "inventory.request_app_trial",
      { personId, customerId, supplierId, supplierAppExternalId: "app-pro-01" },
    );
    if (!requested.ok) {
      throw new Error(`request failed: ${JSON.stringify(requested)}`);
    }
    expect(requested.data.status).toBe("REQUESTED");
    expect(requested.data.already).toBe(false);

    const validated = await bus.execute(actor(tenantId), "inventory.validate_app_trial", {
      trialId: requested.data.id,
      outcome: "VALIDATED",
    });
    if (!validated.ok) {
      throw new Error(`validate failed: ${JSON.stringify(validated)}`);
    }

    const row = await db
      .selectFrom("inventory.app_trials")
      .select(["status", "validated_at"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", requested.data.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("VALIDATED");
    expect(row.validated_at).not.toBeNull();
  });

  it("keeps a single open trial per person+supplier and allows a new one after validation", async () => {
    const tenantId = await makeTenant();
    const personId = await makePerson(tenantId);
    const supplierId = await makeSupplier(tenantId);

    const first = await bus.execute<{ id: string; already: boolean }>(actor(tenantId), "inventory.request_app_trial", {
      personId,
      supplierId,
      supplierAppExternalId: "app-pro-01",
    });
    if (!first.ok) {
      throw new Error(`first request failed: ${JSON.stringify(first)}`);
    }
    const second = await bus.execute<{ id: string; already: boolean }>(
      actor(tenantId),
      "inventory.request_app_trial",
      { personId, supplierId, supplierAppExternalId: "app-pro-02" },
    );
    if (!second.ok) {
      throw new Error(`second request failed: ${JSON.stringify(second)}`);
    }
    expect(second.data.already).toBe(true);
    expect(second.data.id).toBe(first.data.id);

    const validated = await bus.execute(actor(tenantId), "inventory.validate_app_trial", {
      trialId: first.data.id,
      outcome: "VALIDATED",
    });
    if (!validated.ok) {
      throw new Error(`validate failed: ${JSON.stringify(validated)}`);
    }
    const third = await bus.execute<{ id: string; already: boolean }>(actor(tenantId), "inventory.request_app_trial", {
      personId,
      supplierId,
      supplierAppExternalId: "app-pro-02",
    });
    if (!third.ok) {
      throw new Error(`third request failed: ${JSON.stringify(third)}`);
    }
    expect(third.data.already).toBe(false);
    expect(third.data.id).not.toBe(first.data.id);
  });

  it("rejects invalid transitions and cross-customer mixes", async () => {
    const tenantId = await makeTenant();
    const personId = await makePerson(tenantId);
    const otherPersonId = await makePerson(tenantId);
    const otherCustomerId = await makeCustomer(tenantId, otherPersonId);
    const supplierId = await makeSupplier(tenantId);

    const mixed = await bus.execute(actor(tenantId), "inventory.request_app_trial", {
      personId,
      customerId: otherCustomerId,
      supplierId,
      supplierAppExternalId: "app-pro-01",
    });
    expect(mixed.ok).toBe(false);
    if (mixed.ok) {
      throw new Error("cross-customer mix unexpectedly succeeded");
    }
    expect(mixed.code).toBe("precondition_failed");

    const requested = await bus.execute<{ id: string }>(actor(tenantId), "inventory.request_app_trial", {
      personId,
      supplierId,
      supplierAppExternalId: "app-pro-01",
    });
    if (!requested.ok) {
      throw new Error(`request failed: ${JSON.stringify(requested)}`);
    }
    const invalidated = await bus.execute(actor(tenantId), "inventory.validate_app_trial", {
      trialId: requested.data.id,
      outcome: "INVALIDATED",
      reason: "customer rejected the test",
    });
    if (!invalidated.ok) {
      throw new Error(`invalidate failed: ${JSON.stringify(invalidated)}`);
    }
    const again = await bus.execute(actor(tenantId), "inventory.validate_app_trial", {
      trialId: requested.data.id,
      outcome: "VALIDATED",
    });
    expect(again.ok).toBe(false);
    if (again.ok) {
      throw new Error("double validation unexpectedly succeeded");
    }
    expect(again.code).toBe("precondition_failed");
  });

  it("expires due trials and isolates tenants", async () => {
    const tenantId = await makeTenant();
    const personId = await makePerson(tenantId);
    const supplierId = await makeSupplier(tenantId);
    const requested = await bus.execute<{ id: string }>(actor(tenantId), "inventory.request_app_trial", {
      personId,
      supplierId,
      supplierAppExternalId: "app-pro-01",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    if (!requested.ok) {
      throw new Error(`request failed: ${JSON.stringify(requested)}`);
    }
    const expired = await bus.execute<{ expiredTrialIds: string[] }>(actor(tenantId), "inventory.expire_app_trials", {
      limit: 100,
    });
    if (!expired.ok) {
      throw new Error(`expire failed: ${JSON.stringify(expired)}`);
    }
    expect(expired.data.expiredTrialIds).toContain(requested.data.id);

    const otherTenant = await makeTenant();
    const foreignValidate = await bus.execute(actor(otherTenant), "inventory.validate_app_trial", {
      trialId: requested.data.id,
      outcome: "VALIDATED",
    });
    expect(foreignValidate.ok).toBe(false);
    if (foreignValidate.ok) {
      throw new Error("cross-tenant validate unexpectedly succeeded");
    }
    expect(foreignValidate.code).toBe("not_found");

    const foreignRequest = await bus.execute(actor(otherTenant), "inventory.request_app_trial", {
      personId,
      supplierId,
      supplierAppExternalId: "app-pro-01",
    });
    expect(foreignRequest.ok).toBe(false);
    if (foreignRequest.ok) {
      throw new Error("cross-tenant request unexpectedly succeeded");
    }
    expect(foreignRequest.code).toBe("not_found");
  });
});
