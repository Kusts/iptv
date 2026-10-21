import { createHash } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "@iptv/database";
import { withTenantTransaction } from "@iptv/database";
import { newId } from "@iptv/domain";
import {
  generateInboundRef,
  validateInboundAttachmentRef,
  validateInboundUploadBytes,
  type InboundAttachmentCreateInput,
  type InboundAttachmentCreateResult,
  type InboundAttachmentKind,
  type InboundAttachmentRecord,
  type InboundAttachmentStore,
} from "./waha-inbound-attachments.js";

function isUniqueViolation(err: unknown): boolean {
  return err !== null && typeof err === "object" && (err as { code?: unknown }).code === "23505";
}

function mapRow(row: {
  tenant_id: string;
  ref: string;
  kind: string;
  mime_type: string;
  file_name: string | null;
  content: Uint8Array;
  size_bytes: number | string;
}): InboundAttachmentRecord | null {
  if (row.kind !== "IMAGE" && row.kind !== "DOCUMENT" && row.kind !== "AUDIO" && row.kind !== "VIDEO") {
    return null;
  }
  const bytes = Buffer.isBuffer(row.content) ? new Uint8Array(row.content) : row.content;
  return {
    tenantId: row.tenant_id,
    ref: row.ref,
    kind: row.kind,
    mimeType: row.mime_type,
    fileName: row.file_name,
    bytes,
  };
}

/**
 * Persistent tenant-scoped `InboundAttachmentStore` over
 * `platform.inbound_attachments` (migration 062). Every query carries an
 * explicit `tenant_id` predicate (defense-in-depth alongside the RLS
 * `tenant_isolation` policy) and pool-level calls run inside
 * `withTenantTransaction` so the RLS context is always set — without it the
 * fail-closed policy would return 0 rows under `iptv_app`.
 */
export class PgInboundAttachmentStore implements InboundAttachmentStore {
  constructor(private readonly db: Kysely<Database>) {}

  async resolve(tenantId: string, ref: string): Promise<InboundAttachmentRecord | null> {
    const syntactic = validateInboundAttachmentRef(ref);
    if (!syntactic.ok) {
      return null;
    }
    try {
      return await withTenantTransaction(this.db, tenantId, (trx) => this.resolveIn(trx, tenantId, ref));
    } catch {
      // Fail closed (never an exception): bad tenant ids, missing context,
      // or transport faults all refuse the resolution.
      return null;
    }
  }

  async resolveIn(
    trx: Transaction<Database>,
    tenantId: string,
    ref: string,
  ): Promise<InboundAttachmentRecord | null> {
    const row = await trx
      .selectFrom("platform.inbound_attachments")
      .select(["tenant_id", "ref", "kind", "mime_type", "file_name", "content", "size_bytes"])
      .where("tenant_id", "=", tenantId)
      .where("ref", "=", ref)
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    return mapRow(row);
  }

  /**
   * Validate-then-persist fetched inbound bytes. Ref collisions (UNIQUE per
   * tenant) regenerate the opaque ref and retry, bounded.
   */
  async create(tenantId: string, input: InboundAttachmentCreateInput): Promise<InboundAttachmentCreateResult> {
    try {
      return await withTenantTransaction(this.db, tenantId, (trx) => this.createIn(trx, tenantId, input));
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { ok: false, code: "validation_failed", message: "attachment ref collision, retry the ingest" };
      }
      throw err;
    }
  }

  async createIn(
    trx: Transaction<Database>,
    tenantId: string,
    input: InboundAttachmentCreateInput,
  ): Promise<InboundAttachmentCreateResult> {
    return insertInboundAttachmentRow(trx, tenantId, input);
  }
}

/**
 * Insert an inbound row in an ALREADY tenant-scoped transaction (the RLS
 * context is the caller's). Shared by `PgInboundAttachmentStore.createIn`
 * and any future command handler that owns its transaction.
 */
export async function insertInboundAttachmentRow(
  trx: Transaction<Database>,
  tenantId: string,
  input: InboundAttachmentCreateInput,
): Promise<InboundAttachmentCreateResult> {
  const check = validateInboundUploadBytes({
    kind: input.kind,
    mimeType: input.mimeType,
    bytes: input.bytes,
    durationSeconds: input.durationSeconds,
  });
  if (!check.ok) {
    return check;
  }
  const sizeBytes = input.bytes.length;
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const content = Buffer.from(input.bytes);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ref = generateInboundRef();
    try {
      await trx
        .insertInto("platform.inbound_attachments")
        .values({
          id: newId(),
          tenant_id: tenantId,
          ref,
          kind: input.kind as InboundAttachmentKind,
          mime_type: check.normalizedMime,
          file_name: input.fileName,
          content,
          size_bytes: sizeBytes,
          sha256,
          created_at: new Date(),
        })
        .execute();
      return { ok: true, ref, kind: input.kind, mimeType: check.normalizedMime, fileName: input.fileName, sizeBytes };
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
    }
  }
  return { ok: false, code: "validation_failed", message: "attachment ref collision, retry the ingest" };
}
