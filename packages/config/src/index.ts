import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().min(1).optional(),
  // RLS application-role connection. Kept byte-exact (see `blankToUndefined`)
  // and used ONLY by the production boot guard/validation below — the actual
  // pool string is resolved by `resolveAppConnectionString` in the API, which
  // reads env itself, so this field never selects a connection.
  APP_DATABASE_URL: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Session-token pepper (owns `control.auth_sessions.token_hash`).
  // Dev-only default so tests/boot work without env; override in production.
  BETTER_AUTH_SECRET: z
    .string()
    .min(16)
    .default("dev-only-better-auth-secret-0123456789"),
  BETTER_AUTH_URL: z.string().min(1).optional(),
  // W1-08 worker infrastructure: in-process scheduler is opt-in
  // (`API_SCHEDULER_ENABLED=1`); default off so boot never starts
  // background work unless the operator asks for it.
  API_SCHEDULER_ENABLED: z.enum(["0", "1"]).default("0"),
  API_SCHEDULER_TICK_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  // W1-08 Hatchet adapter (Wave-0-gated): only read when set; absence
  // means the local in-process adapter (explicitly non-durable).
  HATCHET_API_TOKEN: z.string().min(1).optional(),
  HATCHET_SERVER_URL: z.string().min(1).optional(),
  // W1-12 observability: OTLP export only when an endpoint is set;
  // otherwise the SDK stays unconstructed (zero-overhead noop path).
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1).optional(),
  OTEL_SDK_DISABLED: z.enum(["true", "false"]).default("true"),
  // MVP-INFISICAL-02 secrets adapter (ADR-0014): env-gated — absence means
  // the Noop port (boot never crashes); all four connection vars must be
  // present for the real adapter. ENVIRONMENT defaults to "development".
  INFISICAL_SITE_URL: z.string().min(1).optional(),
  INFISICAL_PROJECT_ID: z.string().min(1).optional(),
  INFISICAL_CLIENT_ID: z.string().min(1).optional(),
  INFISICAL_CLIENT_SECRET: z.string().min(1).optional(),
  INFISICAL_ENVIRONMENT: z.string().min(1).default("development"),
  // Browser CORS allowlist (explicit origins only — never a wildcard).
  // Comma-separated `scheme://host[:port]` entries with no path/query/hash.
  // Unset means: local default (`http://localhost:3000`) outside
  // production, empty allowlist (deny all cross-origin) in production.
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  // FASE5-S4S5: designated disposable provider account for controlled
  // CREATE_TRIAL writes only. Absent by default (no designation =
  // fail-closed for real trial dispatches); when the per-action
  // `provider.cinevision.trial` gate is AVAILABLE it must name an ACTIVE
  // provider account of the trial's tenant, and the trial dispatch must
  // target exactly that account. Never a secret value — just the account id.
  PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID: z.string().uuid().optional(),
});

export type AppConfig = Omit<z.infer<typeof envSchema>, "CORS_ALLOWED_ORIGINS"> & {
  /** Explicit browser CORS allowlist (origin strings, never a wildcard). */
  CORS_ALLOWED_ORIGINS: string[];
};

/** Local web default so `localhost:3000` → API works out of the box. */
export const DEFAULT_LOCAL_CORS_ORIGIN = "http://localhost:3000";

/** True when `entry` is a bare `scheme://host[:port]` origin (no path/query/hash/wildcard). */
export function isValidCorsOrigin(entry: string): boolean {
  if (entry.includes("*")) return false;
  if (!/^https?:\/\//i.test(entry)) return false;
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.hash !== "" || url.search !== "") return false;
  if (url.pathname !== "/" && url.pathname !== "") return false;
  if (url.host === "") return false;
  // Reject any path beyond the bare root (a trailing "/" normalizes to the origin).
  return entry === url.origin || entry === `${url.origin}/`;
}

/**
 * Parse the comma-separated `CORS_ALLOWED_ORIGINS` env value into an exact
 * origin allowlist. Trims entries, drops empties, dedupes, and normalizes a
 * trailing root "/" to the bare origin. Unset/empty means the local default
 * outside production and deny-all (`[]`) in production. Throws on any
 * wildcard or invalid origin.
 */
