import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InfisicalSecretsAdapter,
  NoopSecretsPort,
  SecretsError,
  asSecretsWriter,
  buildIntegrationSecretRef,
  resolveSecretsWriterPort,
  rotateSecret,
} from "../src/index.js";

const OPTIONS = {
  siteUrl: "https://infisical.example.test",
  projectId: "proj-123",
  clientId: "id-abc",
  clientSecret: "client-secret-stub",
};

const TARGET = {
  tenantId: "tenant-1",
  provider: "asaas" as const,
  environment: "sandbox",
  key: "ASAAS_API_KEY",
};

const WRITE_VALUE = "synthetic-write-value-01";

interface MockResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function mockResponse(status: number, body: unknown): MockResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Queue-based fetch stub; records every call for independent expectations. */
function stubFetch(queue: Array<MockResponse | Error>): {
  calls: string[];
  requests: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: string[] = [];
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push(String(url));
    requests.push({ url: String(url), init });
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch queue exhausted");
    if (next instanceof Error) throw next;
    return next as unknown as Response;
  });
  vi.stubGlobal("fetch", impl);
  return { calls, requests };
}

function header(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers as unknown;
  if (headers instanceof Headers) return headers.get(name);
  if (headers !== null && typeof headers === "object" && !Array.isArray(headers)) {
    const record = headers as Record<string, unknown>;
    for (const [k, v] of Object.entries(record)) {
      if (k.toLowerCase() === name.toLowerCase()) return String(v);
    }
  }
  return null;
}

function bodyJson(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RED: writer facet exists on the port", () => {
  it("Infisical adapter exposes putSecret/deleteSecret", () => {
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    expect(typeof adapter.putSecret).toBe("function");
    expect(typeof adapter.deleteSecret).toBe("function");
  });

  it("Noop port exposes failing putSecret/deleteSecret (fail-closed CONFIG)", async () => {
    const noop = new NoopSecretsPort();
    const putErr = await noop
      .putSecret({ ...TARGET, value: WRITE_VALUE })
      .catch((e: unknown) => e);
    expect(putErr).toBeInstanceOf(SecretsError);
    expect((putErr as SecretsError).code).toBe("CONFIG");
    const delErr = await noop.deleteSecret("infisical://sandbox/ANY").catch((e: unknown) => e);
    expect(delErr).toBeInstanceOf(SecretsError);
    expect((delErr as SecretsError).code).toBe("CONFIG");
  });
});

describe("buildIntegrationSecretRef (backend-owned namespace)", () => {
  it("builds the controlled ref for asaas", () => {
    expect(buildIntegrationSecretRef(TARGET)).toBe(
      "infisical://sandbox/integrations/tenant-1/asaas/ASAAS_API_KEY",
    );
  });

  it("rejects free-form keys, providers and tenant ids", () => {
    const bad = [
      { ...TARGET, key: "FREE_FORM_KEY" },
      { ...TARGET, provider: "evil" as unknown as "asaas" },
      { ...TARGET, tenantId: "../other" },
      { ...TARGET, tenantId: "" },
      { ...TARGET, environment: "pro duction" },
      { ...TARGET, key: "CINEVISION_USER" },
    ];
    for (const target of bad) {
      expect(() => buildIntegrationSecretRef(target)).toThrowError(SecretsError);
    }
  });
});

