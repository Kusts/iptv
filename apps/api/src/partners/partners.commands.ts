import { z } from "zod";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { newId, now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf } from "../crm/wave2-store.js";
import { UniqueViolationError } from "../trial/trial-store.js";
import {
  advisoryLockHierarchy,
  advisoryLockPartnerCredit,
  appendCreditEntry,
  canActivate,
  canConvertToTenant,
  canOrder,
  completeTopicProgress,
  computeAvailableCredit,
  countCompletedTopics,
  ensurePartnerMembership,
  findEntryByKey,
  findOrderByKey,
  getAccount,
  getContentByTopicKey,
  getPriceBook,
  getReservation,
  hasPartnerMembership,
  insertAccount,
  insertDirectRelationship,
  insertOrder,
  insertReservation,
  isAncestorOf,
  isDirectParentOf,
  latestPublishedPriceBook,
  linkPartnerTenant,
  listAcademyContent,
  getActiveParentEdge,
  parsePositiveMinor,
  publishPriceBook,
  settleOrder,
  sumLedgerByCurrency,
  sumReservedByCurrency,
  transitionReservation,
  updateAccountStatus,
  upsertCapability,
  nextStatusOnTopicStart,
  nextStatusOnTopicsComplete,
  type CreditReservationRow,
  type PartnerStatus,
  type ResellerOrderRow,
} from "./partners.store.js";

/**
 * Wave 13 Partners/Resellers commands (owning context for the MVP-PILOT
 * reseller nucleus: direct-edge hierarchy, prepaid credit ledger,
 * reseller orders, Academy gates and lifecycle).
 *
 * Canonical rules enforced here:
 * - Hierarchy is DIRECT edges only: a child has at most one live parent
 *   (DB unique), self-parent is rejected by CHECK, and cycles are
 *   rejected by an ancestor walk (at most one parent per child, so the
 *   walk is linear). Hierarchy writes serialize per tenant (advisory
 *   hierarchy lock), so concurrent A→B + B→A edges cannot both pass the
 *   walk. Only a DIRECT parent manages; ancestors aggregate.
 * - Partner scope derives from auth: `partners.partner_memberships`
 *   grants (migration 035) bind users to accounts; every management,
 *   financial and Academy write requires the caller's membership in the
 *   affected account (platform admins bypass). The acting parent is
 *   derived from the live edge when the body omits it.
 * - Prepaid ledger is append-only (DB trigger rejects UPDATE/DELETE).
 *   Available = SUM(entries) − SUM(RESERVED reservations) under a
 *   per-(tenant, partner) advisory lock — concurrent orders serialize,
 *   never double-spend. Replays resolve via idempotency keys WITH payload
 *   fingerprints: key reuse with a divergent payload is rejected.
 * - Orders pin the exact price-book version and consume credit in the
 *   SAME transaction (RESERVED → SETTLED); insufficient funds fail
 *   closed with `BLOCKED INSUFFICIENT_RESELLER_CREDIT`. Reservations
 *   exist ONLY inside the order transaction (no standalone reserve
 *   endpoint, no permanent holds). Order totals are capped at BIGINT max.
 * - Academy gates the lifecycle: ONBOARDING → TRAINING on first topic,
 *   → READY when all 10 complete, → ACTIVE only by explicit activation.
 *   Topic completions serialize per partner so concurrent final topics
 *   transition to READY exactly once.
 * - Academy gates the lifecycle: ONBOARDING → TRAINING on first topic,
 *   → READY when all 10 complete, → ACTIVE only by explicit activation.
 * - Events are registry-listed ONLY (partner.*.v1). No invented ids.
 */

export const createAccountInput = z.object({
  displayName: z.string().trim().min(1).max(200),
  initialStatus: z.enum(["PROSPECT", "ONBOARDING"]).default("ONBOARDING"),
});
export type CreateAccountInput = z.infer<typeof createAccountInput>;

export const createDirectRelationshipInput = z.object({
  parentAccountId: z.string().uuid(),
  childAccountId: z.string().uuid().optional(),
  childDisplayName: z.string().trim().min(1).max(200).optional(),
});
export type CreateDirectRelationshipInput = z.infer<typeof createDirectRelationshipInput>;

export const setCapabilityInput = z.object({
  partnerAccountId: z.string().uuid(),
  capabilityKey: z.enum(["SERVICE_RESELLER", "SAAS_RESELLER"]),
  status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED"]).default("ACTIVE"),
  // Optional: when omitted the direct parent is derived from the live edge
  // and the caller must hold a membership in it. The scope always derives
  // from auth (membership), never from the body alone.
  actingParentAccountId: z.string().uuid().optional(),
});
export type SetCapabilityInput = z.infer<typeof setCapabilityInput>;

