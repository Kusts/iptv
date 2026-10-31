import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASAAS_TENANT_HOSTS,
  RealAsaasAdapter,
  resolveAsaasPort,
  resolveTenantAsaas,
  resolveAsaasPortForTenant,
} from "../src/billing/asaas-port.js";
import { SecretsError } from "@iptv/secrets";

/**
 * S2C tenant runtime (Issue #86): the Asaas credential is resolved per
 * tenant from its own vaulted `provider.provider_accounts` binding —
 * never from the process-global `ASAAS_API_KEY`.
 *
 * Vault + fetch are faked; zero network, zero real secret.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface WhereFilter {
  field: string;
  value: unknown;
}

interface TenantBinding {
  secret_ref: string;
  environment: string;
  connection_status: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Minimal trx double: routes by table + captured `where` filters. */
function makeTenantTrx(bindings: Record<string, TenantBinding>, providerId = "prov-asaas-1"): unknown {
  const selectFrom = (table: string) => {
    const filters: WhereFilter[] = [];
    const builder: Record<string, unknown> = {
      select: (...args: unknown[]) => {
        void args;
        return builder;
      },
      where: (field: string, _op: string, value: unknown) => {
        filters.push({ field, value });
        return builder;
      },
      orderBy: (...args: unknown[]) => {
        void args;
        return builder;
      },
      limit: (...args: unknown[]) => {
        void args;
        return builder;
      },
      executeTakeFirst: () => {
        if (table === "provider.providers") {
          return Promise.resolve({ id: providerId });
        }
        if (table === "provider.provider_accounts") {
          const tenant = filters.find((f) => f.field === "tenant_id")?.value;
          const status = filters.find((f) => f.field === "connection_status")?.value;
          const row = typeof tenant === "string" ? bindings[tenant] : undefined;
          // Emulate the DB: only an eligible row matches the status filter.
          if (row === undefined || row.connection_status !== status) {
            return Promise.resolve(undefined);
          }
          return Promise.resolve({
            secret_ref: row.secret_ref,
            environment: row.environment,
            connection_status: row.connection_status,
          });
        }
        return Promise.resolve(undefined);
      },
    };
    return builder;
  };
  return { selectFrom };
}

function makeSecretsFake(values: Record<string, string>, onGet?: (ref: string) => void): {
  port: { name: string; getSecret: (ref: string) => Promise<string> };
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    port: {
      name: "fake-vault",
      getSecret: (ref: string) => {
        calls.push(ref);
        onGet?.(ref);
        const value = values[ref];
        if (value === undefined) {
          return Promise.reject(
            new SecretsError("NOT_FOUND", `secret not found in environment ["sandbox"]`),
          );
        }
        return Promise.resolve(value);
      },
    },
  };
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REF_A = "infisical://sandbox/integrations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/asaas/ASAAS_API_KEY";
const REF_B = "infisical://production/integrations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/asaas/ASAAS_API_KEY";
const KEY_A = "tenant-A-key-not-a-secret";
const KEY_B = "tenant-B-key-not-a-secret";

// ---------------------------------------------------------------------------
// RED: the legacy global-key shape (both tenants share one env key)
// ---------------------------------------------------------------------------

describe("S2C RED: legacy global key is shared across tenants", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    process.env["ASAAS_API_KEY"] = "global-legacy-key";
    process.env["ASAAS_BASE_URL"] = "https://sandbox.test";
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env["ASAAS_API_KEY"];
    delete process.env["ASAAS_BASE_URL"];
    globalThis.fetch = originalFetch as typeof fetch;
    vi.restoreAllMocks();
  });

  it("two tenants on the legacy env adapter BOTH send the same global key", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { id: "pay_a", pixQrCode: "qr-a" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "pay_b", pixQrCode: "qr-b" }));
    const portA = new RealAsaasAdapter();
    const portB = new RealAsaasAdapter();
    await portA.createPixCharge({
      chargeId: "charge-a",
      valueMinor: 1000n,
      currency: "BRL",
      payer: { personId: "person-a" },
      providerCustomerId: "cus_a",
    });
    await portB.createPixCharge({
      chargeId: "charge-b",
      valueMinor: 1000n,
      currency: "BRL",
      payer: { personId: "person-b" },
      providerCustomerId: "cus_b",
    });
    const keyA = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    const keyB = (fetchMock.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>;
    // The bug shape: identical global keys — after the cutover the tenant
    // resolver below must produce DISTINCT keys instead.
    expect(keyA["access_token"]).toBe("global-legacy-key");
    expect(keyB["access_token"]).toBe("global-legacy-key");
  });
});

