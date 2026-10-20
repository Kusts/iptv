/**
 * WAHA outbound attachment registry (FIX-WAHA-OUTBOUND).
 *
 * Closes the delegated-SSRF hole where an arbitrary caller-supplied
 * `attachmentRef` was forwarded verbatim as `file.url` to WAHA (the WAHA
 * server would then fetch an attacker-chosen URL), and the
 * declared-only caps/MIME hole (caller-supplied `fileSizeBytes`/`mimeType`
 * trusted without ever reading the real bytes).
 *
 * Rules:
 * - Only opaque tenant-scoped references resolve. Anything shaped like a
 *   URL (`scheme://`, protocol-relative `//`, `data:`/`file:`/etc.,
 *   whitespace/control characters) is refused BEFORE any network or
 *   persistence — free URLs never reach the gateway.
 * - Resolution is server-side and tenant-scoped: a ref resolves only when a
 *   record was registered for THAT tenant (cross-tenant refs refuse).
 * - Caps and MIME are validated against the REAL stored bytes (bounded read
 *   at registration, length rechecked at resolution) and the record's MIME —
 *   never against caller-declared fields. Declared fields that disagree with
 *   the record are refused as mismatches.
 * - Legitimate future URL-backed attachments (none exist today) must go
 *   through the `HttpWahaMediaPort` discipline (exact-origin allowlist,
 *   per-hop revalidation, redirect cap, bounded read) — this module refuses
 *   them until such a wired path exists.
 *
 * Storage note: the persistent tenant-scoped backing is
 * `platform.outbound_attachments` (migration 061) behind
 * `PgOutboundAttachmentStore` (`pg-outbound-attachment-store.ts`), wired as
 * the default at boot (see `AppModule`). The empty fail-closed registry
 * below remains the default only until that wiring runs (and in unit tests
 * that never boot the app); `MemoryOutboundAttachmentStore` is a
 * test-controlled backing. No migration is introduced by THIS fix file —
 * the table lives in its own append-only migration.
 */

import { createHash, randomBytes } from "node:crypto";
import { MEDIA_MAX_AUDIO_SECONDS, MEDIA_MAX_BYTES, MEDIA_MIME_ALLOWLIST, type WahaMediaContentType } from "./waha-media.js";
import type { SendMediaKind } from "./messaging-gateway.js";

export type OutboundAttachmentKind = SendMediaKind;

/**
 * Opaque reference shape: caller-chosen ids only (letters, digits, `.`, `_`,
 * `-`), leading alphanumeric, max 200 chars. Every existing test double id
 * (`att-…`) matches; anything URL-shaped never does.
 */
export const OUTBOUND_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** True when the ref is shaped like a fetchable URL (delegated-SSRF carrier). */
export function isFreeUrlRef(ref: string): boolean {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return true;
  }
  // Control characters / whitespace / quoting never appear in opaque ids.
  if (/[\s<>"'\\]/.test(ref)) {
    return true;
  }
  // Explicit scheme (`http:`, `data:`, `file:`, …), `scheme://`, or
  // protocol-relative `//host/…`.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith("//") || trimmed.includes("://")) {
    return true;
  }
  try {
    // An opaque id never parses as a URL; anything that does carries a
    // scheme (or is otherwise URL-shaped) and is refused.
    new URL(trimmed);
    return true;
  } catch {
    // Not parseable as a URL — falls through to the opaque-pattern check.
  }
  return false;
}

export type OutboundRefValidation =
  | { ok: true }
  | { ok: false; code: "validation_failed"; message: string };

/**
 * Syntactic guard shared by the command layer (refuse before persist/send)
 * and the gateway adapter (defense-in-depth: refuse before POST).
 */
export function validateOutboundAttachmentRef(ref: unknown): OutboundRefValidation {
  if (typeof ref !== "string" || ref.trim().length === 0) {
    return { ok: false, code: "validation_failed", message: "attachment_ref must be a non-empty opaque reference" };
  }
  if (isFreeUrlRef(ref)) {
    return {
      ok: false,
      code: "validation_failed",
      message: "attachment_ref is not a tenant-authorized opaque reference (free URLs refused: delegated-SSRF guard)",
    };
  }
  if (!OUTBOUND_REF_PATTERN.test(ref)) {
    return {
      ok: false,
      code: "validation_failed",
      message: "attachment_ref is not a tenant-authorized opaque reference",
    };
  }
  return { ok: true };
}

export interface OutboundAttachmentRecord {
  tenantId: string;
  ref: string;
  kind: OutboundAttachmentKind;
  mimeType: string;
  fileName: string | null;
  /** Real bytes under controlled storage — the authoritative size/content. */
  bytes: Uint8Array;
}

export interface OutboundAttachmentStore {
  resolve(tenantId: string, ref: string): Promise<OutboundAttachmentRecord | null>;
}