export const topupCreditInput = z.object({
  partnerAccountId: z.string().uuid(),
  amountMinor: z.string().trim().min(1).max(30),
  currency: z.string().trim().min(1).max(8),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type TopupCreditInput = z.infer<typeof topupCreditInput>;

export const releaseCreditInput = z.object({
  reservationId: z.string().uuid(),
});
export type ReleaseCreditInput = z.infer<typeof releaseCreditInput>;

export const publishPriceBookInput = z.object({
  bookKey: z.string().trim().min(1).max(120).default("wholesale-default"),
  unitPriceMinor: z.string().trim().min(1).max(30),
  currency: z.string().trim().min(1).max(8),
});
export type PublishPriceBookInput = z.infer<typeof publishPriceBookInput>;

export const createResellerOrderInput = z.object({
  partnerAccountId: z.string().uuid(),
  priceBookId: z.string().uuid().optional(),
  priceBookKey: z.string().trim().min(1).max(120).default("wholesale-default"),
  quantity: z.number().int().min(1).max(10_000),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type CreateResellerOrderInput = z.infer<typeof createResellerOrderInput>;

export const completeTopicInput = z.object({
  partnerAccountId: z.string().uuid(),
  topicKey: z.string().trim().min(1).max(120),
});
export type CompleteTopicInput = z.infer<typeof completeTopicInput>;

export const activatePartnerInput = z.object({
  partnerAccountId: z.string().uuid(),
});
export type ActivatePartnerInput = z.infer<typeof activatePartnerInput>;

export const convertToTenantInput = z.object({
  partnerAccountId: z.string().uuid(),
  tenantName: z.string().trim().min(1).max(200).optional(),
  tenantSlug: z.string().trim().min(1).max(64).optional(),
});
export type ConvertToTenantInput = z.infer<typeof convertToTenantInput>;

const TENANT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function slugifyTenant(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = newId().replace(/-/g, "").slice(-8);
  return `${base.length > 0 ? base : "tenant"}-${suffix}`;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

/** PostgreSQL BIGINT ceiling — totals above it are rejected before insert. */
const BIGINT_MAX = 9_223_372_036_854_775_807n;

function fingerprintOf(value: Record<string, unknown>): string {
  const ordered = Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}

function fingerprintMismatch() {
  return {
    ok: false as const,
    code: "precondition_failed" as const,
    message: "idempotency key already used with a different payload (IDEMPOTENCY_PAYLOAD_MISMATCH)",
  };
}

/**
 * Auth-derived partner scope: every management/financial/academy write
 * requires the authenticated user to hold a membership grant in the
 * affected partner account (platform admins bypass). Returns a denial
 * result, or null when the scope checks out.
 */
async function denyWithoutPartnerScope(
  ctx: CommandHandlerContext,
  partnerAccountId: string,
): Promise<{ ok: false; code: "forbidden"; message: string } | null> {
  if (ctx.actor.isPlatformAdmin) {
    return null;
  }
  if (!(await hasPartnerMembership(ctx, partnerAccountId, ctx.actor.userId))) {
    return {
      ok: false,
      code: "forbidden",
      message: "authenticated user has no membership in this partner account (PARTNER_FORBIDDEN)",
    };
  }
  return null;
}

function normalizeCurrency(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return CURRENCY_RE.test(normalized) ? normalized : null;
}

async function emitPartner(
  ctx: CommandHandlerContext,
  eventType: string,
  aggregateId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await emitAndEnqueue(ctx, {
    eventType,
    aggregateType: "partner_account",
    aggregateId,
    data: { partner_account_id: aggregateId, ...data },
  });
}

function toPublicReservation(row: CreditReservationRow): Record<string, unknown> {
  return {
    id: row.id,
    partnerAccountId: row.partnerAccountId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status,
  };
}

function toPublicOrder(row: ResellerOrderRow): Record<string, unknown> {
  return {
    id: row.id,
    partnerAccountId: row.partnerAccountId,
    priceBookId: row.priceBookId,
    quantity: row.quantity,
    unitPriceMinor: row.unitPriceMinor,
    totalMinor: row.totalMinor,
    currency: row.currency,
    status: row.status,
    creditReservationId: row.creditReservationId,
    settledAt: row.settledAt?.toISOString() ?? null,
  };
}

async function availableFor(
  ctx: CommandHandlerContext,
  partnerAccountId: string,
  currency: string,
): Promise<string> {
  const ledger = await sumLedgerByCurrency(ctx, partnerAccountId);
  const reserved = await sumReservedByCurrency(ctx, partnerAccountId);
  return computeAvailableCredit(ledger.get(currency) ?? "0", reserved.get(currency) ?? "0");
}

async function handleCreateAccount(
  ctx: CommandHandlerContext,
  input: CreateAccountInput,
): Promise<CommandResult<Record<string, unknown>>> {
  const account = await insertAccount(ctx, { displayName: input.displayName.trim(), status: input.initialStatus });
  await ensurePartnerMembership(ctx, account.id, ctx.actor.userId);
  await emitPartner(ctx, "partner.account_created.v1", account.id, {
    display_name: account.displayName,
    status: account.status,
  });
  return { ok: true, data: { id: account.id, displayName: account.displayName, status: account.status, already: false } };
}

async function handleCreateDirectRelationship(
  ctx: CommandHandlerContext,
  input: CreateDirectRelationshipInput,
): Promise<CommandResult<Record<string, unknown>>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("partners commands require a database transaction");
  }
  if (input.childAccountId === undefined && input.childDisplayName === undefined) {
    return { ok: false, code: "validation_failed", message: "either childAccountId or childDisplayName is required" };
  }
  if (input.childAccountId !== undefined && input.childDisplayName !== undefined) {
    return { ok: false, code: "validation_failed", message: "only one of childAccountId or childDisplayName is allowed" };
  }
  const parent = await getAccount(ctx, input.parentAccountId);
  if (parent === null) {
    return { ok: false, code: "not_found", message: "parent account not found in this tenant" };
  }
  if (parent.status === "TERMINATED" || parent.status === "SUSPENDED") {
    return { ok: false, code: "precondition_failed", message: `parent account is ${parent.status}` };
  }
  const scopeDenial = await denyWithoutPartnerScope(ctx, parent.id);
  if (scopeDenial !== null) {
    return scopeDenial;
  }
  // Tenant-wide hierarchy serialization: concurrent A→B + B→A edges cannot
  // both pass the cycle walk below — exactly one wins, the loser observes
  // the winner's edge (existing-parent or cycle) and is denied.
  await advisoryLockHierarchy(trx, ctx.tenantId);

  let childId: string;
  if (input.childAccountId !== undefined) {
    const child = await getAccount(ctx, input.childAccountId);
    if (child === null) {
      return { ok: false, code: "not_found", message: "child account not found in this tenant" };
    }
    childId = child.id;
  } else {
    const created = await insertAccount(ctx, { displayName: (input.childDisplayName as string).trim(), status: "ONBOARDING" });
    await ensurePartnerMembership(ctx, created.id, ctx.actor.userId);
    await emitPartner(ctx, "partner.account_created.v1", created.id, {
      display_name: created.displayName,
      status: created.status,
    });
    childId = created.id;
  }

  if (childId === parent.id) {
    return { ok: false, code: "validation_failed", message: "an account cannot parent itself" };
  }
  // Direct-edge invariant: the child must have no live parent edge —
  // attaching an account that already belongs to another parent (e.g. a
  // grandparent attaching a grandchild) is denied, never re-parented.
  const existingEdge = await getActiveParentEdge(ctx, childId);
  if (existingEdge !== null) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "child account already has a direct parent (re-parenting is not allowed)",
    };
  }
  // Cycle invariant: the child must not be an ancestor of the parent
  // (A → B → A rejected here; the self-parent CHECK is the backstop).
  if (await isAncestorOf(ctx, childId, parent.id)) {
    return { ok: false, code: "validation_failed", message: "relationship would create a cycle (CYCLE_DETECTED)" };
  }
  try {
    const edge = await insertDirectRelationship(ctx, { parentAccountId: parent.id, childAccountId: childId });
    await emitPartner(ctx, "partner.relationship_created.v1", parent.id, {
      child_account_id: childId,
      relationship_id: edge.id,
    });
    return {
      ok: true,
      data: { relationshipId: edge.id, parentAccountId: parent.id, childAccountId: childId, already: false },
    };
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      return { ok: false, code: "precondition_failed", message: err.message };
    }
    throw err;
  }
}