export function parseCorsAllowedOrigins(raw: string | undefined, nodeEnv: string): string[] {
  if (raw === undefined || raw.trim() === "") {
    return nodeEnv === "production" ? [] : [DEFAULT_LOCAL_CORS_ORIGIN];
  }
  const entries = raw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (entries.length === 0) {
    return nodeEnv === "production" ? [] : [DEFAULT_LOCAL_CORS_ORIGIN];
  }
  const normalized: string[] = [];
  for (const entry of entries) {
    if (!isValidCorsOrigin(entry)) {
      throw new Error(
        `invalid environment configuration: CORS_ALLOWED_ORIGINS contains invalid origin ${JSON.stringify(entry)} (expected comma-separated scheme+host origins like "https://app.example.com", no path/query/hash, no wildcards)`,
      );
    }
    const canonical = new URL(entry).origin;
    if (!normalized.includes(canonical)) {
      normalized.push(canonical);
    }
  }
  return normalized;
}

/** Treat empty-string env values as absent so `.min(1).optional()` fields accept shipped placeholders. */
function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Same blank-means-absent rule as `emptyToUndefined`, but the non-blank value is
 * returned VERBATIM (never trimmed). Used for connection strings: trimming one
 * would rewrite a credential in every environment, so padding is preserved here
 * and rejected — not repaired — by the production boot guard.
 */
function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim().length > 0 ? value : undefined;
}

/**
 * CV-DSP-01 production fail-fast: the leased durable dispatcher is the only
 * certified executor for real provider writes, so a production boot must set
 * this EXACTLY (no trimming, no case folding) instead of relying on the
 * historical inline fallback of `providerDispatchModeFromEnv`. Outside
 * production this key is validated nowhere and every value keeps the inline
 * fallback — the resolver itself is unchanged.
 */
const PRODUCTION_PROVIDER_DISPATCH_MODE = "durable";

/** Human-readable echo of the seen value for the boot error (a non-secret enum-like flag). */
function describeEnvValue(value: string | undefined): string {
  return value === undefined || value.trim() === "" ? "unset" : JSON.stringify(value);
}

/** True when an env var carries any non-blank value (empty means absent, per the repo rule). */
function hasEnvValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/**
 * True when a driver-consumed env var is supplied at all: only the empty string
 * counts as absent, so whitespace-only is treated as a real (and therefore
 * refused) setting rather than as an unset one.
 */
