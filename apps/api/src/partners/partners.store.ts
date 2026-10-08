import { sql, type Transaction } from "kysely";
import { newId, now } from "@iptv/domain";
import type { Database } from "@iptv/database";
import type { CommandHandlerContext } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";
import { UniqueViolationError } from "../trial/trial-store.js";

/**
 * Wave 13 Partners/Resellers store (owning context for partner accounts,
 * direct-edge hierarchy, prepaid credit ledger, reseller orders and
 * Academy progress).
 *
 * Money discipline: exact decimal minor-unit strings (`bigint` at the
 * boundary, never float). Available credit = SUM(ledger entries) −
 * SUM(RESERVED reservations), computed inside one transaction under a
 * per-(tenant, partner) advisory lock so concurrent orders serialize
 * (same lock discipline as the supplier-credit slice).
 *
 * Direct-edge rule (baseline §partner_relationships): a partner manages
 * only DIRECT children; ancestors aggregate but never manage. The single
 * enforcement points are `createDirectRelationship` (child must have no
 * live parent edge; no cycle) and capability writes gated on a direct
 * parent edge.
 */

export const PARTNER_STATUSES = [
  "PROSPECT",
  "ONBOARDING",
  "TRAINING",
  "READY",
  "ACTIVE",
  "AT_RISK",
  "INACTIVE",
  "SUSPENDED",
  "TERMINATED",
] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export const ACADEMY_TOPIC_KEYS = [
  "academy-01-product-service",
  "academy-02-devices-apps",
  "academy-03-trials-retrial",
  "academy-04-provisioning",
  "academy-05-support-escalation",
  "academy-06-consultative-sales",
  "academy-07-renewal-retention",
  "academy-08-finance-pricing",
  "academy-09-campaigns-acquisition",
  "academy-10-saas-pathway",
] as const;

/** Pure lifecycle gate: completing topics moves ONBOARDING → TRAINING. */
export function nextStatusOnTopicStart(current: PartnerStatus): PartnerStatus {
  return current === "ONBOARDING" ? "TRAINING" : current;
}

/** Pure lifecycle gate: READY once every topic completes (from TRAINING). */
export function nextStatusOnTopicsComplete(current: PartnerStatus, completed: number, total: number): PartnerStatus {
  if (completed >= total && (current === "TRAINING" || current === "ONBOARDING")) {
    return "READY";
  }
  return current;
}

/** Pure check: only an explicit READY → ACTIVE activation operates the network. */
export function canActivate(current: PartnerStatus): boolean {
  return current === "READY";
}

/** Pure check: only ACTIVE partners settle reseller orders. */
export function canOrder(current: PartnerStatus): boolean {
  return current === "ACTIVE";
}

/** Exact available-credit math on decimal strings; throws on malformed input. */
export function computeAvailableCredit(ledgerSumMinor: string, reservedMinor: string): string {
  if (!/^-?\d+$/.test(ledgerSumMinor) || !/^-?\d+$/.test(reservedMinor)) {
    throw new Error("credit inputs must be integer minor-unit strings");
  }
  return (BigInt(ledgerSumMinor) - BigInt(reservedMinor)).toString();
}

/** Parse an exact minor-unit amount (strictly positive). */
export function parsePositiveMinor(value: string): bigint {
  const text = value.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error("amount must be a non-negative integer minor-unit value");
  }
  const parsed = BigInt(text);
  if (parsed <= 0n || parsed > 9_223_372_036_854_775_807n) {
    throw new Error("amount must be strictly positive and within PostgreSQL BIGINT range");
  }
  return parsed;
}

function requireTrx(ctx: CommandHandlerContext): Transaction<Database> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("partners commands require a database transaction");
  }
  return trx;
}

export async function advisoryLockPartnerCredit(
  trx: Transaction<Database>,
  tenantId: string,
  partnerAccountId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"reseller-credit:" + tenantId + ":" + partnerAccountId}))`.execute(trx);
}

export async function advisoryLockRelationship(
  trx: Transaction<Database>,
  tenantId: string,
  parentAccountId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"reseller-relationship:" + tenantId + ":" + parentAccountId}))`.execute(trx);
}

