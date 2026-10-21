/**
 * WAHA inbound attachment registry (EXEC-WAHA-MEDIA-FETCH-20261020).
 *
 * Tenant-scoped backing for provider-fetched inbound media bytes
 * (`platform.inbound_attachments`, migration 062). A verified download is
 * validated against the REAL bytes (caps/MIME/magic-byte sniff, same
 * discipline as the outbound registry) and persisted under an opaque
 * tenant-scoped `ref`; the inbound `message.ingest` then references that
 * `ref` with the real content type (IMAGE/AUDIO/DOCUMENT/VIDEO) instead of
 * the previous `media_unavailable` exception with no message row.
 *
 * Why NOT reuse `platform.outbound_attachments` (061): that table records
 * operator/customer-authorized uploads for SENDING (the AUDIO lane requires
 * `customerAuthorized: true`, a consent gate that makes no sense for
 * RECEIVED provider bytes — reusing it would either block all inbound audio
 * or force a bypass of the outbound consent gate). Provenance also differs
 * (uploaded-for-send vs fetched-from-provider); sharing the table would
 * conflate the two directions in audit. 062 therefore mirrors the 061 shape
 * (immutable blobs, RLS `tenant_isolation`, SELECT+INSERT to `iptv_app`
 * only, no BYPASSRLS, no PUBLIC) under a direction-explicit name.
 *
 * AUDIO inbound carries no consent gate (consent applies to sending, not
 * receiving); the 600 s duration cap still applies when reported.
 */

import { randomBytes } from "node:crypto";
import {
  MEDIA_MAX_AUDIO_SECONDS,
  MEDIA_MAX_BYTES,
  MEDIA_MIME_ALLOWLIST,
  type WahaMediaContentType,
} from "./waha-media.js";
import { sniffOutboundMime } from "./waha-outbound-attachments.js";

/** Opaque ref shape: same discipline as the outbound registry. */
export const INBOUND_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** True when the ref is shaped like a fetchable URL (never a valid ref). */
export function isFreeUrlInboundRef(ref: string): boolean {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return true;
  }
  if (/[\s<>"'\\]/.test(ref)) {
    return true;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith("//") || trimmed.includes("://")) {
    return true;
  }
  try {
    new URL(trimmed);
    return true;
  } catch {
    // Not parseable as a URL — falls through to the opaque-pattern check.
  }
  return false;
}

export type InboundRefValidation =
  | { ok: true }
  | { ok: false; code: "validation_failed"; message: string };

/** Syntactic guard for inbound refs (server-minted; defense in depth). */
export function validateInboundAttachmentRef(ref: unknown): InboundRefValidation {
  if (typeof ref !== "string" || ref.trim().length === 0) {
    return { ok: false, code: "validation_failed", message: "attachment_ref must be a non-empty opaque reference" };
  }
  if (isFreeUrlInboundRef(ref)) {
    return {
      ok: false,
      code: "validation_failed",
      message: "attachment_ref is not a tenant-authorized opaque reference (free URLs refused)",
    };
  }
  if (!INBOUND_REF_PATTERN.test(ref)) {
    return {
      ok: false,
      code: "validation_failed",
      message: "attachment_ref is not a tenant-authorized opaque reference",
    };
  }
  return { ok: true };
}

export type InboundAttachmentKind = WahaMediaContentType;

export interface InboundAttachmentRecord {
  tenantId: string;
  ref: string;
  kind: InboundAttachmentKind;
  mimeType: string;
  fileName: string | null;
  /** Real bytes under controlled storage — the authoritative size/content. */
  bytes: Uint8Array;
}

export interface InboundAttachmentCreateInput {
  kind: InboundAttachmentKind;
  mimeType: string;
  fileName: string | null;
  bytes: Uint8Array;
  durationSeconds?: number | null;
}

export type InboundAttachmentCreateResult =
  | {
      ok: true;
      ref: string;
      kind: InboundAttachmentKind;
      mimeType: string;
      fileName: string | null;
      sizeBytes: number;
    }
  | { ok: false; code: "validation_failed" | "storage_unavailable"; message: string };

export interface InboundAttachmentStore {
  resolve(tenantId: string, ref: string): Promise<InboundAttachmentRecord | null>;
  create(tenantId: string, input: InboundAttachmentCreateInput): Promise<InboundAttachmentCreateResult>;
}

/** Fail-closed default: no backing, every resolution/create refuses. */
class EmptyInboundAttachmentStore implements InboundAttachmentStore {
  async resolve(tenantId: string, ref: string): Promise<null> {
    void tenantId;
    void ref;
    return null;
  }

