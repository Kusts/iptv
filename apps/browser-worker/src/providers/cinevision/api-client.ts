/**
 * Bounded in-page API client (`API_IN_BROWSER`, GET-only, FASE 1).
 *
 * The Bearer session token lives in page `localStorage` and never leaves
 * the browser: the in-page closure validates origin and path BEFORE
 * touching storage, then parses and projects the response INSIDE the
 * page — only allowlisted primitive fields (never `token`) cross into
 * the process. Same-origin is guaranteed by the caller (`allowedOrigin`
 * from the validated config); every URL is rebuilt from a closed
 * capability map.
 *
 * Serialization rule (R1): `fetchProjectedInPage` and
 * `cancelInPageFetch` are TOTALMENTE autocontidas — zero references to
 * module identifiers. All constants/regex/helpers are inline in the
 * function body; only serializable arguments cross `evaluate`.
 */

/** Field projection applied inside the page per capability. */
export interface InPageProjection {
  /** Unwrap this envelope key before picking (lists and singletons). */
  unwrap?: "data";
  /** Allowlisted fields to keep (primitive-only pick, per item for arrays). */
  pick: string[];
  /** Keep the pagination `meta` alongside projected `data`. */
  keepMeta?: boolean;
}

/** Structured request executed inside the page (no arbitrary URLs). */
export interface InPageRequest {
  allowedOrigin: string;
  /** Relative path+query from the closed capability map. */
  path: string;
  /**
   * Exact expected path for this capability (built by `fetchCapability`
   * from the closed map). The in-page gate requires strict equality
   * `path === expectedPath` before touching the token — any drift is
   * denied without reading storage.
   */
  expectedPath: string;
  projection: InPageProjection;
  timeoutMs: number;
  /**
   * Per-call id for abort propagation. The in-page call registers its
   * `AbortController` under this id and removes it in `finally`; an
   * external abort fires a second short `evaluate` that aborts it.
   */
  callId?: string;
}

/** Structured HTML evidence computed in-page (never raw text). */
export interface InPageHtmlSignals {
  title: string;
  hasChallengeScript: boolean;
  markers: string[];
}

/** Serializable in-page outcome (no tokens, no raw bodies). */
export type InPageResult =
  | { kind: "ok"; status: number; contentType: string; data: unknown }
  | {
      kind: "html";
      status: number;
      contentType: string;
      title: string;
      hasChallengeScript: boolean;
      markers: string[];
    }
  | { kind: "denied" }
  | { kind: "transport" };

/**
 * Minimal page surface: run `fn` inside the page with a structured
 * request. Mirrors the `fetchIdentity` pattern in `browser.ts`
 * (same-origin fetch with the session Bearer from `localStorage`), kept
 * structural so unit tests can fake it without Playwright. The same
 * `evaluate` entry is reused for the short cancel call (with an
 * explicit cast at the call site — the real Playwright `evaluate` is
 * generic; fakes forward any `fn`/`arg` pair).
 */
export interface CinevisionInPage {
  evaluate(
    fn: (req: InPageRequest) => Promise<InPageResult>,
    req: InPageRequest,
  ): Promise<InPageResult>;
}

/** Closed capability map: fixed path per read, GET only. */
export type ReadCapability =
  | "identity"
  | "customers"
  | "customer"
  | "servers"
  | "serverStatus"
  | "packagePrices"
  | "liveConnections"
  | "integrations";

export interface CapabilityParams {
  customerId?: string;
  serverId?: string;
  perPage?: number;
  page?: number;
}

