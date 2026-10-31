import { afterEach, describe, expect, it, vi } from "vitest";
import { ASAAS_TENANT_HOSTS } from "../src/billing/asaas-port.js";
import { registerBillingCommands } from "../src/billing/billing.commands.js";
import type { CommandBus } from "../src/commands/command-bus.js";

/**
 * P85-ASAAS-WIRING: the production provider registers billing commands with
 * NO fixed `asaasPort`, so handlers resolve per tenant at call time
 * (`resolveAsaasPortForTenant`): a CONNECTED_READ_ONLY binding + readable
 * vault yields a dedicated RealAsaasAdapter; without a binding the legacy
 * env adapter answers (compat). Zero network, zero real secret.
 */

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERSON = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROVIDER_ID = "prov-asaas-1";
const SECRET_REF =
  "infisical://sandbox/integrations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/asaas/ASAAS_API_KEY";
const VAULT_KEY = "tenant-vault-key-not-a-secret";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

interface QueryCall {
  table: string;
  op: "select" | "insert" | "update";
  values?: unknown;
  filters?: Array<{ field: string; value: unknown }>;
}

class StubTrx {
  readonly inserts: QueryCall[] = [];
  constructor(private readonly binding: { secret_ref: string; environment: string; connection_status: string } | undefined) {}
  selectFrom(table: string): StubQueryBuilder {
    return new StubQueryBuilder(this, { table, op: "select", filters: [] });
  }
  insertInto(table: string): StubQueryBuilder {
    const call: QueryCall = { table, op: "insert" };
    this.inserts.push(call);
    return new StubQueryBuilder(this, call);
  }
  updateTable(table: string): StubQueryBuilder {
    return new StubQueryBuilder(this, { table, op: "update" });
  }
  takeFirst(call: QueryCall): Promise<unknown> {
    if (call.op === "insert" && call.table === "billing.customer_provider_bindings") {
      return Promise.resolve({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
    }
    if (call.table === "identity.persons") {
      return Promise.resolve({ id: PERSON, canonical_name: "Test Person" });
    }
    if (call.table === "billing.customer_provider_bindings") {
      return Promise.resolve(undefined);
    }
    if (call.table === "provider.providers") {
      return Promise.resolve({ id: PROVIDER_ID });
    }
    if (call.table === "provider.provider_accounts") {
      const status = call.filters?.find((f) => f.field === "connection_status")?.value;
      if (this.binding === undefined || this.binding.connection_status !== status) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve({
        secret_ref: this.binding.secret_ref,
        environment: this.binding.environment,
        connection_status: this.binding.connection_status,
      });
    }
    return Promise.resolve(undefined);
  }
  exec(): Promise<unknown> {
    return Promise.resolve(undefined);
  }
}

class StubQueryBuilder {
  constructor(
    private readonly trx: StubTrx,
    private readonly call: QueryCall,
  ) {}
  select(...args: unknown[]): this {
    void args;
    return this;
  }
  where(field: string, _op: string, value: unknown): this {
    this.call.filters?.push({ field, value });
    return this;
  }
  forUpdate(): this {
    return this;
  }
  orderBy(...args: unknown[]): this {
    void args;
    return this;
  }
  limit(...args: unknown[]): this {
    void args;
    return this;
  }
  values(v: unknown): this {
    this.call.values = v;
    return this;
  }
  set(v: unknown): this {
    this.call.values = v;
    return this;
  }
  onConflict(fn: (oc: { columns: (cols: string[]) => { doNothing: () => void } }) => unknown): this {
    fn({ columns: () => ({ doNothing: () => undefined }) });
    return this;
  }
  returning(...args: unknown[]): this {
    void args;
    return this;
  }
  executeTakeFirst(): Promise<unknown> {
    return this.trx.takeFirst(this.call);
  }
  executeTakeFirstOrThrow(): Promise<unknown> {
    return this.trx.takeFirst(this.call).then((row) => {
      if (row === undefined) {
        throw new Error(`stub: no row for ${this.call.table}`);
      }
      return row;
    });
  }
  execute(): Promise<unknown> {
    return this.trx.exec();
  }
}

function stubCtx(trx: StubTrx): unknown {
  return {
    actor: {
      userId: "user-1",
      isPlatformAdmin: false,
      tenantId: TENANT,
      roleKeys: ["tenant_owner"],
      permissions: ["billing.charge.write"],
      actorType: "human",
    },
    tenantId: TENANT,
    commandId: "66666666-6666-4666-8666-666666666666",
    correlationId: "77777777-7777-4777-8777-777777777777",
    causationId: null,
    tx: {
      innerDb: () => trx,
      getReviewRequest: () => Promise.resolve({ status: "RESOLVED" }),
      nextAggregateVersion: () => Promise.resolve(1),
      emitDomainEvent: () => Promise.resolve({ domainEventId: "88888888-8888-4888-8888-888888888888" }),
      enqueueOutbox: () => Promise.resolve(undefined),
    },
  };
}

/**
 * Mirrors the production provider wiring: NO `asaasPort` is injected — only
 * the test seams (`secretsPort`/`asaasFetch`) that production fills with the
 * live vault reader and global fetch.
 */
function handlersFor(deps: { secretsPort: unknown; asaasFetch: unknown }) {
  const defs = new Map<string, (ctx: unknown, input: unknown) => Promise<unknown>>();
  const bus = {
    register: (def: { name: string; handler: (ctx: unknown, input: unknown) => Promise<unknown> }) => {
      defs.set(def.name, def.handler);
    },
  };
  registerBillingCommands(bus as unknown as CommandBus, {
    secretsPort: deps.secretsPort as never,
    asaasFetch: deps.asaasFetch as never,
  });
  return defs;
}

afterEach(() => {
  delete process.env["ASAAS_ADAPTER"];
  delete process.env["ASAAS_API_KEY"];
  delete process.env["ASAAS_BASE_URL"];
  vi.restoreAllMocks();
});

describe("P85 provider wiring: per-tenant Asaas resolution without an injected port", () => {
  it("CONNECTED_READ_ONLY binding + readable vault provisions via the tenant RealAsaasAdapter (never echo)", async () => {
    process.env["ASAAS_ADAPTER"] = "echo";
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "cus_real_1", name: "Test Person" }));
    const getSecret = vi.fn(() => Promise.resolve(VAULT_KEY));
    const trx = new StubTrx({
      secret_ref: SECRET_REF,
      environment: "SANDBOX",
      connection_status: "CONNECTED_READ_ONLY",
    });
    const handlers = handlersFor({
      secretsPort: { name: "fake-vault", getSecret },
      asaasFetch: fetchMock,
    });
    const provision = handlers.get("billing.customer_provision");
    expect(provision).toBeDefined();
    const result = (await provision?.(stubCtx(trx), { personId: PERSON })) as {
      ok: boolean;
      data: { providerCustomerId: string; provisioned: boolean };
    };
    expect(result.ok).toBe(true);
    expect(result.data.provisioned).toBe(true);
    // Real provider id — NOT the echo namespace.
    expect(result.data.providerCustomerId).toBe("cus_real_1");
    // Vault read exactly the binding ref.
    expect(getSecret).toHaveBeenCalledTimes(1);
    expect(getSecret).toHaveBeenCalledWith(SECRET_REF);
    // Provider call went to the fixed SANDBOX host with the vaulted key.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ASAAS_TENANT_HOSTS.SANDBOX}/customers`);
    expect((init.headers as Record<string, string>)["access_token"]).toBe(VAULT_KEY);
    const insert = trx.inserts.find((call) => call.table === "billing.customer_provider_bindings");
    expect((insert?.values as Record<string, unknown>)["external_customer_id"]).toBe("cus_real_1");
  });

  it("no binding falls back to the legacy env adapter (echo today) without touching vault or network", async () => {
    process.env["ASAAS_ADAPTER"] = "echo";
    const fetchMock = vi.fn();
    const getSecret = vi.fn(() => Promise.resolve(VAULT_KEY));
    const trx = new StubTrx(undefined);
    const handlers = handlersFor({
      secretsPort: { name: "fake-vault", getSecret },
      asaasFetch: fetchMock,
    });
    const provision = handlers.get("billing.customer_provision");
    const result = (await provision?.(stubCtx(trx), { personId: PERSON })) as {
      ok: boolean;
      data: { providerCustomerId: string; provisioned: boolean };
    };
    expect(result.ok).toBe(true);
    expect(result.data.provisioned).toBe(true);
    expect(result.data.providerCustomerId).toBe(`echo-cus-${PERSON}`);
    expect(getSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
