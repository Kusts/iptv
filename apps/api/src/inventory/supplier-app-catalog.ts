/**
 * Wave 7 read-only slice: supplier app-catalog snapshot ingest + deterministic diff.
 *
 * Pure module (no I/O, no network, no credentials): generic ingest items are
 * normalized, hashed (order-insensitive) and diffed by `external_id`
 * (never by display name). Money is integer minor units with an explicit
 * currency per item — there is no hidden currency default.
 */

import { createHash } from "node:crypto";

export const SUPPLIER_APP_AVAILABILITY = ["AVAILABLE", "LIMITED", "UNAVAILABLE", "UNKNOWN"] as const;
export type SupplierAppAvailability = (typeof SUPPLIER_APP_AVAILABILITY)[number];

const CURRENCY_RE = /^[A-Z]{3}$/;

/** PostgreSQL signed BIGINT max: minor-unit values above this cannot persist. */
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;

/** Generic ingest shape accepted from any capture source (fixtures in tests). */
export interface SupplierAppIngestItem {
  externalId: string;
  name: string;
  annualPriceMinor?: string | number | bigint | null;
  lifetimePriceMinor?: string | number | bigint | null;
  currency: string;
  activationFlags?: Record<string, unknown> | null;
  mediaRefs?: unknown;
  availability?: string | null;
}

export interface NormalizedSupplierAppItem {
  externalId: string;
  name: string;
  annualPriceMinor: string | null;
  lifetimePriceMinor: string | null;
  currency: string;
  activationFlags: Record<string, unknown>;
  mediaRefs: unknown;
  availability: SupplierAppAvailability;
}

export interface CatalogDiffChangedField {
  field:
    | "name"
    | "annualPriceMinor"
    | "lifetimePriceMinor"
    | "currency"
    | "activationFlags"
    | "mediaRefs"
    | "availability";
  before: unknown;
  after: unknown;
}

export interface CatalogDiffChangedEntry {
  externalId: string;
  changes: CatalogDiffChangedField[];
}

export interface SupplierAppCatalogDiff {
  added: NormalizedSupplierAppItem[];
  removed: NormalizedSupplierAppItem[];
  changed: CatalogDiffChangedEntry[];
}

function toMinorOrNull(value: string | number | bigint | null | undefined, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    if (value < 0n || value > PG_BIGINT_MAX) {
      throw new Error(`${field} must be a non-negative integer minor-unit value within PostgreSQL BIGINT range`);
    }
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative integer minor-unit value`);
    }
    const asBigint = BigInt(value);
    if (asBigint > PG_BIGINT_MAX) {
      throw new Error(`${field} must be a non-negative integer minor-unit value within PostgreSQL BIGINT range`);
    }
    return asBigint.toString();
  }
  const text = value.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${field} must be a non-negative integer minor-unit value`);
  }
  const parsed = BigInt(text);
  if (parsed > PG_BIGINT_MAX) {
    throw new Error(`${field} must be a non-negative integer minor-unit value within PostgreSQL BIGINT range`);
  }
  return parsed.toString();
}

function normalizeAvailability(value: string | null | undefined): SupplierAppAvailability {
  if (value === null || value === undefined || value === "") {
    return "UNKNOWN";
  }
  const upper = value.trim().toUpperCase();
  if ((SUPPLIER_APP_AVAILABILITY as readonly string[]).includes(upper)) {
    return upper as SupplierAppAvailability;
  }
  throw new Error(`availability must be one of ${SUPPLIER_APP_AVAILABILITY.join("|")}, got ${JSON.stringify(value)}`);
}

/**
 * Normalize a value to its JSONB-persisted shape via a JSON round-trip — the
 * same serialization `node-pg` applies when writing `jsonb` columns.
 *
 * Policy (predictable, matches PostgreSQL `jsonb` semantics):
 * - `undefined` object properties are dropped; `undefined` array elements
 *   become `null` (exactly what `JSON.stringify` / `jsonb` do).
 * - Key order is irrelevant: hashing and diffing use `stableStringify`, so
 *   reordered keys never produce a false change.
 * - Circular structures and `bigint` values cannot serialize to JSON and are
 *   rejected with a validation error instead of being silently corrupted.
 * - Functions/symbols follow `JSON.stringify` semantics (dropped in objects,
 *   `null` in arrays) so the in-memory shape always equals the persisted one.
 */
function toJsonbCompatible(value: unknown, field: string): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    throw new Error(`${field} must be JSON-serializable: ${(err as Error).message}`);
  }
  if (text === undefined) {
    throw new Error(`${field} must be JSON-serializable (got non-JSON top-level value)`);
  }
  return JSON.parse(text) as unknown;
}

function normalizeActivationFlags(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const raw = value ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("activationFlags must be a JSON object");
  }
  const persisted = toJsonbCompatible(raw, "activationFlags");
  if (typeof persisted !== "object" || persisted === null || Array.isArray(persisted)) {
    throw new Error("activationFlags must be a JSON object");
  }
  return persisted as Record<string, unknown>;
}

function normalizeMediaRefs(value: unknown): unknown {
  return toJsonbCompatible(value ?? [], "mediaRefs");
}

