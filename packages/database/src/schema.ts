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

export interface PlatformOutboxMessagesTable {  id: string;
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

/** Mirrors `platform.domain_events` (migration 001, append-only). */
export interface PlatformDomainEventsTable {
  id: string;
  event_id: string;
  tenant_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  occurred_at: Date;
  recorded_at: Date;
  correlation_id: string;
  causation_id: string | null;
  actor_type: string;
  actor_id: string | null;
  schema_version: number;
  data_json: unknown;
}

/** Mirrors `platform.idempotency_keys` (migration 001). */
export interface PlatformIdempotencyKeysTable {
  id: string;
  tenant_id: string;
  scope: string;
  idempotency_key: string;
  request_hash: string | null;
  resource_type: string | null;
  resource_id: string | null;
  response_status: number | null;
  response_json: unknown;
  state: string;
  locked_until: Date | null;
  created_at: Date;
  completed_at: Date | null;
  expires_at: Date | null;
}

/** Mirrors `platform.inbox_messages` (migration 001). */
export interface PlatformInboxMessagesTable {
  id: string;
  tenant_id: string;
  provider: string;
  external_event_id: string;
  event_type: string | null;
  payload_hash: string;
  payload_json: unknown;
  received_at: Date;
  state: string;
  attempt_count: number;
  processed_at: Date | null;
  last_error_code: string | null;
  correlation_id: string;
}

/** Mirrors `agent.human_review_requests` (migration 010). */
export interface AgentHumanReviewRequestsTable {
  id: string;
  tenant_id: string;
  status: string;
  review_mode: string;
  reason: string;
  risk_class: string;
  priority: string;
  resource_type: string;
  resource_id: string;
  requested_by_type: string;
  requested_by_id: string | null;
  assigned_to_user_id: string | null;
  summary: string;
  context_json: unknown;
  sla_due_at: Date | null;
  escalation_policy: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

/** Mirrors `agent.human_review_actions` (migration 010, append-only). */
export interface AgentHumanReviewActionsTable {
  id: string;
  tenant_id: string;
  human_review_request_id: string;
  action_type: string;
  actor_user_id: string;
  content_json: unknown;
  created_at: Date;
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
  "platform.domain_events": PlatformDomainEventsTable;
  "platform.idempotency_keys": PlatformIdempotencyKeysTable;
  "platform.inbox_messages": PlatformInboxMessagesTable;
  "platform.outbox_messages": PlatformOutboxMessagesTable;
  "platform.migration_history": PlatformMigrationHistoryTable;
  "agent.human_review_requests": AgentHumanReviewRequestsTable;
  "agent.human_review_actions": AgentHumanReviewActionsTable;
}
