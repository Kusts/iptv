/**
 * Typed Kysely schema. Column names are explicit snake_case to match the
 * canonical SQL migrations — CamelCasePlugin is intentionally OFF.
 * Only tables needed by the bootstrap are modeled so far.
 */

export interface ControlTenantsTable {
  id: string;
  slug: string;
  name: string;
  status: string;
  default_currency: string;
  timezone: string;
  created_at: Date;
  updated_at: Date;
}

export interface PlatformOutboxMessagesTable {
  id: string;
  tenant_id: string;
  domain_event_id: string;
  topic: string;
  message_key: string | null;
  payload_json: unknown;
  headers_json: unknown;
  state: string;
  attempt_count: number;
  next_attempt_at: Date;
  published_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
}

export interface PlatformMigrationHistoryTable {
  filename: string;
  sha256: string;
  applied_at: Date;
}

export interface ControlUsersTable {
  id: string;
  auth_subject: string;
  display_name: string | null;
  status: string;
  is_platform_admin: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ControlTenantMembershipsTable {
  id: string;
  tenant_id: string;
  user_id: string;
  role_key: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface ControlRolesTable {
  id: string;
  key: string;
  scope: string;
  description: string;
  created_at: Date;
  updated_at: Date;
}

export interface ControlPermissionsTable {
  id: string;
  key: string;
  description: string;
  created_at: Date;
}

export interface ControlRolePermissionsTable {
  role_key: string;
  permission_key: string;
  created_at: Date;
}

export interface ControlMembershipRolesTable {
  id: string;
  tenant_id: string;
  membership_id: string;
  role_key: string;
  created_at: Date;
}

export interface ControlAuthCredentialsTable {
  id: string;
  user_id: string;
  email: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}

export interface ControlAuthSessionsTable {
  id: string;
  user_id: string;
  token_hash: string;
  active_tenant_id: string | null;
  expires_at: Date;
  created_at: Date;
  last_seen_at: Date;
}

export interface PlatformAuditLogTable {
  id: string;
  tenant_id: string;
  actor_type: string;
  actor_id: string | null;
  action_key: string;
  resource_type: string;
  resource_id: string | null;
  correlation_id: string | null;
  metadata_json: unknown;
  occurred_at: Date;
}

export interface Database {
  "control.tenants": ControlTenantsTable;
  "control.users": ControlUsersTable;
  "control.tenant_memberships": ControlTenantMembershipsTable;
  "control.roles": ControlRolesTable;
  "control.permissions": ControlPermissionsTable;
  "control.role_permissions": ControlRolePermissionsTable;
  "control.membership_roles": ControlMembershipRolesTable;
  "control.auth_credentials": ControlAuthCredentialsTable;
  "control.auth_sessions": ControlAuthSessionsTable;
  "platform.audit_log": PlatformAuditLogTable;
  "platform.outbox_messages": PlatformOutboxMessagesTable;
  "platform.migration_history": PlatformMigrationHistoryTable;
}
