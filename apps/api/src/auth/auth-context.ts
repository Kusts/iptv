import type { FastifyRequest } from "fastify";

/** Session resolved at the HTTP boundary (Bearer or `iptv_session` cookie). */
export interface RequestAuth {
  userId: string;
  sessionId: string;
  /** Raw bearer token (never persisted, never logged). */
  token: string;
  activeTenantId: string | null;
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
