/**
 * S3a (#87) WAHA admin HTTP port.
 *
 * Minimal, confirmed-only surface of the WAHA REST API (docs:
 * https://waha.devlike.pro/docs/how-to/sessions/ and
 * https://waha.devlike.pro/docs/how-to/events/):
 * - `POST /api/sessions` (create; `{name, start, config.webhooks[]}` with
 *   `url`/`events`/`customHeaders` — the exact shape from the docs example);
 * - `GET /api/sessions/{name}` (status DTO `{name, status, …}`);
 * - `POST /api/sessions/{name}/start|stop|restart` (idempotent lifecycle);
 * - `GET /api/{session}/auth/qr` (`Accept: image/png` → binary PNG).
 *
 * Deliberately NOT implemented (engine/version unconfirmed in this repo —
 * GOWS preferred pending certification, no pinned WAHA version):
 * - `PUT /api/sessions/{session}` webhook re-converge on reuse (update
 *   merge semantics unconfirmed; would risk wiping engine config);
 * - pairing-code (`POST /api/{session}/auth/request-code` — docs warn it
 *   is not always available; QR is the supported path, S3b may add it).
 *
 * Auth: platform-owned `X-Api-Key` from env (never a tenant secret, never
 * logged, never returned). Timeouts bounded (8000ms, like the Asaas probe);
 * transport failures map to typed errors, never to invented state.
 */

export type WahaFetch = typeof fetch;

let testFetch: WahaFetch | null = null;

/** Test-only: install a fake WAHA HTTP layer (zero real network). */
export function __setWahaAdminFetchForTests(fetchImpl: WahaFetch): void {
  testFetch = fetchImpl;
}

/** Test-only: remove the fake. */
export function __resetWahaAdminFetchForTests(): void {
  testFetch = null;
}

function resolveFetch(): WahaFetch {
  return testFetch ?? fetch;
}

export interface WahaSessionInfo {
  name: string;
  status: string;
}

export type WahaAdminErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "BAD_RESPONSE";