function isSuppliedEnvValue(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/**
 * Owner/superuser/disposable-test connection vars and credentials that must
 * never live in the API process: owner roles bypass RLS and belong to the
 * migration/DDL job, and a test database is never a production target. Read
 * straight from env (like `PROVIDER_DISPATCH_MODE`) so `AppConfig` keeps no
 * privileged credential and development/test behavior stays untouched.
 */
/**
 * Owner/superuser/disposable-test connection aliases: these are NOT read by the
 * driver as environment variables, so they follow the repo rule that a blank
 * value counts as absent. Read straight from env (like
 * `PROVIDER_DISPATCH_MODE`) so `AppConfig` keeps no owner credential and
 * development/test behavior stays untouched.
 */
const OWNER_ALIAS_ENV_VARS = [
  "DATABASE_URL",
  "DATABASE_OWNER_URL",
  "TEST_DATABASE_URL",
  "POSTGRES_PASSWORD",
] as const;

/**
 * Environment variables the pg driver itself consumes (libpq-compatible
 * target/transport/credential/startup knobs). Presence is judged on the RAW
 * value: anything other than an empty string is refused, whitespace included,
 * because a whitespace value is a supplied setting just as much as a real one.
 * An empty string is absent.
 */
const DRIVER_CONSUMED_ENV_VARS = [
  "PGPASSWORD",
  // Feeds driver startup `options` from OUTSIDE the URI, which is exactly the
  // unverified role-change vector the query-parameter rule closes.
  "PGOPTIONS",
  // Ambient target/transport variables: leaving any of them in the API env would
  // let the connection target or TLS mode be derived outside the validated URI.
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGSSLMODE",
  "PGSSLNEGOTIATION",
] as const;

/** The one role name a production API pool may connect as. */
export const PRODUCTION_DB_USERNAME = "iptv_app";

/** Schemes that can actually reach the PostgreSQL server (`pg` accepts all three). */
const POSTGRES_SCHEMES = new Set(["pg:", "postgres:", "postgresql:"]);

/**
 * Query keys refused in a production API URL (compared lower-cased).
 * - `user` is the driver identity override: it replaces the authority username
 *   at connect time.
 * - `options` is forwarded to server startup as command-line options, so it can
 *   request a role change (e.g. `-c role=owner`); whether that succeeds depends
 *   on server-side role membership/privileges, which this guard does NOT verify.
 * - `role` is denied BY POLICY: no current-driver behavior is claimed for it,
 *   but no production URL needs it and denying it removes an entire class of
 *   identity-shaped parameters.
 * - `host`, `port`, `database`, `db` and `dbname` would override the target the
 *   URI already states, so the connection could land somewhere the guard never
 *   inspected.
 * Ordinary settings (`sslmode`, `application_name`, `connect_timeout`, …) stay
 * legal.
 */
const SESSION_IDENTITY_QUERY_KEYS = new Set([
  "user",
  "role",
  "options",
  "host",
  "port",
  "database",
  "db",
  "dbname",
]);

 /**
 * True when the value contains a literal ASCII control character (NUL, tab, LF,
 * CR, VT, FF … DEL). Implemented by char code rather than a regex literal so the
 * check stays explicit and lint-clean.
 */
function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** True when a `%` is not followed by two hex digits (a malformed escape). */
function hasMalformedPercentEscape(component: string): boolean {
  for (let index = 0; index < component.length; index += 1) {
    if (component.charAt(index) !== "%") continue;
    const hex = component.slice(index + 1, index + 3);
    const isHexPair =
      hex.length === 2 && /^[0-9A-Fa-f]{2}$/.test(hex);
    if (!isHexPair) return true;
  }
  return false;
}

/**
 * Static, credential-free reason why a still-percent-encoded URI component is
 * unsafe, or `null`. WHATWG `URL` keeps `%00`/`%09` encoded in `username`,
 * `password` and the raw query, and `URLSearchParams` decodes them into REAL
 * control characters — so both the escape well-formedness and the decoded
 * content are checked here, before any driver can act on them.
 */
function uriComponentFailure(component: string): string | null {
  if (hasMalformedPercentEscape(component)) {
    return "must not contain malformed percent escapes";
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(component);
  } catch {
    return "must not contain malformed percent escapes";
  }
  if (hasAsciiControlCharacter(decoded)) {
    return "must not contain percent-encoded ASCII control characters (they decode to a real NUL/tab/newline that could smuggle a different connection string)";
  }
  return null;
}

/** The exact values documented for the `sslnegotiation` connection parameter. */
const SSL_NEGOTIATION_VALUES = new Set(["postgres", "direct"]);

/**
 * Exact documented values of the `ssl` parameter for the INSTALLED pg parser.
 * `ssl=false` is deliberately NOT accepted: the parser leaves it as the
 * non-empty string "false", which is truthy, so it does not disable TLS the way
 * an operator expects. Direct operators to `ssl=0` or `sslmode=disable`.
 */
const SSL_VALUES = new Set(["true", "1", "0"]);

/**
 * Only `verify-ca` under libpq-compat needs an explicit CA bundle here: the
 * installed pg parser throws for that combination without `sslrootcert`.
 * `verify-full` is NOT covered — per the node-postgres documentation it uses `{}`
 * (system CA plus identity verification), so it stays legal without a custom
 * root certificate and this guard must not claim otherwise.
 */
const SSLMODE_REQUIRING_ROOT_CERT = "verify-ca";

/** Exact documented values of the `uselibpqcompat` connection parameter. */
const USE_LIBPQ_COMPAT_VALUES = new Set(["true", "false"]);

/** `sslmode` values valid in every configuration. */
const SSLMODE_COMMON_VALUES = new Set([
  "disable",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
]);

/** `allow` is a libpq-compat-only mode; `pg` rejects it without `uselibpqcompat`. */
const SSLMODE_LIBPQ_COMPAT_ONLY = new Set(["allow"]);

/** `no-verify` is the pg-native mode and is rejected under `uselibpqcompat`. */
const SSLMODE_PG_ONLY = new Set(["no-verify"]);

/**
 * Reason why a query parameter NAME is percent-encoded in the raw URI, or
 * `null`. Names must be literal so the driver and this validator read the same
 * setting; percent-encoding is for VALUES only.
 *
 * Checked on the RAW URI because `URLSearchParams` hands back decoded keys. Only
 * well-formed escapes count here — a malformed escape is reported by the
 * component screen instead.
 */
function percentEncodedQueryKeyFailure(raw: string): string | null {
  const queryStart = raw.indexOf("?");
  if (queryStart === -1) return null;
  const query = raw.slice(queryStart + 1).split("#")[0] ?? "";
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const equals = pair.indexOf("=");
    const rawKey = equals === -1 ? pair : pair.slice(0, equals);
    if (/%[0-9A-Fa-f]{2}/.test(rawKey)) {
      return "must not percent-encode a connection-query parameter NAME (write the parameter name literally and lowercase, e.g. `sslmode`, so the driver and this validator see the same setting; percent-encoding is for values only)";
    }
  }
  return null;
}

