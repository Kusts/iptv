-- AI Revenue & Operations Platform
-- Migration 012: Identity RBAC + auth sessions (User = authenticated SaaS user, never Person)
--
-- Design notes:
-- - `control.users` is the single user table (Better Auth custom-adapter mapping:
--   `auth_subject = 'email:<normalized-email>'`). No duplicate users table.
-- - `control.roles` / `control.permissions` / `control.role_permissions` are
--   GLOBAL catalogs (platform + tenant role templates), hence exempt from the
--   tenant-owned `tenant_id NOT NULL + UNIQUE(tenant_id, id)` rule that applies
--   to tenant-owned rows. Tenant scoping lives in the ASSIGNMENTS
--   (`control.tenant_memberships.role_key` + `control.membership_roles`).
-- - `control.membership_roles` IS tenant-owned: tenant_id NOT NULL +
--   UNIQUE(tenant_id, id), tenant match enforced by trigger.
-- - `control.auth_credentials` / `control.auth_sessions` are user-scoped
--   (global Identity context, like `control.users`), not tenant-owned.
-- - Platform-role separation: `control.users.is_platform_admin` (platform admin
--   bypass) is distinct from tenant roles (`scope = 'TENANT'`).
-- - Passwords: only scrypt hashes in `password_hash`; never plaintext.
-- - No Postgres ENUM types: all constrained text uses CHECK constraints.

BEGIN;

-- Platform admin flag on the existing users table (roll-forward ALTER only).
ALTER TABLE control.users
    ADD COLUMN is_platform_admin boolean NOT NULL DEFAULT false;

-- Global permission catalog.
CREATE TABLE control.permissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT permissions_key_not_blank CHECK (btrim(key) <> ''),
    CONSTRAINT permissions_key_unique UNIQUE (key)
);

-- Global role catalog with platform/tenant separation.
CREATE TABLE control.roles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key text NOT NULL,
    scope text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT roles_key_not_blank CHECK (btrim(key) <> ''),
    CONSTRAINT roles_scope_check CHECK (scope IN ('PLATFORM','TENANT')),
    CONSTRAINT roles_key_unique UNIQUE (key)
);

-- Global role -> permission mapping.
CREATE TABLE control.role_permissions (
    role_key text NOT NULL REFERENCES control.roles (key),
    permission_key text NOT NULL REFERENCES control.permissions (key),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT role_permissions_pk PRIMARY KEY (role_key, permission_key)
);

-- Tenant-scoped extra role bindings on top of memberships.role_key.
CREATE TABLE control.membership_roles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants (id),
    membership_id uuid NOT NULL REFERENCES control.tenant_memberships (id) ON DELETE CASCADE,
    role_key text NOT NULL REFERENCES control.roles (key),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT membership_roles_tenant_id_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT membership_roles_binding_unique UNIQUE (membership_id, role_key)
);

CREATE INDEX membership_roles_tenant_membership_idx
    ON control.membership_roles (tenant_id, membership_id);
CREATE INDEX membership_roles_tenant_role_idx
    ON control.membership_roles (tenant_id, role_key);

-- Enforce that a binding's tenant matches its membership's tenant.
CREATE OR REPLACE FUNCTION control.enforce_membership_role_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    membership_tenant uuid;
BEGIN
    SELECT tenant_id INTO membership_tenant
      FROM control.tenant_memberships
     WHERE id = NEW.membership_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'membership % not found', NEW.membership_id;
    END IF;
    IF membership_tenant <> NEW.tenant_id THEN
        RAISE EXCEPTION 'membership % belongs to tenant %, not %',
            NEW.membership_id, membership_tenant, NEW.tenant_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER membership_roles_tenant_match
BEFORE INSERT OR UPDATE ON control.membership_roles
FOR EACH ROW EXECUTE FUNCTION control.enforce_membership_role_tenant();