/** Fail-closed default: no backing, every resolution refuses. */
class EmptyOutboundAttachmentStore implements OutboundAttachmentStore {
  async resolve(tenantId: string, ref: string): Promise<null> {
    void tenantId;
    void ref;
    return null;
  }
}

/** Test/controlled backing: explicitly registered tenant-scoped records. */
export class MemoryOutboundAttachmentStore implements OutboundAttachmentStore {
  private readonly records = new Map<string, OutboundAttachmentRecord>();

  register(record: OutboundAttachmentRecord): void {
    this.records.set(`${record.tenantId}:${record.ref}`, record);
  }

  async resolve(tenantId: string, ref: string): Promise<OutboundAttachmentRecord | null> {
    return this.records.get(`${tenantId}:${ref}`) ?? null;
  }
}

let activeStore: OutboundAttachmentStore = new EmptyOutboundAttachmentStore();

export function currentOutboundAttachmentStore(): OutboundAttachmentStore {
  return activeStore;
}

/**
 * Production wiring: the boot provider installs the Pg-backed store as the
 * default lane (command + gateway resolve through it). Unit tests keep
 * overriding it per-test with the memory backing below.
 */
export function setOutboundAttachmentStore(store: OutboundAttachmentStore): void {
  activeStore = store;
}

export function setOutboundAttachmentStoreForTests(store: OutboundAttachmentStore): void {
  activeStore = store;
}

export function resetOutboundAttachmentStoreForTests(): void {
  activeStore = new EmptyOutboundAttachmentStore();
}

function normalizeMime(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Canonical form for sniffed-vs-registered equality. `audio/x-wav` is the
 * long-standing alias of `audio/wav` (both allowlisted); they compare equal.
 * Every other MIME compares by its normalized value — e.g. PNG bytes
 * (`image/png`) registered as `image/jpeg` refuse even though both are
 * allowlisted for IMAGE.
 */
function canonicalOutboundMime(mime: string): string {
  const normalized = normalizeMime(mime);
  if (normalized === "audio/x-wav") {
    return "audio/wav";
  }
  return normalized;
}

/**
 * Best-effort magic-byte sniff over the real bytes. Returns the detected
 * MIME when the signature is recognized, `null` when unknown. Unknown
 * signatures are ALWAYS refused (fail-closed explicit policy: only known
 * signatures pass) — an unrecognized byte pattern never resolves, even when
 * the record MIME itself is allowlisted.
 */
export function sniffOutboundMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "application/pdf";
  }
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return "audio/ogg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return "audio/wav";
  }
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0);
    if (brand === "mp4" || brand === "isom" || brand === "iso") {
      return "video/mp4";
    }
    return "audio/mp4";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "audio/webm";
  }
  return null;
}

export interface ResolvedOutboundAttachment {
  kind: OutboundAttachmentKind;
  mimeType: string;
  fileName: string | null;
  sizeBytes: number;
}

export type OutboundAttachmentResolution =
  | { ok: true; resolved: ResolvedOutboundAttachment }
  | { ok: false; code: "validation_failed"; message: string };

function refuse(message: string): OutboundAttachmentResolution {
  return { ok: false, code: "validation_failed", message };
}

/**
 * Server-side tenant-scoped resolution with REAL byte validation.
 * Fails closed (refusal, never an exception) on: free-URL refs, unknown
 * refs, cross-tenant refs, kind mismatches, declared-field mismatches,
 * oversized real bytes, disallowlisted record MIME, unrecognized byte
 * signatures, or sniffed-vs-registered MIME inequality.
 */
