/**
 * Secrets port (ADR-0014).
 *
 * Domain tables store `secret_ref` — never secret values. The ONLY
 * implementations shipped here are:
 * - `NoopSecretsPort` (default): used when Infisical env vars are absent;
 *   `getSecret` throws a typed CONFIG error (never a fake value) so boot
 *   never crashes but consumption fails loudly and clearly.
 * - `InfisicalSecretsAdapter` (env-gated): Universal Auth login + raw
 *   secret read against the self-hosted instance; constructed ONLY when
 *   `INFISICAL_SITE_URL` + `INFISICAL_PROJECT_ID` + `INFISICAL_CLIENT_ID` +
 * `INFISICAL_CLIENT_SECRET` are all present (see `resolveSecretsPort`).
 *
 * `INFISICAL_SITE_URL` must be `https://` (plain `http://` is accepted only
 * for `localhost` / `127.0.0.1` local dev); anything else throws CONFIG.
 *
 * SECURITY: secret VALUES and the access token are NEVER logged, thrown
 * inside error messages, or attached to telemetry. Debug output carries
 * only presence/length metadata. Error messages may name the environment
 * (and, for NOT_FOUND, the key) but never the value; the persistent-401
 * UNAUTHORIZED path names only the environment plus the ref segment count,
 * never the key or path.
 *
 * Endpoints (Infisical REST, confirmed against official docs):
 * - login: POST `{site}/api/v1/auth/universal-auth/login`
 *   `{clientId, clientSecret}` → `{accessToken, expiresIn}`.
 * - read: GET `{site}/api/v3/secrets/raw/{secretName}
 *   ?workspaceId=<project>&environment=<env>&secretPath=<path>`
 *   → `{secret: {secretKey, secretValue, ...}}`.
 * (`/api/v3/secrets/raw` is the deprecated-but-stable plaintext endpoint
 * for machine-identity Bearer tokens; migrate to `/api/v4/secrets` when
 * the self-hosted instance guarantees v4 support.)
 */

/** URI scheme for domain `secret_ref` values. */
export const SECRETS_REF_SCHEME = "infisical://";

export type SecretsErrorCode =
  | "MALFORMED_REF"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "TRANSPORT"
  | "CONFIG"
  | "SERVER";

/** Typed secrets failure. `detail` never contains a secret value or token. */
export class SecretsError extends Error {
  readonly code: SecretsErrorCode;

  constructor(code: SecretsErrorCode, detail: string) {
    super(`secrets: ${detail}`);
    this.name = "SecretsError";
    this.code = code;
  }
}

export interface ParsedSecretRef {
  /** Infisical environment slug (first segment of the ref). */
  environment: string;
  /** Infisical secret path (`/` for root, `/a/b` for nested). */
  secretPath: string;
  /** Secret key (last segment of the ref). */
  key: string;
}

const ENV_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Secret-ref grammar:
 *
 *   infisical://<environment>/<key>
 *   infisical://<environment>/<path...>/<key>
 *
 * - `<environment>` is the Infisical environment slug (authoritative for
 *   the request; the adapter's configured default is NOT consulted —
 *   refs are self-contained).
 * - `<key>` is the secret name (last `/`-separated segment).
 * - Any middle segments form the Infisical secret path
 *   (`/browser-worker` in `infisical://production/browser-worker/FOO`).
 *
 * Throws `SecretsError(MALFORMED_REF)` for anything else.
 */
export function parseSecretRef(ref: string): ParsedSecretRef {
  if (typeof ref !== "string" || !ref.startsWith(SECRETS_REF_SCHEME)) {
    throw new SecretsError(
      "MALFORMED_REF",
      `malformed secret ref (expected "infisical://<environment>/<key>")`,
    );
  }
  const rest = ref.slice(SECRETS_REF_SCHEME.length);
  const segments = rest.split("/");
  if (segments.length < 2 || segments.some((s) => s.length === 0)) {
    throw new SecretsError(
      "MALFORMED_REF",
      `malformed secret ref (expected "infisical://<environment>/<key>")`,
    );
  }
  if (segments.some((s) => s === "." || s === "..")) {
    throw new SecretsError(
      "MALFORMED_REF",
      `malformed secret ref (path segments "." and ".." are not allowed)`,
    );
  }
  const environment = segments[0] as string;
  const key = segments[segments.length - 1] as string;
  if (!ENV_SEGMENT_RE.test(environment)) {
    throw new SecretsError(
      "MALFORMED_REF",
      `malformed secret ref environment ${JSON.stringify(environment)} (expected slug like "production")`,
    );
  }
  if (/[\s]/.test(key)) {
    throw new SecretsError("MALFORMED_REF", "malformed secret ref key (must not contain whitespace)");
  }
  const middle = segments.slice(1, -1);
  return { environment, secretPath: middle.length === 0 ? "/" : `/${middle.join("/")}`, key };
}