export interface FetchDeps {
  page: CinevisionInPage;
  allowedOrigin: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Default per-call bound (overridable per call, injectable in tests). */
export const DEFAULT_TIMEOUT_MS = 15000;

export interface CapabilityResponse {
  /** Relative path+query actually requested (no origin, no secrets). */
  path: string;
  /** HTTP status, or null when transport failed before observation. */
  status: number | null;
  contentType: string;
  /** Projected JSON payload (allowlisted fields only, never the token). */
  body: unknown;
  /** Structured HTML signals (set when the response is not JSON). */
  html: InPageHtmlSignals | null;
  transportFailed: boolean;
  durationMs: number;
}

export class CapabilityParamError extends Error {
  constructor() {
    super("cinevision api-client: invalid capability params");
    this.name = "CapabilityParamError";
  }
}

/** Tenant-safe id shape (same class as the worker config ids). */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function reqId(value: string | undefined): string {
  if (value === undefined || !ID_RE.test(value)) throw new CapabilityParamError();
  return value;
}

function pageParam(value: number | undefined, fallback: number): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new CapabilityParamError();
  return n;
}

/** Build the relative path+query for a capability (closed map, GET only). */
export function buildApiPath(capability: ReadCapability, params?: CapabilityParams): string {
  switch (capability) {
    case "identity":
      return "/api/auth/me";
    case "customers": {
      const query = new URLSearchParams({
        perPage: String(pageParam(params?.perPage, 25)),
        page: String(pageParam(params?.page, 1)),
      });
      return `/api/customers?${query.toString()}`;
    }
    case "customer":
      return `/api/customers/${encodeURIComponent(reqId(params?.customerId))}`;
    case "servers":
      return "/api/servers";
    case "serverStatus":
      return "/api/servers/status";
    case "packagePrices":
      return "/api/packages/price";
    case "liveConnections": {
      const query = new URLSearchParams({
        perPage: String(pageParam(params?.perPage, 25)),
        page: String(pageParam(params?.page, 1)),
      });
      return `/api/customers/live-connections/${encodeURIComponent(reqId(params?.serverId))}?${query.toString()}`;
    }
    case "integrations":
      return "/api/integrations";
  }
}

const ORIGIN_RE = /^https:\/\/[^/]+$/;

/**
 * Build the absolute request URL. Rejects non-https origins, non-`/api/`
 * paths, and any resolved URL escaping the allowlist origin.
 */
export function buildApiUrl(allowedOrigin: string, path: string): string {
  if (!ORIGIN_RE.test(allowedOrigin)) throw new CapabilityParamError();
  if (!path.startsWith("/api/")) throw new CapabilityParamError();
  const url = new URL(path, allowedOrigin).toString();
  if (!url.startsWith(`${allowedOrigin}/`)) throw new CapabilityParamError();
  return url;
}

const CUSTOMER_PICK = [
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
];

/** Per-capability projection (`token` is never pickable). */
const PROJECTIONS: Record<ReadCapability, InPageProjection> = {
  identity: { pick: ["id", "username", "credits"] },
  customers: { unwrap: "data", pick: CUSTOMER_PICK, keepMeta: true },
  customer: { unwrap: "data", pick: CUSTOMER_PICK },
  servers: { unwrap: "data", pick: ["id", "name"] },
  serverStatus: { unwrap: "data", pick: ["name"] },
  packagePrices: {
    unwrap: "data",
    pick: ["id", "server_id", "name", "status", "is_trial", "plan_price", "credits", "duration"],
  },
  liveConnections: {
    unwrap: "data",
    pick: [
      "id",
      "user_username",
      "max_connections",
      "reseller_username",
      "stream_display_name",
      "user_agent",
      "date_start_timestamp",
    ],
    keepMeta: true,
  },
  integrations: { unwrap: "data", pick: ["id", "is_active"] },
};

/**
 * Abort a registered in-page fetch by call id. Runs INSIDE the page via
 * a second short `evaluate`. Fully self-contained (no module refs);
 * missing ids are a no-op and never throw.
 */
export function cancelInPageFetch(callId: string): void {
  const g = globalThis as unknown as {
    __cvAbortRegistry?: Record<string, { abort(): void } | undefined>;
  };
  try {
    g.__cvAbortRegistry?.[callId]?.abort();
  } catch {
    // Non-fatal: the in-page timeout remains the backstop.
  }
}

