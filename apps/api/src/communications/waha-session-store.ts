import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@iptv/database";
import { withTenantTransaction } from "@iptv/database";
import { newId } from "@iptv/domain";
import { bindSession } from "./waha-sessions.js";

/**
 * S3a (#87) persistent WAHA session bindings.
 *
 * `waha-sessions.ts` keeps tenant→session bindings in a process-local Map
 * (with an env-shared `WAHA_SESSION=default` fallback) — a restart drops
 * every binding and an unbound tenant silently shares the default session,
 * possibly another tenant's. This module is the DB-backed authority:
 * bindings live on the tenant's `communication.tenant_channels` WHATSAPP
 * row (`waha_session_name`, migration 067) and survive restarts; a missing
 * binding resolves to `null` (fail-closed) instead of a shared default.
 *
 * Lane discipline (preserves the echo/dev contracts byte-for-byte):
 * - BOUND tenant → the DB session, always (also mirrored into the legacy
 *   Map via `bindSession` so the synchronous `WahaGatewayAdapter` guard
 *   keeps enforcing the same value without a second source of truth).
 * - UNBOUND tenant → `null`; callers decide: the S3a session endpoints fail
 *   closed (404), outbound through a live WAHA gateway refuses
 *   (`SESSION_NOT_PROVISIONED`), and the echo/dev lane falls back to the
 *   legacy Map/env behavior exactly as before.
 */

export const WAHA_CHANNEL = "WHATSAPP";

/** Deterministic exclusive session name: `tenant-<12hex>` (48 bits). */
export function deriveWahaSessionName(tenantId: string): string {
  const hex = tenantId.replace(/-/g, "").toLowerCase();
  return `tenant-${hex.slice(0, 12)}`;
}

/** Sanitize a WAHA status for storage: verbatim, length-capped, no secrets. */
export function sanitizeWahaStatus(status: unknown): string | null {
  if (typeof status !== "string") {
    return null;
  }
  const trimmed = status.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.slice(0, 64).toUpperCase();
}

export interface WahaSessionBinding {
  sessionName: string;
  status: string | null;
}

export interface WahaChannelRef {
  id: string;
  tenantKey: string;
}

/** Deterministic webhook routing key: `waha-<12hex>` (stable across disable/enable). */
export function deriveWahaTenantKey(tenantId: string): string {
  const hex = tenantId.replace(/-/g, "").toLowerCase();
  return `waha-${hex.slice(0, 12)}`;
}

/**
 * Ensure the tenant's WHATSAPP channel row exists (reuse the latest row,
 * any status — the routing key stays stable across disable/enable, exactly
 * like the Asaas `webhook_ensure` channel handling).
 */
export async function ensureWahaChannel(trx: TrxLike, tenantId: string): Promise<WahaChannelRef> {
  const existing = await trx
    .selectFrom("communication.tenant_channels")
    .select(["id", "tenant_key"])
    .where("tenant_id", "=", tenantId)
    .where("channel", "=", WAHA_CHANNEL)
    .orderBy("updated_at", "desc")
    .executeTakeFirst();
  if (existing !== undefined) {
    return { id: existing.id, tenantKey: existing.tenant_key };
  }
  const id = newId();
  const tenantKey = deriveWahaTenantKey(tenantId);
  const at = new Date();
  await trx
    .insertInto("communication.tenant_channels")
    .values({
      id,
      tenant_id: tenantId,
      channel: WAHA_CHANNEL,
      tenant_key: tenantKey,
      webhook_secret_hash: null,
      status: "ACTIVE",
      waha_session_name: null,
      waha_status: null,
      created_at: at,
      updated_at: at,
    })
    .execute();
  return { id, tenantKey };
}

/**
 * Persist the tenant↔session binding (plus optional webhook secret hash).
 * Ensures the channel row, marks it ACTIVE (an explicit provision act
 * re-enables), and touches `updated_at`. Never stores token plaintext —
 * only the sha256 hash.
 */
export async function saveWahaSessionBinding(
  trx: TrxLike,
  tenantId: string,
  input: { sessionName: string; status: string | null; webhookSecretHash?: string | null },
): Promise<void> {
  const { id } = await ensureWahaChannel(trx, tenantId);
  const at = new Date();
  await trx
    .updateTable("communication.tenant_channels")
    .set({
      waha_session_name: input.sessionName,
      waha_status: input.status,
      ...(input.webhookSecretHash !== undefined ? { webhook_secret_hash: input.webhookSecretHash } : {}),
      status: "ACTIVE",
      updated_at: at,
    })
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .execute();
}

type TrxLike = Transaction<Database>;

/**
 * Read the tenant's WHATSAPP binding. MUST run with the tenant's RLS
 * context set (`withTenantTransaction`, or the bus trx which already
 * carries it via `KyselyCommandDb.withTransaction`).
 */
export async function getBoundWahaSession(
  trx: TrxLike,
  tenantId: string,
): Promise<WahaSessionBinding | null> {
  const row = await trx
    .selectFrom("communication.tenant_channels")
    .select(["waha_session_name", "waha_status"])
    .where("tenant_id", "=", tenantId)
    .where("channel", "=", WAHA_CHANNEL)
    .where("status", "=", "ACTIVE")
    .orderBy("updated_at", "desc")
    .executeTakeFirst();
  if (row === undefined || row.waha_session_name === null) {
    return null;
  }
  return { sessionName: row.waha_session_name, status: row.waha_status };
}