/**
 * Tenant-wide hierarchy lock. Hierarchy writes (create_direct_relationship)
 * serialize per tenant so concurrent A→B + B→A edges cannot both pass the
 * cycle walk: exactly one wins, the loser sees the winner's edge. Coarse
 * but correct for the MVP direct-edge nucleus (hierarchy writes are rare).
 */
export async function advisoryLockHierarchy(trx: Transaction<Database>, tenantId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"reseller-hierarchy:" + tenantId}))`.execute(trx);
}

/** True when `userId` holds a membership grant in `partnerAccountId` (this tenant). */
export async function hasPartnerMembership(
  ctx: CommandHandlerContext,
  partnerAccountId: string,
  userId: string,
): Promise<boolean> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("partners.partner_memberships")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("partner_account_id", "=", partnerAccountId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row !== undefined;
}

/** Idempotent grant: the actor joins the account's operator set. */
export async function ensurePartnerMembership(
  ctx: CommandHandlerContext,
  partnerAccountId: string,
  userId: string,
): Promise<void> {
  const trx = requireTrx(ctx);
  await trx
    .insertInto("partners.partner_memberships")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      partner_account_id: partnerAccountId,
      user_id: userId,
      created_at: now(),
    })
    .onConflict((oc) => oc.columns(["tenant_id", "partner_account_id", "user_id"]).doNothing())
    .execute();
}

export interface PartnerAccountRow {
  id: string;
  tenantId: string;
  displayName: string;
  accountType: string;
  status: string;
  linkedTenantId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toAccount(row: {
  id: string;
  tenant_id: string;
  display_name: string;
  account_type: string;
  status: string;
  linked_tenant_id: string | null;
  created_at: Date;
  updated_at: Date;
}): PartnerAccountRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    displayName: row.display_name,
    accountType: row.account_type,
    status: row.status,
    linkedTenantId: row.linked_tenant_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getAccount(ctx: CommandHandlerContext, accountId: string): Promise<PartnerAccountRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("partners.partner_accounts")
    .select(["id", "tenant_id", "display_name", "account_type", "status", "linked_tenant_id", "created_at", "updated_at"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", accountId)
    .executeTakeFirst();
  return row === undefined ? null : toAccount(row);
}

export async function insertAccount(
  ctx: CommandHandlerContext,
  input: { displayName: string; status: PartnerStatus },
): Promise<PartnerAccountRow> {
  const trx = requireTrx(ctx);
  const id = newId();
  const at = now();
  await trx
    .insertInto("partners.partner_accounts")
    .values({
      id,
      tenant_id: ctx.tenantId,
      display_name: input.displayName,
      account_type: "SERVICE_RESELLER",
      status: input.status,
      linked_tenant_id: null,
      created_at: at,
      updated_at: at,
    })
    .execute();
  const created = await getAccount(ctx, id);
  if (created === null) {
    throw new Error("partner account insert did not persist");
  }
  return created;
}

export async function updateAccountStatus(
  ctx: CommandHandlerContext,
  accountId: string,
  from: PartnerStatus[],
  to: PartnerStatus,
): Promise<PartnerAccountRow | null> {
  const trx = requireTrx(ctx);
  const updated = await trx
    .updateTable("partners.partner_accounts")
    .set({ status: to, updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", accountId)
    .where("status", "in", [...from])
    .returning(["id", "tenant_id", "display_name", "account_type", "status", "linked_tenant_id", "created_at", "updated_at"])
    .executeTakeFirst();
  return updated === undefined ? null : toAccount(updated);
}

export function canConvertToTenant(status: PartnerStatus, linkedTenantId: string | null): boolean {
  return status === "ACTIVE" && linkedTenantId === null;
}

export async function linkPartnerTenant(
  ctx: CommandHandlerContext,
  accountId: string,
  newTenantId: string,
): Promise<PartnerAccountRow | null> {
  const trx = requireTrx(ctx);
  const updated = await trx
    .updateTable("partners.partner_accounts")
    .set({ linked_tenant_id: newTenantId, updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", accountId)
    .where("linked_tenant_id", "is", null)
    .returning(["id", "tenant_id", "display_name", "account_type", "status", "linked_tenant_id", "created_at", "updated_at"])
    .executeTakeFirst();
  return updated === undefined ? null : toAccount(updated);
}

/** Live ACTIVE edge parent → child, or null. Tenant-scoped. */
export async function getActiveParentEdge(
  ctx: CommandHandlerContext,
  childAccountId: string,
): Promise<{ id: string; parentAccountId: string } | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("partners.partner_relationships")
    .select(["id", "parent_account_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("child_account_id", "=", childAccountId)
    .where("status", "=", "ACTIVE")
    .executeTakeFirst();
  return row === undefined ? null : { id: row.id, parentAccountId: row.parent_account_id };
}

/** True when `candidate` is a strict ancestor of `accountId` (cycle walk). */
export async function isAncestorOf(
  ctx: CommandHandlerContext,
  candidateAncestorId: string,
  accountId: string,
): Promise<boolean> {
  let current: string | null = accountId;
  const seen = new Set<string>();
  while (current !== null) {
    if (current === candidateAncestorId) {
      return true;
    }
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    const edge = await getActiveParentEdge(ctx, current);
    current = edge === null ? null : edge.parentAccountId;
  }
  return false;
}

/** True when `parentId` is the DIRECT active parent of `childId`. */
export async function isDirectParentOf(
  ctx: CommandHandlerContext,
  parentId: string,
  childId: string,
): Promise<boolean> {
  const edge = await getActiveParentEdge(ctx, childId);
  return edge !== null && edge.parentAccountId === parentId;
}

export async function insertDirectRelationship(
  ctx: CommandHandlerContext,
  input: { parentAccountId: string; childAccountId: string },
): Promise<{ id: string; parentAccountId: string; childAccountId: string; status: string }> {
  const trx = requireTrx(ctx);
  const id = newId();
  try {
    await trx
      .insertInto("partners.partner_relationships")
      .values({
        id,
        tenant_id: ctx.tenantId,
        parent_account_id: input.parentAccountId,
        child_account_id: input.childAccountId,
        status: "ACTIVE",
        created_at: now(),
        ended_at: null,
      })
      .execute();
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      throw err;
    }
    throw err;
  }
  return { id, parentAccountId: input.parentAccountId, childAccountId: input.childAccountId, status: "ACTIVE" };
}

export async function listDirectChildren(
  ctx: CommandHandlerContext,
  parentAccountId: string,
): Promise<PartnerAccountRow[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("partners.partner_relationships as rel")
    .innerJoin("partners.partner_accounts as child", (join) =>
      join
        .onRef("child.tenant_id", "=", "rel.tenant_id")
        .onRef("child.id", "=", "rel.child_account_id"),
    )
    .select([
      "child.id",
      "child.tenant_id",
      "child.display_name",
      "child.account_type",
      "child.status",
      "child.linked_tenant_id",
      "child.created_at",
      "child.updated_at",
    ])
    .where("rel.tenant_id", "=", ctx.tenantId)
    .where("rel.parent_account_id", "=", parentAccountId)
    .where("rel.status", "=", "ACTIVE")
    .orderBy("child.created_at", "asc")
    .execute();
  return rows.map(toAccount);
}

export async function upsertCapability(
  ctx: CommandHandlerContext,
  input: { partnerAccountId: string; capabilityKey: string; status: string },
): Promise<{ id: string; capabilityKey: string; status: string }> {
  const trx = requireTrx(ctx);
  const existing = await trx
    .selectFrom("partners.partner_capabilities")
    .select(["id", "capability_key", "status"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("partner_account_id", "=", input.partnerAccountId)
    .where("capability_key", "=", input.capabilityKey)
    .executeTakeFirst();
  if (existing !== undefined) {
    await trx
      .updateTable("partners.partner_capabilities")
      .set({ status: input.status, updated_at: now() })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", existing.id)
      .execute();
    return { id: existing.id, capabilityKey: existing.capability_key, status: input.status };
  }
  const id = newId();
  const at = now();
  await trx
    .insertInto("partners.partner_capabilities")
    .values({
      id,
      tenant_id: ctx.tenantId,
      partner_account_id: input.partnerAccountId,
      capability_key: input.capabilityKey,
      status: input.status,
      created_at: at,
      updated_at: at,
    })
    .execute();
  return { id, capabilityKey: input.capabilityKey, status: input.status };
}

export interface CreditEntryRow {
  id: string;
  entryType: string;
  amountMinor: string;
  currency: string;
  idempotencyKey: string;
  idempotencyFingerprint: string | null;
  referenceType: string | null;
  referenceId: string | null;
}

export async function findEntryByKey(
  ctx: CommandHandlerContext,
  partnerAccountId: string,
  idempotencyKey: string,
): Promise<CreditEntryRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("partners.reseller_credit_entries")
    .select(["id", "entry_type", "amount_minor", "currency", "idempotency_key", "idempotency_fingerprint", "reference_type", "reference_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("partner_account_id", "=", partnerAccountId)
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();
  return row === undefined
    ? null
    : {
        id: row.id,
        entryType: row.entry_type,
        amountMinor: String(row.amount_minor),
        currency: row.currency,
        idempotencyKey: row.idempotency_key,
        idempotencyFingerprint: row.idempotency_fingerprint,
        referenceType: row.reference_type,
        referenceId: row.reference_id,
      };
}

export async function appendCreditEntry(
  ctx: CommandHandlerContext,
  input: {
    partnerAccountId: string;
    entryType: string;
    amountMinor: string;
    currency: string;
    idempotencyKey: string;
    idempotencyFingerprint?: string | null;
    referenceType?: string | null;
    referenceId?: string | null;
  },
): Promise<CreditEntryRow> {
  const trx = requireTrx(ctx);
  const id = newId();
  await trx
    .insertInto("partners.reseller_credit_entries")
    .values({
      id,
      tenant_id: ctx.tenantId,
      partner_account_id: input.partnerAccountId,
      entry_type: input.entryType,
      amount_minor: input.amountMinor,
      currency: input.currency,
      idempotency_key: input.idempotencyKey,
      idempotency_fingerprint: input.idempotencyFingerprint ?? null,
      reference_type: input.referenceType ?? null,
      reference_id: input.referenceId ?? null,
      evidence_ref: null,
      created_at: now(),
    })
    .execute();
  return {
    id,
    entryType: input.entryType,
    amountMinor: input.amountMinor,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    idempotencyFingerprint: input.idempotencyFingerprint ?? null,
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId ?? null,
  };
}

/** SUM(entries) for the partner, per currency. */
export async function sumLedgerByCurrency(
  ctx: CommandHandlerContext,
  partnerAccountId: string,
): Promise<Map<string, string>> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("partners.reseller_credit_entries")
    .select(["currency", sql<string>`sum(amount_minor)::text`.as("total")])
    .where("tenant_id", "=", ctx.tenantId)
    .where("partner_account_id", "=", partnerAccountId)
    .groupBy("currency")
    .execute();
  const out = new Map<string, string>();
  for (const row of rows) {
    out.set(row.currency, row.total);
  }
  return out;
}

/** SUM(RESERVED reservations) for the partner, per currency. */
export async function sumReservedByCurrency(
  ctx: CommandHandlerContext,
  partnerAccountId: string,
): Promise<Map<string, string>> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("partners.reseller_credit_reservations")
    .select(["currency", sql<string>`sum(amount_minor)::text`.as("total")])
    .where("tenant_id", "=", ctx.tenantId)
    .where("partner_account_id", "=", partnerAccountId)
    .where("status", "=", "RESERVED")
    .groupBy("currency")
    .execute();
  const out = new Map<string, string>();
  for (const row of rows) {
    out.set(row.currency, row.total);
  }
  return out;
}

export interface CreditReservationRow {
  id: string;
  partnerAccountId: string;
  amountMinor: string;
  currency: string;
  status: string;
  idempotencyKey: string;
  idempotencyFingerprint: string | null;
}

function toReservation(row: {
  id: string;
  partner_account_id: string;
  amount_minor: string | number | bigint;
  currency: string;
  status: string;
  idempotency_key: string;
  idempotency_fingerprint: string | null;
}): CreditReservationRow {
  return {
    id: row.id,
    partnerAccountId: row.partner_account_id,
    amountMinor: String(row.amount_minor),
    currency: row.currency,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    idempotencyFingerprint: row.idempotency_fingerprint,
  };
}

export async function findReservationByKey(
  ctx: CommandHandlerContext,
  partnerAccountId: string,
  idempotencyKey: string,
): Promise<CreditReservationRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("partners.reseller_credit_reservations")
    .select(["id", "partner_account_id", "amount_minor", "currency", "status", "idempotency_key", "idempotency_fingerprint"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("partner_account_id", "=", partnerAccountId)
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();
  return row === undefined ? null : toReservation(row);
}

export async function getReservation(
  ctx: CommandHandlerContext,
  reservationId: string,
): Promise<CreditReservationRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("partners.reseller_credit_reservations")
    .select(["id", "partner_account_id", "amount_minor", "currency", "status", "idempotency_key", "idempotency_fingerprint"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", reservationId)
    .executeTakeFirst();
  return row === undefined ? null : toReservation(row);
}

export async function insertReservation(
  ctx: CommandHandlerContext,
  input: { partnerAccountId: string; amountMinor: string; currency: string; idempotencyKey: string; idempotencyFingerprint?: string | null },
): Promise<CreditReservationRow> {
  const trx = requireTrx(ctx);
  const id = newId();
  const at = now();
  await trx
    .insertInto("partners.reseller_credit_reservations")
    .values({
      id,
      tenant_id: ctx.tenantId,
      partner_account_id: input.partnerAccountId,
      amount_minor: input.amountMinor,
      currency: input.currency,
      status: "RESERVED",
      idempotency_key: input.idempotencyKey,
      idempotency_fingerprint: input.idempotencyFingerprint ?? null,
      created_at: at,
      updated_at: at,
    })
    .execute();
  return {
    id,
    partnerAccountId: input.partnerAccountId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    status: "RESERVED",
    idempotencyKey: input.idempotencyKey,
    idempotencyFingerprint: input.idempotencyFingerprint ?? null,
  };
}

export async function transitionReservation(
  ctx: CommandHandlerContext,
  reservationId: string,
  from: string[],
  to: string,
): Promise<CreditReservationRow | null> {
  const trx = requireTrx(ctx);
  const updated = await trx
    .updateTable("partners.reseller_credit_reservations")
    .set({ status: to, updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", reservationId)
    .where("status", "in", [...from])
    .returning(["id", "partner_account_id", "amount_minor", "currency", "status", "idempotency_key", "idempotency_fingerprint"])
    .executeTakeFirst();
  return updated === undefined ? null : toReservation(updated);
}

export interface PriceBookRow {
  id: string;
  bookKey: string;
  versionNo: number;
  status: string;
  unitPriceMinor: string;
  currency: string;
}

export async function getPriceBook(ctx: CommandHandlerContext, priceBookId: string): Promise<PriceBookRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("partners.reseller_price_books")
    .select(["id", "book_key", "version_no", "status", "unit_price_minor", "currency"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", priceBookId)
    .executeTakeFirst();
  return row === undefined
    ? null
    : {
        id: row.id,
        bookKey: row.book_key,
        versionNo: row.version_no,
        status: row.status,
        unitPriceMinor: String(row.unit_price_minor),
        currency: row.currency,
      };
}

export async function latestPublishedPriceBook(
  ctx: CommandHandlerContext,
  bookKey: string,
): Promise<PriceBookRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("partners.reseller_price_books")
    .select(["id", "book_key", "version_no", "status", "unit_price_minor", "currency"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("book_key", "=", bookKey)
    .where("status", "=", "PUBLISHED")
    .orderBy("version_no", "desc")
    .executeTakeFirst();
  return row === undefined
    ? null
    : {
        id: row.id,
        bookKey: row.book_key,
        versionNo: row.version_no,
        status: row.status,
        unitPriceMinor: String(row.unit_price_minor),
        currency: row.currency,
      };
}

export async function publishPriceBook(
  ctx: CommandHandlerContext,
  input: { bookKey: string; unitPriceMinor: string; currency: string },
): Promise<PriceBookRow> {
  const trx = requireTrx(ctx);
  const latest = await trx
    .selectFrom("partners.reseller_price_books")
    .select(["version_no"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("book_key", "=", input.bookKey)
    .orderBy("version_no", "desc")
    .executeTakeFirst();
  const versionNo = (latest?.version_no ?? 0) + 1;
  const id = newId();
  const at = now();
  await trx
    .insertInto("partners.reseller_price_books")
    .values({
      id,
      tenant_id: ctx.tenantId,
      book_key: input.bookKey,
      version_no: versionNo,
      status: "PUBLISHED",
      unit_price_minor: input.unitPriceMinor,
      currency: input.currency,
      published_at: at,
      created_at: at,
      updated_at: at,
    })
    .execute();
  return {
    id,
    bookKey: input.bookKey,
    versionNo,
    status: "PUBLISHED",
    unitPriceMinor: input.unitPriceMinor,
    currency: input.currency,
  };
}

export interface ResellerOrderRow {
  id: string;
  partnerAccountId: string;
  priceBookId: string;
  quantity: number;
  unitPriceMinor: string;
  totalMinor: string;
  currency: string;
  status: string;
  creditReservationId: string | null;
  idempotencyKey: string;
  idempotencyFingerprint: string | null;
  settledAt: Date | null;
}

function toOrder(row: {
  id: string;
  partner_account_id: string;
  price_book_id: string;
  quantity: number;
  unit_price_minor: string | number | bigint;
  total_minor: string | number | bigint;
  currency: string;
  status: string;
  credit_reservation_id: string | null;
  idempotency_key: string;
  idempotency_fingerprint: string | null;
  settled_at: Date | null;
}): ResellerOrderRow {
  return {
    id: row.id,
    partnerAccountId: row.partner_account_id,
    priceBookId: row.price_book_id,
    quantity: row.quantity,
    unitPriceMinor: String(row.unit_price_minor),
    totalMinor: String(row.total_minor),
    currency: row.currency,
    status: row.status,
    creditReservationId: row.credit_reservation_id,
    idempotencyKey: row.idempotency_key,
    idempotencyFingerprint: row.idempotency_fingerprint,
    settledAt: row.settled_at,
  };
}

export async function findOrderByKey(
  ctx: CommandHandlerContext,
  partnerAccountId: string,
  idempotencyKey: string,
): Promise<ResellerOrderRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("partners.reseller_orders")
    .select([
      "id",
      "partner_account_id",
      "price_book_id",
      "quantity",
      "unit_price_minor",
      "total_minor",
      "currency",
      "status",
      "credit_reservation_id",
      "idempotency_key",
      "idempotency_fingerprint",
      "settled_at",
    ])
    .where("tenant_id", "=", ctx.tenantId)
    .where("partner_account_id", "=", partnerAccountId)
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();
  return row === undefined ? null : toOrder(row);
}

export async function getOrder(ctx: CommandHandlerContext, orderId: string): Promise<ResellerOrderRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("partners.reseller_orders")
    .select([
      "id",
      "partner_account_id",
      "price_book_id",
      "quantity",
      "unit_price_minor",
      "total_minor",
      "currency",
      "status",
      "credit_reservation_id",
      "idempotency_key",
      "idempotency_fingerprint",
      "settled_at",
    ])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", orderId)
    .executeTakeFirst();
  return row === undefined ? null : toOrder(row);
}

export async function insertOrder(
  ctx: CommandHandlerContext,
  input: {
    partnerAccountId: string;
    priceBookId: string;
    quantity: number;
    unitPriceMinor: string;
    totalMinor: string;
    currency: string;
    creditReservationId: string;
    idempotencyKey: string;
    idempotencyFingerprint?: string | null;
    status: string;
  },
): Promise<ResellerOrderRow> {
  const trx = requireTrx(ctx);
  const id = newId();
  const at = now();
  await trx
    .insertInto("partners.reseller_orders")
    .values({
      id,
      tenant_id: ctx.tenantId,
      partner_account_id: input.partnerAccountId,
      price_book_id: input.priceBookId,
      quantity: input.quantity,
      unit_price_minor: input.unitPriceMinor,
      total_minor: input.totalMinor,
      currency: input.currency,
      status: input.status,
      credit_reservation_id: input.creditReservationId,
      idempotency_key: input.idempotencyKey,
      idempotency_fingerprint: input.idempotencyFingerprint ?? null,
      created_at: at,
      updated_at: at,
      settled_at: null,
    })
    .execute();
  const created = await getOrder(ctx, id);
  if (created === null) {
    throw new Error("reseller order insert did not persist");
  }
  return created;
}

export async function settleOrder(
  ctx: CommandHandlerContext,
  orderId: string,
): Promise<ResellerOrderRow | null> {
  const trx = requireTrx(ctx);
  const at = now();
  const updated = await trx
    .updateTable("partners.reseller_orders")
    .set({ status: "SETTLED", updated_at: at, settled_at: at })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", orderId)
    .where("status", "in", ["DRAFT", "RESERVED"])
    .returning([
      "id",
      "partner_account_id",
      "price_book_id",
      "quantity",
      "unit_price_minor",
      "total_minor",
      "currency",
      "status",
      "credit_reservation_id",
      "idempotency_key",
      "idempotency_fingerprint",
      "settled_at",
    ])
    .executeTakeFirst();
  return updated === undefined ? null : toOrder(updated);
}

export async function failOrder(ctx: CommandHandlerContext, orderId: string): Promise<void> {
  const trx = requireTrx(ctx);
  await trx
    .updateTable("partners.reseller_orders")
    .set({ status: "FAILED", updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", orderId)
    .where("status", "in", ["DRAFT", "RESERVED"])
    .execute();
}

export interface AcademyContentRow {
  id: string;
  topicKey: string;
  title: string;
  position: number;
}

export async function listAcademyContent(ctx: CommandHandlerContext): Promise<AcademyContentRow[]> {
  const trx = requireTrx(ctx);
  // P1.5-058: GLOBAL catalog read (no tenant predicate — same curriculum
  // for every tenant). Runs inside the command's tenant transaction; the
  // table carries no RLS by design, so no separate context is needed.
  const rows = await trx
    .selectFrom("partners.learning_content")
    .select(["id", "topic_key", "title", "position"])
    .orderBy("position", "asc")
    .execute();
  return rows.map((row) => ({ id: row.id, topicKey: row.topic_key, title: row.title, position: row.position }));
}

export async function getContentByTopicKey(
  ctx: CommandHandlerContext,
  topicKey: string,
): Promise<AcademyContentRow | null> {
  const trx = requireTrx(ctx);
  // P1.5-058: GLOBAL catalog read — see listAcademyContent().
  const row = await trx
    .selectFrom("partners.learning_content")
    .select(["id", "topic_key", "title", "position"])
    .where("topic_key", "=", topicKey)
    .executeTakeFirst();
  return row === undefined ? null : { id: row.id, topicKey: row.topic_key, title: row.title, position: row.position };
}

export async function countCompletedTopics(
  ctx: CommandHandlerContext,
  partnerAccountId: string,
): Promise<number> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("partners.learning_progress")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("partner_account_id", "=", partnerAccountId)
    .where("status", "=", "COMPLETED")
    .execute();
  return rows.length;
}

export async function completeTopicProgress(
  ctx: CommandHandlerContext,
  partnerAccountId: string,
  contentId: string,
): Promise<{ already: boolean }> {
  const trx = requireTrx(ctx);
  const existing = await trx
    .selectFrom("partners.learning_progress")
    .select(["id", "status"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("partner_account_id", "=", partnerAccountId)
    .where("content_id", "=", contentId)
    .executeTakeFirst();
  const at = now();
  if (existing !== undefined) {
    if (existing.status === "COMPLETED") {
      return { already: true };
    }
    await trx
      .updateTable("partners.learning_progress")
      .set({ status: "COMPLETED", completed_at: at, updated_at: at })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", existing.id)
      .execute();
    return { already: false };
  }
  await trx
    .insertInto("partners.learning_progress")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      partner_account_id: partnerAccountId,
      content_id: contentId,
      status: "COMPLETED",
      completed_at: at,
      created_at: at,
      updated_at: at,
    })
    .execute();
  return { already: false };
}