-- Email+password credentials mapped onto control.users (custom adapter).
CREATE TABLE control.auth_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES control.users (id) ON DELETE CASCADE,
    email text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT auth_credentials_email_not_blank CHECK (btrim(email) <> ''),
    CONSTRAINT auth_credentials_email_shape_check CHECK (position('@' IN email) > 1),
    CONSTRAINT auth_credentials_hash_not_blank CHECK (btrim(password_hash) <> ''),
    CONSTRAINT auth_credentials_user_unique UNIQUE (user_id)
);

-- Case-insensitive email uniqueness without extra extensions.
CREATE UNIQUE INDEX auth_credentials_email_unique
    ON control.auth_credentials (lower(email));

-- Opaque sessions: only the sha256 of the bearer token is stored.
CREATE TABLE control.auth_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES control.users (id) ON DELETE CASCADE,
    token_hash text NOT NULL,
    active_tenant_id uuid REFERENCES control.tenants (id),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT auth_sessions_token_not_blank CHECK (btrim(token_hash) <> ''),
    CONSTRAINT auth_sessions_token_unique UNIQUE (token_hash)
);

CREATE INDEX auth_sessions_user_idx
    ON control.auth_sessions (user_id, expires_at DESC);

-- Seed: permission catalog (small but real).
INSERT INTO control.permissions (key, description) VALUES
    ('crm.person.read', 'Read CRM persons'),
    ('crm.lead.write', 'Create and update leads'),
    ('conversation.reply', 'Reply to conversations'),
    ('settings.manage', 'Manage tenant settings'),
    ('tenant.member.manage', 'Manage tenant members and role bindings'),
    ('billing.read', 'Read billing data'),
    ('audit.read', 'Read the tenant audit trail'),
    ('support.ticket.write', 'Work support tickets')
ON CONFLICT (key) DO NOTHING;

-- Seed: role catalog with platform-role separation.
INSERT INTO control.roles (key, scope, description) VALUES
    ('platform_admin', 'PLATFORM', 'Platform administrator (cross-tenant bypass, never a tenant role)'),
    ('tenant_owner', 'TENANT', 'Full tenant administration'),
    ('tenant_admin', 'TENANT', 'Tenant administration except audit-trail reads'),
    ('tenant_operator', 'TENANT', 'Day-to-day operational work, no settings or member management')
ON CONFLICT (key) DO NOTHING;

-- Seed: role -> permission mapping.
INSERT INTO control.role_permissions (role_key, permission_key) VALUES
    ('platform_admin', 'crm.person.read'),
    ('platform_admin', 'crm.lead.write'),
    ('platform_admin', 'conversation.reply'),
    ('platform_admin', 'settings.manage'),
    ('platform_admin', 'tenant.member.manage'),
    ('platform_admin', 'billing.read'),
    ('platform_admin', 'audit.read'),
    ('platform_admin', 'support.ticket.write'),
    ('tenant_owner', 'crm.person.read'),
    ('tenant_owner', 'crm.lead.write'),
    ('tenant_owner', 'conversation.reply'),
    ('tenant_owner', 'settings.manage'),
    ('tenant_owner', 'tenant.member.manage'),
    ('tenant_owner', 'billing.read'),
    ('tenant_owner', 'audit.read'),
    ('tenant_owner', 'support.ticket.write'),
    ('tenant_admin', 'crm.person.read'),
    ('tenant_admin', 'crm.lead.write'),
    ('tenant_admin', 'conversation.reply'),
    ('tenant_admin', 'settings.manage'),
    ('tenant_admin', 'tenant.member.manage'),
    ('tenant_admin', 'billing.read'),
    ('tenant_admin', 'support.ticket.write'),
    ('tenant_operator', 'crm.person.read'),
    ('tenant_operator', 'crm.lead.write'),
    ('tenant_operator', 'conversation.reply'),
    ('tenant_operator', 'support.ticket.write')
ON CONFLICT DO NOTHING;

COMMIT;