/**
 * Resolve the expected session for a tenant: DB binding when present
 * (mirrored into the legacy in-process Map so synchronous guards such as
 * `WahaGatewayAdapter` keep enforcing the same value), else `null`
 * (fail-closed — callers MUST NOT substitute a shared default here).
 */
export async function resolveExpectedWahaSession(
  db: Kysely<Database>,
  tenantId: string,
): Promise<string | null> {
  const bound = await withTenantTransaction(db, tenantId, (trx) =>
    getBoundWahaSession(trx, tenantId),
  );
  if (bound === null) {
    return null;
  }
  bindSession(tenantId, bound.sessionName);
  return bound.sessionName;
}

/**
 * Cross-tenant owner lookup: which tenant (if any) owns `sessionName`.
 * Uses the `communication.resolve_waha_session_owner` SECURITY DEFINER
 * function (migration 067) because under the caller's RLS context a direct
 * SELECT could never see another tenant's row. Returns `null` when the
 * session is unowned (legacy/shared names such as `default` are unowned
 * by construction — nobody binds them via S3a).
 */
export async function findWahaSessionOwner(
  db: Kysely<Database> | TrxLike,
  sessionName: string,
): Promise<string | null> {
  const result = await sql<{ tenant_id: string }>`
    select * from communication.resolve_waha_session_owner(${sessionName})
  `.execute(db);
  return result.rows[0]?.tenant_id ?? null;
}

export type OutboundSessionResolution =
  | { ok: true; session: string }
  | { ok: false; code: "precondition_failed"; message: string };

/**
 * Outbound session resolution (send paths):
 * - tenant BOUND → the DB session (mirrored into the legacy Map by
 *   `resolveExpectedWahaSession` readers, so the synchronous adapter guard
 *   enforces the same value);
 * - tenant UNBOUND + live WAHA gateway → fail-closed
 *   (`SESSION_NOT_PROVISIONED` — never the shared default);
 * - otherwise (memory lane, echo/dev gateway) → legacy Map/env, unchanged.
 */
export async function resolveOutboundSession(
  trx: TrxLike | null,
  tenantId: string,
  legacy: (tenantId: string) => string,
  gatewayName: string,
): Promise<OutboundSessionResolution> {
  if (trx !== null) {
    const bound = await getBoundWahaSession(trx, tenantId);
    if (bound !== null) {
      bindSession(tenantId, bound.sessionName);
      return { ok: true, session: bound.sessionName };
    }
    if (gatewayName === "waha") {
      return {
        ok: false,
        code: "precondition_failed",
        message:
          "SESSION_NOT_PROVISIONED: this tenant has no whatsapp session bound (provision via POST /v1/integrations/whatsapp/session); refusing the shared default",
      };
    }
  }
  return { ok: true, session: legacy(tenantId) };
}

export type InboundSessionCheck =
  | { ok: true; session: string | null }
  | { ok: false; expected: string; observed: string | null };

/**
 * Inbound/session-ingest guard (async, DB-backed), over an existing
 * transaction that already carries the tenant's RLS context (bus handlers
 * via `KyselyCommandDb.withTransaction`, or any `withTenantTransaction`
 * scope):
 * - tenant BOUND → observed must equal the bound session (fail-closed,
 *   including sessionless payloads — a bound tenant never accepts
 *   unattributed inbound);
 * - tenant UNBOUND + observed session owned by ANOTHER tenant → mismatch
 *   (the cross-tenant bypass this slice kills);
 * - otherwise → legacy `validateSessionForTenant` (Map/env), preserving the
 *   echo/dev contracts (fixtures with `session: "default"`, no bindings).
 */
export async function checkInboundSessionWithTrx(
  trx: TrxLike,
  tenantId: string,
  observed: string | null | undefined,
  legacy: (tenantId: string, observed: string | null | undefined) => InboundSessionCheck,
): Promise<InboundSessionCheck> {
  const bound = await getBoundWahaSession(trx, tenantId);
  if (bound !== null) {
    if (observed === bound.sessionName) {
      return { ok: true, session: bound.sessionName };
    }
    return { ok: false, expected: bound.sessionName, observed: observed ?? null };
  }
  if (typeof observed === "string" && observed.length > 0) {
    const owner = await findWahaSessionOwner(trx, observed);
    if (owner !== null && owner !== tenantId) {
      return { ok: false, expected: "<unbound>", observed };
    }
  }
  return legacy(tenantId, observed);
}

/**
 * Same guard without a caller transaction: opens a tenant-scoped scope for
 * the bound read (pre-bus paths such as `WahaWebhookService.processRow`).
 */
export async function checkInboundSession(
  db: Kysely<Database>,
  tenantId: string,
  observed: string | null | undefined,
  legacy: (tenantId: string, observed: string | null | undefined) => InboundSessionCheck,
): Promise<InboundSessionCheck> {
  return withTenantTransaction(db, tenantId, (trx) =>
    checkInboundSessionWithTrx(trx, tenantId, observed, legacy),
  );
}
