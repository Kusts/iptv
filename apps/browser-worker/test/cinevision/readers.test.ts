import { describe, expect, it } from "vitest";
import type { CinevisionInPage } from "../../src/providers/cinevision/api-client.js";
import {
  listCustomers,
  listIntegrations,
  listPackagePrices,
  listServers,
  readConnections,
  readCreditBalance,
  readCustomer,
  readCustomerStatus,
  readIdentity,
  readLiveConnections,
  readServerStatus,
  type ReaderDeps,
} from "../../src/providers/cinevision/readers.js";

const ALLOWED = "https://panel.example.test";
const TOKEN = "session-token-value";
const PASSWORD = "pw-never-emitted";

interface Canned {
  status: number;
  contentType: string;
  bodyText: string;
  docTitle?: string;
  docHtml?: string;
  cfMitigated?: string | null;
}

function fakeDeps(canned: Canned, token: string | null = TOKEN): ReaderDeps {
  const page: CinevisionInPage = {
    evaluate: async (fn, req) => {
      const scope = globalThis as unknown as Record<string, unknown>;
      const prevFetch = scope["fetch"];
      const prevStorage = scope["localStorage"];
      const prevLocation = scope["location"];
      const prevDocument = scope["document"];
      scope["localStorage"] = { getItem: (key: string) => (key === "token" ? token : null) };
      scope["location"] = { origin: ALLOWED };
      scope["document"] = {
        title: canned.docTitle ?? "",
        documentElement: { outerHTML: canned.docHtml ?? "" },
      };
      scope["fetch"] = (async () => ({
        status: canned.status,
        headers: {
          get: (name: string) => {
            const lower = name.toLowerCase();
            if (lower === "content-type") return canned.contentType;
            if (lower === "cf-mitigated") return canned.cfMitigated ?? null;
            return null;
          },
        },
        body: { cancel: async () => undefined },
        text: async () => canned.bodyText,
      })) as unknown as typeof fetch;
      try {
        return await fn(req);
      } finally {
        scope["fetch"] = prevFetch;
        scope["localStorage"] = prevStorage;
        scope["location"] = prevLocation;
        scope["document"] = prevDocument;
      }
    },
  };
  return { page, allowedOrigin: ALLOWED };
}

function jsonCanned(status: number, body: unknown): Canned {
  return { status, contentType: "application/json", bodyText: JSON.stringify(body) };
}

function htmlCanned(status: number, docTitle: string, docHtml: string): Canned {
  // Signals now come from the RESPONSE body text (never document.*);
  // the document stubs stay as SPA noise to prove they are ignored.
  return { status, contentType: "text/html", bodyText: docHtml, docTitle, docHtml };
}

const CUSTOMER = {
  id: "cust-1",
  user_id: "user-1",
  server_id: "srv-1",
  package_id: "pkg-1",
  status: "active",
  is_trial: "true",
  connections: 2,
  has_multiple_connections: false,
  expires_at: "2026-10-30T00:00:00Z",
  plan_price: 10,
};
const META = { current_page: 1, last_page: 1, per_page: 25, total: 1 };

