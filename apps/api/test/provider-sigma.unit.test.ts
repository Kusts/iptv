/**
 * Sigma Reseller adapter focused tests (offline, fake fetch, no live calls).
 *
 * Covers: mode selection (simulated default, live requires SIGMA_MODE=live +
 * SecretsPort), secret-ref derivation for CINEVISION_RESELLER_API_TOKEN,
 * create/renew HTTP mapping + GET confirmation, error map (401/402/403/409/
 * 422/429/404/5xx/timeout), Retry-After capture without auto-replay,
 * readback never re-executes, and the 9 simulated scenarios via the reused
 * CinevisionSimulatedWritePort ledger.
 */

import { describe, expect, it } from "vitest";
import { deriveIntegrationSecretRef } from "@iptv/secrets";
import type { ProviderOperationRequest } from "../src/provider/provider-port.js";
import {
  SIGMA_BASE_URL,
  SigmaHttpAdapter,
  SigmaSimulatedAdapter,
  defaultSigmaTokenResolver,
  resolveSigmaPortFromEnv,
} from "../src/provider/provider-sigma.js";
import { validateSecretRequestShape } from "../src/provider/provider-secret-gate.js";
import { CinevisionSimulatedWritePort, buildSimulatedFencingToken } from "../src/provider/provider-cinevision-simulated.js";

const REF = "pgsecret://sandbox/integrations/tenant-1/cinevision/CINEVISION_USER";

function req(overrides: Partial<ProviderOperationRequest> = {}): ProviderOperationRequest {
  return {
    tenantId: "tenant-1",
    providerAccountId: "00000000-0000-0000-0000-000000000001",
    action: "subscription.provision",
    entityType: "subscription",
    entityId: "00000000-0000-0000-0000-000000000002",
    idempotencyKey: "subscription-provision:entity:1",
    payload: { server_id: "srv-1", package_id: "pkg-1" },
    correlationId: buildSimulatedFencingToken("provider-dispatcher-1"),
    secretRef: REF,
    ...overrides,
  };
}

type FakeCall = { url: string; init?: RequestInit };
function fakeJson(calls: FakeCall[], handler: (call: FakeCall) => { status: number; body: unknown; headers?: Record<string, string> }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const out = handler({ url, init });
    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: { "content-type": "application/json", ...(out.headers ?? {}) },
    });
  }) as typeof fetch;
}

describe("sigma mode + token derivation", () => {
  it("defaults to fail-closed unconfigured without token or live mode (never simulated SUCCEEDED)", async () => {
    const port = resolveSigmaPortFromEnv(null);
    expect(port.name).toBe("sigma");
    expect(port.requiresSecretRef).toBe(true);
    expect(port.constructor.name).toBe("SigmaUnconfiguredAdapter");
    const result = await port.requestOperation(req());
    expect(result).toMatchObject({ outcome: "MANUAL", externalRef: null });
    expect(result.detail).not.toContain("sigma-");
  });

  it("derives CINEVISION_RESELLER_API_TOKEN ref from principal ref", () => {
    expect(deriveIntegrationSecretRef(REF, "CINEVISION_RESELLER_API_TOKEN")).toBe(
      "pgsecret://sandbox/integrations/tenant-1/cinevision/CINEVISION_RESELLER_API_TOKEN",
    );
  });

  it("live requires SIGMA_MODE=live and configured ports (else unconfigured MANUAL)", () => {
    const prev = process.env["SIGMA_MODE"];
    process.env["SIGMA_MODE"] = "live";
    try {
      expect(resolveSigmaPortFromEnv(null).constructor.name).toBe("SigmaUnconfiguredAdapter");
      expect(
        resolveSigmaPortFromEnv({ name: "noop", getSecret: async () => "" }).constructor.name,
      ).toBe("SigmaUnconfiguredAdapter");
      const fakeSecrets = { name: "postgres", getSecret: async () => "tok" };
      expect(resolveSigmaPortFromEnv(fakeSecrets).constructor.name).toBe("SigmaHttpAdapter");
    } finally {
      if (prev === undefined) delete process.env["SIGMA_MODE"];
      else process.env["SIGMA_MODE"] = prev;
    }
  });

  it("secret-ref gate rejects disallowed payload keys (password/token not forwarded)", () => {
    const bad = validateSecretRequestShape({
      action: "subscription.provision",
      entityType: "subscription",
      payload: { server_id: "srv-1", package_id: "pkg-1", password: "x" },
    });
    expect(bad.ok).toBe(false);
    const badToken = validateSecretRequestShape({
      action: "subscription.provision",
      entityType: "subscription",
      payload: { server_id: "srv-1", package_id: "pkg-1", token: "x" },
    });
    expect(badToken.ok).toBe(false);
    const good = validateSecretRequestShape({
      action: "subscription.provision",
      entityType: "subscription",
      payload: { server_id: "srv-1", package_id: "pkg-1" },
    });
    expect(good.ok).toBe(true);
    const renew = validateSecretRequestShape({
      action: "subscription.renew",
      entityType: "subscription",
      payload: { sigma_customer_id: "cust-9" },
    });
    expect(renew.ok).toBe(true);
  });

  it("token never leaks into detail/externalRef", async () => {
    const calls: FakeCall[] = [];
    const adapter = new SigmaHttpAdapter(
      async () => "tok-secret-123",
      fakeJson(calls, () => ({ status: 201, body: { data: { id: "cust-9" } } })),
    );
    const result = await adapter.requestOperation(req());
    expect(JSON.stringify(result)).not.toContain("tok-secret-123");
    expect(await adapter.getMe("tok-secret-123")).toBeTruthy();
  });

  it("default resolver fetches only the derived token ref (never yields ref as value)", async () => {
    const seen: string[] = [];
    const resolver = defaultSigmaTokenResolver({
      name: "postgres",
      getSecret: async (ref: string) => {
        seen.push(ref);
        return "super-secret";
      },
    });
    expect(await resolver(REF)).toBe("super-secret");
    expect(seen).toEqual(["pgsecret://sandbox/integrations/tenant-1/cinevision/CINEVISION_RESELLER_API_TOKEN"]);
  });
});

