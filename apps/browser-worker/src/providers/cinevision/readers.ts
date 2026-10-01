/**
 * Semantic CINEVISION readers (FASE 1, GET-only, `API_IN_BROWSER`).
 *
 * One function per capability with OBSERVED live evidence (see
 * `docs/11-research/cinevision-api-investigation-2026-09-30.md`).
 * Omitted on purpose: `READ_SERVER` detail/packages/bouquets and
 * `READ_PLAYLIST` (UNCONFIRMED, never observed live; playlist is also
 * SPEC-blocked), `CALCULATE_*` (UNCONFIRMED POST), all writes, and the
 * reseller surface (inactive 402 / UNCONFIRMED). `readCustomerStatus`,
 * `readConnections`, and `readCreditBalance` are derived from the same
 * live responses as their parents — no separate endpoint exists.
 */

import {
  fetchCapability,
  type CapabilityParams,
  type CinevisionInPage,
  type ReadCapability,
} from "./api-client.js";
import {
  classifyHttpFailure,
  httpError,
  isJsonContentType,
  transportError,
  type ReaderResult,
} from "./errors.js";
import {
  parseCustomer,
  parseCustomerPage,
  parseIdentity,
  parseIntegrationList,
  parseLiveConnectionPage,
  parsePackagePriceList,
  parseServerList,
  parseServerStatusList,
  type CustomerPage,
  type CustomerResult,
  type IdentityResult,
  type IntegrationSummary,
  type LiveConnectionPage,
  type PackagePrice,
  type ParseResult,
  type ServerStatus,
  type ServerSummary,
} from "./schemas.js";

export interface ReaderDeps {
  page: CinevisionInPage;
  allowedOrigin: string;
  timeoutMs?: number;
}

export interface ListArgs {
  perPage?: number;
  page?: number;
}

export interface CustomerArgs {
  customerId: string;
}

export interface LiveConnectionsArgs {
  serverId: string;
  perPage?: number;
  page?: number;
}

/** Derived customer status (from `READ_CUSTOMER` fields, no own endpoint). */
export interface CustomerStatus {
  status: string;
  expiresAt: string | null;
  isTrial: boolean;
}

/** Derived connection allowance (contracted limit, NOT live sessions). */
export interface ConnectionAllowance {
  connections: number | null;
  hasMultipleConnections: boolean | null;
}

async function runRead<T>(
  deps: ReaderDeps,
  capability: ReadCapability,
  params: CapabilityParams | undefined,
  parse: (body: unknown) => ParseResult<T>,
): Promise<ReaderResult<T>> {
  let res;
  try {
    res =
      deps.timeoutMs === undefined
        ? await fetchCapability(
            { page: deps.page, allowedOrigin: deps.allowedOrigin },
            capability,
            params,
          )
        : await fetchCapability(
            { page: deps.page, allowedOrigin: deps.allowedOrigin, timeoutMs: deps.timeoutMs },
            capability,
            params,
          );
  } catch {
    // Programmer errors only (invalid params/origin throw before any
    // `evaluate`): fixed words only. Browser runtime rejections never
    // reach here — `fetchCapability` maps them to transport data.
    return {
      ok: false,
      error: httpError("BAD_RESPONSE", "invalid reader args", {
        status: null,
        contentType: "",
        path: capability,
        durationMs: 0,
        schema: "NOT_EVALUATED",
      }),
    };
  }
  if (res.transportFailed || res.status === null) {
    return { ok: false, error: transportError(res.path, res.durationMs) };
  }
  const status = res.status;
  if (status < 200 || status > 299) {
    const code = classifyHttpFailure({
      status,
      contentType: res.contentType,
      html: res.html,
    });
    return {
      ok: false,
      error: httpError(code, "provider error status", {
        status,
        contentType: res.contentType,
        path: res.path,
        durationMs: res.durationMs,
        schema: "NOT_EVALUATED",
      }),
    };
  }
  if (res.html !== null || !isJsonContentType(res.contentType)) {
    return {
      ok: false,
      error: httpError("BAD_RESPONSE", "expected json response", {
        status,
        contentType: res.contentType,
        path: res.path,
        durationMs: res.durationMs,
        schema: "BAD_RESPONSE",
      }),
    };
  }
  if (res.body === null) {
    return {
      ok: false,
      error: httpError("BAD_RESPONSE", "invalid json body", {
        status,
        contentType: res.contentType,
        path: res.path,
        durationMs: res.durationMs,
        schema: "BAD_RESPONSE",
      }),
    };
  }
  const parsed = parse(res.body);
  if (!parsed.ok) {
    return {
      ok: false,
      error: httpError("BAD_RESPONSE", parsed.reason, {
        status,
        contentType: res.contentType,
        path: res.path,
        durationMs: res.durationMs,
        schema: "BAD_RESPONSE",
      }),
    };
  }
  return {
    ok: true,
    data: parsed.value,
    evidence: {
      status,
      contentType: res.contentType,
      path: res.path,
      durationMs: res.durationMs,
      schema: "ok",
    },
  };
}