/**
 * Reason why the raw query string repeats a parameter name (compared
 * case-insensitively after percent-decoding), or `null`.
 *
 * Checked on the RAW URI before `new URL`: `pg-connection-string` assigns query
 * parameters onto an object, so a repeated key keeps the LAST value written —
 * the effective setting would then depend on parameter order rather than on what
 * a reader sees. The reason names no key and no value.
 */
function duplicateQueryKeyFailure(raw: string): string | null {
  const queryStart = raw.indexOf("?");
  if (queryStart === -1) return null;
  const query = raw.slice(queryStart + 1).split("#")[0] ?? "";
  const seen = new Set<string>();
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const equals = pair.indexOf("=");
    const rawKey = equals === -1 ? pair : pair.slice(0, equals);
    let key: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    } catch {
      // A malformed escape is reported by the component screen; use the raw
      // spelling here only so a duplicate is still caught.
      key = rawKey;
    }
    const normalized = key.trim().toLowerCase();
    if (normalized === "") continue;
    if (seen.has(normalized)) {
      return "must not repeat a query parameter (pg-connection-string assigns parameters onto an object, so a repeated key keeps only the last value and the effective setting would depend on parameter order)";
    }
    seen.add(normalized);
  }
  return null;
}

/**
 * Reason why the (duplicate-free) SSL-related query settings are ambiguous or
 * unsupported, or `null`. Values are never interpolated into the reason.
 * TLS is NOT required globally — that is deployment-specific; only invalid,
 * duplicated or conflicting settings are refused.
 */