async function handleSetCapability(
  ctx: CommandHandlerContext,
  input: SetCapabilityInput,
): Promise<CommandResult<Record<string, unknown>>> {
  const target = await getAccount(ctx, input.partnerAccountId);
  if (target === null) {
    return { ok: false, code: "not_found", message: "partner account not found in this tenant" };
  }
  // The acting parent derives from auth: explicit body value or the live
  // direct-parent edge — either way the caller must hold a membership in it.
  let actingId = input.actingParentAccountId;
  if (actingId === undefined) {
    const edge = await getActiveParentEdge(ctx, target.id);
    if (edge === null) {
      return { ok: false, code: "precondition_failed", message: "partner account has no direct parent (NOT_DIRECT_PARENT)" };
    }
    actingId = edge.parentAccountId;
  }
  const scopeDenial = await denyWithoutPartnerScope(ctx, actingId);
  if (scopeDenial !== null) {
    return scopeDenial;
  }
  const acting = await getAccount(ctx, actingId);
  if (acting === null) {
    return { ok: false, code: "not_found", message: "acting parent account not found in this tenant" };
  }
  // Direct-edge management boundary: only the DIRECT parent manages.
  // An ancestor that is not the direct parent (e.g. a grandparent) is
  // denied — it may aggregate, never manage.
  if (!(await isDirectParentOf(ctx, acting.id, target.id))) {
    return {
      ok: false,
      code: "forbidden",
      message: "only the direct parent manages a partner account (NOT_DIRECT_PARENT)",
    };
  }
  const capability = await upsertCapability(ctx, {
    partnerAccountId: target.id,
    capabilityKey: input.capabilityKey,
    status: input.status,
  });
  return { ok: true, data: { partnerAccountId: target.id, ...capability } };
}

