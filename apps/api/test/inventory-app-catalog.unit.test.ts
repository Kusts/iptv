import { describe, expect, it } from "vitest";
import {
  computeSourceHash,
  diffSupplierAppCatalogs,
  normalizeIngestItems,
  type SupplierAppIngestItem,
} from "../src/inventory/supplier-app-catalog.js";

const SCOPE = { before: { tenantId: "t-1", supplierId: "s-1" }, after: { tenantId: "t-1", supplierId: "s-1" } };

function item(overrides: Partial<SupplierAppIngestItem> & { externalId: string }): SupplierAppIngestItem {
  return {
    name: `App ${overrides.externalId}`,
    annualPriceMinor: "1990",
    lifetimePriceMinor: "5990",
    currency: "BRL",
    activationFlags: { trial: true },
    mediaRefs: [{ kind: "logo", ref: `img://${overrides.externalId}` }],
    availability: "AVAILABLE",
    ...overrides,
  };
}

describe("Wave 7 supplier app catalog (pure ingest + diff)", () => {
  it("hashes captures order-insensitively", () => {
    const a = normalizeIngestItems([item({ externalId: "a" }), item({ externalId: "b" })]);
    const b = normalizeIngestItems([item({ externalId: "b" }), item({ externalId: "a" })]);
    expect(computeSourceHash(a)).toBe(computeSourceHash(b));
  });

  it("keeps duplicate display names distinct by external_id", () => {
    const normalized = normalizeIngestItems([
      item({ externalId: "ext-1", name: "Same Name" }),
      item({ externalId: "ext-2", name: "Same Name" }),
    ]);
    expect(normalized.map((i) => i.externalId).sort()).toEqual(["ext-1", "ext-2"]);
    const diff = diffSupplierAppCatalogs(normalized, normalized, SCOPE);
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
  });

  it("rejects duplicate external_ids inside one capture", () => {
    expect(() => normalizeIngestItems([item({ externalId: "dup" }), item({ externalId: "dup" })])).toThrow(
      /duplicate supplier app external_id/,
    );
  });

  it("requires explicit currency and integer minor-unit prices (no hidden default)", () => {
    expect(() => normalizeIngestItems([item({ externalId: "x", currency: "" })])).toThrow(/explicit 3-letter/);
    expect(() =>
      normalizeIngestItems([{ externalId: "x", name: "X", annualPriceMinor: "19.90", currency: "BRL" }]),
    ).toThrow(/minor-unit/);
    expect(() =>
      normalizeIngestItems([{ externalId: "x", name: "X", annualPriceMinor: -5, currency: "BRL" }]),
    ).toThrow(/minor-unit/);
  });

  it("diffs added/removed without using name as the key", () => {
    const before = normalizeIngestItems([item({ externalId: "keep" }), item({ externalId: "gone" })]);
    const after = normalizeIngestItems([item({ externalId: "keep" }), item({ externalId: "new" })]);
    const diff = diffSupplierAppCatalogs(before, after, SCOPE);
    expect(diff.added.map((i) => i.externalId)).toEqual(["new"]);
    expect(diff.removed.map((i) => i.externalId)).toEqual(["gone"]);
    expect(diff.changed).toEqual([]);
  });

  it("reports price, flag, availability and media changes; a rename is a change", () => {
    const before = normalizeIngestItems([item({ externalId: "app-1" })]);
    const after = normalizeIngestItems([
      item({
        externalId: "app-1",
        name: "Renamed App",
        annualPriceMinor: "2490",
        lifetimePriceMinor: "5990",
        currency: "BRL",
        activationFlags: { trial: false },
        mediaRefs: [{ kind: "logo", ref: "img://app-1-v2" }],
        availability: "LIMITED",
      }),
    ]);
    const diff = diffSupplierAppCatalogs(before, after, SCOPE);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.externalId).toBe("app-1");
    expect(diff.changed[0]?.changes.map((c) => c.field).sort()).toEqual([
      "activationFlags",
      "annualPriceMinor",
      "availability",
      "mediaRefs",
      "name",
    ]);
  });

  it("ignores input order and emits deterministic ordering", () => {
    const before = normalizeIngestItems([item({ externalId: "b" }), item({ externalId: "a" })]);
    const after = normalizeIngestItems([item({ externalId: "c" }), item({ externalId: "a" })]);
    const flipped = diffSupplierAppCatalogs(
      normalizeIngestItems([item({ externalId: "a" }), item({ externalId: "b" })]),
      normalizeIngestItems([item({ externalId: "a" }), item({ externalId: "c" })]),
      SCOPE,
    );
    expect(diffSupplierAppCatalogs(before, after, SCOPE)).toEqual(flipped);
  });

  it("refuses cross-tenant and cross-supplier comparisons", () => {
    const before = normalizeIngestItems([item({ externalId: "a" })]);
    const after = normalizeIngestItems([item({ externalId: "a" })]);
    expect(() =>
      diffSupplierAppCatalogs(before, after, {
        before: { tenantId: "t-1", supplierId: "s-1" },
        after: { tenantId: "t-2", supplierId: "s-1" },
      }),
    ).toThrow(/cross-tenant/);
    expect(() =>
      diffSupplierAppCatalogs(before, after, {
        before: { tenantId: "t-1", supplierId: "s-1" },
        after: { tenantId: "t-1", supplierId: "s-2" },
      }),
    ).toThrow(/cross-supplier/);
  });

  it("rejects unsafe numbers and values above PostgreSQL BIGINT max for both price fields", () => {
    const PG_MAX = "9223372036854775807";
    const PG_OVER = "9223372036854775808";
    for (const field of ["annualPriceMinor", "lifetimePriceMinor"] as const) {
      // Unsafe JS number (beyond MAX_SAFE_INTEGER) rejects even when integral.
      expect(() => normalizeIngestItems([item({ externalId: "x", [field]: Number.MAX_SAFE_INTEGER + 1 })])).toThrow(
        /minor-unit/,
      );
      // PG BIGINT max accepted as string and bigint.
      expect(() =>
        normalizeIngestItems([item({ externalId: "x", [field]: PG_MAX })]),
      ).not.toThrow();
      expect(() =>
        normalizeIngestItems([item({ externalId: "x", [field]: 9_223_372_036_854_775_807n })]),
      ).not.toThrow();
      // Just above PG BIGINT max rejects in every accepted input type.
      expect(() => normalizeIngestItems([item({ externalId: "x", [field]: PG_OVER })])).toThrow(/BIGINT/);
      expect(() => normalizeIngestItems([item({ externalId: "x", [field]: 9_223_372_036_854_775_808n })])).toThrow(
        /BIGINT/,
      );
    }
  });

  it("canonicalizes JSON like JSONB: undefined props dropped, key order ignored", () => {
    const left = normalizeIngestItems([
      item({ externalId: "a", activationFlags: { x: 1, dropped: undefined }, mediaRefs: [{ b: 2, a: 1 }] }),
    ]);
    const right = normalizeIngestItems([
      item({ externalId: "a", activationFlags: { x: 1 }, mediaRefs: [{ a: 1, b: 2 }] }),
    ]);
    expect(computeSourceHash(left)).toBe(computeSourceHash(right));
    expect(diffSupplierAppCatalogs(left, right, SCOPE)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("rejects non-JSON/circular JSON fields with a predictable error", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => normalizeIngestItems([item({ externalId: "x", activationFlags: circular })])).toThrow(
      /JSON-serializable/,
    );
    expect(() =>
      normalizeIngestItems([item({ externalId: "x", activationFlags: { price: 10n } })]),
    ).toThrow(/JSON-serializable/);
    const circularMedia: unknown[] = [];
    circularMedia.push(circularMedia);
    expect(() => normalizeIngestItems([item({ externalId: "x", mediaRefs: circularMedia })])).toThrow(
      /JSON-serializable/,
    );
  });

  it("does not false-positive after a JSONB round-trip (persisted shape)", () => {
    const normalized = normalizeIngestItems([item({ externalId: "a" })]);
    const roundTripped = JSON.parse(JSON.stringify(normalized)) as typeof normalized;
    expect(diffSupplierAppCatalogs(normalized, roundTripped, SCOPE)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    expect(computeSourceHash(normalized)).toBe(computeSourceHash(roundTripped));
  });

  it("rejects serialized non-object activationFlags (Date or scalar toJSON)", () => {
    expect(() =>
      normalizeIngestItems([
        item({ externalId: "x", activationFlags: new Date("2026-01-01T00:00:00Z") as unknown as Record<string, unknown> }),
      ]),
    ).toThrow(/JSON object/);
    expect(() =>
      normalizeIngestItems([
        item({
          externalId: "x",
          activationFlags: { toJSON: () => "scalar" } as unknown as Record<string, unknown>,
        }),
      ]),
    ).toThrow(/JSON object/);
    expect(() =>
      normalizeIngestItems([
        item({
          externalId: "x",
          activationFlags: { toJSON: () => [1, 2] } as unknown as Record<string, unknown>,
        }),
      ]),
    ).toThrow(/JSON object/);
    expect(() =>
      normalizeIngestItems([
        item({
          externalId: "x",
          activationFlags: { toJSON: () => null } as unknown as Record<string, unknown>,
        }),
      ]),
    ).toThrow(/JSON object/);
  });

  it("accepts custom toJSON activationFlags that serialize to a record", () => {
    const normalized = normalizeIngestItems([
      item({
        externalId: "x",
        activationFlags: { toJSON: () => ({ trial: true }) } as unknown as Record<string, unknown>,
      }),
    ]);
    expect(normalized[0]?.activationFlags).toEqual({ trial: true });
  });
});
