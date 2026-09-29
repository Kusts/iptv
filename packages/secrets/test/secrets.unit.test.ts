import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InfisicalSecretsAdapter,
  NoopSecretsPort,
  SecretsError,
  parseSecretRef,
  resolveSecretsPort,
} from "../src/index.js";

const OPTIONS = {
  siteUrl: "https://infisical.example.test",
  projectId: "proj-123",
  clientId: "id-abc",
  clientSecret: "secret-abc",
};

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseSecretRef", () => {
  it("parses environment + key", () => {
    expect(parseSecretRef("infisical://production/TEST_SECRET")).toEqual({
      environment: "production",
      secretPath: "/",
      key: "TEST_SECRET",
    });
  });

  it("parses nested paths", () => {
    expect(parseSecretRef("infisical://production/browser-worker/CINEVISION_USER")).toEqual({
      environment: "production",
      secretPath: "/browser-worker",
      key: "CINEVISION_USER",
    });
  });

  it("rejects malformed refs with a grammar error", () => {
    for (const bad of [
      "",
      "production/TEST_SECRET",
      "infisical://",
      "infisical://onlyenv",
      "infisical:///KEY",
      "infisical://production/",
      "infisical://pro duction/KEY",
      "infisical://a//KEY",
    ]) {
      let err: unknown = null;
      try {
        parseSecretRef(bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as SecretsError).code).toBe("MALFORMED_REF");
    }
  });

  it("rejects dot segments in short and nested refs", () => {
    for (const bad of [
      // Short format (environment/key) with dot segments.
      "infisical://./KEY",
      "infisical://../KEY",
      "infisical://production/.",
      "infisical://production/..",
      // Nested format (environment/path/key) with dot segments.
      "infisical://production/./KEY",
      "infisical://production/../KEY",
      "infisical://production/a/../KEY",
      "infisical://production/./a/KEY",
      "infisical://production/a/./KEY",
    ]) {
      let err: unknown = null;
      try {
        parseSecretRef(bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as SecretsError).code).toBe("MALFORMED_REF");
    }
  });
});

describe("InfisicalSecretsAdapter siteUrl", () => {
  it("rejects plain http on non-local hosts with CONFIG", () => {
    for (const siteUrl of [
      "http://infisical.example.test",
      "http://infisical.example.test:8080",
      "http://192.168.1.10:8080",
      "http://[::1]:8080",
    ]) {
      let err: unknown = null;
      try {
        new InfisicalSecretsAdapter({ ...OPTIONS, siteUrl });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as SecretsError).code).toBe("CONFIG");
    }
  });

  it("accepts https and http localhost dev URLs", () => {
    for (const siteUrl of [
      "https://infisical.example.test",
      "https://infisical.example.test:8443/base/",
      "http://localhost:8080",
      "http://127.0.0.1:8080",
    ]) {
      expect(() => new InfisicalSecretsAdapter({ ...OPTIONS, siteUrl })).not.toThrow();
    }
  });
});