export function normalizeIngestItem(item: SupplierAppIngestItem): NormalizedSupplierAppItem {
  const externalId = item.externalId?.trim() ?? "";
  if (externalId === "") {
    throw new Error("supplier app item requires a non-blank externalId");
  }
  const name = item.name?.trim() ?? "";
  if (name === "") {
    throw new Error(`supplier app item ${JSON.stringify(item.externalId)} requires a non-blank name`);
  }
  if (!CURRENCY_RE.test(item.currency ?? "")) {
    throw new Error(
      `supplier app item ${JSON.stringify(externalId)} requires an explicit 3-letter currency (no default)`,
    );
  }
  return {
    externalId,
    name,
    annualPriceMinor: toMinorOrNull(item.annualPriceMinor, "annualPriceMinor"),
    lifetimePriceMinor: toMinorOrNull(item.lifetimePriceMinor, "lifetimePriceMinor"),
    currency: item.currency,
    activationFlags: normalizeActivationFlags(item.activationFlags),
    mediaRefs: normalizeMediaRefs(item.mediaRefs),
    availability: normalizeAvailability(item.availability),
  };
}

/** Normalize + sort by external_id (identity key); duplicate external_ids reject. */
export function normalizeIngestItems(items: readonly SupplierAppIngestItem[]): NormalizedSupplierAppItem[] {
  const normalized = items.map(normalizeIngestItem);
  const seen = new Set<string>();
  for (const item of normalized) {
    if (seen.has(item.externalId)) {
      throw new Error(`duplicate supplier app external_id ${JSON.stringify(item.externalId)} in one capture`);
    }
    seen.add(item.externalId);
  }
  return [...normalized].sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Canonical payload hashed for idempotency (order-insensitive, name is data). */
export function canonicalCatalogPayload(items: readonly NormalizedSupplierAppItem[]): string {
  return stableStringify(
    items.map((item) => ({
      activationFlags: item.activationFlags,
      annualPriceMinor: item.annualPriceMinor,
      availability: item.availability,
      currency: item.currency,
      externalId: item.externalId,
      lifetimePriceMinor: item.lifetimePriceMinor,
      mediaRefs: item.mediaRefs,
      name: item.name,
    })),
  );
}

export function computeSourceHash(normalized: readonly NormalizedSupplierAppItem[]): string {
  return createHash("sha256").update(canonicalCatalogPayload(normalized), "utf8").digest("hex");
}

function sameJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export interface DiffScope {
  tenantId: string;
  supplierId: string;
}

/**
 * Deterministic diff between two snapshots of the SAME supplier in the SAME
 * tenant. Keyed by external_id only: equal display names never merge, and a
 * rename surfaces as a `name` change rather than add/remove.
 */
export function diffSupplierAppCatalogs(
  before: readonly NormalizedSupplierAppItem[],
  after: readonly NormalizedSupplierAppItem[],
  scope: { before: DiffScope; after: DiffScope },
): SupplierAppCatalogDiff {
  if (scope.before.tenantId !== scope.after.tenantId) {
    throw new Error("refusing cross-tenant catalog diff");
  }
  if (scope.before.supplierId !== scope.after.supplierId) {
    throw new Error("refusing cross-supplier catalog diff");
  }
  const beforeById = new Map(before.map((item) => [item.externalId, item]));
  const afterById = new Map(after.map((item) => [item.externalId, item]));

  const added: NormalizedSupplierAppItem[] = [];
  const removed: NormalizedSupplierAppItem[] = [];
  const changed: CatalogDiffChangedEntry[] = [];

  for (const item of after) {
    const prev = beforeById.get(item.externalId);
    if (prev === undefined) {
      added.push(item);
      continue;
    }
    const changes: CatalogDiffChangedField[] = [];
    if (prev.name !== item.name) {
      changes.push({ field: "name", before: prev.name, after: item.name });
    }
    if (prev.annualPriceMinor !== item.annualPriceMinor) {
      changes.push({ field: "annualPriceMinor", before: prev.annualPriceMinor, after: item.annualPriceMinor });
    }
    if (prev.lifetimePriceMinor !== item.lifetimePriceMinor) {
      changes.push({ field: "lifetimePriceMinor", before: prev.lifetimePriceMinor, after: item.lifetimePriceMinor });
    }
    if (prev.currency !== item.currency) {
      changes.push({ field: "currency", before: prev.currency, after: item.currency });
    }
    if (!sameJson(prev.activationFlags, item.activationFlags)) {
      changes.push({ field: "activationFlags", before: prev.activationFlags, after: item.activationFlags });
    }
    if (!sameJson(prev.mediaRefs, item.mediaRefs)) {
      changes.push({ field: "mediaRefs", before: prev.mediaRefs, after: item.mediaRefs });
    }
    if (prev.availability !== item.availability) {
      changes.push({ field: "availability", before: prev.availability, after: item.availability });
    }
    if (changes.length > 0) {
      changed.push({ externalId: item.externalId, changes });
    }
  }
  for (const item of before) {
    if (!afterById.has(item.externalId)) {
      removed.push(item);
    }
  }

  const byId = (a: NormalizedSupplierAppItem, b: NormalizedSupplierAppItem): number =>
    a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0;
  added.sort(byId);
  removed.sort(byId);
  changed.sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
  return { added, removed, changed };
}