export interface SecretsPort {
  readonly name: string;
  /** Resolve a `secret_ref` to its value. Rejects with `SecretsError`. */
  getSecret(ref: string): Promise<string>;
}

/** Default: records nothing, fails loudly (never a fake secret). */
export class NoopSecretsPort implements SecretsPort {
  readonly name = "noop";

  async getSecret(ref: string): Promise<string> {
    void ref;
    throw new SecretsError(
      "CONFIG",
      "secrets are not configured (set INFISICAL_SITE_URL, INFISICAL_PROJECT_ID, INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET)",
    );
  }
}

export interface InfisicalSecretsOptions {
  siteUrl: string;
  projectId: string;
  clientId: string;
  clientSecret: string;
  /** Retained for callers/smoke tooling; refs carry their own environment. */
  defaultEnvironment?: string;
  /** Per-request timeout in ms (default 8000, as in the Asaas port). */
  timeoutMs?: number;
  /** Fetch implementation (default global fetch; injectable for tests). */
  fetchFn?: typeof fetch;
  /** Debug sink; receives presence/length metadata ONLY (never values). */
  debug?: (message: string) => void;
}

interface TokenCache {
  token: string;
  expiresAtMs: number;
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Enforce TLS for the Infisical site URL: only `https://` is accepted,
 * except explicit `http://localhost` / `http://127.0.0.1` for local dev.
 * Plain HTTP elsewhere would transmit the clientSecret (login body) and
 * the Bearer token (secret reads) without TLS. Throws `SecretsError(CONFIG)`.
 */
function assertSecureSiteUrl(siteUrl: string): void {
  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    throw new SecretsError("CONFIG", "invalid infisical site url (expected absolute https:// url)");
  }
  if (url.protocol === "https:") {
    return;
  }
  if (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  ) {
    return;
  }
  throw new SecretsError(
    "CONFIG",
    "infisical site url must use https:// (http allowed only for http://localhost or http://127.0.0.1 dev)",
  );
}

/**
 * Env-gated Infisical adapter. Construct directly or via
 * `resolveSecretsPort` (which returns `NoopSecretsPort` when env is
 * incomplete so boot never crashes; a PRESENT-but-insecure `INFISICAL_SITE_URL`
 * throws a typed CONFIG error instead of sending credentials over plain HTTP).
 */
export class InfisicalSecretsAdapter implements SecretsPort {
  readonly name = "infisical";

  private readonly siteUrl: string;
  private readonly projectId: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly debug: ((message: string) => void) | undefined;
  private cached: TokenCache | null = null;

  constructor(options: InfisicalSecretsOptions) {
    assertSecureSiteUrl(options.siteUrl);
    this.siteUrl = options.siteUrl.replace(/\/+$/, "");
    this.projectId = options.projectId;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.debug = options.debug;
  }

  async getSecret(ref: string): Promise<string> {
    const parsed = parseSecretRef(ref);
    const token = await this.accessToken(false);
    const first = await this.readSecret(parsed, token);
    if (first.status === "ok") {
      return first.value;
    }
    if (first.status === "unauthorized") {
      // Token may have expired early: re-login once and retry once.
      const fresh = await this.accessToken(true);
      const second = await this.readSecret(parsed, fresh);
      if (second.status === "ok") {
        return second.value;
      }
      if (second.status === "unauthorized") {
        // Fixed message: never echo the ref (key/path) back — a secret name
        // is sensitive metadata. Name only the environment plus the ref
        // shape (segment count), which is enough to locate the binding.
        const segmentCount =
          parsed.secretPath === "/" ? 2 : parsed.secretPath.slice(1).split("/").length + 2;
        throw new SecretsError(
          "UNAUTHORIZED",
          `infisical denied access in environment ${JSON.stringify(parsed.environment)} (ref with ${segmentCount} segments) (check identity scopes)`,
        );
      }
      throw second.error;
    }
    throw first.error;
  }