let callSeq = 0;

function nextCallId(): string {
  callSeq += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `cv-${Date.now().toString(36)}-${callSeq.toString(36)}-${rand}`;
}

/**
 * Secure in-page GET (runs INSIDE the page via `evaluate`).
 *
 * SERIALIZATION CONTRACT: this function body MUST NOT reference any
 * module-level identifier (`ORIGIN_RE`, `DEFAULT_TIMEOUT_MS`,
 * `isJsonContentType`, `CHALLENGE_*`, `INTERSTITIAL_*`,
 * `applyProjection`, `pickOne`, `cancelInPageFetch`, …). Every
 * constant, regex, and helper is inline; only globals (`fetch`, `URL`,
 * `AbortController`, `setTimeout`, `clearTimeout`, `JSON`, `globalThis`)
 * and the serializable `req` argument are used. The isolation harness
 * in `test/cinevision/api-client.test.ts` reconstructs this function
 * from `fn.toString()` in a scope without module bindings and must
 * keep passing.
 *
 * The security gate runs FIRST — origin allowlist, exact expected-path
 * equality (`path === expectedPath`), and final-URL identity — and any
 * denial returns before `localStorage`/token is touched. JSON is parsed
 * and projected in-page (allowlisted PRIMITIVE fields only; nested
 * objects/arrays are discarded; `meta` by explicit pagination
 * allowlist); HTML yields structured signals computed from the
 * RESPONSE body text only (never `document.*`, never raw text).
 *
 * Exported for unit tests via the module only (never via the provider
 * barrel for the fetch itself; `cancelInPageFetch` is exported for the
 * abort path).
 */