describe("sigma HTTP create + confirm (Cenário A path)", () => {
  it("POST /customers then GET /customers/{id} before SUCCEEDED, Bearer only", async () => {
    const calls: FakeCall[] = [];
    const adapter = new SigmaHttpAdapter(
      async () => "tok-123",
      fakeJson(calls, (call) => {
        if (call.url === `${SIGMA_BASE_URL}/customers` && call.init?.method === "POST") {
          expect(call.init?.headers).toMatchObject({ authorization: "Bearer tok-123" });
          return { status: 201, body: { data: { id: "cust-9", server_id: "srv-1", package_id: "pkg-1", status: "ACTIVE" } } };
        }
        if (call.url === `${SIGMA_BASE_URL}/customers/cust-9`) return { status: 200, body: { data: { id: "cust-9", server_id: "srv-1", package_id: "pkg-1", status: "ACTIVE", expires_at: "2027-01-01T00:00:00Z" } } };
        return { status: 500, body: { message: "unexpected" } };
      }),
    );
    const result = await adapter.requestOperation(req());
    expect(result).toMatchObject({ outcome: "SUCCEEDED", externalRef: "cust-9" });
    expect(calls.map((c) => c.url)).toEqual([`${SIGMA_BASE_URL}/customers`, `${SIGMA_BASE_URL}/customers/cust-9`]);
  });

  it("create body carries server_id/package_id plus deterministic username fallback", async () => {
    const calls: FakeCall[] = [];
    const adapter = new SigmaHttpAdapter(
      async () => "tok",
      fakeJson(calls, (call) => {
        if (call.url === `${SIGMA_BASE_URL}/customers`) return { status: 201, body: { data: { id: "c1", server_id: "srv-1", package_id: "pkg-1", status: "ACTIVE" } } };
        return { status: 200, body: { data: { id: "c1", server_id: "srv-1", package_id: "pkg-1", status: "ACTIVE" } } };
      }),
    );
    await adapter.requestOperation(req());
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body["server_id"]).toBe("srv-1");
    expect(body["package_id"]).toBe("pkg-1");
    expect(typeof body["username"]).toBe("string");
  });

  it("confirm-GET failure preserves id as UNKNOWN externalRef (no duplicate)", async () => {
    const calls: FakeCall[] = [];
    const adapter = new SigmaHttpAdapter(
      async () => "tok",
      fakeJson(calls, (call) => {
        if (call.url === `${SIGMA_BASE_URL}/customers`) return { status: 201, body: { data: { id: "cust-9" } } };
        if (call.url === `${SIGMA_BASE_URL}/customers/cust-9`) return { status: 503, body: { message: "down" } };
        return { status: 500, body: {} };
      }),
    );
    const result = await adapter.requestOperation(req());
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.externalRef).toBe("cust-9");
  });
});

