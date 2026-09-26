import { HttpException, Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import { buildAuditRow, type AuditEventInput } from "@iptv/auth";
import type { Database } from "@iptv/database";
import { newId, now } from "@iptv/domain";

/**
 * Writes `platform.audit_log` rows (append-only). Callers pass the request
 * id as `correlationId`; before/after summaries go in `metadata`.
 */
@Injectable()
export class AuditService {
  constructor(@Inject("DB") private readonly db: Kysely<Database> | null) {}

  async write(input: AuditEventInput): Promise<void> {
    if (this.db === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    const row = buildAuditRow(input);
    await this.db
      .insertInto("platform.audit_log")
      .values({
        id: newId(),
        tenant_id: row.tenant_id,
        actor_type: row.actor_type,
        actor_id: row.actor_id,
        action_key: row.action_key,
        resource_type: row.resource_type,
        resource_id: row.resource_id,
        correlation_id: row.correlation_id,
        metadata_json: row.metadata_json,
        occurred_at: now(),
      })
      .execute();
  }
}