async function handleTopup(
  ctx: CommandHandlerContext,
  input: TopupCreditInput,
): Promise<CommandResult<Record<string, unknown>>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("partners commands require a database transaction");
  }
  const currency = normalizeCurrency(input.currency);
  if (currency === null) {
    return { ok: false, code: "validation_failed", message: "currency must be an explicit 3-letter code" };
  }
  let amount: bigint;
  try {
    amount = parsePositiveMinor(input.amountMinor);
  } catch {
    return { ok: false, code: "validation_failed", message: "amountMinor must be a strictly positive integer" };
  }
  const account = await getAccount(ctx, input.partnerAccountId);
  if (account === null) {
    return { ok: false, code: "not_found", message: "partner account not found in this tenant" };
  }
  const topupScopeDenial = await denyWithoutPartnerScope(ctx, account.id);
  if (topupScopeDenial !== null) {
    return topupScopeDenial;
  }
  await advisoryLockPartnerCredit(trx, ctx.tenantId, account.id);
  const key = input.idempotencyKey.trim();
  const topupFingerprint = fingerprintOf({ amountMinor: amount.toString(), currency });
  const replayed = await findEntryByKey(ctx, account.id, key);
  if (replayed !== null) {
    if (replayed.idempotencyFingerprint !== null && replayed.idempotencyFingerprint !== topupFingerprint) {
      return fingerprintMismatch();
    }
    return { ok: true, data: { entryId: replayed.id, amountMinor: replayed.amountMinor, currency: replayed.currency, already: true } };
  }
  try {
    const entry = await appendCreditEntry(ctx, {
      partnerAccountId: account.id,
      entryType: "TOPUP",
      amountMinor: amount.toString(),
      currency,
      idempotencyKey: key,
      idempotencyFingerprint: topupFingerprint,
      referenceType: "topup",
      referenceId: null,
    });
    const available = await availableFor(ctx, account.id, currency);
    return {
      ok: true,
      data: { entryId: entry.id, amountMinor: entry.amountMinor, currency, availableMinor: available, already: false },
    };
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      const raced = await findEntryByKey(ctx, account.id, key);
      if (raced !== null) {
        if (raced.idempotencyFingerprint !== null && raced.idempotencyFingerprint !== topupFingerprint) {
          return fingerprintMismatch();
        }
        return { ok: true, data: { entryId: raced.id, amountMinor: raced.amountMinor, currency: raced.currency, already: true } };
      }
    }
    throw err;
  }
}

async function handleRelease(
  ctx: CommandHandlerContext,
  input: ReleaseCreditInput,
): Promise<CommandResult<Record<string, unknown>>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("partners commands require a database transaction");
  }
  const reservation = await getReservation(ctx, input.reservationId);
  if (reservation === null) {
    return { ok: false, code: "not_found", message: "credit reservation not found in this tenant" };
  }
  const releaseScopeDenial = await denyWithoutPartnerScope(ctx, reservation.partnerAccountId);
  if (releaseScopeDenial !== null) {
    return releaseScopeDenial;
  }
  if (reservation.status === "CONSUMED") {
    return { ok: false, code: "precondition_failed", message: "reservation is CONSUMED; spent funds cannot be released" };
  }
  if (reservation.status === "RELEASED") {
    return { ok: true, data: { ...toPublicReservation(reservation), already: true } };
  }
  await advisoryLockPartnerCredit(trx, ctx.tenantId, reservation.partnerAccountId);
  const released = await transitionReservation(ctx, reservation.id, ["RESERVED"], "RELEASED");
  if (released === null) {
    const raced = await getReservation(ctx, reservation.id);
    if (raced === null) {
      return { ok: false, code: "not_found", message: "credit reservation not found in this tenant" };
    }
    if (raced.status === "CONSUMED") {
      return { ok: false, code: "precondition_failed", message: "reservation is CONSUMED; spent funds cannot be released" };
    }
    return { ok: true, data: { ...toPublicReservation(raced), already: true } };
  }
  await appendCreditEntry(ctx, {
    partnerAccountId: released.partnerAccountId,
    entryType: "RELEASE",
    amountMinor: "0",
    currency: released.currency,
    idempotencyKey: `release-memo:${released.id}`,
    referenceType: "reservation",
    referenceId: released.id,
  });
  return { ok: true, data: { ...toPublicReservation(released), already: false } };
}