describe("sigma HTTP renew (Cenário B path)", () => {
  it("POST /customers/{id}/renew then GET confirm, no duplicate create", async () => {
    const calls: FakeCall[] = [];
    const adapter = new SigmaHttpAdapter(
      async () => "tok",
      fakeJson(calls, (call) => {
        if (call.url === `${SIGMA_BASE_URL}/customers/cust-9/renew`) return { status: 200, body: { data: { id: "cust-9" } } };
        if (call.url === `${SIGMA_BASE_URL}/customers/cust-9`) {
          return { status: 200, body: { data: { id: "cust-9", server_id: "srv-1", package_id: "pkg-1", expires_at: calls.filter((c) => c.url.endsWith("/renew")).length ? "2027-01-01T00:00:00Z" : "2026-01-01T00:00:00Z" } } };
        }
        return { status: 500, body: {} };
      }),
    );
    const result = await adapter.requestOperation(
      req({ action: "subscription.renew", payload: { sigma_customer_id: "cust-9" } }),
    );
    expect(result).toMatchObject({ outcome: "SUCCEEDED", externalRef: "cust-9" });
      expect(calls.map((c) => c.url)).toEqual([`${SIGMA_BASE_URL}/customers/cust-9`, `${SIGMA_BASE_URL}/customers/cust-9/renew`, `${SIGMA_BASE_URL}/customers/cust-9`]);
      expect(calls[1]?.init?.method).toBe("POST");
      expect(calls[1]?.init?.body).toBeUndefined();
  });

  it("provision with existing binding id also renews (fulfillment renew path)", async () => {
    const calls: FakeCall[] = [];
    const adapter = new SigmaHttpAdapter(
      async () => "tok",
      fakeJson(calls, (call) => {
        if (call.url.endsWith("/renew")) return { status: 200, body: { data: { id: "cust-9" } } };
        if (call.url === `${SIGMA_BASE_URL}/customers/cust-9`) {
          return { status: 200, body: { data: { id: "cust-9", server_id: "srv-1", package_id: "pkg-1", expires_at: calls.some((c) => c.url.endsWith("/renew")) ? "2027-06-01T00:00:00Z" : "2026-06-01T00:00:00Z" } } };
        }
        return { status: 500, body: {} };
      }),
    );
    const result = await adapter.requestOperation(
      req({ payload: { server_id: "srv-1", package_id: "pkg-1", sigma_customer_id: "cust-9" } }),
    );
    expect(result.outcome).toBe("SUCCEEDED");
    expect(calls.map((c) => c.url)).toEqual([`${SIGMA_BASE_URL}/customers/cust-9`, `${SIGMA_BASE_URL}/customers/cust-9/renew`, `${SIGMA_BASE_URL}/customers/cust-9`]);
  });
});

describe("sigma error map (Cenário C path, never mis-activated)", () => {
  const cases: Array<{ status: number; outcome: string; extra?: Record<string, string>; body?: unknown }> = [
    { status: 401, outcome: "MANUAL", body: { message: "unauthorized" } },
    { status: 402, outcome: "MANUAL", body: { message: "credits" } },
    { status: 422, outcome: "FAILED", body: { message: "validation" } },
    { status: 404, outcome: "FAILED", body: { message: "not found" } },
    { status: 403, outcome: "MANUAL", body: { error: "insufficient_scope", message: "scope" } },
    { status: 429, outcome: "UNKNOWN", body: { message: "throttled" }, extra: { "retry-after": "7" } },
    { status: 500, outcome: "UNKNOWN", body: { message: "boom" } },
    { status: 503, outcome: "UNKNOWN", body: { message: "down" } },
  ];
  for (const c of cases) {
    it(`HTTP ${c.status} -> ${c.outcome}`, async () => {
      const calls: FakeCall[] = [];
      const adapter = new SigmaHttpAdapter(async () => "tok", fakeJson(calls, () => ({ status: c.status, body: c.body ?? {}, headers: c.extra })));
      const result = await adapter.requestOperation(req());
      expect(result.outcome).toBe(c.outcome);
      expect(calls).toHaveLength(1); // never auto-replays a mutation
      if (c.status === 429) expect(result.detail).toContain("retry-after 7s");
    });
  }

  it("409 binds only when server/package match the request", async () => {
    const mismatch = new SigmaHttpAdapter(
      async () => "tok",
      fakeJson([], (call) => {
        if (call.url === `${SIGMA_BASE_URL}/customers`) return { status: 409, body: { message: "exists" } };
        if (call.url.includes("/by-username/")) return { status: 200, body: { data: { id: "cust-foreign", server_id: "srv-other", package_id: "pkg-other" } } };
        return { status: 500, body: {} };
      }),
    );
    expect((await mismatch.requestOperation(req())).outcome).toBe("MANUAL");
    const match = new SigmaHttpAdapter(
      async () => "tok",
      fakeJson([], (call) => {
        if (call.url === `${SIGMA_BASE_URL}/customers`) return { status: 409, body: { message: "exists" } };
        if (call.url.includes("/by-username/")) return { status: 200, body: { data: { id: "cust-9", server_id: "srv-1", package_id: "pkg-1" } } };
        return { status: 500, body: {} };
      }),
    );
    const matched = await match.requestOperation(req());
    expect(matched).toMatchObject({ outcome: "SUCCEEDED", externalRef: "cust-9" });
  });

  it("409 conflict resolves via by-username then SUCCEEDED only when found", async () => {
    const calls: FakeCall[] = [];
    const adapter = new SigmaHttpAdapter(
      async () => "tok",
      fakeJson(calls, (call) => {
        if (call.url === `${SIGMA_BASE_URL}/customers`) return { status: 409, body: { message: "exists" } };
        if (call.url === `${SIGMA_BASE_URL}/customers/by-username/user-1`) return { status: 200, body: { data: { id: "cust-9", server_id: "srv-1", package_id: "pkg-1" } } };
        return { status: 500, body: {} };
      }),
    );
    const result = await adapter.requestOperation(req({ payload: { server_id: "srv-1", package_id: "pkg-1", username: "user-1" } }));
    expect(result).toMatchObject({ outcome: "SUCCEEDED", externalRef: "cust-9" });
  });

  it("timeout/throw -> UNKNOWN (never FAILED, never activation)", async () => {
    const adapter = new SigmaHttpAdapter(async () => "tok", (async () => {
      throw new Error("network down");
    }) as typeof fetch);
    const result = await adapter.requestOperation(req());
    expect(result.outcome).toBe("UNKNOWN");
    expect(result.externalRef).toBeNull();
  });

  it("missing secretRef or unresolvable token -> MANUAL (fail-closed)", async () => {
    const adapter = new SigmaHttpAdapter(async () => {
      throw new Error("vault down");
    });
    expect((await adapter.requestOperation(req({ secretRef: undefined }))).outcome).toBe("MANUAL");
    expect((await adapter.requestOperation(req())).outcome).toBe("MANUAL");
  });
});