export class WahaAdminError extends Error {
  readonly code: WahaAdminErrorCode;
  readonly status: number | null;
  constructor(code: WahaAdminErrorCode, message: string, status: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface WahaQrImage {
  bytes: Uint8Array;
  contentType: string;
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** Bounded WAHA admin call: 8000ms, `X-Api-Key`, JSON in/out. */
async function callWaha(
  baseUrl: string,
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  let res: Response;
  try {
    res = await resolveFetch()(`${baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isTimeout(err)) {
      throw new WahaAdminError("TIMEOUT", "waha admin request timed out", null);
    }
    throw new WahaAdminError(
      "UNAVAILABLE",
      `waha admin request failed: ${err instanceof Error ? err.message : String(err)}`,
      null,
    );
  }
  return res;
}

function errorForStatus(status: number): WahaAdminError {
  if (status === 404) {
    return new WahaAdminError("NOT_FOUND", "waha session not found", status);
  }
  if (status === 401 || status === 403) {
    return new WahaAdminError("UNAUTHORIZED", "waha admin credential rejected", status);
  }
  if (status === 409) {
    return new WahaAdminError("CONFLICT", "waha session already exists", status);
  }
  if (status === 429) {
    return new WahaAdminError("RATE_LIMITED", "waha rate-limited the request (capping surfaced, not retried)", status);
  }
  if (status >= 500) {
    return new WahaAdminError("UNAVAILABLE", `waha unavailable (HTTP ${status})`, status);
  }
  return new WahaAdminError("BAD_RESPONSE", `waha refused the request (HTTP ${status})`, status);
}

function sessionInfoOf(value: unknown, path: string): WahaSessionInfo {
  const root = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const name = root !== null && typeof root["name"] === "string" ? (root["name"] as string) : null;
  const status = root !== null && typeof root["status"] === "string" ? (root["status"] as string) : null;
  if (name === null || status === null) {
    throw new WahaAdminError("BAD_RESPONSE", `waha returned an unreadable session DTO at ${path}`, null);
  }
  return { name, status };
}

export interface WahaAdminConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

/**
 * Fail-closed config: BOTH `WAHA_BASE_URL` and `WAHA_API_KEY` must be set
 * and non-blank (blank means absent, per repo rule). Returns `null` when
 * WAHA is not configured — callers fail closed, never with a default.
 */
export function wahaAdminConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 8000,
): WahaAdminConfig | null {
  const baseUrl = env["WAHA_BASE_URL"];
  const apiKey = env["WAHA_API_KEY"];
  if (
    typeof baseUrl !== "string" ||
    baseUrl.trim().length === 0 ||
    typeof apiKey !== "string" ||
    apiKey.trim().length === 0
  ) {
    return null;
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, timeoutMs };
}

export interface WahaWebhookTarget {
  url: string;
  secret: string;
}

/**
 * Injectable WAHA admin port. `fetchImpl` is injectable for tests; the
 * module-level test double (`__setWahaAdminFetchForTests`) is the lane the
 * integration suite uses (mirrors the AsaasPort doubles model).
 */
export class HttpWahaAdminPort {
  constructor(private readonly config: WahaAdminConfig) {}

  private call(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    return callWaha(this.config.baseUrl, this.config.apiKey, method, path, body, this.config.timeoutMs);
  }

  /** `null` on WAHA 404 (unknown at the provider). */
  async getSession(name: string): Promise<WahaSessionInfo | null> {
    const res = await this.call("GET", `/api/sessions/${encodeURIComponent(name)}`);
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw errorForStatus(res.status);
    }
    return sessionInfoOf(await res.json().catch(() => null), "getSession");
  }

  /**
   * Provision: `POST /api/sessions` with `{name, start: true, config:
   * {webhooks: [{url, events: ["message", "session.status"],
   * customHeaders: [{name: "x-waha-secret", value: secret}]}]}}` — the
   * static header carries the per-tenant webhook token so the existing
   * `x-waha-secret` ingress check keeps working unchanged. Returns the
   * provider DTO (201 or, on 409, the already-live session via GET).
   */
  async createSession(name: string, webhook: WahaWebhookTarget): Promise<WahaSessionInfo> {
    const res = await this.call("POST", "/api/sessions", {
      name,
      start: true,
      config: {
        webhooks: [
          {
            url: webhook.url,
            events: ["message", "session.status"],
            customHeaders: [{ name: "x-waha-secret", value: webhook.secret }],
          },
        ],
      },
    });
    if (res.status === 409) {
      const existing = await this.getSession(name);
      if (existing !== null) {
        return existing;
      }
      throw new WahaAdminError("CONFLICT", "waha session already exists but cannot be read back", 409);
    }
    if (!res.ok) {
      throw errorForStatus(res.status);
    }
    return sessionInfoOf(await res.json().catch(() => null), "createSession");
  }

  async startSession(name: string): Promise<WahaSessionInfo> {
    const res = await this.call("POST", `/api/sessions/${encodeURIComponent(name)}/start`);
    if (!res.ok) {
      throw errorForStatus(res.status);
    }
    return sessionInfoOf(await res.json().catch(() => null), "startSession");
  }

  async stopSession(name: string): Promise<WahaSessionInfo> {
    const res = await this.call("POST", `/api/sessions/${encodeURIComponent(name)}/stop`);
    if (!res.ok) {
      throw errorForStatus(res.status);
    }
    return sessionInfoOf(await res.json().catch(() => null), "stopSession");
  }

  async restartSession(name: string): Promise<WahaSessionInfo> {
    const res = await this.call("POST", `/api/sessions/${encodeURIComponent(name)}/restart`);
    if (!res.ok) {
      throw errorForStatus(res.status);
    }
    return sessionInfoOf(await res.json().catch(() => null), "restartSession");
  }

  /**
   * QR proxy: `GET /api/{session}/auth/qr` with `Accept: image/png`.
   * Returns `null` when no QR is available (WAHA 404/422 — e.g. WORKING or
   * STOPPED sessions — or a non-image payload), so callers answer an honest
   * 404 instead of inventing bytes.
   */
  async fetchQrPng(name: string): Promise<WahaQrImage | null> {
    let res: Response;
    try {
      res = await resolveFetch()(`${this.config.baseUrl}/api/${encodeURIComponent(name)}/auth/qr`, {
        method: "GET",
        headers: { Accept: "image/png", "X-Api-Key": this.config.apiKey },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      if (isTimeout(err)) {
        throw new WahaAdminError("TIMEOUT", "waha QR request timed out", null);
      }
      throw new WahaAdminError(
        "UNAVAILABLE",
        `waha QR request failed: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    }
    if (res.status === 404 || res.status === 422) {
      return null;
    }
    if (res.status === 429) {
      throw errorForStatus(429);
    }
    if (!res.ok) {
      throw errorForStatus(res.status);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("image/")) {
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) {
      return null;
    }
    return { bytes, contentType: contentType.split(";")[0]?.trim() ?? "image/png" };
  }
}

/** Resolve the port from env, or `null` when WAHA is not configured. */
export function resolveWahaAdminPort(env: NodeJS.ProcessEnv = process.env): HttpWahaAdminPort | null {
  const config = wahaAdminConfigFromEnv(env);
  return config === null ? null : new HttpWahaAdminPort(config);
}
