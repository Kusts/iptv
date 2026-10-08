import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EchoAsaasAdapter,
  RealAsaasAdapter,
  SANDBOX_TEST_DOCUMENT_CPF,
  isSandboxBaseUrl,
  resolveProvisionDocument,
  type AsaasPort,
} from "../src/billing/asaas-port.js";
import {
  chargeCreateInput,
  customerProvisionInput,
  registerBillingCommands,
} from "../src/billing/billing.commands.js";
import type { CommandBus } from "../src/commands/command-bus.js";

afterEach(() => {
  delete process.env["ASAAS_API_KEY"];
  delete process.env["ASAAS_BASE_URL"];
});

describe("GAP-LOOP-1 sandbox vs production document gating", () => {
  it("detects sandbox base urls", () => {
    expect(isSandboxBaseUrl("https://sandbox.asaas.com/api/v3")).toBe(true);
    expect(isSandboxBaseUrl("https://SANDBOX.test")).toBe(true);
    expect(isSandboxBaseUrl("https://api.asaas.com/v3")).toBe(false);
  });

  it("sandbox resolves a missing document to the documented test constant", () => {
    expect(resolveProvisionDocument(null, "https://sandbox.asaas.com/api/v3")).toBe(
      SANDBOX_TEST_DOCUMENT_CPF,
    );
    expect(resolveProvisionDocument(undefined, "https://sandbox.asaas.com/api/v3")).toBe(
      SANDBOX_TEST_DOCUMENT_CPF,
    );
    expect(resolveProvisionDocument("111.444.777-35", "https://sandbox.asaas.com/api/v3")).toBe(
      "11144477735",
    );
  });

  it("production refuses without a real document (DOCUMENT_REQUIRED, never invented)", () => {
    expect(() => resolveProvisionDocument(null, "https://api.asaas.com/v3")).toThrow(
      /DOCUMENT_REQUIRED/,
    );
    expect(() => resolveProvisionDocument("   ", "https://api.asaas.com/v3")).toThrow(
      /DOCUMENT_REQUIRED/,
    );
    expect(() => resolveProvisionDocument("123", "https://api.asaas.com/v3")).toThrow(
      /11 digits.*14 digits|CPF.*CNPJ/,
    );
    expect(resolveProvisionDocument("11144477735", "https://api.asaas.com/v3")).toBe("11144477735");
    expect(resolveProvisionDocument("11.222.333/0001-81", "https://api.asaas.com/v3")).toBe(
      "11222333000181",
    );
  });

  it("echo provisions a namespaced synthetic customer without any document", async () => {
    const port = new EchoAsaasAdapter();
    const created = await port.createCustomer({ personId: "person-1", name: "Test Person" });
    expect(created.effect).toBe("KNOWN_APPLIED");
    expect(created.providerCustomerId).toBe("echo-cus-person-1");
  });
});