export async function fetchProjectedInPage(req: InPageRequest): Promise<InPageResult> {
  const scope = globalThis as unknown as {
    location?: { origin?: unknown };
    localStorage?: { getItem(key: string): string | null };
  };
  if (typeof req.allowedOrigin !== "string" || !/^https:\/\/[^/]+$/.test(req.allowedOrigin)) {
    return { kind: "denied" };
  }
  const expectedRaw = (req as unknown as { expectedPath?: unknown }).expectedPath;
  if (typeof expectedRaw !== "string") {
    return { kind: "denied" };
  }
  const expectedPath: string = expectedRaw;
  if (
    typeof req.path !== "string" ||
    !req.path.startsWith("/api/") ||
    req.path.includes("..") ||
    !expectedPath.startsWith("/api/") ||
    expectedPath.includes("..")
  ) {
    return { kind: "denied" };
  }
  if (req.path !== expectedPath) {
    return { kind: "denied" };
  }
  const pageOrigin =
    typeof scope.location?.origin === "string" ? scope.location.origin : undefined;
  if (pageOrigin !== req.allowedOrigin) return { kind: "denied" };
  let url: string;
  try {
    url = new URL(req.path, req.allowedOrigin).toString();
  } catch {
    return { kind: "denied" };
  }
  if (url !== `${req.allowedOrigin}${expectedPath}`) return { kind: "denied" };

  // Gate passed: the session token may now be read (in-page only).
  const token = scope.localStorage?.getItem("token");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (typeof token === "string" && token.length > 0) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const rawTimeout = req.timeoutMs;
  const timeoutMs =
    typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : 15000;
  const callIdRaw = (req as unknown as { callId?: unknown }).callId;
  const callId: string | null =
    typeof callIdRaw === "string" && callIdRaw.length > 0 ? callIdRaw : null;
  const controller = new AbortController();
  if (callId !== null) {
    const g = globalThis as unknown as {
      __cvAbortRegistry?: Record<string, AbortController>;
    };
    if (typeof g.__cvAbortRegistry !== "object" || g.__cvAbortRegistry === null) {
      g.__cvAbortRegistry = {};
    }
    (g.__cvAbortRegistry as Record<string, AbortController>)[callId] = controller;
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, redirect: "manual", signal: controller.signal });
    const contentType = response.headers.get("content-type") ?? "";
    const status = response.status;
    const isJson = contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
    if (!isJson) {
      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch {
        bodyText = "";
      }
      const titleMatch = bodyText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title =
        typeof titleMatch?.[1] === "string" ? (titleMatch[1] as string).trim().slice(0, 500) : "";
      const lower = bodyText.toLowerCase();
      const fullBlocks = lower.match(/<script\b[^>]*>[\s\S]*?<\/script\s*>/g) ?? [];
      const openTags = lower.match(/<script\b[^>]*>/g) ?? [];
      const scriptFamilies: string[] = ["challenge-platform", "turnstile", "cf-challenge"];
      let hasChallengeScript = false;
      for (const block of fullBlocks) {
        for (const family of scriptFamilies) {
          if (block.includes(family)) {
            hasChallengeScript = true;
            break;
          }
        }
        if (hasChallengeScript) break;
      }
      if (!hasChallengeScript) {
        for (const tag of openTags) {
          for (const family of scriptFamilies) {
            if (tag.includes(family)) {
              hasChallengeScript = true;
              break;
            }
          }
          if (hasChallengeScript) break;
        }
      }
      const htmlNoScripts = lower
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/g, "")
        .replace(/<script\b[^>]*>/g, "");
      const markers: string[] = [];
      if (htmlNoScripts.includes("cf-mitigated") && !markers.includes("cf-mitigated")) {
        markers.push("cf-mitigated");
      }
      if (/<form[\s>/]/.test(htmlNoScripts) && !markers.includes("<form")) {
        markers.push("<form");
      }
      const phraseMarkers: string[] = [
        "checking your browser",
        "verify you are human",
        "attention required",
      ];
      for (const marker of phraseMarkers) {
        if (htmlNoScripts.includes(marker) && !markers.includes(marker)) {
          markers.push(marker);
        }
      }
      const mitigated = response.headers.get("cf-mitigated");
      if (
        typeof mitigated === "string" &&
        mitigated.length > 0 &&
        !markers.includes("cf-mitigated")
      ) {
        markers.push("cf-mitigated");
      }
      return { kind: "html", status, contentType, title, hasChallengeScript, markers };
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { kind: "transport" };
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { kind: "ok", status, contentType, data: null };
    }
    const projection = req.projection as unknown as {
      unwrap?: unknown;
      pick?: unknown;
      keepMeta?: unknown;
    };
    const pickList: string[] = Array.isArray(projection.pick)
      ? (projection.pick as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    const metaAllow: string[] = [
      "current_page",
      "last_page",
      "per_page",
      "total",
      "from",
      "to",
    ];
    const pickPrimitive = (entry: unknown): Record<string, unknown> | null => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
      const src = entry as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of pickList) {
        if (!(key in src)) continue;
        const value: unknown = src[key];
        if (
          value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          out[key] = value;
        }
      }
      return out;
    };
    if (projection.unwrap === "data") {
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { kind: "ok", status, contentType, data: { data: null } };
      }
      const root = parsed as Record<string, unknown>;
      const inner: unknown = root["data"];
      if (Array.isArray(inner)) {
        const items: Array<Record<string, unknown> | null> = [];
        for (const item of inner) {
          items.push(pickPrimitive(item));
        }
        if (projection.keepMeta === true) {
          const metaRaw: unknown = root["meta"];
          if (metaRaw !== null && typeof metaRaw === "object" && !Array.isArray(metaRaw)) {
            const metaSrc = metaRaw as Record<string, unknown>;
            const metaOut: Record<string, unknown> = {};
            for (const key of metaAllow) {
              if (!(key in metaSrc)) continue;
              const value: unknown = metaSrc[key];
              if (
                value === null ||
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean"
              ) {
                metaOut[key] = value;
              }
            }
            return { kind: "ok", status, contentType, data: { data: items, meta: metaOut } };
          }
          return { kind: "ok", status, contentType, data: { data: items, meta: null } };
        }
        return { kind: "ok", status, contentType, data: { data: items } };
      }
      if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
        return { kind: "ok", status, contentType, data: { data: pickPrimitive(inner) } };
      }
      return { kind: "ok", status, contentType, data: { data: null } };
    }
    return { kind: "ok", status, contentType, data: pickPrimitive(parsed) };
  } catch {
    return { kind: "transport" };
  } finally {
    clearTimeout(timer);
    if (callId !== null) {
      try {
        const g = globalThis as unknown as {
          __cvAbortRegistry?: Record<string, unknown>;
        };
        if (typeof g.__cvAbortRegistry === "object" && g.__cvAbortRegistry !== null) {
          delete (g.__cvAbortRegistry as Record<string, unknown>)[callId];
        }
      } catch {
        // Registry cleanup is best-effort.
      }
    }
  }
}