  async create(
    tenantId: string,
    input: InboundAttachmentCreateInput,
  ): Promise<InboundAttachmentCreateResult> {
    void tenantId;
    void input;
    return { ok: false, code: "storage_unavailable", message: "no tenant-scoped inbound attachment storage is wired" };
  }
}

/** Test/controlled backing: explicitly stored tenant-scoped records. */
export class MemoryInboundAttachmentStore implements InboundAttachmentStore {
  private readonly records = new Map<string, InboundAttachmentRecord>();

  async resolve(tenantId: string, ref: string): Promise<InboundAttachmentRecord | null> {
    return this.records.get(`${tenantId}:${ref}`) ?? null;
  }

  async create(tenantId: string, input: InboundAttachmentCreateInput): Promise<InboundAttachmentCreateResult> {
    const check = validateInboundUploadBytes(input);
    if (!check.ok) {
      return check;
    }
    const ref = generateInboundRef();
    this.records.set(`${tenantId}:${ref}`, {
      tenantId,
      ref,
      kind: input.kind,
      mimeType: check.normalizedMime,
      fileName: input.fileName,
      bytes: input.bytes,
    });
    return { ok: true, ref, kind: input.kind, mimeType: check.normalizedMime, fileName: input.fileName, sizeBytes: input.bytes.length };
  }
}

let activeStore: InboundAttachmentStore = new EmptyInboundAttachmentStore();

export function currentInboundAttachmentStore(): InboundAttachmentStore {
  return activeStore;
}

/**
 * Production wiring: the boot provider installs the Pg-backed store as the
 * default lane (webhook persist + resolve read it at call time). Unit tests
 * keep overriding it per-test with the memory backing below.
 */
export function setInboundAttachmentStore(store: InboundAttachmentStore): void {
  activeStore = store;
}

export function setInboundAttachmentStoreForTests(store: InboundAttachmentStore): void {
  activeStore = store;
}

export function resetInboundAttachmentStoreForTests(): void {
  activeStore = new EmptyInboundAttachmentStore();
}

/** Opaque ref mint: `in-` + 32 hex chars (matches `INBOUND_REF_PATTERN`). */
export function generateInboundRef(): string {
  return `in-${randomBytes(16).toString("hex")}`;
}

function normalizeInboundMime(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

export type InboundUploadValidation =
  | { ok: true; normalizedMime: string }
  | { ok: false; code: "validation_failed"; message: string };

function refuseUpload(message: string): InboundUploadValidation {
  return { ok: false, code: "validation_failed", message };
}

/**
 * Inbound byte gate over the REAL fetched bytes (runs BEFORE any persist).
 * Mirrors the outbound upload verdicts — caps, record-MIME allowlist,
 * known-signature sniff, sniffed-vs-declared equality — with two deliberate
 * inbound differences: NO `customerAuthorized` consent gate (consent governs
 * sending, not receiving; the AUDIO duration cap still applies when a
 * duration is reported), and no sha256 here (the Pg lane records it).
 */
export function validateInboundUploadBytes(input: {
  kind: InboundAttachmentKind;
  mimeType: string;
  bytes: Uint8Array;
  durationSeconds?: number | null;
}): InboundUploadValidation {
  const cap = MEDIA_MAX_BYTES[input.kind];
  if (cap === undefined) {
    return refuseUpload(`unknown attachment kind: ${input.kind}`);
  }
  if (input.bytes.length === 0) {
    return refuseUpload("attachment has no bytes");
  }
  if (input.bytes.length > cap) {
    return refuseUpload(`oversized ${input.kind}: real size ${input.bytes.length} > ${cap}`);
  }
  const recordMime = normalizeInboundMime(input.mimeType);
  if (!(MEDIA_MIME_ALLOWLIST[input.kind] as readonly string[]).includes(recordMime)) {
    return refuseUpload(`mismatched MIME for ${input.kind}: ${input.mimeType}`);
  }
  const sniffed = sniffOutboundMime(input.bytes);
  if (sniffed === null) {
    return refuseUpload("unrecognized attachment content signature (only known signatures pass)");
  }
  const canonical = (mime: string): string => (mime === "audio/x-wav" ? "audio/wav" : mime);
  if (canonical(sniffed) !== canonical(recordMime)) {
    return refuseUpload(`mismatched content for ${input.kind}: sniffed ${sniffed} != declared ${input.mimeType}`);
  }
  if (
    input.kind === "AUDIO" &&
    input.durationSeconds !== null &&
    input.durationSeconds !== undefined &&
    input.durationSeconds > MEDIA_MAX_AUDIO_SECONDS
  ) {
    return refuseUpload(`audio duration ${input.durationSeconds}s exceeds ${MEDIA_MAX_AUDIO_SECONDS}s`);
  }
  return { ok: true, normalizedMime: recordMime };
}
