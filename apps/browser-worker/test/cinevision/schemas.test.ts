import { describe, expect, it } from "vitest";
import {
  normalizeIsTrial,
  parseCustomer,
  parseCustomerPage,
  parseIdentity,
  parseIntegrationList,
  parseLiveConnectionPage,
  parsePackagePriceList,
  parseServerList,
  parseServerStatusList,
} from "../../src/providers/cinevision/schemas.js";

const META = { current_page: 1, last_page: 3, per_page: 25, total: 70 };

function customer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cust-1",
    user_id: "user-1",
    server_id: "srv-1",
    package_id: "pkg-1",
    status: "active",
    is_trial: "false",
    connections: 2,
    has_multiple_connections: true,
    expires_at: "2026-10-30T00:00:00Z",
    plan_price: 10,
    ...overrides,
  };
}

describe("normalizeIsTrial", () => {
  it("maps documented string values to boolean", () => {
    expect(normalizeIsTrial("true")).toBe(true);
    expect(normalizeIsTrial("false")).toBe(false);
  });

  it("maps the live-observed exact uppercase enum to boolean", () => {
    expect(normalizeIsTrial("YES")).toBe(true);
    expect(normalizeIsTrial("NO")).toBe(false);
  });

  it("fails closed on any other value (no silent coercion)", () => {
    for (const bad of [
      "1",
      "0",
      "TRUE",
      "yes",
      "no",
      "Yes",
      "yEs",
      "nO",
      "Y",
      "N",
      " YES",
      "YES ",
      " yes ",
      "YES\n",
      true,
      false,
      1,
      0,
      null,
      undefined,
      "",
    ]) {
      expect(() => normalizeIsTrial(bad), JSON.stringify(bad)).toThrowError();
    }
  });
});

describe("parseCustomer", () => {
  it("normalizes is_trial and rejects unknown fields", () => {
    const parsed = parseCustomer({ ...customer({ is_trial: "true" }) });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.isTrial).toBe(true);
    expect(parsed.value).toEqual({
      id: "cust-1",
      userId: "user-1",
      serverId: "srv-1",
      packageId: "pkg-1",
      status: "active",
      isTrial: true,
      connections: 2,
      hasMultipleConnections: true,
      expiresAt: "2026-10-30T00:00:00Z",
      planPrice: 10,
    });
    expect(parseCustomer({ ...customer(), injected: "x" }).ok).toBe(false);
  });

  it("normalizes the live-observed exact uppercase is_trial enum", () => {
    const yes = parseCustomer(customer({ is_trial: "YES" }));
    expect(yes.ok).toBe(true);
    if (!yes.ok) return;
    expect(yes.value.isTrial).toBe(true);
    const no = parseCustomer(customer({ is_trial: "NO" }));
    expect(no.ok).toBe(true);
    if (!no.ok) return;
    expect(no.value.isTrial).toBe(false);
  });

  it("fails on drift: missing id/status/is_trial or wrong types", () => {
    const base = customer();
    const noId: Record<string, unknown> = { ...base };
    delete noId["id"];
    expect(parseCustomer(noId).ok).toBe(false);
    const noStatus: Record<string, unknown> = { ...base };
    delete noStatus["status"];
    expect(parseCustomer(noStatus).ok).toBe(false);
    const noTrial: Record<string, unknown> = { ...base };
    delete noTrial["is_trial"];
    expect(parseCustomer(noTrial).ok).toBe(false);
    expect(parseCustomer(customer({ is_trial: "1" })).ok).toBe(false);
    expect(parseCustomer(customer({ connections: "2" })).ok).toBe(false);
    expect(parseCustomer(null).ok).toBe(false);
  });
});

describe("parseCustomerPage", () => {
  it("parses the Laravel-style envelope and requires meta", () => {
    const parsed = parseCustomerPage({ data: [customer()], links: {}, meta: META });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.items).toHaveLength(1);
    expect(parsed.value.meta).toEqual({ currentPage: 1, lastPage: 3, perPage: 25, total: 70 });
  });

  it("tolerates observed from/to explicitly but rejects unknown meta keys", () => {
    const tolerated = parseCustomerPage({
      data: [customer()],
      meta: { ...META, from: 1, to: 25 },
    });
    expect(tolerated.ok).toBe(true);
    const leaked = parseCustomerPage({ data: [customer()], meta: { ...META, token: "secret" } });
    expect(leaked.ok).toBe(false);
  });

  it("normalizes the observed uppercase is_trial mix across the page", () => {
    const parsed = parseCustomerPage({
      data: [customer({ id: "cust-a", is_trial: "YES" }), customer({ id: "cust-b", is_trial: "NO" })],
      meta: { ...META, total: 2 },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.items.map((item) => item.isTrial)).toEqual([true, false]);
  });

  it("fails when data is not an array or an item drifts", () => {
    expect(parseCustomerPage({ data: {}, meta: META }).ok).toBe(false);
    expect(parseCustomerPage({ data: [customer({ is_trial: "yes" })], meta: META }).ok).toBe(
      false,
    );
    expect(parseCustomerPage({ data: [] }).ok).toBe(false);
  });
});

