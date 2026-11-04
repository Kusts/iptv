import { describe, expect, it, vi, afterEach } from "vitest";
import { ASAAS_TENANT_HOSTS, RealAsaasAdapter } from "../src/billing/asaas-port.js";
import {
  ASAAS_HOSTS,
  __resetIntegrationTestDoubles,
  __setIntegrationTestDoubles,
  registerIntegrationCommands,
} from "../src/integrations/integrations.commands.js";
import type { CommandBus } from "../src/commands/command-bus.js";

/**
 * P85-ASAAS-V3FIX: hosts are pinned with a `/v3` suffix by contract
 * (see `asaas-hosts-parity`), so webhook call sites must append paths
 * WITHOUT a second `/v3` — otherwise the provider sees `/v3/v3/...`
 * and answers 404. Charges (`postJson("/payments")`) are unaffected.
 */

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Mesmo formato sintético das suites S2A (`s2a-synthetic-...`): passa no gate gitleaks. */
const WEBHOOK_AUTH_TOKEN = "s2a-synthetic-webhook-token-ccc333";

const SAVE_INPUT = {
  host: ASAAS_TENANT_HOSTS.SANDBOX,
  apiKey: "tenant-key-not-a-secret",
  name: "iptv webhook",
  url: "https://app.example.test/v1/webhooks/asaas/tenant-key",
  email: "ops@example.test",
  authToken: WEBHOOK_AUTH_TOKEN,
} as const;