function sslSettingsFailure(params: ReadonlyMap<string, string>): string | null {
  const ssl = params.get("ssl");
  if (ssl !== undefined && !SSL_VALUES.has(ssl)) {
    return ssl === "false"
      ? "must not set `ssl=false` (the installed pg parser leaves it as a non-empty string, which is truthy, so it does not disable TLS); use `ssl=0` or `sslmode=disable` to disable TLS explicitly"
      : "must set `ssl` to exactly one of: true, 1, 0";
  }
  const useLibpqCompat = params.get("uselibpqcompat");
  if (useLibpqCompat !== undefined && !USE_LIBPQ_COMPAT_VALUES.has(useLibpqCompat)) {
    return "must set `uselibpqcompat` to exactly true or false";
  }
  const sslmode = params.get("sslmode");
  if (sslmode !== undefined) {
    const libpqCompat = useLibpqCompat === "true";
    const accepted =
      SSLMODE_COMMON_VALUES.has(sslmode) ||
      (libpqCompat && SSLMODE_LIBPQ_COMPAT_ONLY.has(sslmode)) ||
      (!libpqCompat && SSLMODE_PG_ONLY.has(sslmode));
    if (!accepted) {
      return libpqCompat
        ? "must set `sslmode` to one of: disable, prefer, require, verify-ca, verify-full, allow (with uselibpqcompat=true, allow is available and no-verify is not)"
        : "must set `sslmode` to one of: disable, prefer, require, verify-ca, verify-full, no-verify (allow requires uselibpqcompat=true)";
    }
  }
  if (ssl !== undefined && sslmode !== undefined) {
    return "must not set both `ssl` and `sslmode` (their precedence against each other is ambiguous)";
  }
  // libpq-compat `verify-ca` throws in the installed parser without a CA bundle.
  // Only the PARAMETER is checked here: whether the file exists, is readable by
  // the server and actually chains to the certificate is a server-side fact this
  // boot guard does not and cannot verify.
  if (
    useLibpqCompat === "true" &&
    sslmode === SSLMODE_REQUIRING_ROOT_CERT &&
    !hasEnvValue(params.get("sslrootcert"))
  ) {
    return "must carry a non-blank `sslrootcert` value together with `sslmode=verify-ca` under uselibpqcompat=true (the parameter must be present; this guard does not verify that the certificate file is readable or valid on the server)";
  }
  const tlsExplicitlyDisabled = sslmode === "disable" || ssl === "false" || ssl === "0";
  const hasCertificateSetting = ["sslcert", "sslkey", "sslrootcert"].some((key) => {
    const value = params.get(key);
    // The installed parser treats any non-empty certificate path as TLS
    // configuration, including a whitespace-only decoded value.
    return value !== undefined && value.length > 0;
  });
  if (tlsExplicitlyDisabled && hasCertificateSetting) {
    return "must not combine explicit TLS disable (`ssl=0` or `sslmode=disable`) with `sslcert`, `sslkey` or `sslrootcert` (certificate settings can override `ssl=0`; with `sslmode=disable` the combination remains conflicting and may still trigger certificate-file handling)";
  }
  if (tlsExplicitlyDisabled && params.get("sslnegotiation") === "direct") {
    return "must not set `sslnegotiation=direct` while TLS is explicitly disabled (`sslmode=disable`, or `ssl=false`/`ssl=0`)";
  }
  return null;
}

/**
 * Credential-free reason why `raw` is not an acceptable production application
 * connection, or `null` when it is acceptable. The value itself is NEVER
 * interpolated into the reason — only the variable name and the rule are
 * reported.
 */
