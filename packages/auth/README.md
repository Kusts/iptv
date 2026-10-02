# @iptv/auth

Identity primitives for the SaaS user (Identity context): sessions,
password hashing, RBAC permissions and audit-row building. Depends on
`@iptv/database`, `@iptv/domain` and `kysely` only — no HTTP framework.

## What it is

A **custom** Better-Auth-shaped adapter, not the Better Auth library (no such
dependency). `createAuth(db, config)` maps email+password onto the existing
`control.users` table (`auth_subject = 'email:<normalized-email>'`), so there
is no duplicate users table:

- credentials in `control.auth_credentials` (scrypt hash only);
- opaque sessions in `control.auth_sessions`, storing only
  `sha256(secret:token)` — the raw token is never persisted.

Exposed surface:

- `register`, `login`, `logout`, `resolveSession`;
- `setActiveTenant` — atomic tenant switch guarded by the client's
  `expectedTenantContextRevision` (compare-and-swap that increments
  `tenant_context_revision` in the same statement). A stale or malformed
  revision fails with `409 TENANT_CONTEXT_CONFLICT`, including for `A→B→A`.
  Revisions are canonical decimal strings (BIGINT), never JS numbers.
- `hashToken`, `normalizeEmail`, `assertEmail`, `bearerTokenFromHeader`,
  `AuthError`.
- RBAC: `PERMISSIONS` (catalog mirroring migration 012 + 021 + 039 seeds),
  `ROLE_PERMISSIONS`, the `platform_admin` / `tenant_owner` / `tenant_admin` /
  `tenant_operator` roles, `hasPermission`, `requirePermission`,
  `resolveActor`, `ForbiddenError`.
- Passwords: `hashPassword` / `verifyPassword` (scrypt `N=16384, r=8, p=1`,
  per-password random salt, constant-time compare) and
  `assertPasswordPolicy` (minimum 8 characters).
- Audit: `AUDIT_ACTOR_TYPES` (`system`/`agent`/`human`/`external`),
  `buildAuditRow`, `writeAudit` for the append-only `platform.audit_log`.

## Usage

```ts
import { createAuth } from "@iptv/auth";

const auth = createAuth(db, { secret: process.env.BETTER_AUTH_SECRET!, baseUrl });
const { token, user, activeTenantId, tenantContextRevision } = await auth.login({ email, password });
```

## Env

`BETTER_AUTH_SECRET` (min 16 characters) is the session-token pepper; it must
be overridden in production. `BETTER_AUTH_URL` is the optional auth base URL.
Both are read in `apps/api/src/app.module.ts` and validated by
`@iptv/config`.

## Notes

- `User` here is the authenticated SaaS user, never a CRM `Person`.
- Role catalog is global; tenant scoping lives in the assignments
  (`tenant_memberships.role_key` + `membership_roles`). The platform-role
  bypass applies only to platform admins.
- Keep `ROLE_PERMISSIONS` in sync with the migration 012/021/039 seeds; new
  permissions need a migration seed plus this catalog.