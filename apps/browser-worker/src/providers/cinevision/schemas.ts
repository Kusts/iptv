/**
 * Minimal strict validators for CINEVISION readback (FASE 1, reads only).
 *
 * Dependency note: Zod is not a dependency of `@iptv/browser-worker` and
 * adding it would require editing `package.json`, which is outside this
 * task's write scope. These validators enforce the same contract the Zod
 * schemas would: reject unknown root fields, require the observed minima,
 * and allow exactly one documented normalization — `is_trial:
 * "true"/"false"/"YES"/"NO"` (string) to boolean. Any other `is_trial`
 * value, including `"1"`, lowercase `"yes"` or a boolean, fails closed.
 * Reasons use fixed words (field names only).
 *
 * The in-page projection already strips unlisted fields, so these
 * validators are the second barrier on the projected shape.
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

class SchemaViolation extends Error {}

/** Reject unknown root keys (strict shape, fail closed). */
function rejectUnknown(
  record: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new SchemaViolation(`${key}: unexpected field`);
  }
  void what;
}

function reqString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new SchemaViolation(`${key}: expected string`);
  return value;
}

function optString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new SchemaViolation(`${key}: expected string|null`);
  return value;
}

function optNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SchemaViolation(`${key}: expected number|null`);
  }
  return value;
}

function optBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw new SchemaViolation(`${key}: expected boolean|null`);
  return value;
}

function reqNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SchemaViolation(`${key}: expected number`);
  }
  return value;
}

/**
 * Documented normalization: provider sends `is_trial` as a STRING.
 * Accepted exact representations: `"true"`/`"false"` (observed in the
 * 2026-09-30 investigation) and `"YES"`/`"NO"` (observed live on 2026-10-05 in
 * an authenticated GET of the customers list — the current panel serializes the
 * flag as an exact uppercase enum). Comparison is exact: no trimming, no case
 * folding, no `1`/`0`, no booleans; anything else fails closed.
 */
export function normalizeIsTrial(value: unknown): boolean {
  if (value === "true" || value === "YES") return true;
  if (value === "false" || value === "NO") return false;
  throw new SchemaViolation('is_trial: expected "true"|"false"|"YES"|"NO" string');
}

function optIsTrial(record: Record<string, unknown>): boolean | null {
  const value = record["is_trial"];
  if (value === null || value === undefined) return null;
  return normalizeIsTrial(value);
}

function reqIsTrial(record: Record<string, unknown>): boolean {
  return normalizeIsTrial(record["is_trial"]);
}

function asRecord(body: unknown, what: string): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new SchemaViolation(`${what}: expected object`);
  }
  return body as Record<string, unknown>;
}

function asArray(body: unknown, what: string): unknown[] {
  if (!Array.isArray(body)) throw new SchemaViolation(`${what}: expected array`);
  return body;
}

/** Observed Laravel envelope keys (`links` ignored, anything else fails). */
const ENVELOPE_FIELDS = ["data", "meta", "links"] as const;

function asEnvelope(body: unknown, what: string): Record<string, unknown> {
  const record = asRecord(body, what);
  rejectUnknown(record, ENVELOPE_FIELDS, what);
  return record;
}

