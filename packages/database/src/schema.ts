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

export interface Database {
  "control.tenants": ControlTenantsTable;
  "platform.outbox_messages": PlatformOutboxMessagesTable;
  "platform.migration_history": PlatformMigrationHistoryTable;
}