describe("InfisicalSecretsAdapter", () => {
  it("logs in and reads the secret value", async () => {
    const { calls, requests } = stubFetch([
      mockResponse(200, { accessToken: "tok-1", expiresIn: 7200 }),
      mockResponse(200, { secret: { secretKey: "TEST_SECRET", secretValue: "s3cr3t" } }),
    ]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    await expect(adapter.getSecret("infisical://production/TEST_SECRET")).resolves.toBe("s3cr3t");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/api/v1/auth/universal-auth/login");
    expect(calls[1]).toContain("/api/v3/secrets/raw/TEST_SECRET");
    expect(calls[1]).toContain("workspaceId=proj-123");
    expect(calls[1]).toContain("environment=production");
    // RequestInit: login posts JSON, reads carry the Bearer token, every
    // request carries an abort signal (timeout).
    expect(requests[0]?.init?.method).toBe("POST");
    expect(header(requests[0]?.init, "Content-Type")).toBe("application/json");
    expect(String(requests[0]?.init?.body)).toContain('"clientSecret"');
    expect(requests[1]?.init?.method).toBe("GET");
    expect(header(requests[1]?.init, "Authorization")).toBe("Bearer tok-1");
    for (const r of requests) {
      expect(r.init?.signal).toBeDefined();
    }
  });

  it("reuses the cached token across reads (one login for two reads)", async () => {
    stubFetch([
      mockResponse(200, { accessToken: "tok-1", expiresIn: 7200 }),
      mockResponse(200, { secret: { secretValue: "one" } }),
      mockResponse(200, { secret: { secretValue: "two" } }),
    ]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    await expect(adapter.getSecret("infisical://production/A")).resolves.toBe("one");
    await expect(adapter.getSecret("infisical://production/B")).resolves.toBe("two");
    const fetchMock = vi.mocked(globalThis.fetch);
    const loginCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/api/v1/auth/universal-auth/login"),
    );
    expect(loginCalls).toHaveLength(1);
  });

  it("refreshes the token once on 401 then retries", async () => {
    const { requests } = stubFetch([
      mockResponse(200, { accessToken: "tok-old", expiresIn: 7200 }),
      mockResponse(401, { message: "unauthorized" }),
      mockResponse(200, { accessToken: "tok-new", expiresIn: 7200 }),
      mockResponse(200, { secret: { secretValue: "fresh" } }),
    ]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    await expect(adapter.getSecret("infisical://production/A")).resolves.toBe("fresh");
    const fetchMock = vi.mocked(globalThis.fetch);
    const loginCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/api/v1/auth/universal-auth/login"),
    );
    expect(loginCalls).toHaveLength(2);
    // RequestInit: first read used the stale token, the retry uses the fresh
    // one; every request carries an abort signal (timeout).
    const reads = requests.filter((r) => r.url.includes("/api/v3/secrets/raw/"));
    expect(reads).toHaveLength(2);
    expect(header(reads[0]?.init, "Authorization")).toBe("Bearer tok-old");
    expect(header(reads[1]?.init, "Authorization")).toBe("Bearer tok-new");
    for (const r of requests) {
      expect(r.init?.signal).toBeDefined();
    }
  });

  it("surfaces persistent 401 as UNAUTHORIZED", async () => {
    const { calls, requests } = stubFetch([
      mockResponse(200, { accessToken: "tok-old", expiresIn: 7200 }),
      mockResponse(401, { message: "unauthorized" }),
      mockResponse(200, { accessToken: "tok-new", expiresIn: 7200 }),
      mockResponse(401, { message: "unauthorized again" }),
    ]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    const ref = "infisical://production/SUPER_SECRET_KEY_XYZ";
    const err = await adapter.getSecret(ref).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretsError);
    expect((err as SecretsError).code).toBe("UNAUTHORIZED");
    // Fixed message: names the environment + ref shape, never the key/path.
    const message = (err as SecretsError).message;
    expect(message).toContain("production");
    expect(message).not.toContain("SUPER_SECRET_KEY_XYZ");
    expect(message).not.toContain(ref);
    // Exact call counts: exactly one login + one read, one re-login + one
    // retry read — 4 calls total, no retry loop.
    expect(calls).toHaveLength(4);
    const logins = requests.filter((r) => r.url.includes("/api/v1/auth/universal-auth/login"));
    const reads = requests.filter((r) => r.url.includes("/api/v3/secrets/raw/"));
    expect(logins).toHaveLength(2);
    expect(reads).toHaveLength(2);
    expect(header(reads[1]?.init, "Authorization")).toBe("Bearer tok-new");
    for (const r of requests) {
      expect(r.init?.signal).toBeDefined();
    }
  });

  it("maps a missing secret to NOT_FOUND", async () => {
    stubFetch([
      mockResponse(200, { accessToken: "tok-1", expiresIn: 7200 }),
      mockResponse(404, { message: "not found" }),
    ]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    const err = await adapter.getSecret("infisical://production/NOPE").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretsError);
    expect((err as SecretsError).code).toBe("NOT_FOUND");
  });

  it("maps network failures to a typed TRANSPORT error", async () => {
    stubFetch([new Error("socket hang up")]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    const err = await adapter.getSecret("infisical://production/A").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretsError);
    expect((err as SecretsError).code).toBe("TRANSPORT");
  });

  it("rejects malformed refs without any network call", async () => {
    const { calls } = stubFetch([]);
    const adapter = new InfisicalSecretsAdapter(OPTIONS);
    const err = await adapter.getSecret("not-a-ref").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretsError);
    expect((err as SecretsError).code).toBe("MALFORMED_REF");
    expect(calls).toHaveLength(0);
  });

  it("never leaks values or tokens in errors or debug output", async () => {
    const debugMessages: string[] = [];
    stubFetch([
      mockResponse(200, { accessToken: "tok-super-secret", expiresIn: 7200 }),
      mockResponse(200, { secret: { secretValue: "value-super-secret" } }),
    ]);
    const adapter = new InfisicalSecretsAdapter({
      ...OPTIONS,
      debug: (m) => debugMessages.push(m),
    });
    const value = await adapter.getSecret("infisical://production/A");
    expect(value).toBe("value-super-secret");
    for (const m of debugMessages) {
      expect(m).not.toContain("tok-super-secret");
      expect(m).not.toContain("value-super-secret");
    }
  });
});

describe("resolveSecretsPort", () => {
  it("returns Noop when env is incomplete (never throws)", () => {
    expect(resolveSecretsPort({}).name).toBe("noop");
    expect(
      resolveSecretsPort({ INFISICAL_SITE_URL: "https://x", INFISICAL_PROJECT_ID: "p" }).name,
    ).toBe("noop");
    expect(resolveSecretsPort({ INFISICAL_SITE_URL: "   " }).name).toBe("noop");
  });

  it("returns the Infisical adapter when fully configured", () => {
    const port = resolveSecretsPort({
      INFISICAL_SITE_URL: "https://infisical.example.test",
      INFISICAL_PROJECT_ID: "proj-123",
      INFISICAL_CLIENT_ID: "id-abc",
      INFISICAL_CLIENT_SECRET: "secret-abc",
    });
    expect(port.name).toBe("infisical");
  });

  it("Noop fails loudly with CONFIG instead of a fake value", async () => {
    const err = await new NoopSecretsPort().getSecret("infisical://production/A").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretsError);
    expect((err as SecretsError).code).toBe("CONFIG");
  });
});