export async function resolveOutboundAttachmentWithStore(
  store: OutboundAttachmentStore,
  input: {
    tenantId: string;
    attachmentRef: string;
    kind: OutboundAttachmentKind;
    declaredMimeType: string;
    declaredFileSizeBytes: number | null | undefined;
  },
): Promise<OutboundAttachmentResolution> {
  const syntactic = validateOutboundAttachmentRef(input.attachmentRef);
  if (!syntactic.ok) {
    return syntactic;
  }
  const record = await store.resolve(input.tenantId, input.attachmentRef);
  if (record === null) {
    return refuse("attachment_ref is not registered for this tenant (unknown or cross-tenant reference refused)");
  }
  if (record.kind !== input.kind) {
    return refuse(`attachment_ref kind mismatch: registered as ${record.kind}, requested as ${input.kind}`);
  }
  const cap = MEDIA_MAX_BYTES[input.kind as WahaMediaContentType];
  const realSize = record.bytes.length;
  if (realSize === 0) {
    return refuse("attachment has no stored bytes");
  }
  if (realSize > cap) {
    return refuse(`oversized ${input.kind}: real size ${realSize} > ${cap}`);
  }
  const recordMime = normalizeMime(record.mimeType);
  if (!(MEDIA_MIME_ALLOWLIST[input.kind as WahaMediaContentType] as readonly string[]).includes(recordMime)) {
    return refuse(`mismatched MIME for ${input.kind}: ${record.mimeType}`);
  }
  // Explicit sniff policy: only known signatures pass, and the sniffed MIME
  // must equal the registered MIME (canonicalized) — allowlist membership
  // of the sniffed kind alone is NOT sufficient (PNG bytes registered as
  // JPEG refuse).
  const sniffed = sniffOutboundMime(record.bytes);
  if (sniffed === null) {
    return refuse("unrecognized attachment content signature (only known signatures pass)");
  }
  if (canonicalOutboundMime(sniffed) !== canonicalOutboundMime(recordMime)) {
    return refuse(`mismatched content for ${input.kind}: sniffed ${sniffed} != registered ${record.mimeType}`);
  }
  const declaredMime = normalizeMime(input.declaredMimeType);
  if (declaredMime !== recordMime) {
    return refuse(`declared MIME ${input.declaredMimeType} does not match registered attachment (${record.mimeType})`);
  }
  if (input.declaredFileSizeBytes !== null && input.declaredFileSizeBytes !== undefined && input.declaredFileSizeBytes !== realSize) {
    return refuse(
      `declared size ${input.declaredFileSizeBytes} does not match registered attachment size ${realSize}`,
    );
  }
  return {
    ok: true,
    resolved: { kind: record.kind, mimeType: record.mimeType, fileName: record.fileName, sizeBytes: realSize },
  };
}

export async function resolveOutboundAttachment(input: {
  tenantId: string;
  attachmentRef: string;
  kind: OutboundAttachmentKind;
  declaredMimeType: string;
  declaredFileSizeBytes: number | null | undefined;
}): Promise<OutboundAttachmentResolution> {
  return resolveOutboundAttachmentWithStore(currentOutboundAttachmentStore(), input);
}

/** Opaque ref mint: `att-` + 32 hex chars (matches `OUTBOUND_REF_PATTERN`). */
export function generateOutboundRef(): string {
  return `att-${randomBytes(16).toString("hex")}`;
}

/** Hex sha256 over the real bytes (recorded at upload for cheap rechecks). */
export function sha256HexBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type OutboundUploadValidation =
  | { ok: true; normalizedMime: string }
  | { ok: false; code: "validation_failed"; message: string };

function refuseUpload(message: string): OutboundUploadValidation {
  return { ok: false, code: "validation_failed", message };
}

/**
 * Upload-time gate over the REAL bytes (shared by the Pg store and the
 * command handler, so both lanes refuse before persisting). Mirrors the
 * resolve-time verdicts: declared caps/MIME are never trusted — the stored
 * bytes and the record MIME carry the decision. AUDIO additionally requires
 * `customerAuthorized: true` and honors the 600 s duration cap when a
 * duration is reported.
 */
export function validateOutboundUploadBytes(input: {
  kind: OutboundAttachmentKind;
  mimeType: string;
  bytes: Uint8Array;
  durationSeconds?: number | null;
  customerAuthorized?: boolean;
}): OutboundUploadValidation {
  const cap = MEDIA_MAX_BYTES[input.kind as WahaMediaContentType];
  if (cap === undefined) {
    return refuseUpload(`unknown attachment kind: ${input.kind}`);
  }
  if (input.bytes.length === 0) {
    return refuseUpload("attachment has no bytes");
  }
  if (input.bytes.length > cap) {
    return refuseUpload(`oversized ${input.kind}: real size ${input.bytes.length} > ${cap}`);
  }
  const recordMime = normalizeMime(input.mimeType);
  if (!(MEDIA_MIME_ALLOWLIST[input.kind as WahaMediaContentType] as readonly string[]).includes(recordMime)) {
    return refuseUpload(`mismatched MIME for ${input.kind}: ${input.mimeType}`);
  }
  const sniffed = sniffOutboundMime(input.bytes);
  if (sniffed === null) {
    return refuseUpload("unrecognized attachment content signature (only known signatures pass)");
  }
  if (canonicalOutboundMime(sniffed) !== canonicalOutboundMime(recordMime)) {
    return refuseUpload(`mismatched content for ${input.kind}: sniffed ${sniffed} != declared ${input.mimeType}`);
  }
  if (input.kind === "AUDIO") {
    if (
      input.durationSeconds !== null &&
      input.durationSeconds !== undefined &&
      input.durationSeconds > MEDIA_MAX_AUDIO_SECONDS
    ) {
      return refuseUpload(`audio duration ${input.durationSeconds}s exceeds ${MEDIA_MAX_AUDIO_SECONDS}s`);
    }
    if (input.customerAuthorized !== true) {
      return refuseUpload("audio uploads require explicit customer authorization (customerAuthorized: true)");
    }
  }
  return { ok: true, normalizedMime: recordMime };
}