describe("asaas webhook urls (P85-ASAAS-V3FIX)", () => {
  it("list/create/update hit single-/v3/ urls (never /v3/v3/)", async () => {
    const fetchMock: ReturnType<typeof vi.fn> = vi.fn();
    fetchMock.mockImplementation(async () => jsonResponse(200, { data: [] }));
    const port = new RealAsaasAdapter();

    await port.listWebhooks?.({
      host: ASAAS_TENANT_HOSTS.SANDBOX,
      apiKey: SAVE_INPUT.apiKey,
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    const [listUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(listUrl).toBe(`${ASAAS_TENANT_HOSTS.SANDBOX}/webhooks?limit=100`);
    expect(listUrl).not.toContain("/v3/v3/");

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "wh_1" }));
    const created = await port.createWebhook?.({
      ...SAVE_INPUT,
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    expect(created?.id).toBe("wh_1");
    const [createUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toBe(`${ASAAS_TENANT_HOSTS.SANDBOX}/webhooks`);
    expect(createUrl).not.toContain("/v3/v3/");

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "wh_1" }));
    const updated = await port.updateWebhook?.({
      ...SAVE_INPUT,
      providerWebhookId: "wh_1",
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    expect(updated?.id).toBe("wh_1");
    const [updateUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(updateUrl).toBe(`${ASAAS_TENANT_HOSTS.SANDBOX}/webhooks/wh_1`);
    expect(updateUrl).not.toContain("/v3/v3/");
  });
});

/**
 * P85-V3FIX-FINALIZE (reviewer MEDIUM): o probe `integration.test` compõe
 * `${host}${path}` sobre o host da allowlist (que já termina com `/v3`),
 * então os paths precisam ser `/webhooks?limit=1` e `/customers?limit=1`
 * — sem o prefixo `/v3` que gerava `/v3/v3/...` → 404 sistemático.
 * Exercita o handler real com trx/vault/fetch fakes (zero rede, zero DB).
 */
describe("asaas probe urls (P85-V3FIX-FINALIZE)", () => {
  const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SECRET_REF = "infisical://sandbox/integrations/tenant/asaas/ASAAS_API_KEY";
  const API_KEY = "probe-key-not-a-secret";

  afterEach(() => {
    __resetIntegrationTestDoubles();
    vi.restoreAllMocks();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }

  /** Stub trx mínimo: cobre os encadeamentos usados por `handleTest`. */
  function stubTrx() {
    const builder: Record<string, unknown> = {};
    builder["select"] = (...args: unknown[]) => {
      void args;
      return builder;
    };
    builder["where"] = (...args: unknown[]) => {
      void args;
      return builder;
    };
    builder["orderBy"] = (...args: unknown[]) => {
      void args;
      return builder;
    };
    builder["forUpdate"] = () => builder;
    builder["set"] = (...args: unknown[]) => {
      void args;
      return builder;
    };
    builder["executeTakeFirst"] = () => {
      const table = (builder["__table"] as string) ?? "";
      if (table === "provider.providers") {
        return Promise.resolve({ id: "prov-asaas-1" });
      }
      return Promise.resolve({
        id: "bind-1",
        environment: "SANDBOX",
        secret_ref: SECRET_REF,
        connection_status: "DRAFT",
        version: 1,
      });
    };
    builder["execute"] = () => Promise.resolve(undefined);
    return {
      selectFrom: (table: string) => {
        builder["__table"] = table;
        return builder;
      },
      updateTable: (table: string) => {
        builder["__table"] = table;
        return builder;
      },
      insertInto: (table: string) => {
        builder["__table"] = table;
        return builder;
      },
    };
  }

  function handlersFor() {
    const defs = new Map<string, (ctx: unknown, input: unknown) => Promise<unknown>>();
    const bus = {
      register: (def: { name: string; handler: (ctx: unknown, input: unknown) => Promise<unknown> }) => {
        defs.set(def.name, def.handler);
      },
    };
    registerIntegrationCommands(bus as unknown as CommandBus);
    const test = defs.get("integration.test");
    expect(test).toBeDefined();
    return test as (ctx: unknown, input: unknown) => Promise<{
      ok: boolean;
      data: { connection_status: string; last_error_code: string | null };
    }>;
  }

  function stubCtx() {
    return {
      actor: {
        userId: "user-1",
        isPlatformAdmin: false,
        tenantId: TENANT,
        roleKeys: ["tenant_owner"],
        permissions: ["integration.test"],
        actorType: "human",
      },
      tenantId: TENANT,
      commandId: "66666666-6666-4666-8666-666666666666",
      correlationId: "77777777-7777-4777-8777-777777777777",
      causationId: null,
      tx: {
        innerDb: () => stubTrx(),
        getReviewRequest: () => Promise.resolve({ status: "RESOLVED" }),
        nextAggregateVersion: () => Promise.resolve(1),
        emitDomainEvent: () => Promise.resolve({ domainEventId: "88888888-8888-4888-8888-888888888888" }),
        enqueueOutbox: () => Promise.resolve(undefined),
      },
    };
  }

  function installDoubles(fetchMock: ReturnType<typeof vi.fn>) {
    __setIntegrationTestDoubles({
      secretsWriter: {
        putSecret: () => Promise.resolve({ ref: SECRET_REF, created: false }),
        getSecret: () => Promise.resolve(API_KEY),
        deleteSecret: () => Promise.resolve(undefined),
      } as never,
      asaasFetch: fetchMock as unknown as typeof fetch,
    });
  }

  it("probe ok via webhooks usa URL de /v3 único", async () => {
    const fetchMock: ReturnType<typeof vi.fn> = vi.fn();
    fetchMock.mockImplementation(async () => jsonResponse(200, { data: [] }));
    installDoubles(fetchMock);
    const result = await handlersFor()(stubCtx(), { provider: "asaas", environment: "SANDBOX" });
    expect(result.ok).toBe(true);
    expect(result.data.connection_status).toBe("CONNECTED_READ_ONLY");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ASAAS_HOSTS.SANDBOX}/webhooks?limit=1`);
    expect(url).not.toContain("/v3/v3/");
    expect((init.headers as Record<string, string>)["access_token"]).toBe(API_KEY);
  });

  it("404 na coleção de webhooks é incompatibilidade de contrato, não lista vazia", async () => {
    const fetchMock: ReturnType<typeof vi.fn> = vi.fn();
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/customers")) {
        return jsonResponse(200, { data: [] });
      }
      return jsonResponse(404, { error: "none" });
    });
    installDoubles(fetchMock);
    const result = await handlersFor()(stubCtx(), { provider: "asaas", environment: "SANDBOX" });
    expect(result.ok).toBe(true);
    expect(result.data.connection_status).toBe("TESTING");
    expect(result.data.last_error_code).toBe("PROVIDER_CONTRACT_MISMATCH");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ASAAS_HOSTS.SANDBOX}/webhooks?limit=1`);
    expect(url).not.toContain("/v3/v3/");
  });
});