async function handlePublishPriceBook(
  ctx: CommandHandlerContext,
  input: PublishPriceBookInput,
): Promise<CommandResult<Record<string, unknown>>> {
  const currency = normalizeCurrency(input.currency);
  if (currency === null) {
    return { ok: false, code: "validation_failed", message: "currency must be an explicit 3-letter code" };
  }
  let unit: bigint;
  try {
    unit = parsePositiveMinor(input.unitPriceMinor);
  } catch {
    return { ok: false, code: "validation_failed", message: "unitPriceMinor must be a strictly positive integer" };
  }
  const book = await publishPriceBook(ctx, {
    bookKey: input.bookKey.trim(),
    unitPriceMinor: unit.toString(),
    currency,
  });
  return {
    ok: true,
    data: {
      id: book.id,
      bookKey: book.bookKey,
      versionNo: book.versionNo,
      status: book.status,
      unitPriceMinor: book.unitPriceMinor,
      currency: book.currency,
    },
  };
}

async function handleCreateOrder(
  ctx: CommandHandlerContext,
  input: CreateResellerOrderInput,
): Promise<CommandResult<Record<string, unknown>>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("partners commands require a database transaction");
  }
  const account = await getAccount(ctx, input.partnerAccountId);
  if (account === null) {
    return { ok: false, code: "not_found", message: "partner account not found in this tenant" };
  }
  if (!canOrder(account.status as PartnerStatus)) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `partner account is ${account.status}; only ACTIVE partners settle reseller orders`,
    };
  }
  const orderScopeDenial = await denyWithoutPartnerScope(ctx, account.id);
  if (orderScopeDenial !== null) {
    return orderScopeDenial;
  }
  await advisoryLockPartnerCredit(trx, ctx.tenantId, account.id);
  const key = input.idempotencyKey.trim();
  const orderFingerprint = fingerprintOf({
    priceBookId: input.priceBookId ?? null,
    priceBookKey: input.priceBookKey.trim(),
    quantity: input.quantity,
  });
  const replayed = await findOrderByKey(ctx, account.id, key);
  if (replayed !== null) {
    if (replayed.idempotencyFingerprint !== null && replayed.idempotencyFingerprint !== orderFingerprint) {
      return fingerprintMismatch();
    }
    return { ok: true, data: { ...toPublicOrder(replayed), already: true } };
  }
  const book =
    input.priceBookId !== undefined ? await getPriceBook(ctx, input.priceBookId) : await latestPublishedPriceBook(ctx, input.priceBookKey.trim());
  if (book === null) {
    return { ok: false, code: "not_found", message: "price book not found in this tenant" };
  }
  if (book.status !== "PUBLISHED") {
    return { ok: false, code: "precondition_failed", message: `price book version is ${book.status}; only PUBLISHED versions settle` };
  }
  const total = BigInt(book.unitPriceMinor) * BigInt(input.quantity);
  if (total > BIGINT_MAX) {
    return {
      ok: false,
      code: "validation_failed",
      message: `order total ${total.toString()} exceeds the BIGINT minor-unit ceiling (${BIGINT_MAX.toString()})`,
    };
  }
  const available = await availableFor(ctx, account.id, book.currency);
  if (BigInt(available) < total) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `BLOCKED INSUFFICIENT_RESELLER_CREDIT: available ${available} ${book.currency} is less than ${total.toString()}`,
    };
  }
  try {
    // Reserve + consume + settle in the SAME transaction (prepaid: funds
    // are known, no two-phase needed). Any failure rolls everything back.
    // This is the ONLY reservation path: the standalone reserve endpoint
    // was removed, so no hold can outlive its order transaction.
    const reservation = await insertReservation(ctx, {
      partnerAccountId: account.id,
      amountMinor: total.toString(),
      currency: book.currency,
      idempotencyKey: `order:${key}`,
      idempotencyFingerprint: orderFingerprint,
    });
    await appendCreditEntry(ctx, {
      partnerAccountId: account.id,
      entryType: "RESERVE",
      amountMinor: "0",
      currency: book.currency,
      idempotencyKey: `reserve-memo:${reservation.id}`,
      referenceType: "reservation",
      referenceId: reservation.id,
    });
    await emitPartner(ctx, "partner.credit_reserved.v1", account.id, {
      reservation_id: reservation.id,
      amount_minor: reservation.amountMinor,
      currency: book.currency,
    });
    const order = await insertOrder(ctx, {
      partnerAccountId: account.id,
      priceBookId: book.id,
      quantity: input.quantity,
      unitPriceMinor: book.unitPriceMinor,
      totalMinor: total.toString(),
      currency: book.currency,
      creditReservationId: reservation.id,
      idempotencyKey: key,
      idempotencyFingerprint: orderFingerprint,
      status: "RESERVED",
    });
    const consumed = await transitionReservation(ctx, reservation.id, ["RESERVED"], "CONSUMED");
    if (consumed === null) {
      throw new Error("reservation changed concurrently during order settlement");
    }
    await appendCreditEntry(ctx, {
      partnerAccountId: account.id,
      entryType: "CONSUME",
      amountMinor: (-total).toString(),
      currency: book.currency,
      idempotencyKey: `consume:${order.id}`,
      referenceType: "order",
      referenceId: order.id,
    });
    await emitPartner(ctx, "partner.credit_consumed.v1", account.id, {
      reservation_id: reservation.id,
      order_id: order.id,
      amount_minor: total.toString(),
      currency: book.currency,
    });
    const settled = await settleOrder(ctx, order.id);
    if (settled === null) {
      throw new Error("order changed concurrently during settlement");
    }
    await emitPartner(ctx, "partner.order_settled.v1", account.id, {
      order_id: settled.id,
      price_book_id: book.id,
      price_book_version: book.versionNo,
      quantity: settled.quantity,
      total_minor: settled.totalMinor,
      currency: settled.currency,
    });
    return { ok: true, data: { ...toPublicOrder(settled), already: false } };
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      const raced = await findOrderByKey(ctx, account.id, key);
      if (raced !== null) {
        if (raced.idempotencyFingerprint !== null && raced.idempotencyFingerprint !== orderFingerprint) {
          return fingerprintMismatch();
        }
        return { ok: true, data: { ...toPublicOrder(raced), already: true } };
      }
      // Lost the reservation-key race to a concurrent order with a
      // different idempotency key: unwind is automatic (same trx rolls
      // back on throw) — report the conflict so the caller retries with
      // its own key instead of double-charging.
      return { ok: false, code: "precondition_failed", message: "concurrent order won the credit hold; retry with your idempotency key" };
    }
    throw err;
  }
}