/** Require at least one known field to hold a non-null value. */
function requireAny(record: Record<string, unknown>, keys: readonly string[], what: string): void {
  const empty = keys.every((key) => record[key] === null || record[key] === undefined);
  if (empty) throw new SchemaViolation(`${what}: expected fields`);
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** Sanitized identity snapshot (never includes the session token). */
export interface IdentityResult {
  id: string | null;
  username: string | null;
  credits: number | null;
}

const IDENTITY_FIELDS = ["id", "username", "credits"] as const;

export function parseIdentity(body: unknown): ParseResult<IdentityResult> {
  try {
    const record = asRecord(body, "identity");
    rejectUnknown(record, IDENTITY_FIELDS, "identity");
    const value = {
      id: optString(record, "id"),
      username: optString(record, "username"),
      credits: optNumber(record, "credits"),
    };
    if (value.id === null && value.username === null && value.credits === null) {
      throw new SchemaViolation("identity: expected fields");
    }
    return { ok: true, value };
  } catch (err) {
    return fail(err instanceof SchemaViolation ? err.message : "identity: invalid shape");
  }
}

/** Sanitized customer snapshot (PII-free subset needed for readback). */
export interface CustomerResult {
  id: string;
  userId: string | null;
  serverId: string | null;
  packageId: string | null;
  status: string;
  isTrial: boolean;
  connections: number | null;
  hasMultipleConnections: boolean | null;
  expiresAt: string | null;
  planPrice: number | null;
}

const CUSTOMER_FIELDS = [
  "id",
  "user_id",
  "server_id",
  "package_id",
  "status",
  "is_trial",
  "connections",
  "has_multiple_connections",
  "expires_at",
  "plan_price",
] as const;

export function parseCustomer(body: unknown): ParseResult<CustomerResult> {
  try {
    const record = asRecord(body, "customer");
    rejectUnknown(record, CUSTOMER_FIELDS, "customer");
    return {
      ok: true,
      value: {
        id: reqString(record, "id"),
        userId: optString(record, "user_id"),
        serverId: optString(record, "server_id"),
        packageId: optString(record, "package_id"),
        status: reqString(record, "status"),
        isTrial: reqIsTrial(record),
        connections: optNumber(record, "connections"),
        hasMultipleConnections: optBoolean(record, "has_multiple_connections"),
        expiresAt: optString(record, "expires_at"),
        planPrice: optNumber(record, "plan_price"),
      },
    };
  } catch (err) {
    return fail(err instanceof SchemaViolation ? err.message : "customer: invalid shape");
  }
}

export interface PageMeta {
  currentPage: number;
  lastPage: number;
  perPage: number;
  total: number;
}

function parsePageMeta(body: unknown): PageMeta {
  const record = asRecord(body, "meta");
  // Explicit allowlist: the four pagination counters are required.
  // `from`/`to` are observed live Laravel counters and are tolerated
  // explicitly (documented decision) — any other key fails closed.
  rejectUnknown(
    record,
    ["current_page", "last_page", "per_page", "total", "from", "to"],
    "meta",
  );
  return {
    currentPage: reqNumber(record, "current_page"),
    lastPage: reqNumber(record, "last_page"),
    perPage: reqNumber(record, "per_page"),
    total: reqNumber(record, "total"),
  };
}

export interface CustomerPage {
  items: CustomerResult[];
  meta: PageMeta;
}

/** Laravel-style envelope `{data: Customer[], meta}`; `links` ignored. */
export function parseCustomerPage(body: unknown): ParseResult<CustomerPage> {
  try {
    const record = asEnvelope(body, "customers");
    const items = asArray(record["data"], "customers.data").map((item) => {
      const parsed = parseCustomer(item);
      if (!parsed.ok) throw new SchemaViolation(parsed.reason);
      return parsed.value;
    });
    return { ok: true, value: { items, meta: parsePageMeta(record["meta"]) } };
  } catch (err) {
    return fail(err instanceof SchemaViolation ? err.message : "customers: invalid shape");
  }
}

/** Minimal server summary (observed minima: id and/or name). */
export interface ServerSummary {
  id: string | null;
  name: string | null;
}

const SERVER_FIELDS = ["id", "name"] as const;

export function parseServerList(body: unknown): ParseResult<ServerSummary[]> {
  try {
    const record = asEnvelope(body, "servers");
    return {
      ok: true,
      value: asArray(record["data"], "servers.data").map((item) => {
        const entry = asRecord(item, "servers.data[]");
        rejectUnknown(entry, SERVER_FIELDS, "servers.data[]");
        const value = { id: optString(entry, "id"), name: optString(entry, "name") };
        if (value.id === null && value.name === null) {
          throw new SchemaViolation("servers.data[]: expected fields");
        }
        return value;
      }),
    };
  } catch (err) {
    return fail(err instanceof SchemaViolation ? err.message : "servers: invalid shape");
  }
}

/** Server status entry (observed whitelist: `name` only). */
export interface ServerStatus {
  name: string;
}

const SERVER_STATUS_FIELDS = ["name"] as const;

export function parseServerStatusList(body: unknown): ParseResult<ServerStatus[]> {
  try {
    const record = asEnvelope(body, "servers.status");
    return {
      ok: true,
      value: asArray(record["data"], "servers.status.data").map((item) => {
        const entry = asRecord(item, "servers.status.data[]");
        rejectUnknown(entry, SERVER_STATUS_FIELDS, "servers.status.data[]");
        return { name: reqString(entry, "name") };
      }),
    };
  } catch (err) {
    return fail(err instanceof SchemaViolation ? err.message : "servers.status: invalid shape");
  }
}

/** Package price entry (historical fields; at least one must be present). */
export interface PackagePrice {
  id: string | null;
  serverId: string | null;
  name: string | null;
  status: string | null;
  isTrial: boolean | null;
  planPrice: number | null;
  credits: number | null;
  duration: number | null;
}

const PACKAGE_PRICE_FIELDS = [
  "id",
  "server_id",
  "name",
  "status",
  "is_trial",
  "plan_price",
  "credits",
  "duration",
] as const;

export function parsePackagePriceList(body: unknown): ParseResult<PackagePrice[]> {
  try {
    const record = asEnvelope(body, "packages.price");
    return {
      ok: true,
      value: asArray(record["data"], "packages.price.data").map((item) => {
        const entry = asRecord(item, "packages.price.data[]");
        rejectUnknown(entry, PACKAGE_PRICE_FIELDS, "packages.price.data[]");
        const value = {
          id: optString(entry, "id"),
          serverId: optString(entry, "server_id"),
          name: optString(entry, "name"),
          status: optString(entry, "status"),
          isTrial: optIsTrial(entry),
          planPrice: optNumber(entry, "plan_price"),
          credits: optNumber(entry, "credits"),
          duration: optNumber(entry, "duration"),
        };
        requireAny(entry, PACKAGE_PRICE_FIELDS, "packages.price.data[]");
        return value;
      }),
    };
  } catch (err) {
    return fail(err instanceof SchemaViolation ? err.message : "packages.price: invalid shape");
  }
}

/** Minimal integration summary (id + active flag only). */
export interface IntegrationSummary {
  id: string | null;
  active: boolean | null;
}

const INTEGRATION_FIELDS = ["id", "is_active"] as const;

export function parseIntegrationList(body: unknown): ParseResult<IntegrationSummary[]> {
  try {
    const record = asEnvelope(body, "integrations");
    return {
      ok: true,
      value: asArray(record["data"], "integrations.data").map((item) => {
        const entry = asRecord(item, "integrations.data[]");
        rejectUnknown(entry, INTEGRATION_FIELDS, "integrations.data[]");
        const value = { id: optString(entry, "id"), active: optBoolean(entry, "is_active") };
        if (value.id === null && value.active === null) {
          throw new SchemaViolation("integrations.data[]: expected fields");
        }
        return value;
      }),
    };
  } catch (err) {
    return fail(err instanceof SchemaViolation ? err.message : "integrations: invalid shape");
  }
}

/** Live session entry (observed sample schema; all fields required). */
export interface LiveConnection {
  id: string;
  userUsername: string;
  maxConnections: number;
  resellerUsername: string;
  streamDisplayName: string;
  userAgent: string;
  dateStartTimestamp: number;
}

const LIVE_CONNECTION_FIELDS = [
  "id",
  "user_username",
  "max_connections",
  "reseller_username",
  "stream_display_name",
  "user_agent",
  "date_start_timestamp",
] as const;

export function parseLiveConnection(item: unknown): ParseResult<LiveConnection> {
  try {
    const entry = asRecord(item, "live-connections.data[]");
    rejectUnknown(entry, LIVE_CONNECTION_FIELDS, "live-connections.data[]");
    return {
      ok: true,
      value: {
        id: reqString(entry, "id"),
        userUsername: reqString(entry, "user_username"),
        maxConnections: reqNumber(entry, "max_connections"),
        resellerUsername: reqString(entry, "reseller_username"),
        streamDisplayName: reqString(entry, "stream_display_name"),
        userAgent: reqString(entry, "user_agent"),
        dateStartTimestamp: reqNumber(entry, "date_start_timestamp"),
      },
    };
  } catch (err) {
    return fail(err instanceof SchemaViolation ? err.message : "live-connections: invalid shape");
  }
}

export interface LiveConnectionPage {
  items: LiveConnection[];
  meta: PageMeta;
}

export function parseLiveConnectionPage(body: unknown): ParseResult<LiveConnectionPage> {
  try {
    const record = asEnvelope(body, "live-connections");
    const items = asArray(record["data"], "live-connections.data").map((item) => {
      const parsed = parseLiveConnection(item);
      if (!parsed.ok) throw new SchemaViolation(parsed.reason);
      return parsed.value;
    });
    return { ok: true, value: { items, meta: parsePageMeta(record["meta"]) } };
  } catch (err) {
    return fail(err instanceof SchemaViolation ? err.message : "live-connections: invalid shape");
  }
}