describe("parseIdentity", () => {
  it("picks id/username/credits and rejects the session token", () => {
    const parsed = parseIdentity({ id: "u-1", username: "op", credits: 2 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ id: "u-1", username: "op", credits: 2 });
    expect(parseIdentity({ id: "u-1", username: "op", credits: 2, token: "secret" }).ok).toBe(
      false,
    );
  });

  it("fails on non-object bodies and empty objects", () => {
    expect(parseIdentity(null).ok).toBe(false);
    expect(parseIdentity([1]).ok).toBe(false);
    expect(parseIdentity({}).ok).toBe(false);
  });
});

describe("parseServerList / parseServerStatusList", () => {
  it("accepts entries with at least one observed field, rejects empties", () => {
    const parsed = parseServerList({ data: [{ id: "s-1" }, { name: "srv-b" }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual([
      { id: "s-1", name: null },
      { id: null, name: "srv-b" },
    ]);
    expect(parseServerList({ data: [{}] }).ok).toBe(false);
    expect(parseServerList({ data: [{ id: "s-1", injected: 1 }] }).ok).toBe(false);
  });

  it("requires observed name on status entries", () => {
    expect(parseServerStatusList({ data: [{ name: "srv-a" }] }).ok).toBe(true);
    expect(parseServerStatusList({ data: [{}] }).ok).toBe(false);
  });
});

describe("parsePackagePriceList / parseIntegrationList", () => {
  it("parses optional price fields with strict is_trial", () => {
    const parsed = parsePackagePriceList({
      data: [{ id: "p-1", plan_price: 9, is_trial: "false" }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value[0]).toMatchObject({ id: "p-1", planPrice: 9, isTrial: false });
    expect(parsePackagePriceList({ data: [{ is_trial: "1" }] }).ok).toBe(false);
    expect(parsePackagePriceList({ data: [{ id: "p-1", extra: 1 }] }).ok).toBe(false);
    expect(parsePackagePriceList({ data: [{}] }).ok).toBe(false);
  });

  it("shares the uppercase is_trial normalization with the customer parsers", () => {
    const parsed = parsePackagePriceList({
      data: [
        { id: "p-1", is_trial: "YES" },
        { id: "p-2", is_trial: "NO" },
        { id: "p-3", is_trial: "true" },
        { id: "p-4", is_trial: "false" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.map((entry) => entry.isTrial)).toEqual([true, false, true, false]);
    expect(parsePackagePriceList({ data: [{ id: "p-1", is_trial: "yes" }] }).ok).toBe(false);
  });

  it("parses integration summaries", () => {
    const parsed = parseIntegrationList({ data: [{ id: "reseller-api", is_active: false }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual([{ id: "reseller-api", active: false }]);
  });
});

describe("parseLiveConnectionPage", () => {
  function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "sess-1",
      user_username: "user-1",
      max_connections: 2,
      reseller_username: "op",
      stream_display_name: "stream",
      user_agent: "agent",
      date_start_timestamp: 1727745600,
      ...overrides,
    };
  }

  it("parses the observed session schema with paginated meta", () => {
    const parsed = parseLiveConnectionPage({ data: [item()], meta: META });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.items).toHaveLength(1);
    expect(parsed.value.meta.total).toBe(70);
  });

  it("fails on drift: missing or mistyped session fields", () => {
    const full = item();
    const noAgent: Record<string, unknown> = { ...full };
    delete noAgent["user_agent"];
    expect(parseLiveConnectionPage({ data: [noAgent], meta: META }).ok).toBe(false);
    expect(
      parseLiveConnectionPage({ data: [item({ max_connections: "2" })], meta: META }).ok,
    ).toBe(false);
  });
});