/**
 * Execute one bounded capability read. Never throws for transport or
 * HTTP outcomes (those are data); throws only for programmer errors
 * (invalid params/origin, before any `evaluate`). A rejected `evaluate`
 * (closed page, destroyed context) collapses to transport data.
 */
export async function fetchCapability(
  deps: FetchDeps,
  capability: ReadCapability,
  params?: CapabilityParams,
): Promise<CapabilityResponse> {
  const path = buildApiPath(capability, params);
  buildApiUrl(deps.allowedOrigin, path);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new CapabilityParamError();

  const fail = (durationMs: number): CapabilityResponse => ({
    path,
    status: null,
    contentType: "",
    body: null,
    html: null,
    transportFailed: true,
    durationMs,
  });

  // Pre-aborted: never start the in-page work.
  if (deps.signal?.aborted === true) return fail(0);

  const started = Date.now();
  const callId = nextCallId();
  const req: InPageRequest = {
    allowedOrigin: deps.allowedOrigin,
    path,
    expectedPath: path,
    projection: PROJECTIONS[capability],
    timeoutMs,
    callId,
  };
  const fireCancel = (): void => {
    try {
      const generic = deps.page as unknown as {
        evaluate(fn: (id: string) => void, id: string): Promise<unknown>;
      };
      generic.evaluate(cancelInPageFetch, callId).catch(() => undefined);
    } catch {
      // Non-fatal: the in-page timeout remains the backstop.
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const responsePromise = deps.page
      .evaluate(fetchProjectedInPage, req)
      .then((result) => ({ kind: "response" as const, result }));
    const pending: Promise<
      { kind: "response"; result: InPageResult } | { kind: "timeout" } | { kind: "aborted" }
    >[] = [
      responsePromise,
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ];
    if (deps.signal !== undefined) {
      const signal = deps.signal;
      pending.push(
        new Promise<{ kind: "aborted" }>((resolve) => {
          onAbort = () => {
            fireCancel();
            resolve({ kind: "aborted" });
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }
    const settled = await Promise.race(pending);
    const durationMs = Date.now() - started;
    if (settled.kind !== "response") {
      // Outer timeout: also nudge the in-page fetch (best-effort).
      fireCancel();
      return fail(durationMs);
    }
    const result = settled.result;
    if (result.kind === "transport" || result.kind === "denied") return fail(durationMs);
    if (result.kind === "html") {
      return {
        path,
        status: result.status,
        contentType: result.contentType,
        body: null,
        html: {
          title: result.title,
          hasChallengeScript: result.hasChallengeScript,
          markers: result.markers,
        },
        transportFailed: false,
        durationMs,
      };
    }
    return {
      path,
      status: result.status,
      contentType: result.contentType,
      body: result.data,
      html: null,
      transportFailed: false,
      durationMs,
    };
  } catch {
    // Browser runtime rejection (closed page, destroyed context).
    return fail(Date.now() - started);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined && deps.signal !== undefined) {
      deps.signal.removeEventListener("abort", onAbort);
    }
  }
}