// ---------------------------------------------------------------------------
// GREEN: tenant-scoped resolution + isolation + fail-closed matrix
// ---------------------------------------------------------------------------

describe("S2C GREEN: resolveAsaasPortForTenant", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    delete process.env["ASAAS_API_KEY"];
    delete process.env["ASAAS_BASE_URL"];
    delete process.env["ASAAS_ADAPTER"];
    fetchMock = vi.fn();
  });

  afterEach(() => {
    delete process.env["ASAAS_API_KEY"];
    delete process.env["ASAAS_BASE_URL"];
    delete process.env["ASAAS_ADAPTER"];
    vi.restoreAllMocks();
  });

  function bindings(): Record<string, TenantBinding> {
    return {
      [TENANT_A]: { secret_ref: REF_A, environment: "SANDBOX", connection_status: "CONNECTED_READ_ONLY" },
      [TENANT_B]: { secret_ref: REF_B, environment: "PRODUCTION", connection_status: "CONNECTED_READ_ONLY" },
    };
  }

  function secrets() {
    return makeSecretsFake({ [REF_A]: KEY_A, [REF_B]: KEY_B });
  }

  it("tenant A uses key A on the SANDBOX host; tenant B uses key B on the PRODUCTION host", async () => {
    const vault = secrets();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { id: "pay_a", pixQrCode: "qr-a" }))
      .mockResolvedValueOnce(jsonResponse(200, { payload: "qr-a-payload" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "pay_b", pixQrCode: "qr-b" }))
      .mockResolvedValueOnce(jsonResponse(200, { payload: "qr-b-payload" }));
    const portA = await resolveAsaasPortForTenant(makeTenantTrx(bindings()) as never, TENANT_A, {
      secretsPort: vault.port as never,
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    const portB = await resolveAsaasPortForTenant(makeTenantTrx(bindings()) as never, TENANT_B, {
      secretsPort: vault.port as never,
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    expect(portA.name).toBe("real");
    expect(portB.name).toBe("real");
    const resA = await portA.createPixCharge({
      chargeId: "charge-a",
      valueMinor: 1000n,
      currency: "BRL",
      payer: { personId: "person-a" },
      providerCustomerId: "cus_a",
    });
    const resB = await portB.createPixCharge({
      chargeId: "charge-b",
      valueMinor: 2000n,
      currency: "BRL",
      payer: { personId: "person-b" },
      providerCustomerId: "cus_b",
    });
    expect(resA.effect).toBe("KNOWN_APPLIED");
    expect(resB.effect).toBe("KNOWN_APPLIED");
    const [urlA, initA] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [urlB, initB] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(urlA).toBe(`${ASAAS_TENANT_HOSTS.SANDBOX}/payments`);
    expect(urlB).toBe(`${ASAAS_TENANT_HOSTS.PRODUCTION}/payments`);
    const headersA = initA.headers as Record<string, string>;
    const headersB = initB.headers as Record<string, string>;
    expect(headersA["access_token"]).toBe(KEY_A);
    expect(headersB["access_token"]).toBe(KEY_B);
    // Isolation: distinct credentials, no cross-tenant key reuse.
    expect(headersA["access_token"]).not.toBe(headersB["access_token"]);
    // Contamination: each tenant resolved its OWN ref (never the other's).
    expect(vault.calls).toContain(REF_A);
    expect(vault.calls).toContain(REF_B);
    // No secret material in results/details.
    for (const detail of [resA.detail, resB.detail, resA.providerChargeId, resB.providerChargeId]) {
      expect(detail).not.toContain(KEY_A);
      expect(detail).not.toContain(KEY_B);
    }
  });

  it("refund via the tenant port authenticates with the tenant key", async () => {
    const vault = secrets();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "refund_a", status: "REFUNDED" }));
    const portA = await resolveAsaasPortForTenant(makeTenantTrx(bindings()) as never, TENANT_A, {
      secretsPort: vault.port as never,
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    const result = await portA.executeRefund({
      paymentId: "11111111-1111-4111-8111-111111111111",
      refundId: "refund-a",
      providerChargeId: "pay_a",
      valueMinor: 500n,
      currency: "BRL",
    });
    expect(result.effect).toBe("KNOWN_APPLIED");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["access_token"]).toBe(KEY_A);
    expect(result.detail).not.toContain(KEY_A);
  });

  it("DRAFT bindings are NOT eligible: falls back to the legacy adapter without touching the vault", async () => {
    process.env["ASAAS_ADAPTER"] = "echo";
    const draftBindings: Record<string, TenantBinding> = {
      [TENANT_A]: { secret_ref: REF_A, environment: "SANDBOX", connection_status: "DRAFT" },
    };
    const getSecret = vi.fn();
    const vault = makeSecretsFake({ [REF_A]: KEY_A });
    const resolved = await resolveTenantAsaas(makeTenantTrx(draftBindings) as never, TENANT_A, {
      secretsPort: { name: "fake", getSecret } as never,
    });
    expect(resolved.source).toBe("legacy");
    expect(resolved.environment).toBeNull();
    expect(resolved.port.name).toBe("echo");
    expect(getSecret).not.toHaveBeenCalled();
    void vault;
  });

  it("no binding at all falls back to the legacy adapter (staging compat)", async () => {
    process.env["ASAAS_ADAPTER"] = "echo";
    const resolved = await resolveTenantAsaas(makeTenantTrx({}) as never, TENANT_A, {
      secretsPort: secrets().port as never,
    });
    expect(resolved.source).toBe("legacy");
    expect(resolved.port.name).toBe("echo");
  });

  it("vault down with a live binding throws fail-closed (never a silent echo); the error carries no secret", async () => {
    const failingVault = {
      name: "down-vault",
      getSecret: () => Promise.reject(new SecretsError("TRANSPORT", "infisical read timed out")),
    };
    const promise = resolveAsaasPortForTenant(makeTenantTrx(bindings()) as never, TENANT_A, {
      secretsPort: failingVault as never,
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    await expect(promise).rejects.toThrow(/tenant credential unavailable/);
    try {
      await promise.catch((err: unknown) => {
        throw err;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(KEY_A);
      expect(message).not.toContain(REF_A);
      expect(message).not.toContain("ASAAS_API_KEY");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    // Fail-closed is NOT the legacy echo: the legacy factory still answers
    // echo here (proving the throw above was a decision, not the default).
    expect(resolveAsaasPort("echo").name).toBe("echo");
  });

  it("unknown environment throws fail-closed before any vault or provider I/O", async () => {
    const weird: Record<string, TenantBinding> = {
      [TENANT_A]: { secret_ref: REF_A, environment: "HOMOLOG", connection_status: "CONNECTED_READ_ONLY" },
    };
    const getSecret = vi.fn(() => Promise.resolve(KEY_A));
    await expect(
      resolveAsaasPortForTenant(makeTenantTrx(weird) as never, TENANT_A, {
        secretsPort: { name: "fake", getSecret } as never,
        fetchFn: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/unknown environment/);
    expect(getSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("injected adapter options win over the process env (per-tenant independence at the adapter level)", async () => {
    process.env["ASAAS_API_KEY"] = "global-legacy-key";
    process.env["ASAAS_BASE_URL"] = "https://global.test";
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { id: "pay_t", pixQrCode: "qr" }))
      .mockResolvedValueOnce(jsonResponse(200, { payload: "qr-t-payload" }));
    const port = new RealAsaasAdapter({
      apiKey: KEY_A,
      baseUrl: ASAAS_TENANT_HOSTS.SANDBOX,
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    await port.createPixCharge({
      chargeId: "charge-t",
      valueMinor: 100n,
      currency: "BRL",
      payer: { personId: "p" },
      providerCustomerId: "cus_t",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ASAAS_TENANT_HOSTS.SANDBOX}/payments`);
    expect((init.headers as Record<string, string>)["access_token"]).toBe(KEY_A);
  });

  it("half-injected credentials stay misconfigured (no silent half-key requests)", async () => {
    const port = new RealAsaasAdapter({ apiKey: KEY_A });
    // createPixCharge maps misconfiguration to UNKNOWN (never a blind
    // retry); the key point is zero provider I/O with a half key.
    const created = await port.createPixCharge({
      chargeId: "c",
      valueMinor: 100n,
      currency: "BRL",
      payer: { personId: "p" },
    });
    expect(created.effect).toBe("UNKNOWN");
    expect(fetchMock).not.toHaveBeenCalled();
    // The throwing surface (customer/refund/readback) still fails loudly.
    await expect(port.createCustomer({ personId: "p", name: "N" })).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