describe("InfisicalSecretsAdapter.putSecret", () => {
  it("creates the secret and returns the backend-owned ref", async () => {
    const debugMessages: string[] = [];
    const { calls, requests } = stubFetch([
      mockResponse(200, { accessToken: "stub-token-1", expiresIn: 7200 }),
      mockResponse(200, { secret: { secretKey: "ASAAS_API_KEY" } }),
    ]);
    const adapter = new InfisicalSecretsAdapter({
      ...OPTIONS,
      debug: (m) => debugMessages.push(m),
    });
    const result = await adapter.putSecret({ ...TARGET, value: WRITE_VALUE });
    expect(result).toEqual({
      ref: "infisical://sandbox/integrations/tenant-1/asaas/ASAAS_API_KEY",
      created: true,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("/api/v3/secrets/raw/ASAAS_API_KEY");
    const payload = bodyJson(requests[1]?.init);
    expect(payload["workspaceId"]).toBe("proj-123");
    expect(payload["environment"]).toBe("sandbox");
    expect(payload["secretPath"]).toBe("/integrations/tenant-1/asaas");
    expect(requests[1]?.init?.signal).toBeDefined();
    for (const m of debugMessages) {
      expect(m).not.toContain(WRITE_VALUE);
      expect(m).not.toContain("stub-token-1");
    }
  });

  it("lowercases the environment ONLY on the transport (uppercase ref preserved)", async () => {
    const { calls, requests } = stubFetch([
      mockResponse(200, { accessToken: "stub-token-1", expiresIn: 7200 }),
      mockResponse(200, { secret: { secretKey: "ASAAS_API_KEY" } }),
    ]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    const result = await adapter.putSecret({
      tenantId: "t",
      provider: "asaas",
      environment: "SANDBOX",
      key: "ASAAS_API_KEY",
      value: WRITE_VALUE,
    });
    // Canonical ref keeps the original uppercase environment.
    expect(result.ref).toBe("infisical://SANDBOX/integrations/t/asaas/ASAAS_API_KEY");
    expect(calls).toHaveLength(2);
    const payload = bodyJson(requests[1]?.init);
    // Transport body uses the lowercase slug the server accepts.
    expect(payload["environment"]).toBe("sandbox");
  });

  it("falls back to update on conflict (upsert, still one logical secret)", async () => {
    const { calls } = stubFetch([
      mockResponse(200, { accessToken: "stub-token-1", expiresIn: 7200 }),
      mockResponse(409, { message: "already exists" }),
      mockResponse(200, { secret: { secretKey: "ASAAS_API_KEY" } }),
    ]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    const result = await adapter.putSecret({ ...TARGET, value: WRITE_VALUE });
    expect(result.created).toBe(false);
    expect(result.ref).toBe("infisical://sandbox/integrations/tenant-1/asaas/ASAAS_API_KEY");
    const writes = calls.filter((c) => c.includes("/api/v3/secrets/raw/"));
    expect(writes).toHaveLength(2);
  });

  it("falls back to update on 400 already-exists (v0.165.16 duplicate shape)", async () => {
    const { calls, requests } = stubFetch([
      mockResponse(200, { accessToken: "stub-token-1", expiresIn: 7200 }),
      mockResponse(400, { message: "Secret already exists with the provided key" }),
      mockResponse(200, { secret: { secretKey: "ASAAS_API_KEY" } }),
    ]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    const result = await adapter.putSecret({ ...TARGET, value: WRITE_VALUE });
    expect(result.created).toBe(false);
    expect(result.ref).toBe("infisical://sandbox/integrations/tenant-1/asaas/ASAAS_API_KEY");
    const writes = requests.filter((r) => r.url.includes("/api/v3/secrets/raw/"));
    expect(writes).toHaveLength(2);
    expect(writes[0]?.init?.method).toBe("POST");
    expect(writes[1]?.init?.method).toBe("PATCH");
    expect(calls.filter((c) => c.includes("/api/v3/secrets/raw/"))).toHaveLength(2);
  });

  it("keeps other 400 create failures as SERVER (never masked as conflict)", async () => {
    stubFetch([
      mockResponse(200, { accessToken: "stub-token-1", expiresIn: 7200 }),
      mockResponse(400, { message: "environment is invalid" }),
    ]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    const err = await adapter.putSecret({ ...TARGET, value: WRITE_VALUE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretsError);
    expect((err as SecretsError).code).toBe("SERVER");
    expect((err as SecretsError).message).not.toContain(WRITE_VALUE);
  });

  it("is idempotent for a stable request-id (same ref, no duplicate)", async () => {
    const { requests } = stubFetch([
      mockResponse(200, { accessToken: "stub-token-1", expiresIn: 7200 }),
      mockResponse(200, { secret: {} }),
      mockResponse(200, { secret: {} }),
    ]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    const first = await adapter.putSecret({ ...TARGET, value: WRITE_VALUE, requestId: "req-stable-1" });
    const second = await adapter.putSecret({ ...TARGET, value: WRITE_VALUE, requestId: "req-stable-1" });
    expect(second.ref).toBe(first.ref);
    const writes = requests.filter((r) => r.url.includes("/api/v3/secrets/raw/"));
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(header(w.init, "X-Request-Id")).toBe("req-stable-1");
    }
  });

  it("maps vault unavailable/timeout to typed errors (never CONNECTED, never value in error)", async () => {
    stubFetch([mockResponse(500, { message: "down" })]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    const serverErr = await adapter.putSecret({ ...TARGET, value: WRITE_VALUE }).catch((e: unknown) => e);
    expect(serverErr).toBeInstanceOf(SecretsError);
    expect((serverErr as SecretsError).code).toBe("SERVER");
    expect((serverErr as SecretsError).message).not.toContain(WRITE_VALUE);
    vi.unstubAllGlobals();

    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    stubFetch([timeout]);
    const adapter2 = new InfisicalSecretsAdapter(OPTIONS);
    const timeoutErr = await adapter2.putSecret({ ...TARGET, value: WRITE_VALUE }).catch((e: unknown) => e);
    expect(timeoutErr).toBeInstanceOf(SecretsError);
    expect((timeoutErr as SecretsError).code).toBe("TRANSPORT");
    expect((timeoutErr as SecretsError).message).not.toContain(WRITE_VALUE);
  });

  it("rejects out-of-namespace targets without any network call", async () => {
    const { calls } = stubFetch([]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    const err = await adapter
      .putSecret({ ...TARGET, key: "FREE_FORM_KEY", value: WRITE_VALUE })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretsError);
    expect((err as SecretsError).code).toBe("MALFORMED_REF");
    expect(calls).toHaveLength(0);
  });
});

describe("InfisicalSecretsAdapter.deleteSecret", () => {
  it("deletes a namespaced ref", async () => {
    const debugMessages: string[] = [];
    const { calls } = stubFetch([
      mockResponse(200, { accessToken: "stub-token-1", expiresIn: 7200 }),
      mockResponse(200, {}),
    ]);
    const adapter = new InfisicalSecretsAdapter({
      ...OPTIONS,
      debug: (m) => debugMessages.push(m),
    });
    await adapter.deleteSecret("infisical://sandbox/integrations/tenant-1/asaas/ASAAS_API_KEY");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("/api/v3/secrets/raw/ASAAS_API_KEY");
    expect(calls[1]).toContain("secretPath=%2Fintegrations%2Ftenant-1%2Fasaas");
    for (const m of debugMessages) {
      expect(m).not.toContain("stub-token-1");
    }
  });

  it("sends the scope in the DELETE body (v0.165.16 requires it, query kept)", async () => {
    const debugMessages: string[] = [];
    const { calls, requests } = stubFetch([
      mockResponse(200, { accessToken: "stub-token-1", expiresIn: 7200 }),
      mockResponse(200, {}),
    ]);
    const adapter = new InfisicalSecretsAdapter({
      ...OPTIONS,
      debug: (m) => debugMessages.push(m),
    });
    const ref = "infisical://sandbox/integrations/tenant-1/asaas/ASAAS_API_KEY";
    await adapter.deleteSecret(ref);
    expect(calls).toHaveLength(2);
    const del = requests[1];
    expect(del?.init?.method).toBe("DELETE");
    // Query string preserved.
    expect(del?.url).toContain("secretPath=%2Fintegrations%2Ftenant-1%2Fasaas");
    // Scope now also in the JSON body.
    expect(header(del?.init, "Content-Type")).toBe("application/json");
    const payload = bodyJson(del?.init);
    expect(payload["workspaceId"]).toBe("proj-123");
    expect(payload["environment"]).toBe("sandbox");
    expect(payload["secretPath"]).toBe("/integrations/tenant-1/asaas");
    // Debug log carries the masked ref hash, never the full ref, key or token.
    expect(debugMessages.some((m) => m.includes("refHash="))).toBe(true);
    for (const m of debugMessages) {
      expect(m).not.toContain(ref);
      expect(m).not.toContain("ASAAS_API_KEY");
      expect(m).not.toContain("stub-token-1");
    }
  });

  it("maps missing secret to NOT_FOUND", async () => {
    stubFetch([
      mockResponse(200, { accessToken: "stub-token-1", expiresIn: 7200 }),
      mockResponse(404, { message: "not found" }),
    ]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    const err = await adapter
      .deleteSecret("infisical://sandbox/integrations/tenant-1/asaas/ASAAS_API_KEY")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretsError);
    expect((err as SecretsError).code).toBe("NOT_FOUND");
  });

  it("rejects refs outside the namespace without any network call", async () => {
    const { calls } = stubFetch([]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    const err = await adapter.deleteSecret("infisical://production/OTHER_KEY").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretsError);
    expect((err as SecretsError).code).toBe("MALFORMED_REF");
    expect(calls).toHaveLength(0);
  });
});

describe("rotateSecret (orchestrated domain flow)", () => {
  function queuedAdapter(queue: Array<MockResponse | Error>): {
    adapter: InfisicalSecretsAdapter;
    calls: string[];
  } {
    const { calls } = stubFetch(queue);
    return { adapter: new InfisicalSecretsAdapter(OPTIONS), calls };
  }

  it("stages, probes, cuts over and cleans the stage on success", async () => {
    const { adapter, calls } = queuedAdapter([
      mockResponse(200, { accessToken: "stub-token-1", expiresIn: 7200 }),
      mockResponse(200, { secret: {} }),
      mockResponse(200, { secret: {} }),
      mockResponse(200, {}),
    ]);
    let probedRef: string | null = null;
    const result = await rotateSecret(adapter, {
      ...TARGET,
      value: "synthetic-rotated-value-02",
      probe: async (stagedRef) => {
        probedRef = stagedRef;
      },
    });
    expect(result.ref).toBe("infisical://sandbox/integrations/tenant-1/asaas/ASAAS_API_KEY");
    expect(result.stagedRef).toBe(
      "infisical://sandbox/integrations/tenant-1/asaas/ASAAS_API_KEY__next",
    );
    expect(probedRef).toBe(result.stagedRef);
    const writes = calls.filter((c) => c.includes("/api/v3/secrets/raw/"));
    // stage put + cutover put + stage delete = 3 secret calls (+1 login).
    expect(writes).toHaveLength(3);
    expect(calls).toHaveLength(4);
  });

  it("failed probe never cuts over: live ref preserved, stage cleaned", async () => {
    const { adapter, calls } = queuedAdapter([
      mockResponse(200, { accessToken: "stub-token-1", expiresIn: 7200 }),
      mockResponse(200, { secret: {} }),
      mockResponse(200, {}),
    ]);
    const err = await rotateSecret(adapter, {
      ...TARGET,
      value: "synthetic-rotated-value-03",
      probe: async () => {
        throw new Error("read-only probe rejected the candidate");
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretsError);
    const writes = calls.filter(
      (c) =>
        c.endsWith("/api/v3/secrets/raw/ASAAS_API_KEY") ||
        c.includes("/api/v3/secrets/raw/ASAAS_API_KEY?"),
    );
    expect(writes).toHaveLength(0);
    // Stage was created then cleaned up.
    expect(calls.some((c) => c.includes("ASAAS_API_KEY__next"))).toBe(true);
  });
});

describe("writer discovery", () => {
  it("asSecretsWriter narrows real writers and rejects read-only ports", () => {
    expect(asSecretsWriter(new InfisicalSecretsAdapter(OPTIONS))).not.toBeNull();
    expect(asSecretsWriter(new NoopSecretsPort())).not.toBeNull();
    expect(asSecretsWriter({ name: "read-only", getSecret: async () => "x" })).toBeNull();
  });

  it("resolveSecretsWriterPort returns a writer (noop when env incomplete)", () => {
    expect(resolveSecretsWriterPort({}).name).toBe("noop");
    const writer = resolveSecretsWriterPort({
      INFISICAL_SITE_URL: "https://infisical.example.test",
      INFISICAL_PROJECT_ID: "proj-123",
      INFISICAL_CLIENT_ID: "id-abc",
      INFISICAL_CLIENT_SECRET: "client-secret-stub",
    });
    expect(writer.name).toBe("infisical");
    expect(asSecretsWriter(writer)).not.toBeNull();
  });
});