function productionAppDatabaseUrlFailure(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") {
    return "must be set and non-blank";
  }
  // Checked BEFORE the padding test and BEFORE URL parsing: WHATWG `new URL`
  // silently strips tab/LF/CR, so an embedded control character (a classic
  // smuggling vector) would otherwise vanish before any check could see it —
  // including when it is trailing, which the padding rule would also catch.
  if (hasAsciiControlCharacter(raw)) {
    return "must not contain ASCII control characters (tab, newline or carriage return would be stripped by URL parsing and can smuggle a different connection string)";
  }
  // `blankToUndefined`/the resolver keep the value byte-exact, so padding is
  // visible here. A credential is never silently trimmed: a padded value is a
  // configuration error to report, not something to repair at boot.
  if (raw !== raw.trim()) {
    return "must not have leading or trailing whitespace";
  }
  // A literal space anywhere is refused: the node-postgres docs require the URI
  // user/password to be URL-encoded, and the installed parser REWRITES the URI
  // when a literal space is present — which can make the driver's view of a
  // percent-encoded query key differ from the WHATWG-validated one.
  if (raw.includes(" ")) {
    return "must not contain a literal space (percent-encode it as %20 — the installed driver rewrites a URI that contains one, so a space in the password or in a parameter would be read differently by the driver than by this validator)";
  }
  // Before URL parsing: `pg-connection-string` assigns query parameters onto an
  // object, so a repeated key is LAST-VALUE-WINS — the effective setting would
  // depend on parameter order instead of what a reader sees.
  const duplicateKey = duplicateQueryKeyFailure(raw);
  if (duplicateKey !== null) {
    return duplicateKey;
  }
  const encodedKey = percentEncodedQueryKeyFailure(raw);
  if (encodedKey !== null) {
    return encodedKey;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be a parseable PostgreSQL connection URI";
  }
  if (!POSTGRES_SCHEMES.has(url.protocol)) {
    return "must use a PostgreSQL scheme (pg://, postgres:// or postgresql://)";
  }
  // The target must be stated IN the URI: an empty host or an empty path
  // database name would otherwise leave node-postgres free to fall back to
  // PGHOST/PGDATABASE (or the libpq default), connecting somewhere this guard
  // never inspected.
  if (url.hostname === "") {
    return "must carry an explicit host in the URI authority (an empty host would let the driver fall back to ambient PGHOST/defaults)";
  }
  if (url.pathname === "" || url.pathname === "/") {
    return "must carry an explicit database name in the URI path (an empty path would let the driver fall back to ambient PGDATABASE/defaults)";
  }
  // Component-level checks BEFORE the username comparison, so a smuggled
  // control character is reported as such instead of as a username mismatch.
  // `url.hostname`/`url.search`/`url.pathname` are still percent-encoded here,
  // so they cover the target host, every query key/value and the database name
  // exactly as authored; decoded forms are checked below too.
  for (const [label, component] of [
    ["URI username", url.username],
    ["URI password", url.password],
    ["URI hostname", url.hostname],
    ["URI query string", url.search],
    ["URI database path", url.pathname],
  ] as const) {
    const componentFailure = uriComponentFailure(component);
    if (componentFailure !== null) {
      return `must not have an unsafe ${label}: it ${componentFailure}`;
    }
  }
  // A fragment is not part of the PostgreSQL connection contract, so it is
  // refused rather than parsed, interpreted or silently dropped downstream.
  // The RAW delimiter is checked (fail-closed) so even a bare trailing `#`,
  // whose `url.hash` is empty, is refused. An encoded `%23` inside a component
  // is NOT a delimiter and stays ordinary encoded data — it is only refused if
  // it decodes to an ASCII control character, which the component screen above
  // already covers.
  if (raw.includes("#")) {
    return "must not contain a URI fragment delimiter (a fragment is not part of the PostgreSQL connection contract; percent-encoded %23 inside a component is ordinary encoded data and stays legal)";
  }
  for (const key of url.searchParams.keys()) {
    if (hasAsciiControlCharacter(key)) {
      return "must not have a query parameter whose decoded key contains an ASCII control character";
    }
  }
  for (const value of url.searchParams.values()) {
    if (hasAsciiControlCharacter(value)) {
      return "must not have a query parameter whose decoded value contains an ASCII control character";
    }
  }
  // Compared as the canonical literal: percent-encoded (`iptv%5Fapp`) and
  // case-variant (`IPTV_APP`) spellings are rejected in favor of one exact
  // production identity, with no claim about how the driver would resolve them.
  if (url.username !== PRODUCTION_DB_USERNAME) {
    return `must carry exactly "${PRODUCTION_DB_USERNAME}" as the URI authority username (the restricted application role; any other role name — including an owner or superuser — is refused)`;
  }
  // Per the node-postgres connection-string reference: `user` is the driver
  // identity override (it replaces the authority username at connect time) and
  // `options` is forwarded to server startup as command-line options, so it can
  // request a role change; whether that succeeds depends on server-side role
  // membership/privileges, which this guard does NOT verify. `role` is denied
  // BY POLICY — no current-driver behavior is claimed for it, and no production
  // URL needs it. All three are refused case-insensitively; ordinary connection
  // settings (sslmode, application_name, connect_timeout, …) stay legal.
  for (const key of url.searchParams.keys()) {
    if (SESSION_IDENTITY_QUERY_KEYS.has(key.toLowerCase())) {
      return `must not carry a \`${key.toLowerCase()}\` query parameter (it changes the effective session identity or configuration at connect time; only ordinary settings such as sslmode/application_name/connect_timeout are allowed)`;
    }
  }
  // Canonical lowercase keys only. The driver consumes lowercase connection
  // parameters, so `SSLMODE=…`/`SslMode=…` would be read as an unknown setting
  // and silently change behavior (a no-TLS fallback rather than the intended
  // mode). Percent-encoded NAMES were already refused pre-parse, above; values
  // may remain percent-encoded. Forbidden keys stay rejected case-insensitively.
  for (const key of url.searchParams.keys()) {
    if (key !== key.toLowerCase()) {
      return "must use canonical lowercase connection-query keys (the driver consumes lowercase parameters; a mixed/upper-case key would be ignored and silently change the connection settings)";
    }
  }
  // `sslnegotiation` is echoed back by the driver/server, so only the two
  // documented exact values are accepted; the seen value is never printed.
  // Repeats are already refused above, so this map has one entry per key.
  const params = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    params.set(key.toLowerCase(), value);
  }
  if (params.has("sslnegotiation") && !SSL_NEGOTIATION_VALUES.has(params.get("sslnegotiation") ?? "")) {
    return 'must set `sslnegotiation` to exactly "postgres" or "direct"';
  }
  return sslSettingsFailure(params);
}

