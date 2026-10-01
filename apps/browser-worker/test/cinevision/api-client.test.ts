import { describe, expect, it, vi } from "vitest";
import {
  buildApiPath,
  buildApiUrl,
  cancelInPageFetch,
  CapabilityParamError,
  fetchCapability,
  fetchProjectedInPage,
  type CinevisionInPage,
  type InPageRequest,
  type InPageResult,
} from "../../src/providers/cinevision/api-client.js";

const ALLOWED = "https://panel.example.test";
const TOKEN = "spa-token-value";

interface StubBehavior {
  token: string | null;
  status: number;
  contentType: string;
  bodyText: string;
  network: "ok" | "reset";
  fetchMode?: "immediate" | "hang-until-abort";
  badText?: boolean;
  pageOrigin?: string;
  docTitle?: string;
  docHtml?: string;
  cfMitigated?: string | null;
  onAbort?: () => void;
}

interface Captured {
  url: string;
  authorization: string | null;
}

/**
 * Fake page that executes the REAL in-page fetch closure with stubbed
 * globals (same technique as `test/browser.test.ts`): proves the gate
 * runs before the token, the Bearer is attached in-page, and only
 * projected data (never the token) crosses back. Forwards ANY fn/arg
 * pair so the short cancel `evaluate` works while a fetch is pending
 * (registry lives on `globalThis` and is never saved/restored here).
 */
function fakePage(
  behavior: StubBehavior,
  captured: Captured[],
  results: InPageResult[] = [],
  tokenReads: { reads: number } = { reads: 0 },
): CinevisionInPage {
  return {
    evaluate: async (fn, req) => {
      const scope = globalThis as unknown as Record<string, unknown>;
      const prevFetch = scope["fetch"];
      const prevStorage = scope["localStorage"];
      const prevLocation = scope["location"];
      const prevDocument = scope["document"];
      scope["localStorage"] = {
        getItem: (key: string) => {
          if (key === "token") tokenReads.reads += 1;
          return key === "token" ? behavior.token : null;
        },
      };
      scope["location"] = { origin: behavior.pageOrigin ?? ALLOWED };
      scope["document"] = {
        title: behavior.docTitle ?? "",
        documentElement: { outerHTML: behavior.docHtml ?? "" },
      };
      scope["fetch"] = (async (
        requestUrl: string,
        init?: { headers?: Record<string, string>; signal?: AbortSignal },
      ) => {
        captured.push({ url: requestUrl, authorization: init?.headers?.["Authorization"] ?? null });
        if (behavior.fetchMode === "hang-until-abort") {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                behavior.onAbort?.();
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          });
        }
        if (behavior.network === "reset") throw new Error("connection reset");
        return {
          status: behavior.status,
          headers: {
            get: (name: string) => {
              const lower = name.toLowerCase();
              if (lower === "content-type") return behavior.contentType;
              if (lower === "cf-mitigated") return behavior.cfMitigated ?? null;
              return null;
            },
          },
          body: { cancel: async () => undefined },
          text: async () => {
            if (behavior.badText === true) throw new Error("body unreadable");
            return behavior.bodyText;
          },
        };
      }) as unknown as typeof fetch;
      try {
        const result = await (fn as (arg: unknown) => Promise<InPageResult>)(req);
        if (result !== undefined && typeof (result as InPageResult).kind === "string") {
          results.push(result as InPageResult);
        }
        return result as InPageResult;
      } finally {
        scope["fetch"] = prevFetch;
        scope["localStorage"] = prevStorage;
        scope["location"] = prevLocation;
        scope["document"] = prevDocument;
      }
    },
  };
}

function okBehavior(overrides: Partial<StubBehavior> = {}): StubBehavior {
  return {
    token: TOKEN,
    status: 200,
    contentType: "application/json",
    bodyText: '{"data":[],"meta":{"current_page":1,"last_page":1,"per_page":25,"total":0}}',
    network: "ok",
    ...overrides,
  };
}

