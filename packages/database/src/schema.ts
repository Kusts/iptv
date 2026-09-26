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

/** Mirrors `platform.capabilities` (migration 014, global catalog). */
export interface PlatformCapabilitiesTable {
  id: string;
  key: string;
  owner_context: string;
  availability: string;
  certification_status: string;
  risk_level: string;
  mvp_phase: string;
  manual_equivalent: string;
  policy_family: string;
  degradation: string;
  permissions: unknown;
  created_at: Date;
  updated_at: Date;
}

/** Mirrors `platform.capability_events` (migration 014, append-only). */
export interface PlatformCapabilityEventsTable {
  id: string;
  capability_key: string;
  from_availability: string | null;
  to_availability: string;
  reason: string;
  actor_id: string | null;
  occurred_at: Date;
}

/** Mirrors `platform.policy_documents` (migration 014, versioned rows). */
export interface PlatformPolicyDocumentsTable {
  id: string;
  tenant_id: string | null;
  family: string;
  scope: string;
  class: string;
  version: number;
  status: string;
  document: unknown;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Mirrors `identity.persons` (migration 002, CRM-owned). */
export interface IdentityPersonsTable {
  id: string;
  tenant_id: string;
  status: string;
  canonical_name: string | null;
  locale: string | null;
  timezone: string | null;
  created_at: Date;
  updated_at: Date;
  anonymized_at: Date | null;
}

/** Mirrors `identity.identities` (migration 002). */
export interface IdentityIdentitiesTable {
  id: string;
  tenant_id: string;
  person_id: string;
  identity_type: string;
  normalized_value: string;
  external_provider: string | null;
  external_id: string | null;
  verification_status: string;
  link_confidence: unknown;
  metadata_json: unknown;
  created_at: Date;
  verified_at: Date | null;
  detached_at: Date | null;
}

/** Mirrors `crm.leads` (migration 002, CRM-owned). */
export interface CrmLeadsTable {
  id: string;
  tenant_id: string;
  person_id: string;
  status: string;
  stage: string | null;
  source_attribution_id: string | null;
  created_at: Date;
  qualified_at: Date | null;
  lost_at: Date | null;
  closed_reason: string | null;
}

/** Mirrors `crm.customers` (migration 002; Wave 2 MUST NOT write here). */
export interface CrmCustomersTable {
  id: string;
  tenant_id: string;
  person_id: string;
  status: string;
  customer_since: Date;
  last_reactivated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Mirrors `communication.conversations` (migration 009). */
export interface CommunicationConversationsTable {
  id: string;
  tenant_id: string;
  person_id: string;
  channel: string;
  external_thread_id: string | null;
  status: string;
  control_mode: string;
  last_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  archived_at: Date | null;
}

/** Mirrors `communication.messages` (migration 009, append-only). */
export interface CommunicationMessagesTable {
  id: string;
  tenant_id: string;
  conversation_id: string;
  person_id: string;
  direction: string;
  channel: string;
  sender_type: string;
  external_message_id: string | null;
  idempotency_key: string | null;
  content_type: string;
  body_text: string | null;
  attachment_ref: string | null;
  metadata_json: unknown;
  occurred_at: Date;
  received_at: Date | null;
  created_at: Date;
}

/** Mirrors `communication.message_deliveries` (migration 009, append-only). */
export interface CommunicationMessageDeliveriesTable {
  id: string;
  tenant_id: string;
  message_id: string;
  provider: string;
  status: string;
  attempt_no: number;
  external_delivery_id: string | null;
  error_code: string | null;
  error_detail_json: unknown;
  occurred_at: Date;
}

/** Mirrors `communication.communication_preferences` (migration 009). */
export interface CommunicationPreferencesTable {
  id: string;
  tenant_id: string;
  person_id: string;
  purpose_key: string;
  channel: string;
  status: string;
  source: string;
  evidence_ref: string | null;
  updated_at: Date;
  created_at: Date;
}

/** Mirrors `communication.communication_suppressions` (migration 009). */
export interface CommunicationSuppressionsTable {
  id: string;
  tenant_id: string;
  person_id: string | null;
  identity_id: string | null;
  channel: string | null;
  purpose_key: string | null;
  reason: string;
  starts_at: Date;
  ends_at: Date | null;
  created_at: Date;
}

/** Mirrors `communication.conversation_control_events` (migration 009, append-only). */
export interface CommunicationControlEventsTable {
  id: string;
  tenant_id: string;
  conversation_id: string;
  from_mode: string | null;
  to_mode: string;
  reason: string | null;
  actor_type: string;
  actor_id: string | null;
  occurred_at: Date;
}

/** Mirrors `communication.tenant_channels` (migration 015). */
export interface CommunicationTenantChannelsTable {
  id: string;
  tenant_id: string;
  channel: string;
  tenant_key: string;
  webhook_secret_hash: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

/** Mirrors `communication.exceptions` (migration 015). */
export interface CommunicationExceptionsTable {
  id: string;
  tenant_id: string;
  kind: string;
  status: string;
  channel: string | null;
  external_message_id: string | null;
  from_address: string | null;
  conversation_id: string | null;
  person_id: string | null;
  reason: string | null;
  payload_json: unknown;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
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
  "platform.capabilities": PlatformCapabilitiesTable;
  "platform.capability_events": PlatformCapabilityEventsTable;
  "platform.policy_documents": PlatformPolicyDocumentsTable;
  "identity.persons": IdentityPersonsTable;
  "identity.identities": IdentityIdentitiesTable;
  "crm.leads": CrmLeadsTable;
  "crm.customers": CrmCustomersTable;
  "communication.conversations": CommunicationConversationsTable;
  "communication.messages": CommunicationMessagesTable;
  "communication.message_deliveries": CommunicationMessageDeliveriesTable;
  "communication.communication_preferences": CommunicationPreferencesTable;
  "communication.communication_suppressions": CommunicationSuppressionsTable;
  "communication.conversation_control_events": CommunicationControlEventsTable;
  "communication.tenant_channels": CommunicationTenantChannelsTable;
  "communication.exceptions": CommunicationExceptionsTable;
}
