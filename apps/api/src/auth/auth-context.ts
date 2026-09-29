import type { FastifyRequest } from "fastify";

/** Session resolved at the HTTP boundary (Bearer or `iptv_session` cookie). */
export interface RequestAuth {
  userId: string;
  sessionId: string;
  /** Raw bearer token (never persisted, never logged). */
  token: string;
  activeTenantId: string | null;
  /**
   * Authoritative per-session tenant-context revision (canonical decimal
   * string) resolved from the DB at guard time. Tenant selection and
   * permissions always derive from this server-side snapshot — never from
   * the `x-tenant-context-revision` request header, which is a staleness
   * precondition only.
   */
  tenantContextRevision: string;
  isPlatformAdmin: boolean;
  email: string;
}

/** Tenant context derived from membership — never from the request body. */
export interface RequestTenant {
  id: string;
  roleKeys: string[];
  permissions: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: RequestAuth;
    tenant?: RequestTenant;
    /** W1-12 correlation id from `traceparent` (see `observability-hook.ts`). */
    traceId?: string;
  }
}

/** Read the session token: `Authorization: Bearer` first, cookie fallback. */
export function extractSessionToken(req: FastifyRequest): string | null {
  const header = req.headers["authorization"];
  if (typeof header === "string") {
    const match = /^Bearer (.+)$/.exec(header.trim());
    if (match !== null && (match[1] as string).trim().length > 0) {
      return (match[1] as string).trim();
    }
  }
  const cookie = req.headers["cookie"];
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) {
        continue;
      }
      if (part.slice(0, eq).trim() === "iptv_session") {
        const value = part.slice(eq + 1).trim();
        if (value.length > 0) {
          return value;
        }
      }
    }
  }
  return null;
}

/**
 * Client staleness precondition for tenant-context reads/writes. The header
 * carries the revision the client observed (canonical decimal string); it
 * never selects a tenant or grants permissions — that always comes from
 * the server-side session snapshot.
 */
export const TENANT_CONTEXT_REVISION_HEADER = "x-tenant-context-revision";

/** Postgres BIGINT ceiling: revisions must stay exactly representable. */
const MAX_TENANT_CONTEXT_REVISION = 9223372036854775807n;

const REVISION_RE = /^(0|[1-9][0-9]*)$/;

/**
 * Parse the raw header value into canonical decimal form, or `null` when
 * missing/malformed/out-of-range. Fail-closed: callers treat `null` as a
 * 409 `TENANT_CONTEXT_CONFLICT`, never as "no precondition".
 */
export function parseTenantContextRevision(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!REVISION_RE.test(trimmed)) {
    return null;
  }
  try {
    const n = BigInt(trimmed);
    if (n < 0n || n > MAX_TENANT_CONTEXT_REVISION) {
      return null;
    }
    return n.toString(10);
  } catch {
    return null;
  }
}

/**
 * Routes that bootstrap/discover session state and therefore cannot require
 * the context precondition: the client calls them precisely to learn the
 * current authoritative revision. Everything else under AuthGuard requires
 * a matching `x-tenant-context-revision` header.
 */
export function isTenantContextExempt(req: FastifyRequest): boolean {
  const method = (req.method ?? "").toUpperCase();
  const path = (req.url ?? "").split("?", 1)[0] ?? "";
  if (method === "GET" && path === "/v1/auth/session") {
    return true;
  }
  if (method === "POST" && path === "/v1/auth/logout") {
    return true;
  }
  return false;
}
