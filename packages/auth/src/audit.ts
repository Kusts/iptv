/**
 * Audit event builder for `platform.audit_log`.
 *
 * Table notes (migration 001): append-only (reject trigger on UPDATE/DELETE),
 * `tenant_id` NOT NULL, `actor_type` in system/agent/human/external,
 * `correlation_id` uuid (carries the request id), before/after summaries go
 * in `metadata_json`.
 */

export const AUDIT_ACTOR_TYPES = ["system", "agent", "human", "external"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export interface AuditEventInput {
  tenantId: string;
  actorType: AuditActorType;
  actorId?: string | null;
  /** e.g. `auth.register`, `auth.login`, `tenant.switch`, `tenant.create`. */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  /** Request id (`request.id`, echoed as `x-request-id`). */
  correlationId?: string | null;
  /** Before/after summary JSON. Must never contain secrets or hashes. */
  metadata?: Record<string, unknown>;
}

export interface AuditRow {
  tenant_id: string;
  actor_type: AuditActorType;
  actor_id: string | null;
  action_key: string;
  resource_type: string;
  resource_id: string | null;
  correlation_id: string | null;
  metadata_json: Record<string, unknown>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Pure builder: validates and shapes the row; writing is the caller's job. */
export function buildAuditRow(input: AuditEventInput): AuditRow {
  if (!isUuid(input.tenantId)) {
    throw new Error("audit tenantId must be a UUID");
  }
  if (!AUDIT_ACTOR_TYPES.includes(input.actorType)) {
    throw new Error(`invalid audit actor type: ${input.actorType}`);
  }
  if (input.action.trim().length === 0) {
    throw new Error("audit action must not be blank");
  }
  if (input.resourceType.trim().length === 0) {
    throw new Error("audit resourceType must not be blank");
  }
  if (input.correlationId !== undefined && input.correlationId !== null && !isUuid(input.correlationId)) {
    throw new Error("audit correlationId must be a UUID");
  }
  if (input.resourceId !== undefined && input.resourceId !== null && !isUuid(input.resourceId)) {
    throw new Error("audit resourceId must be a UUID");
  }
  const metadata = input.metadata ?? {};
  const serialized = JSON.stringify(metadata);
  if (/(password|secret|token|hash)/i.test(serialized)) {
    throw new Error("audit metadata must not contain secrets");
  }
  return {
    tenant_id: input.tenantId,
    actor_type: input.actorType,
    actor_id: input.actorId ?? null,
    action_key: input.action,
    resource_type: input.resourceType,
    resource_id: input.resourceId ?? null,
    correlation_id: input.correlationId ?? null,
    metadata_json: metadata,
  };
}

/** Minimal writer port (Kysely-backed in the API, faked in tests). */
export interface AuditWriter {
  write(row: AuditRow): Promise<void>;
}

export async function writeAudit(writer: AuditWriter, input: AuditEventInput): Promise<AuditRow> {
  const row = buildAuditRow(input);
  await writer.write(row);
  return row;
}