function validReq(path: string, extra: Partial<InPageRequest> = {}): InPageRequest {
  return {
    allowedOrigin: ALLOWED,
    path,
    expectedPath: path,
    projection: { pick: ["id"] },
    timeoutMs: 1000,
    ...extra,
  };
}

describe("buildApiPath (closed capability map)", () => {
  it("maps every capability to a fixed GET path", () => {
    expect(buildApiPath("identity")).toBe("/api/auth/me");
    expect(buildApiPath("servers")).toBe("/api/servers");
    expect(buildApiPath("serverStatus")).toBe("/api/servers/status");
    expect(buildApiPath("packagePrices")).toBe("/api/packages/price");
    expect(buildApiPath("integrations")).toBe("/api/integrations");
    expect(buildApiPath("customers", { perPage: 1, page: 2 })).toBe(
      "/api/customers?perPage=1&page=2",
    );
    expect(buildApiPath("customer", { customerId: "cust-1" })).toBe("/api/customers/cust-1");
    expect(buildApiPath("liveConnections", { serverId: "srv-9" })).toContain(
      "/api/customers/live-connections/srv-9?",
    );
  });

  it("rejects path-smuggling ids and out-of-range pagination", () => {
    for (const bad of ["../evil", "a/b", "", "x".repeat(65)]) {
      expect(() => buildApiPath("customer", { customerId: bad }), bad).toThrowError(
        CapabilityParamError,
      );
    }
    expect(() => buildApiPath("liveConnections", {})).toThrowError(CapabilityParamError);
    expect(() => buildApiPath("customers", { perPage: 0 })).toThrowError(CapabilityParamError);
    expect(() => buildApiPath("customers", { perPage: 101 })).toThrowError(CapabilityParamError);
  });
});

describe("buildApiUrl", () => {
  it("builds absolute same-origin urls", () => {
    expect(buildApiUrl(ALLOWED, "/api/auth/me")).toBe("https://panel.example.test/api/auth/me");
  });

  it("rejects malformed origins and non-api paths", () => {
    // Shape guard only: the allowlist value itself is the caller's
    // responsibility (validated config). The client rejects anything
    // that is not an https origin or not a fixed /api/ path.
    for (const badOrigin of ["http://panel.example.test", "not-a-url", "https://host/path", ""]) {
      expect(() => buildApiUrl(badOrigin, "/api/auth/me"), badOrigin).toThrowError(
        CapabilityParamError,
      );
    }
    expect(() => buildApiUrl(ALLOWED, "https://evil.example.test/api/auth/me")).toThrowError(
      CapabilityParamError,
    );
  });
});

describe("R1: in-page closure is serialization-safe", () => {
  it("references zero module identifiers", () => {
    const src = fetchProjectedInPage.toString();
    for (const banned of [
      "ORIGIN_RE",
      "DEFAULT_TIMEOUT_MS",
      "isJsonContentType",
      "CHALLENGE_SCRIPT_IN_PAGE",
      "INTERSTITIAL_IN_PAGE",
      "applyProjection",
      "pickOne",
      "PROJECTIONS",
      "CUSTOMER_PICK",
      "cancelInPageFetch",
    ]) {
      expect(src, banned).not.toContain(banned);
    }
  });

  it("runs isolated from module bindings (fails if a module symbol is reintroduced)", async () => {
    const src = fetchProjectedInPage.toString();
    const isolated = new Function(`return (${src})`)() as typeof fetchProjectedInPage;
    const scope = globalThis as unknown as Record<string, unknown>;
    const prevFetch = scope["fetch"];
    const prevStorage = scope["localStorage"];
    const prevLocation = scope["location"];
    scope["localStorage"] = { getItem: (key: string) => (key === "token" ? TOKEN : null) };
    scope["location"] = { origin: ALLOWED };
    scope["fetch"] = (async () => ({
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () =>
        JSON.stringify({ id: "u-1", username: "op", credits: 2, token: TOKEN }),
    })) as unknown as typeof fetch;
    try {
      const result = await isolated({
        allowedOrigin: ALLOWED,
        path: "/api/auth/me",
        expectedPath: "/api/auth/me",
        projection: { pick: ["id", "username", "credits"] },
        timeoutMs: 1000,
        callId: "r1-isolation-probe",
      });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.data).toEqual({ id: "u-1", username: "op", credits: 2 });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    } finally {
      scope["fetch"] = prevFetch;
      scope["localStorage"] = prevStorage;
      scope["location"] = prevLocation;
    }
  });

  it("cancel helper is also self-contained", () => {
    const src = cancelInPageFetch.toString();
    expect(src).not.toContain("fetchProjectedInPage");
    const isolated = new Function(`return (${src})`)() as typeof cancelInPageFetch;
    expect(() => isolated("missing-id-never-throws")).not.toThrow();
  });
});