async function handleCompleteTopic(
  ctx: CommandHandlerContext,
  input: CompleteTopicInput,
): Promise<CommandResult<Record<string, unknown>>> {
  const account = await getAccount(ctx, input.partnerAccountId);
  if (account === null) {
    return { ok: false, code: "not_found", message: "partner account not found in this tenant" };
  }
  const topicScopeDenial = await denyWithoutPartnerScope(ctx, account.id);
  if (topicScopeDenial !== null) {
    return topicScopeDenial;
  }
  const content = await getContentByTopicKey(ctx, input.topicKey.trim());
  if (content === null) {
    return { ok: false, code: "not_found", message: "academy topic not found" };
  }
  // Per-partner serialization: concurrent completions of the final topics
  // write, count and transition atomically — the last writer observes the
  // full count and moves the account to READY exactly once.
  const topicTrx = kyselyTrxOf(ctx);
  if (topicTrx === null) {
    throw new Error("partners commands require a database transaction");
  }
  await advisoryLockPartnerCredit(topicTrx, ctx.tenantId, account.id);
  const { already } = await completeTopicProgress(ctx, account.id, content.id);
  const total = (await listAcademyContent(ctx)).length;
  const completed = await countCompletedTopics(ctx, account.id);
  let status = account.status as PartnerStatus;
  const started = nextStatusOnTopicStart(status);
  if (started !== status) {
    const moved = await updateAccountStatus(ctx, account.id, [status], started);
    if (moved !== null) {
      status = moved.status as PartnerStatus;
    }
  }
  const ready = nextStatusOnTopicsComplete(status, completed, total);
  if (ready !== status) {
    const moved = await updateAccountStatus(ctx, account.id, [status], ready);
    if (moved !== null) {
      status = moved.status as PartnerStatus;
    }
  }
  return {
    ok: true,
    data: { partnerAccountId: account.id, topicKey: content.topicKey, completedCount: completed, totalTopics: total, status, already },
  };
}