/** `GET /api/auth/me` — sanitized identity snapshot (no token). */
export function readIdentity(deps: ReaderDeps): Promise<ReaderResult<IdentityResult>> {
  return runRead(deps, "identity", undefined, parseIdentity);
}

/** `credits` field of `GET /api/auth/me` (unit/precision unknown). */
export function readCreditBalance(deps: ReaderDeps): Promise<ReaderResult<number>> {
  return runRead(deps, "identity", undefined, (body) => {
    const parsed = parseIdentity(body);
    if (!parsed.ok) return parsed;
    if (parsed.value.credits === null) return { ok: false, reason: "credits: expected number" };
    return { ok: true, value: parsed.value.credits };
  });
}

/** `GET /api/customers` — paginated customer snapshots. */
export function listCustomers(
  deps: ReaderDeps,
  args?: ListArgs,
): Promise<ReaderResult<CustomerPage>> {
  const params: CapabilityParams = {};
  if (args?.perPage !== undefined) params.perPage = args.perPage;
  if (args?.page !== undefined) params.page = args.page;
  return runRead(deps, "customers", params, parseCustomerPage);
}

/** `GET /api/customers/{id}` — single customer snapshot. */
export function readCustomer(
  deps: ReaderDeps,
  args: CustomerArgs,
): Promise<ReaderResult<CustomerResult>> {
  return runRead(deps, "customer", { customerId: args.customerId }, (body) => {
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      const envelope = body as Record<string, unknown>;
      // Live evidence: `data` IS the customer object (no `data.customer`).
      if ("data" in envelope) return parseCustomer(envelope["data"]);
    }
    return parseCustomer(body);
  });
}

/** Derived from `readCustomer` fields (status/expires_at/is_trial). */
export async function readCustomerStatus(
  deps: ReaderDeps,
  args: CustomerArgs,
): Promise<ReaderResult<CustomerStatus>> {
  const customer = await readCustomer(deps, args);
  if (!customer.ok) return customer;
  return {
    ok: true,
    data: {
      status: customer.data.status,
      expiresAt: customer.data.expiresAt,
      isTrial: customer.data.isTrial,
    },
    evidence: customer.evidence,
  };
}

/** Derived allowance (contracted limit, NOT live sessions). */
export async function readConnections(
  deps: ReaderDeps,
  args: CustomerArgs,
): Promise<ReaderResult<ConnectionAllowance>> {
  const customer = await readCustomer(deps, args);
  if (!customer.ok) return customer;
  return {
    ok: true,
    data: {
      connections: customer.data.connections,
      hasMultipleConnections: customer.data.hasMultipleConnections,
    },
    evidence: customer.evidence,
  };
}

/** `GET /api/servers` — server catalog snapshot. */
export function listServers(deps: ReaderDeps): Promise<ReaderResult<ServerSummary[]>> {
  return runRead(deps, "servers", undefined, parseServerList);
}

/** `GET /api/servers/status` — status entries (observed: `name` only). */
export function readServerStatus(deps: ReaderDeps): Promise<ReaderResult<ServerStatus[]>> {
  return runRead(deps, "serverStatus", undefined, parseServerStatusList);
}

/** `GET /api/packages/price` — package price table snapshot. */
export function listPackagePrices(deps: ReaderDeps): Promise<ReaderResult<PackagePrice[]>> {
  return runRead(deps, "packagePrices", undefined, parsePackagePriceList);
}

/** `GET /api/customers/live-connections/{serverId}` — live sessions. */
export function readLiveConnections(
  deps: ReaderDeps,
  args: LiveConnectionsArgs,
): Promise<ReaderResult<LiveConnectionPage>> {
  const params: CapabilityParams = { serverId: args.serverId };
  if (args.perPage !== undefined) params.perPage = args.perPage;
  if (args.page !== undefined) params.page = args.page;
  return runRead(deps, "liveConnections", params, parseLiveConnectionPage);
}

/** `GET /api/integrations` — integration catalog snapshot. */
export function listIntegrations(deps: ReaderDeps): Promise<ReaderResult<IntegrationSummary[]>> {
  return runRead(deps, "integrations", undefined, parseIntegrationList);
}