describe("readers: happy paths", () => {
  it("readIdentity returns a sanitized snapshot with ok evidence", async () => {
    const result = await readIdentity(
      fakeDeps(jsonCanned(200, { id: "u-1", username: "op", credits: 2, token: TOKEN })),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ id: "u-1", username: "op", credits: 2 });
    expect(result.evidence).toMatchObject({ status: 200, schema: "ok" });
    expect(result.evidence.path).toBe("/api/auth/me");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("readCreditBalance projects the credits field", async () => {
    const result = await readCreditBalance(fakeDeps(jsonCanned(200, { credits: 7 })));
    expect(result).toEqual(
      expect.objectContaining({ ok: true, data: 7 }),
    );
    const missing = await readCreditBalance(fakeDeps(jsonCanned(200, {})));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("BAD_RESPONSE");
  });

  it("listCustomers normalizes is_trial string to boolean", async () => {
    const result = await listCustomers(
      fakeDeps(jsonCanned(200, { data: [CUSTOMER], links: {}, meta: META })),
      { perPage: 1 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]?.isTrial).toBe(true);
    expect(result.data.meta.total).toBe(1);
  });

  it("readCustomer unwraps data-is-customer and derives status/allowance", async () => {
    const deps = fakeDeps(jsonCanned(200, { data: CUSTOMER }));
    const customer = await readCustomer(deps, { customerId: "cust-1" });
    expect(customer.ok).toBe(true);
    const status = await readCustomerStatus(deps, { customerId: "cust-1" });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.data).toEqual({
      status: "active",
      expiresAt: "2026-10-30T00:00:00Z",
      isTrial: true,
    });
    const allowance = await readConnections(deps, { customerId: "cust-1" });
    expect(allowance.ok).toBe(true);
    if (!allowance.ok) return;
    expect(allowance.data).toEqual({ connections: 2, hasMultipleConnections: false });
  });

  it("listServers/readServerStatus/listPackagePrices/listIntegrations read", async () => {
    const servers = await listServers(fakeDeps(jsonCanned(200, { data: [{ id: "s-1" }] })));
    expect(servers.ok).toBe(true);
    const serverStatus = await readServerStatus(
      fakeDeps(jsonCanned(200, { data: [{ name: "srv-a" }] })),
    );
    expect(serverStatus.ok).toBe(true);
    const prices = await listPackagePrices(
      fakeDeps(jsonCanned(200, { data: [{ id: "p-1", plan_price: 9 }] })),
    );
    expect(prices.ok).toBe(true);
    const integrations = await listIntegrations(
      fakeDeps(jsonCanned(200, { data: [{ id: "reseller-api", is_active: false }] })),
    );
    expect(integrations.ok).toBe(true);
    if (!integrations.ok) return;
    expect(integrations.data).toEqual([{ id: "reseller-api", active: false }]);
  });

  it("readLiveConnections parses sessions with paginated meta", async () => {
    const result = await readLiveConnections(
      fakeDeps(
        jsonCanned(200, {
          data: [
            {
              id: "sess-1",
              user_username: "user-1",
              max_connections: 2,
              reseller_username: "op",
              stream_display_name: "stream",
              user_agent: "agent",
              date_start_timestamp: 1727745600,
            },
          ],
          meta: META,
        }),
      ),
      { serverId: "srv-1", perPage: 1 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toHaveLength(1);
    expect(result.evidence.path).toContain("/api/customers/live-connections/srv-1");
  });
});

describe("readers: contract matrix (client + classification)", () => {
  async function codeFor(canned: Canned) {
    const result = await listServers(fakeDeps(canned));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    return result.error.code;
  }

  it("maps provider statuses to the canonical taxonomy", async () => {
    expect(await codeFor({ status: 401, contentType: "", bodyText: "" })).toBe("SESSION_EXPIRED");
    expect(
      await codeFor(jsonCanned(402, { error: "integration_inactive", expires_at: null })),
    ).toBe("INTEGRATION_INACTIVE");
    expect(await codeFor(jsonCanned(403, { message: "Proibido" }))).toBe("PERMISSION_DENIED");
    expect(
      await codeFor(
        htmlCanned(
          403,
          "Um momento…",
          "<html><head><title>Um momento…</title></head><body>cf-mitigated turnstile<form></form></body></html>",
        ),
      ),
    ).toBe("CHALLENGE");
    expect(await codeFor(htmlCanned(403, "Forbidden", "<html><body>deny</body></html>"))).toBe(
      "HTTP_FAILURE",
    );
    expect(
      await codeFor(
        htmlCanned(
          403,
          "Forbidden",
          '<html><head><script src="/cdn-cgi/challenge-platform/h/b/scripts.js"></script></head></html>',
        ),
      ),
    ).toBe("HTTP_FAILURE");
    expect(
      await codeFor({ status: 404, contentType: "text/html", bodyText: "<title>NOT_FOUND</title>" }),
    ).toBe("HTTP_FAILURE");
    expect(await codeFor({ status: 429, contentType: "", bodyText: "" })).toBe("RATE_LIMITED");
  });

  it("maps shape failures to BAD_RESPONSE", async () => {
    expect(
      await codeFor({ status: 200, contentType: "text/html", bodyText: "<html></html>" }),
    ).toBe("BAD_RESPONSE");
    expect(await codeFor({ status: 200, contentType: "application/json", bodyText: "{bad" })).toBe(
      "BAD_RESPONSE",
    );
    expect(await codeFor(jsonCanned(200, { data: [{ id: "s-1", name: 42 }] }))).toBe(
      "BAD_RESPONSE",
    );
  });

  it("maps invalid args to BAD_RESPONSE without throwing", async () => {
    const result = await readLiveConnections(fakeDeps(jsonCanned(200, {})), {
      serverId: "../../evil",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("BAD_RESPONSE");
  });

  it("maps evaluate rejection (closed page) to TRANSPORT", async () => {
    const broken: ReaderDeps = {
      page: {
        evaluate: async () => {
          throw new Error("context destroyed");
        },
      },
      allowedOrigin: ALLOWED,
    };
    const result = await listServers(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TRANSPORT");
  });

  it("never leaks tokens or passwords in results or evidence", async () => {
    const bodies = [
      jsonCanned(200, { data: [{ id: "s-1", secret: TOKEN, password: PASSWORD }] }),
      htmlCanned(403, "Um momento…", `<html><body>Um momento ${TOKEN}</body></html>`),
    ];
    for (const canned of bodies) {
      const result = await listServers(fakeDeps(canned));
      const line = JSON.stringify(result);
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(PASSWORD);
    }
  });
});