describe("R2: exact expected-path gate", () => {
  it("denies a valid same-origin off-map path without touching the token", async () => {
    const scope = globalThis as unknown as Record<string, unknown>;
    const prevStorage = scope["localStorage"];
    const prevLocation = scope["location"];
    const prevFetch = scope["fetch"];
    const reads = { reads: 0 };
    let fetches = 0;
    scope["localStorage"] = {
      getItem: (key: string) => {
        if (key === "token") reads.reads += 1;
        return TOKEN;
      },
    };
    scope["location"] = { origin: ALLOWED };
    scope["fetch"] = (async () => {
      fetches += 1;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch;
    try {
      // Same-origin, well-formed, but NOT the capability's exact path.
      await expect(
        fetchProjectedInPage({
          allowedOrigin: ALLOWED,
          path: "/api/auth/refresh-token",
          expectedPath: "/api/auth/me",
          projection: { pick: ["id"] },
          timeoutMs: 1000,
        }),
      ).resolves.toEqual({ kind: "denied" });
      expect(reads.reads).toBe(0);
      expect(fetches).toBe(0);
    } finally {
      scope["localStorage"] = prevStorage;
      scope["location"] = prevLocation;
      scope["fetch"] = prevFetch;
    }
  });

  it("denies when expectedPath is missing or path drifts after construction", async () => {
    const scope = globalThis as unknown as Record<string, unknown>;
    const prevStorage = scope["localStorage"];
    const prevLocation = scope["location"];
    const reads = { reads: 0 };
    scope["localStorage"] = {
      getItem: (key: string) => {
        if (key === "token") reads.reads += 1;
        return TOKEN;
      },
    };
    scope["location"] = { origin: ALLOWED };
    try {
      const noExpected = {
        allowedOrigin: ALLOWED,
        path: "/api/auth/me",
        projection: { pick: ["id"] },
        timeoutMs: 1000,
      } as unknown as InPageRequest;
      await expect(fetchProjectedInPage(noExpected)).resolves.toEqual({ kind: "denied" });
      await expect(
        fetchProjectedInPage(validReq("/api/servers", { expectedPath: "/api/servers/status" })),
      ).resolves.toEqual({ kind: "denied" });
      expect(reads.reads).toBe(0);
    } finally {
      scope["localStorage"] = prevStorage;
      scope["location"] = prevLocation;
    }
  });
});

describe("R3: boundary projection (primitive-only, meta allowlist)", () => {
  it("drops meta.token and keeps only pagination counters", async () => {
    const captured: Captured[] = [];
    const res = await fetchCapability(
      {
        page: fakePage(
          okBehavior({
            bodyText: JSON.stringify({
              data: [],
              meta: {
                current_page: 1,
                last_page: 1,
                per_page: 25,
                total: 0,
                from: 1,
                to: 0,
                token: "meta-secret-never-crosses",
              },
            }),
          }),
          captured,
        ),
        allowedOrigin: ALLOWED,
      },
      "customers",
    );
    expect(res.transportFailed).toBe(false);
    expect(JSON.stringify(res)).not.toContain("meta-secret-never-crosses");
    expect(JSON.stringify(res)).not.toContain('"token"');
    expect(res.body).toEqual({
      data: [],
      meta: { current_page: 1, last_page: 1, per_page: 25, total: 0, from: 1, to: 0 },
    });
  });

  it("drops nested objects/arrays inside picked fields", async () => {
    const captured: Captured[] = [];
    const res = await fetchCapability(
      {
        page: fakePage(
          okBehavior({
            bodyText: JSON.stringify({
              id: { token: "nested-secret-never-crosses" },
              username: "op",
              credits: 2,
              token: TOKEN,
            }),
          }),
          captured,
        ),
        allowedOrigin: ALLOWED,
      },
      "identity",
    );
    expect(res.transportFailed).toBe(false);
    const line = JSON.stringify(res);
    expect(line).not.toContain("nested-secret-never-crosses");
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain('"token"');
    // The nested object field is discarded, not copied.
    expect(res.body).toEqual({ username: "op", credits: 2 });
  });
});

describe("R4: html signals come from the RESPONSE, never document.*", () => {
  it("reports CHALLENGE from a 403 response even when the SPA document looks normal", async () => {
    const captured: Captured[] = [];
    const res = await fetchCapability(
      {
        page: fakePage(
          okBehavior({
            status: 403,
            contentType: "text/html",
            bodyText:
              '<html><head><title>Just a moment</title><script src="/cdn-cgi/challenge-platform/h/b/scripts.js"></script></head><body><form>verify you are human</form></body></html>',
            docTitle: "Dashboard",
            docHtml: "<html><head><title>Dashboard</title></head><body>app</body></html>",
          }),
          captured,
        ),
        allowedOrigin: ALLOWED,
      },
      "servers",
    );
    expect(res.transportFailed).toBe(false);
    expect(res.html).toMatchObject({ title: "Just a moment" });
    expect(res.html?.hasChallengeScript).toBe(true);
    expect(res.html?.markers).toContain("verify you are human");
  });

  it("does not report CHALLENGE from a challenge-titled document when the response is JSON", async () => {
    const captured: Captured[] = [];
    const res = await fetchCapability(
      {
        page: fakePage(
          okBehavior({
            bodyText: JSON.stringify({ data: [{ id: "s-1", name: "srv" }] }),
            docTitle: "Just a moment",
            docHtml:
              '<html><head><title>Just a moment</title><script src="/turnstile.js"></script></head></html>',
          }),
          captured,
        ),
        allowedOrigin: ALLOWED,
      },
      "servers",
    );
    expect(res.transportFailed).toBe(false);
    expect(res.html).toBeNull();
    expect(res.body).toEqual({ data: [{ id: "s-1", name: "srv" }] });
  });
});

describe("R5b: F1 — markers never born inside scripts", () => {
  it.each(["challenge-platform", "turnstile", "cf-challenge"])(
    "script attribute marker '<form' of family %s yields no markers",
    async (family) => {
      const captured: Captured[] = [];
      const res = await fetchCapability(
        {
          page: fakePage(
            okBehavior({
              status: 403,
              contentType: "text/html",
              bodyText: `<html><head><script src="/cdn-cgi/${family}/x.js" data-info="<form"></script></head><body>deny</body></html>`,
            }),
            captured,
          ),
          allowedOrigin: ALLOWED,
        },
        "servers",
      );
      expect(res.transportFailed).toBe(false);
      expect(res.html?.hasChallengeScript).toBe(true);
      expect(res.html?.markers).toEqual([]);
    },
  );

  it("exact F1 shape: turnstile attribute marker is not structural", async () => {
    const captured: Captured[] = [];
    const res = await fetchCapability(
      {
        page: fakePage(
          okBehavior({
            status: 403,
            contentType: "text/html",
            bodyText:
              '<html><head><script src="/turnstile.js" data-info="<form"></script></head></html>',
          }),
          captured,
        ),
        allowedOrigin: ALLOWED,
      },
      "servers",
    );
    expect(res.html?.hasChallengeScript).toBe(true);
    expect(res.html?.markers).toEqual([]);
  });

  it("marker inside inline JS string yields no markers", async () => {
    const captured: Captured[] = [];
    const res = await fetchCapability(
      {
        page: fakePage(
          okBehavior({
            status: 403,
            contentType: "text/html",
            bodyText:
              '<html><head><script>var s="<form>";</script></head><body>deny</body></html>',
          }),
          captured,
        ),
        allowedOrigin: ALLOWED,
      },
      "servers",
    );
    expect(res.html?.markers).toEqual([]);
  });
});

describe("R5c: F2 — inline script content is inspected, form must be real", () => {
  it("inline family code + real form yields challenge signals", async () => {
    const captured: Captured[] = [];
    const res = await fetchCapability(
      {
        page: fakePage(
          okBehavior({
            status: 403,
            contentType: "text/html",
            bodyText: '<script>turnstile.render("#challenge")</script><form id="challenge"></form>',
          }),
          captured,
        ),
        allowedOrigin: ALLOWED,
      },
      "servers",
    );
    expect(res.html?.hasChallengeScript).toBe(true);
    expect(res.html?.markers).toContain("<form");
  });

  it("inline family code without a real form yields no markers", async () => {
    const captured: Captured[] = [];
    const res = await fetchCapability(
      {
        page: fakePage(
          okBehavior({
            status: 403,
            contentType: "text/html",
            bodyText: '<script>turnstile.render("#x")</script><p>deny</p>',
          }),
          captured,
        ),
        allowedOrigin: ALLOWED,
      },
      "servers",
    );
    expect(res.html?.hasChallengeScript).toBe(true);
    expect(res.html?.markers).toEqual([]);
  });
});
describe("R5: script families never prove a challenge alone", () => {
  it.each(["challenge-platform", "turnstile", "cf-challenge"])(
    "lone <%s> script tag yields signals but no challenge",
    async (family) => {
      const captured: Captured[] = [];
      const res = await fetchCapability(
        {
          page: fakePage(
            okBehavior({
              status: 403,
              contentType: "text/html",
              bodyText: `<html><head><script src="/cdn-cgi/${family}/x.js"></script></head><body>deny</body></html>`,
              docTitle: "Forbidden",
              docHtml: "",
            }),
            captured,
          ),
          allowedOrigin: ALLOWED,
        },
        "servers",
      );
      expect(res.transportFailed).toBe(false);
      expect(res.html?.hasChallengeScript).toBe(true);
      expect(res.html?.markers).toEqual([]);
    },
  );
});

describe("R6: external abort aborts the in-page fetch", () => {
  it("aborts the hanging in-page fetch and cleans the registry", async () => {
    let abortedInPage = false;
    const captured: Captured[] = [];
    const controller = new AbortController();
    const pending = fetchCapability(
      {
        page: fakePage(
          okBehavior({ fetchMode: "hang-until-abort", onAbort: () => (abortedInPage = true) }),
          captured,
        ),
        allowedOrigin: ALLOWED,
        timeoutMs: 10000,
        signal: controller.signal,
      },
      "servers",
    );
    setTimeout(() => controller.abort(), 20);
    const res = await pending;
    expect(res.transportFailed).toBe(true);
    expect(res.status).toBeNull();
    expect(abortedInPage).toBe(true);
    const registry = (globalThis as unknown as { __cvAbortRegistry?: Record<string, unknown> })
      .__cvAbortRegistry;
    expect(registry === undefined || Object.keys(registry).length === 0).toBe(true);
  });
});

describe("fetchCapability", () => {
  it("sends the session bearer in-page and returns projected data only", async () => {
    const captured: Captured[] = [];
    const results: InPageResult[] = [];
    const res = await fetchCapability(
      {
        page: fakePage(
          okBehavior({
            bodyText: JSON.stringify({ id: "u-1", username: "op", credits: 2, token: TOKEN }),
          }),
          captured,
          results,
        ),
        allowedOrigin: ALLOWED,
      },
      "identity",
    );
    expect(res.transportFailed).toBe(false);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "u-1", username: "op", credits: 2 });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://panel.example.test/api/auth/me");
    expect(captured[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    // The value crossing the boundary carries no token.
    for (const result of results) {
      const line = JSON.stringify(result);
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain('"token"');
    }
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it("returns html signals from the response body without leaking raw text", async () => {
    const captured: Captured[] = [];
    const res = await fetchCapability(
      {
        page: fakePage(
          okBehavior({
            contentType: "text/html",
            bodyText:
              "<html><head><title>Login</title></head><body>login SENTINEL-RAW-BODY-XYZ</body></html>",
            docTitle: "Dashboard",
            docHtml: "<html><head><title>Dashboard</title></head><body>spa</body></html>",
          }),
          captured,
        ),
        allowedOrigin: ALLOWED,
      },
      "servers",
    );
    expect(res.transportFailed).toBe(false);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.html).toEqual({ title: "Login", hasChallengeScript: false, markers: [] });
    expect(JSON.stringify(res)).not.toContain("SENTINEL-RAW-BODY-XYZ");
  });

  it("denies a foreign page origin without touching the token", async () => {
    const evilReads = { reads: 0 };
    const evilCaptured: Captured[] = [];
    const evil = await fetchCapability(
      {
        page: fakePage(
          okBehavior({ pageOrigin: "https://evil.example.test" }),
          evilCaptured,
          [],
          evilReads,
        ),
        allowedOrigin: ALLOWED,
      },
      "identity",
    );
    expect(evil.transportFailed).toBe(true);
    expect(evil.status).toBeNull();
    expect(evilReads.reads).toBe(0);
    expect(evilCaptured).toHaveLength(0);
  });

  it("denies off-map paths inside the closure without touching the token", async () => {
    const scope = globalThis as unknown as Record<string, unknown>;
    const prevStorage = scope["localStorage"];
    const prevLocation = scope["location"];
    const reads = { reads: 0 };
    scope["localStorage"] = {
      getItem: (key: string) => {
        if (key === "token") reads.reads += 1;
        return TOKEN;
      },
    };
    scope["location"] = { origin: ALLOWED };
    try {
      const badPaths = ["/api/../evil", "https://evil.example.test/api/auth/me", "/other", ""];
      for (const path of badPaths) {
        const req: InPageRequest = {
          allowedOrigin: ALLOWED,
          path,
          expectedPath: "/api/auth/me",
          projection: { pick: ["id"] },
          timeoutMs: 1000,
        };
        await expect(fetchProjectedInPage(req), path).resolves.toEqual({ kind: "denied" });
      }
      const evilOrigin: InPageRequest = {
        allowedOrigin: "https://evil.example.test",
        path: "/api/auth/me",
        expectedPath: "/api/auth/me",
        projection: { pick: ["id"] },
        timeoutMs: 1000,
      };
      // Page origin is ALLOWED, request claims evil: denied pre-token.
      await expect(fetchProjectedInPage(evilOrigin)).resolves.toEqual({ kind: "denied" });
      expect(reads.reads).toBe(0);
    } finally {
      scope["localStorage"] = prevStorage;
      scope["location"] = prevLocation;
    }
  });

  it("leaves body null on malformed JSON", async () => {
    const captured: Captured[] = [];
    const res = await fetchCapability(
      { page: fakePage(okBehavior({ bodyText: "{nope" }), captured), allowedOrigin: ALLOWED },
      "servers",
    );
    expect(res.transportFailed).toBe(false);
    expect(res.body).toBeNull();
  });

  it("maps connection reset to transport failure", async () => {
    const captured: Captured[] = [];
    const res = await fetchCapability(
      { page: fakePage(okBehavior({ network: "reset" }), captured), allowedOrigin: ALLOWED },
      "servers",
    );
    expect(res.transportFailed).toBe(true);
    expect(res.status).toBeNull();
  });

  it("maps a bounded timeout to transport failure (injectable, no long sleep)", async () => {
    const hanging: CinevisionInPage = {
      evaluate: () => new Promise<InPageResult>(() => undefined),
    };
    const res = await fetchCapability(
      { page: hanging, allowedOrigin: ALLOWED, timeoutMs: 20 },
      "servers",
    );
    expect(res.transportFailed).toBe(true);
    expect(res.status).toBeNull();
    expect(res.durationMs).toBeLessThan(1000);
  });

  it("cancels the real in-page fetch on timeout via AbortController", async () => {
    const captured: Captured[] = [];
    const res = await fetchCapability(
      {
        page: fakePage(okBehavior({ fetchMode: "hang-until-abort" }), captured),
        allowedOrigin: ALLOWED,
        timeoutMs: 20,
      },
      "servers",
    );
    expect(res.transportFailed).toBe(true);
    expect(res.status).toBeNull();
    expect(captured).toHaveLength(1);
  });

  it("maps an aborted signal to transport failure", async () => {
    const hanging: CinevisionInPage = {
      evaluate: () => new Promise<InPageResult>(() => undefined),
    };
    const res = await fetchCapability(
      { page: hanging, allowedOrigin: ALLOWED, timeoutMs: 5000, signal: AbortSignal.abort() },
      "servers",
    );
    expect(res.transportFailed).toBe(true);
  });

  it("maps abort-after-start to transport failure", async () => {
    const hanging: CinevisionInPage = {
      evaluate: () => new Promise<InPageResult>(() => undefined),
    };
    const controller = new AbortController();
    const pending = fetchCapability(
      { page: hanging, allowedOrigin: ALLOWED, timeoutMs: 5000, signal: controller.signal },
      "servers",
    );
    setTimeout(() => controller.abort(), 10);
    const res = await pending;
    expect(res.transportFailed).toBe(true);
    expect(res.status).toBeNull();
  });

  it("never starts evaluate when the signal is pre-aborted", async () => {
    let calls = 0;
    const spy: CinevisionInPage = {
      evaluate: async () => {
        calls += 1;
        return { kind: "transport" };
      },
    };
    const res = await fetchCapability(
      { page: spy, allowedOrigin: ALLOWED, timeoutMs: 5000, signal: AbortSignal.abort() },
      "servers",
    );
    expect(res.transportFailed).toBe(true);
    expect(calls).toBe(0);
  });

  it("cleans up timers and abort listeners after success", async () => {
    vi.useFakeTimers();
    try {
      const captured: Captured[] = [];
      const controller = new AbortController();
      const addSpy = vi.spyOn(controller.signal, "addEventListener");
      const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
      const res = await fetchCapability(
        {
          page: fakePage(okBehavior(), captured),
          allowedOrigin: ALLOWED,
          timeoutMs: 5000,
          signal: controller.signal,
        },
        "servers",
      );
      expect(res.transportFailed).toBe(false);
      expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
      expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps evaluate rejection (closed page) to transport, never throws", async () => {
    const broken: CinevisionInPage = {
      evaluate: async () => {
        throw new Error("context destroyed");
      },
    };
    const res = await fetchCapability({ page: broken, allowedOrigin: ALLOWED }, "servers");
    expect(res.transportFailed).toBe(true);
    expect(res.status).toBeNull();
  });

  it("throws programmer errors before evaluate (invalid origin)", async () => {
    let calls = 0;
    const spy: CinevisionInPage = {
      evaluate: async () => {
        calls += 1;
        return { kind: "transport" };
      },
    };
    await expect(
      fetchCapability({ page: spy, allowedOrigin: "not-an-origin" }, "servers"),
    ).rejects.toThrowError(CapabilityParamError);
    expect(calls).toBe(0);
  });

  it("never sends Authorization when the session token is absent", async () => {
    const captured: Captured[] = [];
    const res = await fetchCapability(
      {
        page: fakePage(okBehavior({ token: null, status: 401, bodyText: "" }), captured),
        allowedOrigin: ALLOWED,
      },
      "identity",
    );
    expect(res.status).toBe(401);
    expect(captured[0]?.authorization).toBeNull();
  });
});