/**
 * Validate a production API connection string and return it BYTE-EXACT.
 * Throws a credential-free `Error` when it is absent, blank, padded, contains
 * an ASCII control character (raw or percent-encoded), has a malformed percent
 * escape in any component, contains a literal `#` fragment delimiter, repeats a
 * query parameter, is not a PostgreSQL URI, omits the host or database name, is
 * not the `iptv_app` role, carries a `user`/`role`/`options` or
 * host/port/database target query override, or states ambiguous/unsupported TLS
 * settings (`ssl`, `sslmode`, `uselibpqcompat`, `sslnegotiation`).
 *
 * This is the single implementation of the rule: `loadConfig` validates at boot
 * and `resolveAppConnectionString` (API pool factory) calls the same function,
 * so the two entry points cannot drift. It proves the CONFIGURED identity only
 * — it does not query the server, so it does not prove the connected role's
 * effective privileges, RLS enforcement, or any cutover step.
 */
export function validateProductionAppDatabaseUrl(raw: string | undefined): string {
  const failure = productionAppDatabaseUrlFailure(raw);
  if (failure !== null) {
    throw new Error(
      `invalid environment configuration: APP_DATABASE_URL ${failure} when NODE_ENV=production (the API never falls back to DATABASE_URL/TEST_DATABASE_URL; the connection value is never trimmed and never printed here)`,
    );
  }
  // Non-null by `productionAppDatabaseUrlFailure` returning null only for a
  // defined, non-blank value.
  return raw as string;
}

/**
 * Fail closed in the API process env, even if `APP_DATABASE_URL` is valid.
 *
 * Two presence semantics, deliberately different:
 * - owner/superuser/test connection ALIASES use the repo rule (blank is absent);
 * - DRIVER-CONSUMED `PG*` variables must be genuinely unset: any non-empty value,
 *   whitespace included, is refused, because the driver would consume it just as
 *   readily as a meaningful one.
 *
 * `PGAPPNAME` is allowed, but an ASCII control character in it is refused.
 */
export function assertNoPrivilegedDatabaseEnv(env: NodeJS.ProcessEnv): void {
  for (const key of OWNER_ALIAS_ENV_VARS) {
    if (hasEnvValue(env[key])) {
      throw new Error(
        `invalid environment configuration: ${key} must NOT be present in the API process when NODE_ENV=production (owner/superuser credentials bypass RLS, a test database is never a production target, and a password must not sit in the API env); remove it from the API environment — the API never falls back to it`,
      );
    }
  }
  for (const key of DRIVER_CONSUMED_ENV_VARS) {
    if (isSuppliedEnvValue(env[key])) {
      throw new Error(
        `invalid environment configuration: ${key} must NOT be present in the API process when NODE_ENV=production (the pg driver consumes this variable directly, so any non-empty value would set the connection target, transport or startup options outside the validated APP_DATABASE_URL); remove it from the API environment`,
      );
    }
  }
  // `PGAPPNAME` is a legitimate production setting, so it is NOT denied — only
  // screened: an ASCII control character in the application name is refused
  // before it reaches driver startup parameters or server logs. Ordinary names
  // (including spaces) stay legal and the value is never printed.
  const appName = env["PGAPPNAME"];
  if (appName !== undefined && hasAsciiControlCharacter(appName)) {
    throw new Error(
      "invalid environment configuration: PGAPPNAME must not contain ASCII control characters when NODE_ENV=production (the application name is forwarded to the driver and server logs)",
    );
  }
}