async function handleActivate(
  ctx: CommandHandlerContext,
  input: ActivatePartnerInput,
): Promise<CommandResult<Record<string, unknown>>> {
  const account = await getAccount(ctx, input.partnerAccountId);
  if (account === null) {
    return { ok: false, code: "not_found", message: "partner account not found in this tenant" };
  }
  const activateScopeDenial = await denyWithoutPartnerScope(ctx, account.id);
  if (activateScopeDenial !== null) {
    return activateScopeDenial;
  }
  if (!canActivate(account.status as PartnerStatus)) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `partner account is ${account.status}; activation requires READY (explicit authorization after Academy)`,
    };
  }
  const moved = await updateAccountStatus(ctx, account.id, ["READY"], "ACTIVE");
  if (moved === null) {
    return { ok: false, code: "precondition_failed", message: "partner account changed concurrently" };
  }
  await emitPartner(ctx, "partner.activated.v1", moved.id, { status: moved.status });
  return { ok: true, data: { id: moved.id, status: moved.status, already: false } };
}

async function handleConvertToTenant(
  ctx: CommandHandlerContext,
  input: ConvertToTenantInput,
): Promise<CommandResult<Record<string, unknown>>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("partners commands require a database transaction");
  }
  const account = await getAccount(ctx, input.partnerAccountId);
  if (account === null) {
    return { ok: false, code: "not_found", message: "partner account not found in this tenant" };
  }
  const scopeDenial = await denyWithoutPartnerScope(ctx, account.id);
  if (scopeDenial !== null) {
    return scopeDenial;
  }
  if (account.linkedTenantId !== null) {
    const existing = await trx
      .selectFrom("control.tenants")
      .select(["id", "slug", "name"])
      .where("id", "=", account.linkedTenantId)
      .executeTakeFirst();
    return {
      ok: true,
      data: {
        id: account.id,
        status: account.status,
        linkedTenantId: account.linkedTenantId,
        tenant: existing === undefined ? null : { id: existing.id, slug: existing.slug, name: existing.name },
        already: true,
      },
    };
  }
  if (!canConvertToTenant(account.status as PartnerStatus, account.linkedTenantId)) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `partner account is ${account.status}; conversion to a SaaS tenant requires ACTIVE`,
    };
  }
  const tenantName = (input.tenantName ?? `${account.displayName} SaaS`).trim();
  if (tenantName.length === 0 || tenantName.length > 200) {
    return { ok: false, code: "validation_failed", message: "tenantName must be a non-empty name up to 200 chars" };
  }
  let slug: string;
  if (input.tenantSlug !== undefined) {
    if (!TENANT_SLUG_RE.test(input.tenantSlug)) {
      return { ok: false, code: "validation_failed", message: "tenantSlug is invalid" };
    }
    slug = input.tenantSlug;
  } else {
    slug = slugifyTenant(tenantName);
  }
  const tenantId = newId();
  const at = now();
  // Pre-check the slug on the GLOBAL tenants table (no RLS) BEFORE any
  // context change: a taken slug fails closed here with the business
  // SLUG_TAKEN shape instead of aborting the transaction below.
  const slugTaken = await trx
    .selectFrom("control.tenants")
    .select(["id"])
    .where("slug", "=", slug)
    .executeTakeFirst();
  if (slugTaken !== undefined) {
    return { ok: false, code: "precondition_failed", message: "tenant slug is taken (SLUG_TAKEN)" };
  }
  // The membership tables are RLS-enrolled (049): this transaction runs under
  // the SOURCE tenant context, so acquire context equal to the NEW tenant
  // before inserting its membership row, then restore the caller's context so
  // every later tenant-scoped write below keeps its original evaluation.
  await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
  try {
    await trx
      .insertInto("control.tenants")
      .values({
        id: tenantId,
        slug,
        name: tenantName,
        status: "ACTIVE",
        default_currency: "BRL",
        timezone: "America/Sao_Paulo",
        created_at: at,
        updated_at: at,
      })
      .execute();
    await trx
      .insertInto("control.tenant_memberships")
      .values({
        id: newId(),
        tenant_id: tenantId,
        user_id: ctx.actor.userId,
        role_key: "tenant_owner",
        status: "ACTIVE",
        created_at: at,
        updated_at: at,
      })
      .execute();
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      return { ok: false, code: "precondition_failed", message: "tenant slug is taken (SLUG_TAKEN)" };
    }
    throw err;
  } finally {
    // Always release the acquired context, even on the error paths above.
    // On an aborted transaction the restore itself fails, so secondary
    // errors are swallowed: the tx is rolling back anyway and must not mask
    // the original error.
    try {
      await sql`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`.execute(trx);
    } catch {
      // Swallowed by design (see above).
    }
  }
  const linked = await linkPartnerTenant(ctx, account.id, tenantId);
  if (linked === null) {
    const raced = await getAccount(ctx, account.id);
    const racedTenantId = raced?.linkedTenantId ?? tenantId;
    const racedTenant = await trx
      .selectFrom("control.tenants")
      .select(["id", "slug", "name"])
      .where("id", "=", racedTenantId)
      .executeTakeFirst();
    return {
      ok: true,
      data: {
        id: account.id,
        status: raced?.status ?? account.status,
        linkedTenantId: racedTenantId,
        tenant: racedTenant === undefined ? null : { id: racedTenant.id, slug: racedTenant.slug, name: racedTenant.name },
        already: true,
      },
    };
  }
  await emitPartner(ctx, "partner.converted_to_tenant.v1", linked.id, {
    linked_tenant_id: linked.linkedTenantId,
    tenant_id: tenantId,
    tenant_slug: slug,
  });
  return {
    ok: true,
    data: {
      id: linked.id,
      status: linked.status,
      linkedTenantId: linked.linkedTenantId,
      tenant: { id: tenantId, slug, name: tenantName },
      already: false,
    },
  };
}