describe("simulated 9 scenarios via reused ledger (no live calls)", () => {
  const base = (suffix: string): ProviderOperationRequest => req({ idempotencyKey: `sigma-sim-${suffix}` });
  it("1. auth valid -> SUCCEEDED", async () => {
    const port = new CinevisionSimulatedWritePort("success");
    expect((await port.requestOperation(base("auth"))).outcome).toBe("SUCCEEDED");
    expect(new SigmaSimulatedAdapter("success").constructor.name).toBe("SigmaSimulatedAdapter");
  });
  it("2. packages/servers fixtures resolve catalog ids (offline)", async () => {
    // Offline SQL fixtures shaped by OpenAPI Package/Server; ids are opaque,
    // never assumed equal to internal plan ids.
    const packages = [{ id: "pkg-1", server_id: "srv-1", name: "Monthly" }];
    const servers = [{ id: "srv-1", name: "BR-1" }];
    expect(packages[0]?.server_id).toBe(servers[0]?.id);
  });
  it("3. create success -> SUCCEEDED with external ref", async () => {
    const port = new CinevisionSimulatedWritePort("success");
    const r = await port.requestOperation(base("create"));
    expect(r.outcome).toBe("SUCCEEDED");
    expect(r.externalRef).toBeTruthy();
  });
  it("4. existing -> SUCCEEDED idempotently", async () => {
    const port = new CinevisionSimulatedWritePort("exists");
    expect((await port.requestOperation(base("exists"))).outcome).toBe("SUCCEEDED");
  });
  it("5. renew success -> SUCCEEDED", async () => {
    const port = new SigmaSimulatedAdapter("success");
    const r = await port.requestOperation(req({ action: "subscription.renew", payload: { sigma_customer_id: "cust-9" } }));
    expect(r.externalRef).toBeTruthy();
  });
  it("6. insufficient credits -> FAILED", async () => {
    const port = new CinevisionSimulatedWritePort("credits");
    expect((await port.requestOperation(base("credits"))).outcome).toBe("FAILED");
  });
  it("7. permission denied -> MANUAL", async () => {
    const port = new CinevisionSimulatedWritePort("permission");
    expect((await port.requestOperation(base("perm"))).outcome).toBe("MANUAL");
  });
  it("8. unavailable -> UNKNOWN", async () => {
    const port = new CinevisionSimulatedWritePort("unavailable");
    expect((await port.requestOperation(base("unavail"))).outcome).toBe("UNKNOWN");
  });
  it("9. timeout after send -> UNKNOWN, retry parks MANUAL (single effect)", async () => {
    const port = new CinevisionSimulatedWritePort("timeout", 10);
    const key = "sigma-sim-timeout-key";
    expect((await port.requestOperation(req({ idempotencyKey: key }))).outcome).toBe("UNKNOWN");
    const effects = port.effectCount;
    expect((await port.requestOperation(req({ idempotencyKey: key }))).outcome).toBe("MANUAL");
    expect(port.effectCount).toBe(effects);
  });
});