/** Validate env (defaults to `process.env`) and return typed config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse({
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    DATABASE_URL: blankToUndefined(env.DATABASE_URL),
    APP_DATABASE_URL: blankToUndefined(env.APP_DATABASE_URL),
    LOG_LEVEL: env.LOG_LEVEL,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    API_SCHEDULER_ENABLED: env.API_SCHEDULER_ENABLED,
    API_SCHEDULER_TICK_SECONDS: env.API_SCHEDULER_TICK_SECONDS,
    HATCHET_API_TOKEN: emptyToUndefined(env.HATCHET_API_TOKEN),
    HATCHET_SERVER_URL: emptyToUndefined(env.HATCHET_SERVER_URL),
    OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_SDK_DISABLED: env.OTEL_SDK_DISABLED,
    INFISICAL_SITE_URL: emptyToUndefined(env.INFISICAL_SITE_URL),
    INFISICAL_PROJECT_ID: emptyToUndefined(env.INFISICAL_PROJECT_ID),
    INFISICAL_CLIENT_ID: emptyToUndefined(env.INFISICAL_CLIENT_ID),
    INFISICAL_CLIENT_SECRET: emptyToUndefined(env.INFISICAL_CLIENT_SECRET),
    INFISICAL_ENVIRONMENT: emptyToUndefined(env.INFISICAL_ENVIRONMENT),
    PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID: emptyToUndefined(env.PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID),
    CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS,
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid environment configuration: ${details}`);
  }
  let corsAllowedOrigins: string[];
  try {
    corsAllowedOrigins = parseCorsAllowedOrigins(
      parsed.data.CORS_ALLOWED_ORIGINS,
      parsed.data.NODE_ENV,
    );
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  if (
    parsed.data.NODE_ENV === "production" &&
    parsed.data.BETTER_AUTH_SECRET === "dev-only-better-auth-secret-0123456789"
  ) {
    throw new Error(
      "invalid environment configuration: BETTER_AUTH_SECRET must be overridden in production",
    );
  }
  // Deliberately NOT a schema field: the value is read straight from env so an
  // inline/typo value stays legal outside production, and `AppConfig` keeps no
  // copy that could drift from the call-time resolver in `provider-port.ts`.
  if (
    parsed.data.NODE_ENV === "production" &&
    env.PROVIDER_DISPATCH_MODE !== PRODUCTION_PROVIDER_DISPATCH_MODE
  ) {
    throw new Error(
      `invalid environment configuration: PROVIDER_DISPATCH_MODE must be exactly "${PRODUCTION_PROVIDER_DISPATCH_MODE}" when NODE_ENV=production (the durable dispatcher is the only certified executor for real provider writes); received ${describeEnvValue(env.PROVIDER_DISPATCH_MODE)}`,
    );
  }
  // RLS production boot guard: the API process must present the restricted
  // `iptv_app` connection and must NOT carry privileged/test database
  // credentials. Both checks delegate to the shared helpers so this boot path
  // and the API pool resolver enforce exactly the same rule. This is a boot
  // precondition ONLY — it proves the CONFIGURED identity, not the connected
  // role's effective privileges: nothing here queries the server, enables RLS,
  // completes the role-split cutover or certifies anything (see
  // `docs/10-operations/runbooks/rls-role-split-cutover.md`).
  if (parsed.data.NODE_ENV === "production") {
    assertNoPrivilegedDatabaseEnv(env);
    validateProductionAppDatabaseUrl(parsed.data.APP_DATABASE_URL);
  }
  return { ...parsed.data, CORS_ALLOWED_ORIGINS: corsAllowedOrigins };
}
