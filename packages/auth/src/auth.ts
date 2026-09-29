import { createHash, randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "@iptv/database";
import { newId, now } from "@iptv/domain";
import { hashPassword, verifyPassword } from "./passwords.js";

export interface AuthConfig {
  /**
   * Pepper for session-token hashes (`sha256(secret:token)`). Env-driven
   * (`BETTER_AUTH_SECRET`); dev default only, must be overridden in prod.
   */
  secret: string;
  baseUrl?: string;
  /** Session lifetime in hours (default 168 = 7 days). */
  sessionTtlHours?: number;
}

export class AuthError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  isPlatformAdmin: boolean;
}

export interface MembershipSummary {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  roleKey: string;
  status: string;
}

export interface SessionInfo {
  user: AuthUser;
  sessionId: string;
  activeTenantId: string | null;
  /**
   * Per-session monotonic tenant-context revision, canonical decimal string
   * (migration 023). Starts at "0", increments atomically on every tenant
   * switch. Never a JS number: BIGINT precision is preserved end-to-end.
   */
  tenantContextRevision: string;
  expiresAt: Date;
  memberships: MembershipSummary[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Postgres BIGINT range: revisions must fit to stay exactly representable. */
const MAX_TENANT_CONTEXT_REVISION = 9223372036854775807n;

/** Canonical decimal-string form: no leading zeros, no signs, no whitespace. */
const REVISION_RE = /^(0|[1-9][0-9]*)$/;

function staleContext(): AuthError {
  return new AuthError(
    409,
    "TENANT_CONTEXT_CONFLICT",
    "tenant context is stale; refresh session and retry",
  );
}

/**
 * Validate a client-supplied revision precondition. Malformed values fail
 * closed with 409 (never 400): a malformed context is indistinguishable
 * from a stale one for retry purposes.
 */
function assertTenantContextRevision(value: string): string {
  if (!REVISION_RE.test(value)) {
    throw staleContext();
  }
  let n: bigint;
  try {
    n = BigInt(value);
  } catch {
    throw staleContext();
  }
  if (n < 0n || n > MAX_TENANT_CONTEXT_REVISION) {
    throw staleContext();
  }
  return n.toString(10);
}

/** Canonicalize a BIGINT value read back from Postgres (arrives as text). */
function toTenantContextRevision(value: string | number | bigint): string {
  try {
    const n = typeof value === "bigint" ? value : BigInt(String(value).trim());
    if (n < 0n || n > MAX_TENANT_CONTEXT_REVISION) {
      throw staleContext();
    }
    return n.toString(10);
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    throw staleContext();
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (!EMAIL_RE.test(normalized)) {
    throw new AuthError(400, "INVALID_EMAIL", "invalid email address");
  }
  return normalized;
}

/** Extract a bearer token from an `Authorization` header value. */
export function bearerTokenFromHeader(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^Bearer (.+)$/.exec(value.trim());
  if (match === null || (match[1] as string).trim().length === 0) {
    return null;
  }
  return (match[1] as string).trim();
}

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  // Random tail of the UUID, NOT the timestamp head: slice(0, 8) of a
  // UUIDv7 is pure timestamp (minute-scale collision window across runs).
  const suffix = newId().replace(/-/g, "").slice(-8);
  return `${base.length > 0 ? base : "tenant"}-${suffix}`;
}

/**
 * Better Auth integration (email+password + sessions) via a custom adapter
 * mapped onto the EXISTING `control.users` table:
 * `auth_subject = 'email:<normalized-email>'`. No duplicate users table;
 * credentials live in `control.auth_credentials`, opaque sessions in
 * `control.auth_sessions` (only `sha256(secret:token)` is stored).
 */
export function createAuth(db: Kysely<Database>, config: AuthConfig): {
  hashToken: (token: string) => string;
  register: (input: {
    email: string;
    password: string;
    displayName?: string;
    tenantName?: string;
  }) => Promise<{
    token: string;
    user: AuthUser;
    activeTenantId: string | null;
    tenantContextRevision: string;
  }>;
  login: (input: { email: string; password: string }) => Promise<{
    token: string;
    user: AuthUser;
    activeTenantId: string | null;
    tenantContextRevision: string;
  }>;
  logout: (input: { token: string }) => Promise<void>;
  resolveSession: (input: { token: string }) => Promise<SessionInfo | null>;
  /**
   * Atomically switch the session's active tenant guarded by the client's
   * observed tenant-context revision (compare-and-swap): the UPDATE checks
   * `tenant_context_revision = expected` and increments it in the same
   * statement. The expected value is the already-validated request
   * precondition — never a fresh server snapshot — so a request that
   * started from revision N fails after any intervening successful switch,
   * including A -> B -> A. Exactly one concurrent update from revision N
   * wins; losers get 409 `TENANT_CONTEXT_CONFLICT` with no side effects.
   */
  setActiveTenant: (input: {
    token: string;
    tenantId: string;
    expectedTenantContextRevision: string;
  }) => Promise<{ activeTenantId: string; tenantContextRevision: string }>;
} {
  if (typeof config.secret !== "string" || config.secret.length < 16) {
    throw new Error("auth secret must be at least 16 characters (BETTER_AUTH_SECRET)");
  }
  const ttlMs = (config.sessionTtlHours ?? 168) * 3600_000;

  const hashToken = (token: string): string =>
    createHash("sha256").update(`${config.secret}:${token}`).digest("hex");

  const newToken = (): string => randomBytes(32).toString("hex");

  async function toUser(row: {
    id: string;
    display_name: string | null;
    is_platform_admin: boolean;
    email: string;
  }): Promise<AuthUser> {
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      isPlatformAdmin: row.is_platform_admin,
    };
  }

  async function listMemberships(userId: string): Promise<MembershipSummary[]> {
    const rows = await db
      .selectFrom("control.tenant_memberships as m")
      .innerJoin("control.tenants as t", "t.id", "m.tenant_id")
      .select([
        "m.tenant_id as tenant_id",
        "t.slug as tenant_slug",
        "t.name as tenant_name",
        "m.role_key as role_key",
        "m.status as status",
      ])
      .where("m.user_id", "=", userId)
      .orderBy("t.created_at", "asc")
      .execute();
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      tenantSlug: r.tenant_slug,
      tenantName: r.tenant_name,
      roleKey: r.role_key,
      status: r.status,
    }));
  }

  async function createSession(
    q: Pick<Kysely<Database>, "insertInto">,
    userId: string,
    activeTenantId: string | null,
  ): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
    const token = newToken();
    const expiresAt = new Date(now().getTime() + ttlMs);
    const inserted = await q
      .insertInto("control.auth_sessions")
      .values({
        id: newId(),
        user_id: userId,
        token_hash: hashToken(token),
        active_tenant_id: activeTenantId,
        // New sessions start at revision "0" (matches the SQL DEFAULT).
        tenant_context_revision: "0",
        expires_at: expiresAt,
        created_at: now(),
        last_seen_at: now(),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    return { token, sessionId: inserted.id, expiresAt };
  }

  return {
    hashToken,

    async register(input) {
      const email = assertEmail(input.email);
      const displayName =
        typeof input.displayName === "string" && input.displayName.trim().length > 0
          ? input.displayName.trim()
          : email.split("@")[0] as string;
      if (typeof input.password !== "string" || input.password.length < 8) {
        throw new AuthError(400, "WEAK_PASSWORD", "password must be at least 8 characters");
      }
      if (input.tenantName !== undefined && input.tenantName.trim().length === 0) {
        throw new AuthError(400, "INVALID_TENANT_NAME", "tenant name must not be blank");
      }
      const passwordHash = await hashPassword(input.password);
      try {
        return await db.transaction().execute(async (trx) => {
          // Exact-form pre-check; case variants are caught by the
          // `lower(email)` unique index at INSERT time (mapped to 409 below).
          const existing = await trx
            .selectFrom("control.auth_credentials")
            .select(["id"])
            .where("control.auth_credentials.email", "=", email)
            .executeTakeFirst();
          if (existing !== undefined) {
            throw new AuthError(409, "EMAIL_TAKEN", "email is already registered");
          }
          const user = await trx
            .insertInto("control.users")
            .values({
              id: newId(),
              auth_subject: `email:${email}`,
              display_name: displayName,
              status: "ACTIVE",
              is_platform_admin: false,
              created_at: now(),
              updated_at: now(),
            })
            .returning(["id", "display_name", "is_platform_admin"])
            .executeTakeFirstOrThrow();
          await trx
            .insertInto("control.auth_credentials")
            .values({
              id: newId(),
              user_id: user.id,
              email,
              password_hash: passwordHash,
              created_at: now(),
              updated_at: now(),
            })
            .execute();
          let activeTenantId: string | null = null;
          if (input.tenantName !== undefined) {
            const tenant = await trx
              .insertInto("control.tenants")
              .values({
                id: newId(),
                slug: slugify(input.tenantName),
                name: input.tenantName.trim(),
                status: "ACTIVE",
                default_currency: "BRL",
                timezone: "America/Sao_Paulo",
                created_at: now(),
                updated_at: now(),
              })
              .returning(["id"])
              .executeTakeFirstOrThrow();
            await trx
              .insertInto("control.tenant_memberships")
              .values({
                id: newId(),
                tenant_id: tenant.id,
                user_id: user.id,
                role_key: "tenant_owner",
                status: "ACTIVE",
                created_at: now(),
                updated_at: now(),
              })
              .execute();
            activeTenantId = tenant.id;
          }
          const session = await createSession(
            trx as Pick<Kysely<Database>, "insertInto">,
            user.id,
            activeTenantId,
          );
          return {
            token: session.token,
            user: await toUser({
              id: user.id,
              display_name: user.display_name,
              is_platform_admin: user.is_platform_admin,
              email,
            }),
            activeTenantId,
            tenantContextRevision: "0",
          };
        });
      } catch (err) {
        if (err instanceof AuthError) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (/duplicate key|unique/i.test(message)) {
          throw new AuthError(409, "EMAIL_TAKEN", "email is already registered");
        }
        throw err;
      }
    },

    async login(input) {
      const email = assertEmail(input.email);
      const cred = await db
        .selectFrom("control.auth_credentials as c")
        .innerJoin("control.users as u", "u.id", "c.user_id")
        .select([
          "c.password_hash as password_hash",
          "u.id as user_id",
          "u.display_name as display_name",
          "u.status as status",
          "u.is_platform_admin as is_platform_admin",
        ])
        .where("c.email", "=", email)
        .executeTakeFirst();
      if (cred === undefined) {
        throw new AuthError(401, "INVALID_CREDENTIALS", "invalid email or password");
      }
      const ok = await verifyPassword(input.password, cred.password_hash);
      if (!ok) {
        throw new AuthError(401, "INVALID_CREDENTIALS", "invalid email or password");
      }
      if (cred.status !== "ACTIVE") {
        throw new AuthError(403, "USER_SUSPENDED", "user is not active");
      }
      const memberships = await listMemberships(cred.user_id);
      const firstActive = memberships.find((m) => m.status === "ACTIVE") ?? null;
      const session = await createSession(
        db as Pick<Kysely<Database>, "insertInto">,
        cred.user_id,
        firstActive?.tenantId ?? null,
      );
      return {
        token: session.token,
        user: await toUser({
          id: cred.user_id,
          display_name: cred.display_name,
          is_platform_admin: cred.is_platform_admin,
          email,
        }),
        activeTenantId: firstActive?.tenantId ?? null,
        tenantContextRevision: "0",
      };
    },

    async logout(input) {
      await db
        .deleteFrom("control.auth_sessions")
        .where("token_hash", "=", hashToken(input.token))
        .execute();
    },

    async resolveSession(input) {
      const rows = await db
        .selectFrom("control.auth_sessions as s")
        .innerJoin("control.users as u", "u.id", "s.user_id")
        .leftJoin("control.auth_credentials as c", "c.user_id", "u.id")
        .select([
          "s.id as session_id",
          "s.active_tenant_id as active_tenant_id",
          "s.tenant_context_revision as tenant_context_revision",
          "s.expires_at as expires_at",
          "u.id as user_id",
          "u.display_name as display_name",
          "u.status as status",
          "u.is_platform_admin as is_platform_admin",
          "c.email as email",
        ])
        .where("s.token_hash", "=", hashToken(input.token))
        .executeTakeFirst();
      if (rows === undefined) {
        return null;
      }
      if (rows.expires_at.getTime() <= Date.now() || rows.status !== "ACTIVE") {
        return null;
      }
      const memberships = await listMemberships(rows.user_id);
      return {
        user: await toUser({
          id: rows.user_id,
          display_name: rows.display_name,
          is_platform_admin: rows.is_platform_admin,
          email: rows.email ?? "",
        }),
        sessionId: rows.session_id,
        activeTenantId: rows.active_tenant_id,
        tenantContextRevision: toTenantContextRevision(rows.tenant_context_revision),
        expiresAt: rows.expires_at,
        memberships,
      };
    },

    async setActiveTenant(input) {
      // Fail closed on a malformed precondition before any side effect.
      const expectedRevision = assertTenantContextRevision(input.expectedTenantContextRevision);
      const session = await db
        .selectFrom("control.auth_sessions as s")
        .innerJoin("control.users as u", "u.id", "s.user_id")
        .select([
          "s.id as session_id",
          "s.user_id as user_id",
          "s.expires_at as expires_at",
          "u.status as status",
          "u.is_platform_admin as is_platform_admin",
        ])
        .where("s.token_hash", "=", hashToken(input.token))
        .executeTakeFirst();
      if (session === undefined || session.expires_at.getTime() <= Date.now() || session.status !== "ACTIVE") {
        throw new AuthError(401, "UNAUTHENTICATED", "session is invalid or expired");
      }
      const tenant = await db
        .selectFrom("control.tenants")
        .select(["id"])
        .where("id", "=", input.tenantId)
        .executeTakeFirst();
      if (tenant === undefined) {
        throw new AuthError(404, "TENANT_NOT_FOUND", "tenant not found");
      }
      if (!session.is_platform_admin) {
        const membership = await db
          .selectFrom("control.tenant_memberships")
          .select(["id"])
          .where("user_id", "=", session.user_id)
          .where("tenant_id", "=", input.tenantId)
          .where("status", "=", "ACTIVE")
          .executeTakeFirst();
        if (membership === undefined) {
          throw new AuthError(403, "TENANT_FORBIDDEN", "no active membership in this tenant");
        }
      }
      // Compare-and-swap on the revision: the check and the increment are a
      // single atomic statement, so concurrent switches from one revision
      // resolve to exactly one winner (losers update zero rows -> 409).
      const updated = await db
        .updateTable("control.auth_sessions")
        .set({
          active_tenant_id: input.tenantId,
          tenant_context_revision: sql`tenant_context_revision + 1`,
          last_seen_at: now(),
        })
        .where("id", "=", session.session_id)
        .where("tenant_context_revision", "=", expectedRevision)
        .returning(["tenant_context_revision"])
        .executeTakeFirst();
      if (updated === undefined) {
        throw staleContext();
      }
      return {
        activeTenantId: input.tenantId,
        tenantContextRevision: toTenantContextRevision(updated.tenant_context_revision),
      };
    },
  };
}

export type AuthInstance = ReturnType<typeof createAuth>;
