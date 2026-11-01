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
 *   The same adapter also serves the S1 self-service writer facet
 *   (`SecretsWriterPort`: `putSecret`/`deleteSecret` under the
 *   backend-owned `integrations/<tenantId>/<provider>` namespace, plus the
 *   orchestrated `rotateSecret` domain flow — stage, read-only probe,
 *   cutover, stage cleanup; fail-closed on any step).
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
  | "ROTATE_FAILED"
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
export class NoopSecretsPort implements SecretsWriterPort {
  readonly name = "noop";

  async getSecret(ref: string): Promise<string> {
    void ref;
    throw new SecretsError(
      "CONFIG",
      "secrets are not configured (set INFISICAL_SITE_URL, INFISICAL_PROJECT_ID, INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET)",
    );
  }

  async putSecret(input: PutSecretInput): Promise<PutSecretResult> {
    void input;
    throw new SecretsError(
      "CONFIG",
      "secrets are not configured (set INFISICAL_SITE_URL, INFISICAL_PROJECT_ID, INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET)",
    );
  }

  async deleteSecret(ref: string): Promise<void> {
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
 * Transport-level environment normalization: the self-hosted Infisical
 * server (v0.165.16) only accepts lowercase environment slugs (`sandbox`),
 * while domain refs canonically use uppercase (`infisical://SANDBOX/...`).
 * Apply ONLY when mounting the HTTP transport (query `environment=` /
 * body `environment:`); refs, validations, error messages and
 * `buildIntegrationSecretRef` keep the original spelling.
 */
function transportEnv(environment: string): string {
  return environment.toLowerCase();
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
export class InfisicalSecretsAdapter implements SecretsWriterPort {
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

  /**
   * Store (upsert) a secret under the backend-owned integration namespace.
   * The ref is derived from the validated target — never from client input
   * — so callers cannot write outside
   * `infisical://<env>/integrations/<tenantId>/<provider>/<KEY>`.
   * Before the secret write, the provider folder
   * `/integrations/<tenantId>/<provider>` is created idempotently
   * (`POST /api/v2/folders`; duplicate/race counts only with a readback
   * that confirms the exact child in the exact parent). Folder setup is
   * fail-closed: no secret bytes are sent when confirmation fails.
   * Infisical secrets are name-keyed, so put is idempotent by construction;
   * a stable `requestId` is forwarded as `X-Request-Id` for tracing.
   * Exactly one re-login + retry on 401 (same policy as reads); no blind
   * retries. Values are sent in the write body (required) but never logged.
   */
  async putSecret(input: PutSecretInput): Promise<PutSecretResult> {
    if (typeof input.value !== "string" || input.value.length === 0) {
      throw new SecretsError("MALFORMED_REF", "secret value must be a non-empty string");
    }
    if (
      input.requestId !== undefined &&
      (typeof input.requestId !== "string" || input.requestId.length === 0)
    ) {
      throw new SecretsError("MALFORMED_REF", "request id must be a non-empty string when provided");
    }
    // Throws MALFORMED_REF before any network call for out-of-namespace
    // targets (unknown provider/key, bad tenant id or environment).
    const ref = buildIntegrationSecretRef(input);
    const parsed = parseSecretRef(ref);
    // Re-prove the namespace from the validated ref and derive the folder
    // ONLY from the allowlisted binding (never from raw input paths).
    const binding = parseIntegrationSecretRef(ref);
    await this.ensureIntegrationFolder(binding, ref);

    const create = (token: string): Promise<WriteOutcome> =>
      this.writeSecret(parsed, input.value, input.requestId, token, "create");
    const update = (token: string): Promise<WriteOutcome> =>
      this.writeSecret(parsed, input.value, input.requestId, token, "update");

    const first = await this.runWrite(create);
    if (first.status === "ok") {
      this.debug?.(
        `infisical: secret stored (refHash=${hashSecretRef(ref)}, valueLen=${input.value.length}, created=true)`,
      );
      return { ref, created: true };
    }
    if (first.status === "unauthorized") throw writeDenied(parsed.environment);
    if (first.status === "error") throw first.error;
    // Name-keyed conflict: the secret already exists — update it in place
    // (still one logical secret, never a duplicate).
    const second = await this.runWrite(update);
    if (second.status === "ok") {
      this.debug?.(
        `infisical: secret stored (refHash=${hashSecretRef(ref)}, valueLen=${input.value.length}, created=false)`,
      );
      return { ref, created: false };
    }
    if (second.status === "unauthorized") throw writeDenied(parsed.environment);
    if (second.status === "missing") {
      // Vanished between the conflict and the update: create once more.
      const third = await this.runWrite(create);
      if (third.status === "ok") {
        this.debug?.(
          `infisical: secret stored (refHash=${hashSecretRef(ref)}, valueLen=${input.value.length}, created=true)`,
        );
        return { ref, created: true };
      }
      if (third.status === "unauthorized") throw writeDenied(parsed.environment);
      if (third.status === "error") throw third.error;
      throw new SecretsError("SERVER", "infisical write did not converge (create, update, create)");
    }
    if (second.status === "error") throw second.error;
    throw new SecretsError("SERVER", "infisical update reported a conflict");
  }

  /**
   * Delete a secret by ref. Only refs inside the integration namespace are
   * accepted (`parseIntegrationSecretRef` throws MALFORMED_REF otherwise,
   * before any network call). A repeated delete of an absent secret
   * surfaces NOT_FOUND so callers can distinguish "already gone".
   */
  async deleteSecret(ref: string): Promise<void> {
    // Throws MALFORMED_REF before any network call for out-of-namespace refs.
    const binding = parseIntegrationSecretRef(ref);
    // Exactly one re-login + retry on 401/403 (same policy as reads).
    const first = await this.deleteCall(binding, await this.accessToken(false));
    if (first.status !== "unauthorized") {
      if (first.status === "error") throw first.error;
      // Length/presence metadata only — NEVER the ref, key, value or token.
      this.debug?.(`infisical: secret deleted (refHash=${hashSecretRef(ref)})`);
      return;
    }
    const second = await this.deleteCall(binding, await this.accessToken(true));
    if (second.status === "unauthorized") throw writeDenied(binding.environment);
    if (second.status === "error") throw second.error;
    // Length/presence metadata only — NEVER the ref, key, value or token.
    this.debug?.(`infisical: secret deleted (refHash=${hashSecretRef(ref)})`);
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

  /**
   * Run a write with exactly one re-login + retry on 401/403 (same policy
   * as reads). Any other outcome is returned as-is: no blind retries on
   * 5xx or transport failures.
   */
  private async runWrite<T extends { status: string }>(
    op: (token: string) => Promise<T>,
  ): Promise<T> {
    const token = await this.accessToken(false);
    const first = await op(token);
    if (first.status !== "unauthorized") {
      return first;
    }
    return op(await this.accessToken(true));
  }

  /**
   * Idempotent provider-folder setup for `putSecret` (fail-closed).
   *
   * Derives the folder ONLY from the allowlisted binding:
   * parent `/integrations/<tenantId>`, child name `<provider>`. Exactly
   * one re-login + retry on 401/403; any other ambiguity is resolved by a
   * readback (`GET /api/v2/folders?path=<parent>`) that must confirm the
   * exact child in the exact parent. Confirmation failures throw and the
   * caller must NOT send secret bytes. Messages/logs carry only the
   * environment + status (never body text, ref, value or token).
   */
  private async ensureIntegrationFolder(binding: IntegrationSecretBinding, ref: string): Promise<void> {
    const first = await this.folderCall(binding, await this.accessToken(false));
    if (first.status === "ready") {
      this.debug?.(`infisical: folder ready (refHash=${hashSecretRef(ref)})`);
      return;
    }
    if (first.status !== "unauthorized") {
      throw first.error;
    }
    const second = await this.folderCall(binding, await this.accessToken(true));
    if (second.status === "ready") {
      this.debug?.(`infisical: folder ready (refHash=${hashSecretRef(ref)})`);
      return;
    }
    if (second.status === "unauthorized") throw writeDenied(binding.environment);
    throw second.error;
  }

  private async folderCall(binding: IntegrationSecretBinding, token: string): Promise<FolderOutcome> {
    const parentPath = `/${SECRET_NAMESPACE_ROOT}/${binding.tenantId}`;
    const folderName = binding.provider;
    const targetPath = `${parentPath}/${binding.provider}`;
    const environment = transportEnv(binding.environment);
    const fail = (code: SecretsError["code"], detail: string): FolderOutcome => ({
      status: "error",
      error: new SecretsError(code, detail),
    });

    let res: Response;
    try {
      res = await this.fetchFn(`${this.siteUrl}/api/v2/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          projectId: this.projectId,
          environment,
          path: parentPath,
          name: folderName,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return fail(
        "TRANSPORT",
        isTimeout(err) ? "infisical folder setup timed out" : "infisical folder setup transport error",
      );
    }
    if (res.status === 401 || res.status === 403) {
      return { status: "unauthorized" };
    }
    if (res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      // POST success must still confirm the exact path; an unconfirmed
      // success falls back to the readback instead of proceeding blind.
      if (folderCreatePayloadConfirmsTarget(body, folderName, targetPath)) {
        return { status: "ready" };
      }
      return this.confirmFolderReadback(parentPath, folderName, binding.environment, token);
    }
    if (res.status === 400 || res.status === 409) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      // Only an explicit duplicate marker counts as "already exists";
      // any other 400/409 stays a SERVER error (never masked).
      if (!isDuplicateFolderBody(body)) {
        return fail("SERVER", `infisical folder setup failed with status ${res.status}`);
      }
      return this.confirmFolderReadback(parentPath, folderName, binding.environment, token);
    }
    return fail("SERVER", `infisical folder setup failed with status ${res.status}`);
  }

  private async confirmFolderReadback(
    parentPath: string,
    folderName: string,
    environment: string,
    token: string,
  ): Promise<FolderOutcome> {
    const fail = (code: SecretsError["code"], detail: string): FolderOutcome => ({
      status: "error",
      error: new SecretsError(code, detail),
    });
    const url =
      `${this.siteUrl}/api/v2/folders` +
      `?projectId=${encodeURIComponent(this.projectId)}` +
      `&environment=${encodeURIComponent(transportEnv(environment))}` +
      `&path=${encodeURIComponent(parentPath)}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return fail(
        "TRANSPORT",
        isTimeout(err) ? "infisical folder confirmation timed out" : "infisical folder confirmation transport error",
      );
    }
    if (res.status === 401 || res.status === 403) {
      return { status: "unauthorized" };
    }
    if (!res.ok) {
      return fail("SERVER", `infisical folder confirmation failed with status ${res.status}`);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (folderListConfirmsTarget(body, folderName)) {
      return { status: "ready" };
    }
    return fail(
      "SERVER",
      `infisical folder confirmation failed in environment ${JSON.stringify(environment)} (folder not confirmed)`,
    );
  }

  private async writeSecret(
    parsed: ParsedSecretRef,
    value: string,
    requestId: string | undefined,
    token: string,
    mode: "create" | "update",
  ): Promise<WriteOutcome> {
    const url = `${this.siteUrl}/api/v3/secrets/raw/${encodeURIComponent(parsed.key)}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
    if (requestId !== undefined) {
      headers["X-Request-Id"] = requestId;
    }
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: mode === "create" ? "POST" : "PATCH",
        headers,
        body: JSON.stringify({
          workspaceId: this.projectId,
          environment: transportEnv(parsed.environment),
          secretPath: parsed.secretPath,
          secretValue: value,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return {
        status: "error",
        error: new SecretsError(
          "TRANSPORT",
          isTimeout(err) ? "infisical write timed out" : "infisical write transport error",
        ),
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: "unauthorized" };
    }
    if (mode === "create" && res.status === 409) {
      return { status: "exists" };
    }
    if (mode === "create" && res.status === 400) {
      // Self-hosted v0.165.16 reports duplicate creates as 400 with
      // "already exists" in the body (not 409). Only that message maps
      // to "exists"; any other 400 stays a SERVER error (never masked).
      let dupBody: unknown = null;
      try {
        dupBody = await res.json();
      } catch {
        dupBody = null;
      }
      if (dupBody !== null && JSON.stringify(dupBody).toLowerCase().includes("already exists")) {
        return { status: "exists" };
      }
      return {
        status: "error",
        error: new SecretsError("SERVER", `infisical write failed with status ${res.status}`),
      };
    }
    if (mode === "update" && res.status === 404) {
      return { status: "missing" };
    }
    if (!res.ok) {
      return {
        status: "error",
        error: new SecretsError("SERVER", `infisical write failed with status ${res.status}`),
      };
    }
    return { status: "ok" };
  }

  private async deleteCall(binding: ParsedSecretRef, token: string): Promise<DeleteOutcome> {
    const url =
      `${this.siteUrl}/api/v3/secrets/raw/${encodeURIComponent(binding.key)}` +
      `?workspaceId=${encodeURIComponent(this.projectId)}` +
      `&environment=${encodeURIComponent(transportEnv(binding.environment))}` +
      `&secretPath=${encodeURIComponent(binding.secretPath)}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        // Self-hosted v0.165.16 requires the scope in the DELETE body
        // (query string alone returns 422 "Expected object, received null").
        body: JSON.stringify({
          workspaceId: this.projectId,
          environment: transportEnv(binding.environment),
          secretPath: binding.secretPath,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return {
        status: "error",
        error: new SecretsError(
          "TRANSPORT",
          isTimeout(err) ? "infisical delete timed out" : "infisical delete transport error",
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
          `secret ${JSON.stringify(binding.key)} not found in environment ${JSON.stringify(binding.environment)}`,
        ),
      };
    }
    if (!res.ok) {
      return {
        status: "error",
        error: new SecretsError("SERVER", `infisical delete failed with status ${res.status}`),
      };
    }
    return { status: "ok" };
  }

  private async readSecret(
    parsed: ParsedSecretRef,
    token: string,
  ): Promise<{ status: "ok"; value: string } | { status: "unauthorized" } | { status: "error"; error: SecretsError }> {
    const url =
      `${this.siteUrl}/api/v3/secrets/raw/${encodeURIComponent(parsed.key)}` +
      `?workspaceId=${encodeURIComponent(this.projectId)}` +
      `&environment=${encodeURIComponent(transportEnv(parsed.environment))}` +
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

/* ------------------------------------------------------------------ *
 * Writer facet (S1 self-service): server-side secret provisioning.
 *
 * Reads stay on `SecretsPort`. Writes live on `SecretsWriterPort`
 * (a separate interface extending the read port so existing read-only
 * fakes keep compiling): `putSecret`/`deleteSecret` under a controlled
 * namespace, plus `rotateSecret` as an orchestrated domain function —
 * not an opaque port operation — composed from put + a read-only probe
 * + cutover + staged-key cleanup.
 *
 * SECURITY: refs are produced ONLY by the backend from validated
 * targets (`buildIntegrationSecretRef`); the browser never sends a path
 * or a raw ref to these operations. Values are transmitted in write
 * bodies (required) but NEVER appear in errors, logs or telemetry —
 * debug output carries only the FNV-1a hash of the ref plus
 * presence/length metadata.
 * ------------------------------------------------------------------ */

/** Root path segment of the controlled namespace. */
export const SECRET_NAMESPACE_ROOT = "integrations";

/**
 * Suffix for rotation staging keys (`<KEY>__next`). The ONLY
 * client-unreachable-by-convention key shape besides the per-provider
 * allowlist; `rotateSecret` stages the candidate under it, probes
 * read-only, then cuts over. Never constructed in the browser.
 */
export const SECRET_STAGED_SUFFIX = "__next";

/** Providers allowed to hold tenant secrets in the vault. */
export type IntegrationProvider = "asaas" | "cinevision" | "whatsapp";

/** Exact secret keys each provider may store (no free-form keys). */
const INTEGRATION_SECRET_KEYS: Record<IntegrationProvider, readonly string[]> = {
  asaas: ["ASAAS_API_KEY", "ASAAS_WEBHOOK_TOKEN"],
  cinevision: ["CINEVISION_USER", "CINEVISION_PASS"],
  whatsapp: ["WAHA_WEBHOOK_SECRET"],
};

/** Backend-owned write target: tenant + provider + environment + key. */
export interface IntegrationSecretTarget {
  tenantId: string;
  provider: IntegrationProvider;
  environment: string;
  key: string;
}

const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

type WriteOutcome =
  | { status: "ok" }
  | { status: "exists" }
  | { status: "missing" }
  | { status: "unauthorized" }
  | { status: "error"; error: SecretsError };

type DeleteOutcome =
  | { status: "ok" }
  | { status: "unauthorized" }
  | { status: "error"; error: SecretsError };

type FolderOutcome =
  | { status: "ready" }
  | { status: "unauthorized" }
  | { status: "error"; error: SecretsError };

/**
 * True when a folder-write failure body carries an explicit duplicate
 * marker. Only these markers count as "already exists" — any other 400
 * body stays a SERVER error (never masked as a conflict).
 */
function isDuplicateFolderBody(body: unknown): boolean {
  if (body === null || body === undefined) return false;
  let text: string;
  try {
    text = JSON.stringify(body).toLowerCase();
  } catch {
    return false;
  }
  return (
    text.includes("already exists") ||
    text.includes("already_exists") ||
    text.includes("already-exists") ||
    text.includes("duplicate")
  );
}

interface FolderEntry {
  name: unknown;
  path: unknown;
  relativePath: unknown;
}

function collectFolderEntries(value: unknown, out: FolderEntry[], depth: number): void {
  if (depth > 4 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectFolderEntries(item, out, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record["name"] === "string") {
    out.push({ name: record["name"], path: record["path"], relativePath: record["relativePath"] });
  }
  for (const key of ["folder", "folders", "data"]) {
    if (record[key] !== undefined) collectFolderEntries(record[key], out, depth + 1);
  }
}

/**
 * Confirm the POST /api/v2/folders response names the exact created target.
 * The v0.165.16 create response supplies the full path.
 */
function folderCreatePayloadConfirmsTarget(
  body: unknown,
  folderName: string,
  targetPath: string,
): boolean {
  const entries: FolderEntry[] = [];
  collectFolderEntries(body, entries, 0);
  return entries.some((entry) => entry.name === folderName && entry.path === targetPath);
}

/**
 * Confirm a direct child from GET /api/v2/folders with recursive omitted.
 * Infisical v0.165.16 returns folder rows with id/envId/name but no path
 * fields in this mode. The exact parent is guaranteed by the backend-derived
 * query; path-bearing/recursive-shaped rows fail closed rather than being
 * interpreted as belonging to the tenant.
 */
function folderListConfirmsTarget(body: unknown, folderName: string): boolean {
  const folders = asRecordOrNull(body)?.["folders"];
  if (!Array.isArray(folders)) return false;
  const entries = folders.map(asRecordOrNull);
  if (
    entries.some(
      (entry) =>
        entry === null ||
        typeof entry["id"] !== "string" ||
        typeof entry["envId"] !== "string" ||
        typeof entry["name"] !== "string" ||
        Object.hasOwn(entry, "path") ||
        Object.hasOwn(entry, "relativePath"),
    )
  ) {
    return false;
  }
  return entries.some((entry) => entry?.["name"] === folderName);
}

/** FNV-1a (32-bit) hash for masked ref logging — never the ref itself. */
function hashSecretRef(ref: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < ref.length; index += 1) {
    hash ^= ref.charCodeAt(index) as number;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Fixed write-denied message: names the environment only, never key/path. */
function writeDenied(environment: string): SecretsError {
  return new SecretsError(
    "UNAUTHORIZED",
    `infisical write denied in environment ${JSON.stringify(environment)} (check write identity scopes)`,
  );
}

function validateIntegrationTarget(target: IntegrationSecretTarget): { secretPath: string } {
  if (
    typeof target.provider !== "string" ||
    !Object.hasOwn(INTEGRATION_SECRET_KEYS, target.provider)
  ) {
    throw new SecretsError(
      "MALFORMED_REF",
      "unknown integration provider (expected one of: asaas, cinevision, whatsapp)",
    );
  }
  if (typeof target.environment !== "string" || !ENV_SEGMENT_RE.test(target.environment)) {
    throw new SecretsError(
      "MALFORMED_REF",
      `malformed integration environment ${JSON.stringify(target.environment)} (expected slug like "sandbox")`,
    );
  }
  if (typeof target.tenantId !== "string" || !TENANT_ID_RE.test(target.tenantId)) {
    throw new SecretsError(
      "MALFORMED_REF",
      "malformed tenant id (expected 1-64 chars: letters, digits, '-' or '_')",
    );
  }
  const provider = target.provider as IntegrationProvider;
  const allowed = INTEGRATION_SECRET_KEYS[provider];
  const staged = target.key.endsWith(SECRET_STAGED_SUFFIX);
  const base = staged ? target.key.slice(0, -SECRET_STAGED_SUFFIX.length) : target.key;
  if (!allowed.includes(base)) {
    throw new SecretsError(
      "MALFORMED_REF",
      `secret key ${JSON.stringify(target.key)} is not allowed for provider ${JSON.stringify(provider)}`,
    );
  }
  return { secretPath: `/${SECRET_NAMESPACE_ROOT}/${target.tenantId}/${provider}` };
}

/**
 * Build the backend-owned ref for an integration secret:
 * `infisical://<environment>/integrations/<tenantId>/<provider>/<KEY>`.
 * The Infisical environment slug doubles as the integration `env`
 * (sandbox/production); the secret path carries the tenant/provider
 * scope. Throws `SecretsError(MALFORMED_REF)` for anything outside the
 * controlled namespace — before any network call.
 */
export function buildIntegrationSecretRef(target: IntegrationSecretTarget): string {
  const { secretPath } = validateIntegrationTarget(target);
  return `${SECRETS_REF_SCHEME}${target.environment}${secretPath}/${target.key}`;
}

/** A parsed ref proven to live inside the integration namespace. */
export interface IntegrationSecretBinding extends ParsedSecretRef {
  tenantId: string;
  provider: IntegrationProvider;
  /** True for rotation staging keys (`<KEY>__next`). */
  staged: boolean;
}

/**
 * Parse a ref and prove it lives inside the integration namespace:
 * exactly `/integrations/<tenantId>/<provider>` with a valid tenant id,
 * a known provider and an allowlisted (or staged) key. Anything else
 * throws `SecretsError(MALFORMED_REF)` — before any network call.
 */
export function parseIntegrationSecretRef(ref: string): IntegrationSecretBinding {
  const parsed = parseSecretRef(ref);
  const segments = parsed.secretPath === "/" ? [] : parsed.secretPath.slice(1).split("/");
  if (
    segments.length !== 3 ||
    segments[0] !== SECRET_NAMESPACE_ROOT ||
    typeof segments[1] !== "string" ||
    typeof segments[2] !== "string"
  ) {
    throw new SecretsError(
      "MALFORMED_REF",
      "secret ref is outside the integrations namespace (expected infisical://<env>/integrations/<tenantId>/<provider>/<KEY>)",
    );
  }
  const candidate: IntegrationSecretTarget = {
    tenantId: segments[1],
    provider: segments[2] as IntegrationProvider,
    environment: parsed.environment,
    key: parsed.key,
  };
  // Reuses the allowlist (including the `__next` staging convention).
  validateIntegrationTarget(candidate);
  return {
    ...parsed,
    tenantId: segments[1],
    provider: segments[2] as IntegrationProvider,
    staged: parsed.key.endsWith(SECRET_STAGED_SUFFIX),
  };
}

/** Input for `putSecret`: backend-owned target + value + optional idempotency key. */
export interface PutSecretInput extends IntegrationSecretTarget {
  /** Secret value. Transmitted in the write body; never logged or thrown. */
  value: string;
  /**
   * Stable idempotency key. Secrets are name-keyed so put is idempotent by
   * construction (same target overwrites, never duplicates); the key is
   * forwarded as `X-Request-Id` for vault-side tracing.
   */
  requestId?: string;
}

/** Result of `putSecret`: the backend-owned ref plus whether it was created. */
export interface PutSecretResult {
  ref: string;
  created: boolean;
}

/**
 * Writer facet of the secrets port. Extends (rather than widens)
 * `SecretsPort` so existing read-only implementations keep compiling;
 * use `asSecretsWriter` to narrow.
 */
export interface SecretsWriterPort extends SecretsPort {
  /** Store (upsert) a secret under the controlled namespace. */
  putSecret(input: PutSecretInput): Promise<PutSecretResult>;
  /** Delete a secret by namespaced ref. */
  deleteSecret(ref: string): Promise<void>;
}

/**
 * Narrow a `SecretsPort` to its writer facet. Returns `null` for
 * read-only implementations (no `putSecret`/`deleteSecret`), so callers
 * fail closed instead of assuming write capability.
 */
export function asSecretsWriter(port: SecretsPort): SecretsWriterPort | null {
  const candidate = port as Partial<SecretsWriterPort>;
  if (typeof candidate.putSecret === "function" && typeof candidate.deleteSecret === "function") {
    return candidate as SecretsWriterPort;
  }
  return null;
}

/**
 * Env-gated writer selection: mirrors `resolveSecretsPort` but typed as
 * `SecretsWriterPort`. The Noop writer throws typed CONFIG on use
 * (fail-closed); it never reports a vault-backed connection.
 */
export function resolveSecretsWriterPort(env: NodeJS.ProcessEnv = process.env): SecretsWriterPort {
  const writer = asSecretsWriter(resolveSecretsPort(env));
  if (writer === null) {
    throw new SecretsError("CONFIG", "secrets writer is not available (unexpected port shape)");
  }
  return writer;
}

/** Input for `rotateSecret`: live target + candidate value + read-only probe. */
export interface RotateSecretInput extends PutSecretInput {
  /**
   * Read-only canary validation against the STAGED ref (e.g. a provider
   * read-only probe resolving the staged secret). Must not mutate
   * anything; a rejection aborts the rotation with the live ref preserved.
   */
  probe: (stagedRef: string) => Promise<void>;
}

/** Result of `rotateSecret`: live ref (cut over) plus the staged ref used. */
export interface RotateSecretResult {
  ref: string;
  stagedRef: string;
}

/**
 * Orchestrated secret rotation (domain function, not an opaque port op):
 *
 * 1. `put` the candidate under `<KEY>__next` (same path/environment);
 * 2. run the read-only `probe` against the staged ref;
 * 3. `put` (cutover) the live key with the candidate value;
 * 4. best-effort `delete` of the staged key.
 *
 * Failure at any step is fail-closed: a probe rejection cleans the stage
 * and throws `SecretsError(ROTATE_FAILED)` with the live ref untouched
 * (never mark the integration connected); put/delete failures propagate
 * their typed errors. The post-cutover stage cleanup is best-effort so a
 * successful cutover is never reported as failed.
 */
export async function rotateSecret(
  port: SecretsWriterPort,
  input: RotateSecretInput,
): Promise<RotateSecretResult> {
  const { probe, ...target } = input;
  if (typeof probe !== "function") {
    throw new SecretsError("MALFORMED_REF", "rotation requires a read-only probe callback");
  }
  if (typeof target.value !== "string" || target.value.length === 0) {
    throw new SecretsError("MALFORMED_REF", "secret value must be a non-empty string");
  }
  // Both throw MALFORMED_REF before any network call when out of namespace.
  const ref = buildIntegrationSecretRef(target);
  const stagedKey = `${target.key}${SECRET_STAGED_SUFFIX}`;
  const stagedRef = buildIntegrationSecretRef({ ...target, key: stagedKey });
  // 1. Stage the candidate.
  await port.putSecret({ ...target, key: stagedKey, value: target.value });
  // 2. Read-only canary. A rejection aborts: clean the stage (best-effort,
  // never masking the probe failure) and fail closed.
  try {
    await probe(stagedRef);
  } catch {
    await port.deleteSecret(stagedRef).catch(() => undefined);
    throw new SecretsError(
      "ROTATE_FAILED",
      `rotation probe rejected the candidate in environment ${JSON.stringify(target.environment)} (live ref preserved)`,
    );
  }
  // 3. Cutover. Typed put errors propagate; the live ref is only touched here.
  await port.putSecret({ ...target, value: target.value });
  // 4. Best-effort stage cleanup after a successful cutover.
  await port.deleteSecret(stagedRef).catch(() => undefined);
  return { ref, stagedRef };
}
