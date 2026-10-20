import type { Kysely, Transaction } from "kysely";
import type { Database } from "@iptv/database";
import { withTenantTransaction } from "@iptv/database";
import { newId } from "@iptv/domain";
import {
  generateOutboundRef,
  sha256HexBytes,
  validateOutboundAttachmentRef,
  validateOutboundUploadBytes,
  type OutboundAttachmentKind,
  type OutboundAttachmentRecord,
  type OutboundAttachmentStore,
} from "./waha-outbound-attachments.js";

export interface OutboundAttachmentCreateInput {
  kind: OutboundAttachmentKind;
  mimeType: string;
  fileName: string | null;
  bytes: Uint8Array;
  durationSeconds?: number | null;
  customerAuthorized?: boolean;
}

export type OutboundAttachmentCreateResult =
  | {
      ok: true;
      ref: string;
      kind: OutboundAttachmentKind;
      mimeType: string;
      fileName: string | null;
      sizeBytes: number;
      sha256: string;
    }
  | { ok: false; code: "validation_failed"; message: string };

function isUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === "23505"
  );
}

function mapRow(row: {
  tenant_id: string;
  ref: string;
  kind: string;
  mime_type: string;
  file_name: string | null;
  content: Uint8Array;
  size_bytes: number | string;
}): OutboundAttachmentRecord | null {
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
 * Persistent tenant-scoped `OutboundAttachmentStore` over
 * `platform.outbound_attachments` (migration 061). Every query carries an
 * explicit `tenant_id` predicate (defense-in-depth alongside the RLS
 * `tenant_isolation` policy) and pool-level calls run inside
 * `withTenantTransaction` so the RLS context is always set — without it the
 * fail-closed policy would return 0 rows under `iptv_app`.
 */
export class PgOutboundAttachmentStore implements OutboundAttachmentStore {
  constructor(private readonly db: Kysely<Database>) {}

  async resolve(tenantId: string, ref: string): Promise<OutboundAttachmentRecord | null> {
    const syntactic = validateOutboundAttachmentRef(ref);
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
  ): Promise<OutboundAttachmentRecord | null> {
    const row = await trx
      .selectFrom("platform.outbound_attachments")
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
   * Validate-then-persist an upload. The pure byte gate runs BEFORE any
   * insert; ref collisions (UNIQUE per tenant) regenerate the opaque ref and
   * retry, bounded.
   */
  async create(tenantId: string, input: OutboundAttachmentCreateInput): Promise<OutboundAttachmentCreateResult> {
    try {
      return await withTenantTransaction(this.db, tenantId, (trx) => this.createIn(trx, tenantId, input));
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { ok: false, code: "validation_failed", message: "attachment ref collision, retry the upload" };
      }
      throw err;
    }
  }

  async createIn(
    trx: Transaction<Database>,
    tenantId: string,
    input: OutboundAttachmentCreateInput,
  ): Promise<OutboundAttachmentCreateResult> {
    return insertOutboundAttachmentRow(trx, tenantId, input);
  }
}

/**
 * Insert an upload row in an ALREADY tenant-scoped transaction (the RLS
 * context is the caller's). Shared by `PgOutboundAttachmentStore.createIn`
 * and the `attachment.upload` command handler, which owns its transaction.
 */
export async function insertOutboundAttachmentRow(
  trx: Transaction<Database>,
  tenantId: string,
  input: OutboundAttachmentCreateInput,
): Promise<OutboundAttachmentCreateResult> {
  const check = validateOutboundUploadBytes({
    kind: input.kind,
    mimeType: input.mimeType,
    bytes: input.bytes,
    durationSeconds: input.durationSeconds,
    customerAuthorized: input.customerAuthorized,
  });
  if (!check.ok) {
    return check;
  }
  const sizeBytes = input.bytes.length;
  const sha256 = sha256HexBytes(input.bytes);
  const content = Buffer.from(input.bytes);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ref = generateOutboundRef();
    try {
      await trx
        .insertInto("platform.outbound_attachments")
        .values({
          id: newId(),
          tenant_id: tenantId,
          ref,
          kind: input.kind,
          mime_type: check.normalizedMime,
          file_name: input.fileName,
          content,
          size_bytes: sizeBytes,
          sha256,
          created_at: new Date(),
        })
        .execute();
      return { ok: true, ref, kind: input.kind, mimeType: check.normalizedMime, fileName: input.fileName, sizeBytes, sha256 };
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
    }
  }
  return { ok: false, code: "validation_failed", message: "attachment ref collision, retry the upload" };
}
