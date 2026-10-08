import { HttpException, Inject, Injectable } from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import { buildAuditRow, type AuditEventInput } from "@iptv/auth";
import type { Database } from "@iptv/database";

/**
 * Writes `platform.audit_log` rows (append-only). Callers pass the request
 * id as `correlationId`; before/after summaries go in `metadata`.
 *
 * Standalone (non-command) path: pool-level, no ambient transaction, so the
 * row goes through the `platform.audit_write` producer (053) instead of a
 * direct insert -- under `iptv_app` a direct pre-context INSERT fails the
 * RLS WITH CHECK, and the producer validates the tenant the same way the
 * command path does.
 */
@Injectable()
export class AuditService {
  constructor(@Inject("DB") private readonly db: Kysely<Database> | null) {}

  async write(input: AuditEventInput): Promise<void> {
    if (this.db === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    const row = buildAuditRow(input);
    await sql`select platform.audit_write(${row.tenant_id}::uuid, ${row.actor_type}, ${row.actor_id}, ${row.action_key}, ${row.resource_type}, ${row.resource_id}, ${row.correlation_id}, ${JSON.stringify(row.metadata_json)}::jsonb)`.execute(
      this.db,
    );
  }
}