export function registerPartnersCommands(bus: CommandBus): void {
  bus.register<CreateAccountInput, Record<string, unknown>>({
    name: "partners.create_account",
    permission: "crm.lead.write",
    auditAction: "partners.create_account",
    auditResource: "partner_account",
    input: createAccountInput,
    handler: handleCreateAccount,
  });
  bus.register<CreateDirectRelationshipInput, Record<string, unknown>>({
    name: "partners.create_direct_relationship",
    permission: "crm.lead.write",
    auditAction: "partners.create_direct_relationship",
    auditResource: "partner_relationship",
    input: createDirectRelationshipInput,
    handler: handleCreateDirectRelationship,
  });
  bus.register<SetCapabilityInput, Record<string, unknown>>({
    name: "partners.set_capability",
    permission: "crm.lead.write",
    auditAction: "partners.set_capability",
    auditResource: "partner_capability",
    input: setCapabilityInput,
    handler: handleSetCapability,
  });
  bus.register<TopupCreditInput, Record<string, unknown>>({
    name: "partners.topup_credit",
    permission: "commerce.order.write",
    auditAction: "partners.topup_credit",
    auditResource: "reseller_credit_entry",
    input: topupCreditInput,
    handler: handleTopup,
  });
  bus.register<ReleaseCreditInput, Record<string, unknown>>({
    name: "partners.release_credit",
    permission: "commerce.order.write",
    auditAction: "partners.release_credit",
    auditResource: "reseller_credit_reservation",
    input: releaseCreditInput,
    handler: handleRelease,
  });
  bus.register<PublishPriceBookInput, Record<string, unknown>>({
    name: "partners.publish_price_book",
    permission: "commerce.order.write",
    auditAction: "partners.publish_price_book",
    auditResource: "reseller_price_book",
    input: publishPriceBookInput,
    handler: handlePublishPriceBook,
  });
  bus.register<CreateResellerOrderInput, Record<string, unknown>>({
    name: "partners.create_reseller_order",
    permission: "commerce.order.write",
    auditAction: "partners.create_reseller_order",
    auditResource: "reseller_order",
    input: createResellerOrderInput,
    handler: handleCreateOrder,
  });
  bus.register<CompleteTopicInput, Record<string, unknown>>({
    name: "partners.complete_topic",
    permission: "crm.lead.write",
    auditAction: "partners.complete_topic",
    auditResource: "learning_progress",
    input: completeTopicInput,
    handler: handleCompleteTopic,
  });
  bus.register<ActivatePartnerInput, Record<string, unknown>>({
    name: "partners.activate",
    permission: "crm.lead.write",
    auditAction: "partners.activate",
    auditResource: "partner_account",
    input: activatePartnerInput,
    handler: handleActivate,
  });
  bus.register<ConvertToTenantInput, Record<string, unknown>>({
    name: "partners.convert_to_tenant",
    permission: "crm.lead.write",
    auditAction: "partners.convert_to_tenant",
    auditResource: "partner_account",
    input: convertToTenantInput,
    handler: handleConvertToTenant,
  });
}