describe("GAP-LOOP-1 Real adapter customer provision (mocked fetch, no network)", () => {
  const API_KEY = "test-key-not-a-secret";
  const SANDBOX_BASE = "https://sandbox.asaas.test/api/v3";
  const PROD_BASE = "https://api.asaas.test/v3";

  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    process.env["ASAAS_API_KEY"] = API_KEY;
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
    vi.restoreAllMocks();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }

  it("sandbox posts /customers with the test constant when no document is given", async () => {
    process.env["ASAAS_BASE_URL"] = SANDBOX_BASE;
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "cus_sandbox_1", name: "Test" }));
    const port = new RealAsaasAdapter();
    const created = await port.createCustomer({ personId: "person-1", name: "Test Person" });
    expect(created.effect).toBe("KNOWN_APPLIED");
    expect(created.providerCustomerId).toBe("cus_sandbox_1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SANDBOX_BASE}/customers`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["cpfCnpj"]).toBe(SANDBOX_TEST_DOCUMENT_CPF);
    expect(body["name"]).toBe("Test Person");
  });

  it("production refuses without a document BEFORE any provider I/O", async () => {
    process.env["ASAAS_BASE_URL"] = PROD_BASE;
    const port = new RealAsaasAdapter();
    await expect(port.createCustomer({ personId: "person-1", name: "Real Person" })).rejects.toThrow(
      /DOCUMENT_REQUIRED/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("production posts /customers with the real document digits", async () => {
    process.env["ASAAS_BASE_URL"] = PROD_BASE;
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "cus_prod_1" }));
    const port = new RealAsaasAdapter();
    const created = await port.createCustomer({
      personId: "person-1",
      name: "Real Person",
      document: "111.444.777-35",
    });
    expect(created.effect).toBe("KNOWN_APPLIED");
    expect(created.providerCustomerId).toBe("cus_prod_1");
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<
      string,
      unknown
    >;
    expect(body["cpfCnpj"]).toBe("11144477735");
  });

  it("maps provider refusal to KNOWN_NOT_APPLIED and uncertainty to UNKNOWN (never a binding)", async () => {
    process.env["ASAAS_BASE_URL"] = SANDBOX_BASE;
    const port = new RealAsaasAdapter();

    fetchMock.mockResolvedValueOnce(jsonResponse(400, { errors: ["invalid"] }));
    const refused = await port.createCustomer({ personId: "p", name: "N" });
    expect(refused.effect).toBe("KNOWN_NOT_APPLIED");
    expect(refused.providerCustomerId).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
    const broken = await port.createCustomer({ personId: "p", name: "N" });
    expect(broken.effect).toBe("UNKNOWN");
    expect(broken.providerCustomerId).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: "no id" }));
    const noId = await port.createCustomer({ personId: "p", name: "N" });
    expect(noId.effect).toBe("UNKNOWN");
    expect(noId.providerCustomerId).toBeNull();
  });

  it("throws when the adapter is misconfigured", async () => {
    delete process.env["ASAAS_API_KEY"];
    process.env["ASAAS_BASE_URL"] = SANDBOX_BASE;
    const port = new RealAsaasAdapter();
    await expect(port.createCustomer({ personId: "p", name: "N" })).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GAP-LOOP-1 command wiring (stub transaction, no DB)", () => {
  const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PERSON = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ORDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  interface QueryCall {
    table: string;
    op: "select" | "insert" | "update";
    values?: unknown;
  }

  class StubTrx {
    readonly inserts: QueryCall[] = [];
    constructor(private readonly rows: Map<string, unknown>) {}
    selectFrom(table: string): StubQueryBuilder {
      return new StubQueryBuilder(this, { table, op: "select" });
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
      return Promise.resolve(this.rows.get(call.table));
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
    where(...args: unknown[]): this {
      void args;
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

  function handlersFor(port: AsaasPort): Map<string, (ctx: unknown, input: unknown) => Promise<unknown>> {
    const defs = new Map<string, (ctx: unknown, input: unknown) => Promise<unknown>>();
    const bus = {
      register: (def: { name: string; handler: (ctx: unknown, input: unknown) => Promise<unknown> }) => {
        defs.set(def.name, def.handler);
      },
    };
    registerBillingCommands(bus as unknown as CommandBus, { asaasPort: port });
    return defs;
  }

  function echoPort(): AsaasPort {
    return new EchoAsaasAdapter();
  }

  it("charge.create input carries no forged provider field (stripped, never honored)", () => {
    const parsed = chargeCreateInput.safeParse({
      orderId: ORDER,
      providerCustomerId: "cus_forged",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("providerCustomerId" in parsed.data).toBe(false);
    }
  });

  it("customer_provision input requires a person uuid", () => {
    expect(customerProvisionInput.safeParse({ personId: PERSON }).success).toBe(true);
    expect(customerProvisionInput.safeParse({ personId: "not-a-uuid" }).success).toBe(false);
    expect(customerProvisionInput.safeParse({}).success).toBe(false);
  });

  it("charge.create fails closed without a binding (no charge row, explicit precondition)", async () => {
    const rows = new Map<string, unknown>([
      [
        "commerce.orders",
        { id: ORDER, person_id: PERSON, status: "AWAITING_PAYMENT", net_amount_minor: "1000", currency: "BRL" },
      ],
      ["billing.customer_provider_bindings", undefined],
    ]);
    const trx = new StubTrx(rows);
    const handlers = handlersFor(echoPort());
    const create = handlers.get("charge.create");
    expect(create).toBeDefined();
    const result = (await create?.(stubCtx(trx), { orderId: ORDER })) as {
      ok: boolean;
      code?: string;
      message?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.code).toBe("precondition_failed");
    expect(result.message).toContain("billing.customer_provision");
    // Fail-closed BEFORE the insert: no phantom PENDING charge exists.
    expect(trx.inserts.some((call) => call.table === "billing.charges")).toBe(false);
  });

  it("charge.create resolves the binding and persists it on the charge binding", async () => {
    const rows = new Map<string, unknown>([
      [
        "commerce.orders",
        { id: ORDER, person_id: PERSON, status: "AWAITING_PAYMENT", net_amount_minor: "1000", currency: "BRL" },
      ],
      ["billing.customer_provider_bindings", { external_customer_id: "cus_123" }],
      ["billing.charges", { id: "charge-1" }],
    ]);
    const trx = new StubTrx(rows);
    const handlers = handlersFor(echoPort());
    const create = handlers.get("charge.create");
    const result = (await create?.(stubCtx(trx), { orderId: ORDER })) as {
      ok: boolean;
      data: { status: string; providerChargeId: string | null; effectUncertain: boolean };
    };
    expect(result.ok).toBe(true);
    expect(result.data.status).toBe("PROCESSING");
    const bindingInsert = trx.inserts.find((call) => call.table === "billing.charge_provider_bindings");
    expect(bindingInsert).toBeDefined();
    expect((bindingInsert?.values as Record<string, unknown>)["external_customer_id"]).toBe("cus_123");
  });

  it("provision is idempotent when the binding already exists (provider never called)", async () => {
    let calls = 0;
    const port: AsaasPort = {
      ...echoPort(),
      createCustomer: () => {
        calls += 1;
        return Promise.resolve({ effect: "KNOWN_APPLIED" as const, providerCustomerId: "cus_x", detail: "x" });
      },
    };
    const rows = new Map<string, unknown>([
      ["identity.persons", { id: PERSON, canonical_name: "Test" }],
      ["billing.customer_provider_bindings", { id: "bind-1", external_customer_id: "cus_existing" }],
    ]);
    const handlers = handlersFor(port);
    const provision = handlers.get("billing.customer_provision");
    const result = (await provision?.(stubCtx(new StubTrx(rows)), { personId: PERSON })) as {
      ok: boolean;
      data: { providerCustomerId: string; provisioned: boolean };
    };
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: "bind-1", personId: PERSON, providerCustomerId: "cus_existing", provisioned: false });
    expect(calls).toBe(0);
  });

  it("provision persists the binding on KNOWN_APPLIED (echo)", async () => {
    const rows = new Map<string, unknown>([
      ["identity.persons", { id: PERSON, canonical_name: "Test" }],
      ["billing.customer_provider_bindings", undefined],
    ]);
    const trx = new StubTrx(rows);
    const handlers = handlersFor(echoPort());
    const provision = handlers.get("billing.customer_provision");
    // The provision insert returns via onConflict().returning(): emulate the
    // returning row for insert-ops while selects keep hitting the map.
    const origTakeFirst = trx.takeFirst.bind(trx);
    trx.takeFirst = (call: QueryCall) => {
      if (call.table === "billing.customer_provider_bindings" && call.op === "insert") {
        return Promise.resolve({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
      }
      return origTakeFirst(call);
    };
    const result = (await provision?.(stubCtx(trx), { personId: PERSON })) as {
      ok: boolean;
      data: { providerCustomerId: string; provisioned: boolean };
    };
    expect(result.ok).toBe(true);
    expect(result.data.provisioned).toBe(true);
    expect(result.data.providerCustomerId).toContain("echo-cus-");
    const insert = trx.inserts.find((call) => call.table === "billing.customer_provider_bindings");
    expect((insert?.values as Record<string, unknown>)["person_id"]).toBe(PERSON);
    expect((insert?.values as Record<string, unknown>)["provider"]).toBe("ASAAS");
  });

  it("provision maps a DOCUMENT_REQUIRED throw to an explicit precondition failure", async () => {
    const port: AsaasPort = {
      ...echoPort(),
      createCustomer: () => Promise.reject(new Error("asaas: DOCUMENT_REQUIRED — production needs a document")),
    };
    const rows = new Map<string, unknown>([
      ["identity.persons", { id: PERSON, canonical_name: "Test" }],
      ["billing.customer_provider_bindings", undefined],
    ]);
    const trx = new StubTrx(rows);
    const handlers = handlersFor(port);
    const provision = handlers.get("billing.customer_provision");
    const result = (await provision?.(stubCtx(trx), { personId: PERSON })) as {
      ok: boolean;
      code?: string;
      message?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.code).toBe("precondition_failed");
    expect(result.message).toContain("DOCUMENT_REQUIRED");
    expect(trx.inserts.some((call) => call.table === "billing.customer_provider_bindings")).toBe(false);
  });

  it("provision refuses an unknown person in this tenant", async () => {
    const rows = new Map<string, unknown>([
      ["identity.persons", undefined],
      ["billing.customer_provider_bindings", undefined],
    ]);
    const handlers = handlersFor(echoPort());
    const provision = handlers.get("billing.customer_provision");
    const result = (await provision?.(stubCtx(new StubTrx(rows)), { personId: PERSON })) as {
      ok: boolean;
      code?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_found");
  });
});