  /** Cached Universal Auth token (refresh on expiry or when forced). */
  private async accessToken(force: boolean): Promise<string> {
    if (!force && this.cached !== null && Date.now() < this.cached.expiresAtMs) {
      return this.cached.token;
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${this.siteUrl}/api/v1/auth/universal-auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: this.clientId, clientSecret: this.clientSecret }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SecretsError(
        "TRANSPORT",
        isTimeout(err) ? "infisical login timed out" : "infisical login transport error",
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new SecretsError("UNAUTHORIZED", "infisical login rejected (check client id/secret)");
    }
    if (!res.ok) {
      throw new SecretsError("SERVER", `infisical login failed with status ${res.status}`);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const record = asRecordOrNull(body);
    const accessToken = record?.["accessToken"];
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new SecretsError("SERVER", "infisical login response without access token");
    }
    const expiresIn = record?.["expiresIn"];
    const ttlSeconds =
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 600;
    // Refresh 30s before expiry (or 10% of TTL when shorter).
    const skewSeconds = Math.min(30, Math.floor(ttlSeconds / 10));
    this.cached = { token: accessToken, expiresAtMs: Date.now() + (ttlSeconds - skewSeconds) * 1000 };
    // Length/presence metadata only — NEVER the token itself.
    this.debug?.(`infisical: login ok (tokenLen=${accessToken.length}, ttl=${ttlSeconds}s)`);
    return accessToken;
  }

  private async readSecret(
    parsed: ParsedSecretRef,
    token: string,
  ): Promise<{ status: "ok"; value: string } | { status: "unauthorized" } | { status: "error"; error: SecretsError }> {
    const url =
      `${this.siteUrl}/api/v3/secrets/raw/${encodeURIComponent(parsed.key)}` +
      `?workspaceId=${encodeURIComponent(this.projectId)}` +
      `&environment=${encodeURIComponent(parsed.environment)}` +
      `&secretPath=${encodeURIComponent(parsed.secretPath)}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return {
        status: "error",
        error: new SecretsError(
          "TRANSPORT",
          isTimeout(err) ? "infisical read timed out" : "infisical read transport error",
        ),
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: "unauthorized" };
    }
    if (res.status === 404) {
      return {
        status: "error",
        error: new SecretsError(
          "NOT_FOUND",
          `secret ${JSON.stringify(parsed.key)} not found in environment ${JSON.stringify(parsed.environment)}`,
        ),
      };
    }
    if (!res.ok) {
      return {
        status: "error",
        error: new SecretsError("SERVER", `infisical read failed with status ${res.status}`),
      };
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const value = asRecordOrNull(asRecordOrNull(body)?.["secret"])?.["secretValue"];
    if (typeof value !== "string") {
      return {
        status: "error",
        error: new SecretsError("SERVER", "infisical read response without secret value"),
      };
    }
    // Length metadata only — NEVER the value itself.
    this.debug?.(
      `infisical: secret fetched (envLen=${parsed.environment.length}, ` +
        `keyLen=${parsed.key.length}, valueLen=${value.length})`,
    );
    return { status: "ok", value };
  }
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Env-gated selection: builds the Infisical adapter ONLY when
 * `INFISICAL_SITE_URL` + `INFISICAL_PROJECT_ID` + `INFISICAL_CLIENT_ID` +
 * `INFISICAL_CLIENT_SECRET` are all present; otherwise returns the Noop
 * port. Never throws for missing env (never a boot crash).
 */
export function resolveSecretsPort(env: NodeJS.ProcessEnv = process.env): SecretsPort {
  const siteUrl = emptyToUndefined(env["INFISICAL_SITE_URL"]);
  const projectId = emptyToUndefined(env["INFISICAL_PROJECT_ID"]);
  const clientId = emptyToUndefined(env["INFISICAL_CLIENT_ID"]);
  const clientSecret = emptyToUndefined(env["INFISICAL_CLIENT_SECRET"]);
  if (
    siteUrl === undefined ||
    projectId === undefined ||
    clientId === undefined ||
    clientSecret === undefined
  ) {
    return new NoopSecretsPort();
  }
  return new InfisicalSecretsAdapter({
    siteUrl,
    projectId,
    clientId,
    clientSecret,
    defaultEnvironment: emptyToUndefined(env["INFISICAL_ENVIRONMENT"]) ?? "development",
  });
}
