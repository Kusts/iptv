import { sql, type Transaction } from "kysely";
import { newId, now } from "@iptv/domain";
import type { Database } from "@iptv/database";
import type { CommandHandlerContext } from "../commands/command-bus.js";
import { UniqueViolationError } from "../trial/trial-store.js";
import { buildSucceededRefundsQuery } from "../billing/settlement.js";
import { isCoveringPaymentStatus, toMinor } from "../commerce/money-math.js";

/**
 * Wave 12 Referral + Rewards store accessors (Kysely only).
 *
 * Like the Renewal slice, these commands require a database transaction —
 * there is no in-memory path. Units run against the pure
 * `referral-policy.ts` helpers; the full flow is covered by the
 * `TEST_DATABASE_URL` integration suite.
 *
 * Storage rules (migration 011, no new migrations in this slice):
 * - First-touch is preserved by the `referrals_active_person_per_program`
 *   partial unique index: writers pre-check + take a per-(program, person)
 *   advisory lock instead of catching PG 23505 (a caught unique violation
 *   would abort the surrounding transaction).
 * - `reward_ledger_entries` is append-only (DB trigger rejects UPDATE/
 *   DELETE): reversals are compensating entries; every insert uses
 *   `ON CONFLICT (tenant_id, idempotency_key) DO NOTHING` so replays
 *   resolve to the existing row without aborting the transaction.
 * - Zero-value redemption orders reuse the Wave 5 `commerce.orders` shape
 *   (`reward_amount_minor = gross`, `net = 0`, `settled = 0`) and reach
 *   SETTLED with NO Payment row (SPEC §10).
 */

function requireTrx(ctx: CommandHandlerContext): Transaction<Database> {
  const trx = (() => {
    const inner = ctx.tx.innerDb() as Record<string, unknown> | null;
    if (
      inner !== null &&
      typeof inner === "object" &&
      typeof (inner as { selectFrom?: unknown }).selectFrom === "function"
    ) {
      return inner as unknown as Transaction<Database>;
    }
    return null;
  })();
  if (trx === null) {
    throw new Error("referral commands require a database transaction");
  }
  return trx;
}

export async function advisoryLockReferral(
  trx: Transaction<Database>,
  referralId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"referral:" + referralId}))`.execute(trx);
}

export async function advisoryLockReward(trx: Transaction<Database>, rewardId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"reward:" + rewardId}))`.execute(trx);
}

export async function advisoryLockProgramPerson(  trx: Transaction<Database>,
  tenantId: string,
  programId: string,
  personId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${"referral-attrib:" + tenantId + ":" + programId + ":" + personId}))`.execute(
    trx,
  );
}

/** CRM normalization mirror (`crm.commands`): trim; WHATSAPP keeps digits/+. */
export function normalizeIdentityValue(identityType: string, value: string): string {
  const trimmed = value.trim();
  return identityType === "WHATSAPP" ? trimmed.replace(/[^+\d]/g, "") || trimmed : trimmed;
}

export interface ProgramRow {
  id: string;
  name: string;
  status: string;
  rulesVersion: string;
  rules: Record<string, unknown>;
  startsAt: Date;
  endsAt: Date | null;
}

function toProgramRow(row: {
  id: string;
  name: string;
  status: string;
  rules_version: string;
  rules_json: unknown;
  starts_at: Date;
  ends_at: Date | null;
}): ProgramRow {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    rulesVersion: row.rules_version,
    rules: (row.rules_json ?? {}) as Record<string, unknown>,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

export async function getProgram(
  ctx: CommandHandlerContext,
  programId: string,
): Promise<ProgramRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("referral.referral_programs")
    .select(["id", "name", "status", "rules_version", "rules_json", "starts_at", "ends_at"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", programId)
    .executeTakeFirst();
  return row === undefined ? null : toProgramRow(row);
}

/** Latest ACTIVE program whose window covers `at` (the invite-time default). */
export async function getActiveProgram(
  ctx: CommandHandlerContext,
  at: Date,
): Promise<ProgramRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("referral.referral_programs")
    .select(["id", "name", "status", "rules_version", "rules_json", "starts_at", "ends_at"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("status", "=", "ACTIVE")
    .where("starts_at", "<=", at)
    .where((eb) => eb.or([eb("ends_at", "is", null), eb("ends_at", ">", at)]))
    .orderBy("starts_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? null : toProgramRow(row);
}

export interface CustomerRow {
  id: string;
  personId: string;
  status: string;
}

export async function getCustomer(
  ctx: CommandHandlerContext,
  customerId: string,
): Promise<CustomerRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("crm.customers")
    .select(["id", "person_id", "status"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", customerId)
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return { id: row.id, personId: row.person_id, status: row.status };
}

export async function getPersonIdForCustomer(
  ctx: CommandHandlerContext,
  customerId: string,
): Promise<string | null> {
  const customer = await getCustomer(ctx, customerId);
  return customer === null ? null : customer.personId;
}

export async function personExists(
  ctx: CommandHandlerContext,
  personId: string,
): Promise<boolean> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("identity.persons")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", personId)
    .executeTakeFirst();
  return row !== undefined;
}

export async function findPersonByIdentity(
  ctx: CommandHandlerContext,
  identityType: string,
  normalizedValue: string,
): Promise<string | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("identity.identities")
    .select(["person_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("identity_type", "=", identityType)
    .where("normalized_value", "=", normalizedValue)
    .where("detached_at", "is", null)
    .executeTakeFirst();
  return row === undefined ? null : row.person_id;
}

export interface ReferralRow {
  id: string;
  programId: string;
  advocateCustomerId: string;
  referredPersonId: string | null;
  code: string;
  status: string;
  sourceContext: string | null;
  createdAt: Date;
  attributedAt: Date | null;
  confirmedAt: Date | null;
  expiredAt: Date | null;
  reversedAt: Date | null;
}

function toReferralRow(row: {
  id: string;
  program_id: string;
  advocate_customer_id: string;
  referred_person_id: string | null;
  referral_code: string;
  status: string;
  source_context: string | null;
  created_at: Date;
  attributed_at: Date | null;
  confirmed_at: Date | null;
  expired_at: Date | null;
  reversed_at: Date | null;
}): ReferralRow {
  return {
    id: row.id,
    programId: row.program_id,
    advocateCustomerId: row.advocate_customer_id,
    referredPersonId: row.referred_person_id,
    code: row.referral_code,
    status: row.status,
    sourceContext: row.source_context,
    createdAt: row.created_at,
    attributedAt: row.attributed_at,
    confirmedAt: row.confirmed_at,
    expiredAt: row.expired_at,
    reversedAt: row.reversed_at,
  };
}

const REFERRAL_COLUMNS = [
  "id",
  "program_id",
  "advocate_customer_id",
  "referred_person_id",
  "referral_code",
  "status",
  "source_context",
  "created_at",
  "attributed_at",
  "confirmed_at",
  "expired_at",
  "reversed_at",
] as const;

export async function getReferral(
  ctx: CommandHandlerContext,
  referralId: string,
): Promise<ReferralRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("referral.referrals")
    .select(REFERRAL_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", referralId)
    .executeTakeFirst();
  return row === undefined ? null : toReferralRow(row);
}

export async function listReferralsByCustomer(
  ctx: CommandHandlerContext,
  customerId: string,
  limit: number,
): Promise<ReferralRow[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("referral.referrals")
    .select(REFERRAL_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("advocate_customer_id", "=", customerId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  return rows.map(toReferralRow);
}

const ACTIVE_REFERRAL_STATUSES = ["ATTRIBUTED", "ENGAGED", "QUALIFYING", "CONFIRMED"];

/** First-touch probe: the live referral already covering (program, person). */
export async function findActiveReferralForPerson(
  ctx: CommandHandlerContext,
  programId: string,
  personId: string,
): Promise<ReferralRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("referral.referrals")
    .select(REFERRAL_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("program_id", "=", programId)
    .where("referred_person_id", "=", personId)
    .where("status", "in", ACTIVE_REFERRAL_STATUSES)
    .orderBy("created_at", "asc")
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? null : toReferralRow(row);
}

/** Any OTHER live referral for (program, person) — the duplicate signal. */
export async function hasOtherActiveReferralForPerson(
  ctx: CommandHandlerContext,
  input: { programId: string; personId: string; excludeReferralId: string },
): Promise<boolean> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("referral.referrals")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("program_id", "=", input.programId)
    .where("referred_person_id", "=", input.personId)
    .where("id", "!=", input.excludeReferralId)
    .where("status", "in", ACTIVE_REFERRAL_STATUSES)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export async function insertReferral(
  ctx: CommandHandlerContext,
  input: {
    programId: string;
    advocateCustomerId: string;
    referredPersonId: string | null;
    code: string;
    status: "CREATED" | "ATTRIBUTED";
    sourceContext: string | null;
  },
): Promise<ReferralRow> {
  const trx = requireTrx(ctx);
  const at = now();
  try {
    const row = await trx
      .insertInto("referral.referrals")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        program_id: input.programId,
        advocate_customer_id: input.advocateCustomerId,
        referred_person_id: input.referredPersonId,
        referral_code: input.code,
        status: input.status,
        source_context: input.sourceContext,
        created_at: at,
        attributed_at: input.status === "ATTRIBUTED" ? at : null,
        confirmed_at: null,
        expired_at: null,
        reversed_at: null,
      })
      .returning(REFERRAL_COLUMNS)
      .executeTakeFirstOrThrow();
    return toReferralRow(row);
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      throw new UniqueViolationError("referral already covers this person in the program");
    }
    throw err;
  }
}

/**
 * Conditional lifecycle step with an expected-status guard (compare-and-set):
 * returns null when the row moved concurrently. Terminal timestamps are
 * stamped by the transition itself.
 */
export async function transitionReferral(
  ctx: CommandHandlerContext,
  input: {
    referralId: string;
    from: string[];
    to: string;
    setReferredPersonId?: string;
  },
): Promise<ReferralRow | null> {
  const trx = requireTrx(ctx);
  const at = now();
  const patch: Record<string, Date | string | null> = {};
  if (input.to === "ATTRIBUTED") {
    patch["attributed_at"] = at;
  } else if (input.to === "CONFIRMED") {
    patch["confirmed_at"] = at;
  } else if (input.to === "EXPIRED") {
    patch["expired_at"] = at;
  } else if (input.to === "REVERSED") {
    patch["reversed_at"] = at;
  }
  if (input.setReferredPersonId !== undefined) {
    patch["referred_person_id"] = input.setReferredPersonId;
    if (input.to === "ATTRIBUTED" || input.to === "ENGAGED") {
      patch["attributed_at"] = at;
    }
  }
  try {
    const row = await trx
      .updateTable("referral.referrals")
      .set({ status: input.to, ...patch })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.referralId)
      .where("status", "in", input.from)
      .returning(REFERRAL_COLUMNS)
      .executeTakeFirst();
    return row === undefined ? null : toReferralRow(row);
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      throw new UniqueViolationError("referral already covers this person in the program");
    }
    throw err;
  }
}

export interface QualificationRow {
  id: string;
  referralId: string;
  status: string;
  reasonCodes: string[];
  qualifiedOrderId: string | null;
  policyVersion: string;
  createdAt: Date;
  resolvedAt: Date | null;
}

function toQualificationRow(row: {
  id: string;
  referral_id: string;
  status: string;
  reason_codes: string[];
  qualified_order_id: string | null;
  policy_version: string;
  created_at: Date;
  resolved_at: Date | null;
}): QualificationRow {
  return {
    id: row.id,
    referralId: row.referral_id,
    status: row.status,
    reasonCodes: row.reason_codes,
    qualifiedOrderId: row.qualified_order_id,
    policyVersion: row.policy_version,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

const QUALIFICATION_COLUMNS = [
  "id",
  "referral_id",
  "status",
  "reason_codes",
  "qualified_order_id",
  "policy_version",
  "created_at",
  "resolved_at",
] as const;

export async function getOpenQualification(
  ctx: CommandHandlerContext,
  referralId: string,
): Promise<QualificationRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("referral.referral_qualifications")
    .select(QUALIFICATION_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("referral_id", "=", referralId)
    .where("resolved_at", "is", null)
    .executeTakeFirst();
  return row === undefined ? null : toQualificationRow(row);
}

export async function getLatestQualification(
  ctx: CommandHandlerContext,
  referralId: string,
): Promise<QualificationRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("referral.referral_qualifications")
    .select(QUALIFICATION_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("referral_id", "=", referralId)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? null : toQualificationRow(row);
}

export async function insertQualification(
  ctx: CommandHandlerContext,
  input: { referralId: string; policyVersion: string; qualifiedOrderId?: string | null },
): Promise<QualificationRow> {
  const trx = requireTrx(ctx);
  try {
    const row = await trx
      .insertInto("referral.referral_qualifications")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        referral_id: input.referralId,
        status: "PENDING",
        risk_assessment_id: null,
        reason_codes: [],
        qualified_order_id: input.qualifiedOrderId ?? null,
        policy_version: input.policyVersion,
        created_at: now(),
        resolved_at: null,
      })
      .returning(QUALIFICATION_COLUMNS)
      .executeTakeFirstOrThrow();
    return toQualificationRow(row);
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      throw new UniqueViolationError("an open qualification already exists for this referral");
    }
    throw err;
  }
}

export async function resolveQualification(
  ctx: CommandHandlerContext,
  input: {
    qualificationId: string;
    status: "ALLOW" | "REVIEW" | "DENY" | "EXPIRED";
    reasonCodes: string[];
    qualifiedOrderId?: string | null;
  },
): Promise<QualificationRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .updateTable("referral.referral_qualifications")
    .set({
      status: input.status,
      reason_codes: input.reasonCodes,
      ...(input.qualifiedOrderId !== undefined ? { qualified_order_id: input.qualifiedOrderId } : {}),
      resolved_at: now(),
    })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.qualificationId)
    .where("resolved_at", "is", null)
    .returning(QUALIFICATION_COLUMNS)
    .executeTakeFirst();
  return row === undefined ? null : toQualificationRow(row);
}

export interface RewardDefinitionRow {
  id: string;
  rewardKey: string;
  rewardType: string;
  status: string;
  perceivedValueMinor: string | null;
  estimatedCostMinor: string | null;
  currency: string | null;
  recurringCostPolicy: string | null;
  rules: Record<string, unknown>;
}

function toDefinitionRow(row: {
  id: string;
  reward_key: string;
  reward_type: string;
  status: string;
  perceived_value_minor: string | bigint | number | null;
  estimated_cost_minor: string | bigint | number | null;
  currency: string | null;
  recurring_cost_policy: string | null;
  rules_json: unknown;
}): RewardDefinitionRow {
  return {
    id: row.id,
    rewardKey: row.reward_key,
    rewardType: row.reward_type,
    status: row.status,
    perceivedValueMinor: row.perceived_value_minor === null ? null : String(row.perceived_value_minor),
    estimatedCostMinor: row.estimated_cost_minor === null ? null : String(row.estimated_cost_minor),
    currency: row.currency,
    recurringCostPolicy: row.recurring_cost_policy,
    rules: (row.rules_json ?? {}) as Record<string, unknown>,
  };
}

const DEFINITION_COLUMNS = [
  "id",
  "reward_key",
  "reward_type",
  "status",
  "perceived_value_minor",
  "estimated_cost_minor",
  "currency",
  "recurring_cost_policy",
  "rules_json",
] as const;

export async function getDefinitionByKey(
  ctx: CommandHandlerContext,
  rewardKey: string,
): Promise<RewardDefinitionRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("loyalty.reward_definitions")
    .select(DEFINITION_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("reward_key", "=", rewardKey)
    .executeTakeFirst();
  return row === undefined ? null : toDefinitionRow(row);
}

/**
 * Idempotent definition provisioning: the canonical advocate credit
 * (`referral-advocate-credit`, ORDER_CREDIT) is created on first use via
 * `ON CONFLICT (tenant_id, reward_key) DO NOTHING` + re-read — never a
 * caught 23505, never a duplicate.
 */
export async function ensureAdvocateCreditDefinition(
  ctx: CommandHandlerContext,
): Promise<RewardDefinitionRow> {
  const trx = requireTrx(ctx);
  const at = now();
  await trx
    .insertInto("loyalty.reward_definitions")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      reward_key: "referral-advocate-credit",
      reward_type: "ORDER_CREDIT",
      status: "ACTIVE",
      perceived_value_minor: null,
      estimated_cost_minor: null,
      currency: "BRL",
      recurring_cost_policy: null,
      rules_json: { issued_by: "referral.qualify", value: "order-net-capped" },
      created_at: at,
      updated_at: at,
    })
    .onConflict((oc) => oc.columns(["tenant_id", "reward_key"]).doNothing())
    .execute();
  const row = await trx
    .selectFrom("loyalty.reward_definitions")
    .select(DEFINITION_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("reward_key", "=", "referral-advocate-credit")
    .executeTakeFirstOrThrow();
  return toDefinitionRow(row);
}

export interface RewardRow {
  id: string;
  customerId: string;
  rewardDefinitionId: string;
  sourceType: string;
  sourceId: string | null;
  status: string;
  economicValueMinor: string | null;
  estimatedCostMinor: string | null;
  currency: string | null;
  issuedAt: Date | null;
  availableAt: Date | null;
  redeemedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

function toRewardRow(row: {
  id: string;
  customer_id: string;
  reward_definition_id: string;
  source_type: string;
  source_id: string | null;
  status: string;
  economic_value_minor: string | bigint | number | null;
  estimated_cost_minor: string | bigint | number | null;
  currency: string | null;
  issued_at: Date | null;
  available_at: Date | null;
  redeemed_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}): RewardRow {
  return {
    id: row.id,
    customerId: row.customer_id,
    rewardDefinitionId: row.reward_definition_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    status: row.status,
    economicValueMinor:
      row.economic_value_minor === null ? null : String(row.economic_value_minor),
    estimatedCostMinor:
      row.estimated_cost_minor === null ? null : String(row.estimated_cost_minor),
    currency: row.currency,
    issuedAt: row.issued_at,
    availableAt: row.available_at,
    redeemedAt: row.redeemed_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

const REWARD_COLUMNS = [
  "id",
  "customer_id",
  "reward_definition_id",
  "source_type",
  "source_id",
  "status",
  "economic_value_minor",
  "estimated_cost_minor",
  "currency",
  "issued_at",
  "available_at",
  "redeemed_at",
  "expires_at",
  "revoked_at",
  "created_at",
] as const;

export async function insertReward(
  ctx: CommandHandlerContext,
  input: {
    customerId: string;
    rewardDefinitionId: string;
    sourceType: string;
    sourceId: string | null;
    economicValueMinor: string | null;
    currency: string | null;
    expiresAt: Date | null;
  },
): Promise<RewardRow> {
  const trx = requireTrx(ctx);
  const at = now();
  const row = await trx
    .insertInto("loyalty.rewards")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      customer_id: input.customerId,
      reward_definition_id: input.rewardDefinitionId,
      source_type: input.sourceType,
      source_id: input.sourceId,
      status: "PENDING",
      economic_value_minor: input.economicValueMinor,
      estimated_cost_minor: input.economicValueMinor,
      currency: input.currency,
      issued_at: null,
      available_at: null,
      redeemed_at: null,
      expires_at: input.expiresAt,
      revoked_at: null,
      created_at: at,
      updated_at: at,
    })
    .returning(REWARD_COLUMNS)
    .executeTakeFirstOrThrow();
  return toRewardRow(row);
}

export async function getReward(
  ctx: CommandHandlerContext,
  rewardId: string,
): Promise<RewardRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("loyalty.rewards")
    .select(REWARD_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", rewardId)
    .executeTakeFirst();
  return row === undefined ? null : toRewardRow(row);
}

export async function listRewardsByCustomer(
  ctx: CommandHandlerContext,
  customerId: string,
  limit: number,
): Promise<RewardRow[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("loyalty.rewards")
    .select(REWARD_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("customer_id", "=", customerId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  return rows.map(toRewardRow);
}

/** Conditional reward step with an expected-status guard; null on concurrent move. */
export async function transitionReward(
  ctx: CommandHandlerContext,
  input: { rewardId: string; from: string[]; to: string },
): Promise<RewardRow | null> {
  const trx = requireTrx(ctx);
  const at = now();
  const patch: Record<string, Date | null> = { updated_at: at };
  if (input.to === "ISSUED") {
    patch["issued_at"] = at;
  } else if (input.to === "AVAILABLE") {
    patch["available_at"] = at;
  } else if (input.to === "REDEEMED") {
    patch["redeemed_at"] = at;
  } else if (input.to === "REVOKED") {
    patch["revoked_at"] = at;
  }
  const row = await trx
    .updateTable("loyalty.rewards")
    .set({ status: input.to, ...patch })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.rewardId)
    .where("status", "in", input.from)
    .returning(REWARD_COLUMNS)
    .executeTakeFirst();
  return row === undefined ? null : toRewardRow(row);
}

/** Rewards linked to one referral (normally zero or one). */
export async function listRewardsForReferral(
  ctx: CommandHandlerContext,
  referralId: string,
): Promise<RewardRow[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("referral.referral_reward_links")
    .innerJoin("loyalty.rewards", (join) =>
      join
        .onRef("loyalty.rewards.tenant_id", "=", "referral.referral_reward_links.tenant_id")
        .onRef("loyalty.rewards.id", "=", "referral.referral_reward_links.reward_id"),
    )
    .select([
      "loyalty.rewards.id as id",
      "loyalty.rewards.customer_id as customer_id",
      "loyalty.rewards.reward_definition_id as reward_definition_id",
      "loyalty.rewards.source_type as source_type",
      "loyalty.rewards.source_id as source_id",
      "loyalty.rewards.status as status",
      "loyalty.rewards.economic_value_minor as economic_value_minor",
      "loyalty.rewards.estimated_cost_minor as estimated_cost_minor",
      "loyalty.rewards.currency as currency",
      "loyalty.rewards.issued_at as issued_at",
      "loyalty.rewards.available_at as available_at",
      "loyalty.rewards.redeemed_at as redeemed_at",
      "loyalty.rewards.expires_at as expires_at",
      "loyalty.rewards.revoked_at as revoked_at",
      "loyalty.rewards.created_at as created_at",
    ])
    .where("referral.referral_reward_links.tenant_id", "=", ctx.tenantId)
    .where("referral.referral_reward_links.referral_id", "=", referralId)
    .execute();
  return rows.map((row) =>
    toRewardRow({
      id: row["id"] as string,
      customer_id: row["customer_id"] as string,
      reward_definition_id: row["reward_definition_id"] as string,
      source_type: row["source_type"] as string,
      source_id: (row["source_id"] as string | null) ?? null,
      status: row["status"] as string,
      economic_value_minor: (row["economic_value_minor"] as string | null) ?? null,
      estimated_cost_minor: (row["estimated_cost_minor"] as string | null) ?? null,
      currency: (row["currency"] as string | null) ?? null,
      issued_at: (row["issued_at"] as Date | null) ?? null,
      available_at: (row["available_at"] as Date | null) ?? null,
      redeemed_at: (row["redeemed_at"] as Date | null) ?? null,
      expires_at: (row["expires_at"] as Date | null) ?? null,
      revoked_at: (row["revoked_at"] as Date | null) ?? null,
      created_at: row["created_at"] as Date,
    }),
  );
}

export async function insertRewardLink(
  ctx: CommandHandlerContext,
  input: { referralId: string; rewardId: string },
): Promise<void> {
  const trx = requireTrx(ctx);
  try {
    await trx
      .insertInto("referral.referral_reward_links")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        referral_id: input.referralId,
        reward_id: input.rewardId,
        created_at: now(),
      })
      .execute();
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      throw new UniqueViolationError("this referral already links this reward");
    }
    throw err;
  }
}

export interface LedgerEntryInput {
  customerId: string;
  rewardId: string | null;
  entryType: "EARNED" | "REDEEMED" | "EXPIRED" | "REVOKED" | "ADJUSTMENT" | "REVERSAL";
  amountMinor: string | null;
  pointsDelta: number | null;
  currency: string | null;
  idempotencyKey: string;
  referenceType: string | null;
  referenceId: string | null;
}

/**
 * Append-only ledger insert. `ON CONFLICT (tenant_id, idempotency_key)
 * DO NOTHING` makes every replay resolve to the existing row — a caught
 * 23505 would abort the command transaction, so it is never caught.
 */
export async function appendLedgerEntry(
  ctx: CommandHandlerContext,
  input: LedgerEntryInput,
): Promise<{ id: string; duplicate: boolean }> {
  const trx = requireTrx(ctx);
  const inserted = await trx
    .insertInto("loyalty.reward_ledger_entries")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      customer_id: input.customerId,
      reward_id: input.rewardId,
      entry_type: input.entryType,
      amount_minor: input.amountMinor,
      points_delta: input.pointsDelta,
      currency: input.currency,
      idempotency_key: input.idempotencyKey,
      reference_type: input.referenceType,
      reference_id: input.referenceId,
      created_at: now(),
    })
    .onConflict((oc) => oc.columns(["tenant_id", "idempotency_key"]).doNothing())
    .returning(["id"])
    .executeTakeFirst();
  if (inserted !== undefined) {
    return { id: inserted.id, duplicate: false };
  }
  const raced = await trx
    .selectFrom("loyalty.reward_ledger_entries")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("idempotency_key", "=", input.idempotencyKey)
    .executeTakeFirstOrThrow();
  return { id: raced.id, duplicate: true };
}

export interface LedgerEntryRow {
  id: string;
  rewardId: string | null;
  entryType: string;
  amountMinor: string | null;
  pointsDelta: number | null;
  currency: string | null;
  idempotencyKey: string;
  referenceType: string | null;
  referenceId: string | null;
}

export async function listLedgerByReward(
  ctx: CommandHandlerContext,
  rewardId: string,
): Promise<LedgerEntryRow[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("loyalty.reward_ledger_entries")
    .select([
      "id",
      "reward_id",
      "entry_type",
      "amount_minor",
      "points_delta",
      "currency",
      "idempotency_key",
      "reference_type",
      "reference_id",
    ])
    .where("tenant_id", "=", ctx.tenantId)
    .where("reward_id", "=", rewardId)
    .orderBy("created_at", "asc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    rewardId: row.reward_id,
    entryType: row.entry_type,
    amountMinor: row.amount_minor === null ? null : String(row.amount_minor),
    pointsDelta: row.points_delta === null ? null : Number(row.points_delta),
    currency: row.currency,
    idempotencyKey: row.idempotency_key,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
  }));
}

export interface GiftPassRow {
  id: string;
  issuedToCustomerId: string;
  sourceRewardId: string | null;
  code: string;
  status: string;
  benefit: Record<string, unknown>;
  expiresAt: Date;
  redeemedByPersonId: string | null;
  redeemedAt: Date | null;
  createdAt: Date;
}

function toGiftPassRow(row: {
  id: string;
  issued_to_customer_id: string;
  source_reward_id: string | null;
  code: string;
  status: string;
  benefit_json: unknown;
  expires_at: Date;
  redeemed_by_person_id: string | null;
  redeemed_at: Date | null;
  created_at: Date;
}): GiftPassRow {
  return {
    id: row.id,
    issuedToCustomerId: row.issued_to_customer_id,
    sourceRewardId: row.source_reward_id,
    code: row.code,
    status: row.status,
    benefit: (row.benefit_json ?? {}) as Record<string, unknown>,
    expiresAt: row.expires_at,
    redeemedByPersonId: row.redeemed_by_person_id,
    redeemedAt: row.redeemed_at,
    createdAt: row.created_at,
  };
}

const GIFT_PASS_COLUMNS = [
  "id",
  "issued_to_customer_id",
  "source_reward_id",
  "code",
  "status",
  "benefit_json",
  "expires_at",
  "redeemed_by_person_id",
  "redeemed_at",
  "created_at",
] as const;

export async function getGiftPassByCode(
  ctx: CommandHandlerContext,
  code: string,
): Promise<GiftPassRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("loyalty.gift_passes")
    .select(GIFT_PASS_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("code", "=", code)
    .executeTakeFirst();
  return row === undefined ? null : toGiftPassRow(row);
}

export async function insertGiftPass(
  ctx: CommandHandlerContext,
  input: {
    issuedToCustomerId: string;
    sourceRewardId: string | null;
    code: string;
    benefit: Record<string, unknown>;
    expiresAt: Date;
  },
): Promise<GiftPassRow> {
  const trx = requireTrx(ctx);
  try {
    const row = await trx
      .insertInto("loyalty.gift_passes")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        issued_to_customer_id: input.issuedToCustomerId,
        source_reward_id: input.sourceRewardId,
        code: input.code,
        status: "AVAILABLE",
        benefit_json: input.benefit,
        expires_at: input.expiresAt,
        redeemed_by_person_id: null,
        redeemed_at: null,
        created_at: now(),
      })
      .returning(GIFT_PASS_COLUMNS)
      .executeTakeFirstOrThrow();
    return toGiftPassRow(row);
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      throw new UniqueViolationError("gift pass code already exists in this tenant");
    }
    throw err;
  }
}

/** Conditional gift-pass step; null when the row moved concurrently. */
export async function transitionGiftPass(
  ctx: CommandHandlerContext,
  input: { giftPassId: string; from: string[]; to: string; redeemedByPersonId?: string },
): Promise<GiftPassRow | null> {
  const trx = requireTrx(ctx);
  const at = now();
  const patch: Record<string, Date | string | null> =
    input.to === "REDEEMED"
      ? { redeemed_by_person_id: input.redeemedByPersonId ?? null, redeemed_at: at }
      : {};
  const row = await trx
    .updateTable("loyalty.gift_passes")
    .set({ status: input.to, ...patch })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.giftPassId)
    .where("status", "in", input.from)
    .returning(GIFT_PASS_COLUMNS)
    .executeTakeFirst();
  return row === undefined ? null : toGiftPassRow(row);
}

/** AVAILABLE gift passes past expiry (bounded worker scan). */
export async function listExpiredGiftPasses(
  ctx: CommandHandlerContext,
  input: { at: Date; limit: number },
): Promise<GiftPassRow[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("loyalty.gift_passes")
    .select(GIFT_PASS_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("status", "=", "AVAILABLE")
    .where("expires_at", "<=", input.at)
    .orderBy("expires_at", "asc")
    .limit(input.limit)
    .execute();
  return rows.map(toGiftPassRow);
}

/** AVAILABLE rewards past expiry (bounded worker scan). */
export async function listExpiredRewards(
  ctx: CommandHandlerContext,
  input: { at: Date; limit: number },
): Promise<RewardRow[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("loyalty.rewards")
    .select(REWARD_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("status", "=", "AVAILABLE")
    .where("expires_at", "is not", null)
    .where("expires_at", "<=", input.at)
    .orderBy("expires_at", "asc")
    .limit(input.limit)
    .execute();
  return rows.map(toRewardRow);
}

export interface ConversionOrderRow {
  id: string;
  personId: string;
  customerId: string | null;
  orderType: string;
  status: string;
  currency: string;
  grossMinor: string;
  rewardMinor: string;
  netMinor: string;
  settledAt: Date | null;
}

function toConversionOrderRow(row: {
  id: string;
  person_id: string;
  customer_id: string | null;
  order_type: string;
  status: string;
  currency: string;
  gross_amount_minor: string | bigint | number;
  reward_amount_minor: string | bigint | number;
  net_amount_minor: string | bigint | number;
  settled_at: Date | null;
}): ConversionOrderRow {
  return {
    id: row.id,
    personId: row.person_id,
    customerId: row.customer_id,
    orderType: row.order_type,
    status: row.status,
    currency: row.currency,
    grossMinor: String(row.gross_amount_minor),
    rewardMinor: String(row.reward_amount_minor),
    netMinor: String(row.net_amount_minor),
    settledAt: row.settled_at,
  };
}

const CONVERSION_ORDER_COLUMNS = [
  "id",
  "person_id",
  "customer_id",
  "order_type",
  "status",
  "currency",
  "gross_amount_minor",
  "reward_amount_minor",
  "net_amount_minor",
  "settled_at",
] as const;

export async function getConversionOrder(
  ctx: CommandHandlerContext,
  orderId: string,
): Promise<ConversionOrderRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("commerce.orders")
    .select(CONVERSION_ORDER_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", orderId)
    .executeTakeFirst();
  return row === undefined ? null : toConversionOrderRow(row);
}

/** Latest same-tenant SETTLED order for a person (auto-discovery fallback). */
export async function findLatestSettledOrderForPerson(
  ctx: CommandHandlerContext,
  personId: string,
): Promise<ConversionOrderRow | null> {
  const trx = requireTrx(ctx);
  const row = await trx
    .selectFrom("commerce.orders")
    .select(CONVERSION_ORDER_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("person_id", "=", personId)
    .where("status", "=", "SETTLED")
    .orderBy("settled_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? null : toConversionOrderRow(row);
}

/**
 * Latest same-tenant economic SETTLED order for a person: skips the
 * zero-value ADJUSTMENT orders minted by reward redemption (SPEC §10) and
 * any other non-positive-net settlement, so a redemption can never
 * auto-qualify a referral. Exact minor-unit comparison in code (no float).
 */
export async function findLatestEconomicSettledOrderForPerson(
  ctx: CommandHandlerContext,
  personId: string,
): Promise<ConversionOrderRow | null> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("commerce.orders")
    .select(CONVERSION_ORDER_COLUMNS)
    .where("tenant_id", "=", ctx.tenantId)
    .where("person_id", "=", personId)
    .where("status", "=", "SETTLED")
    .where("order_type", "!=", "ADJUSTMENT")
    .orderBy("settled_at", "desc")
    .limit(25)
    .execute();
  for (const row of rows) {
    const candidate = toConversionOrderRow(row);
    if (toMinor(candidate.netMinor) > 0n) {
      return candidate;
    }
  }
  return null;
}

export interface OrderPaymentRow {
  status: string;
  amountMinor: string;
}

export async function listPaymentsForOrder(
  ctx: CommandHandlerContext,
  orderId: string,
): Promise<OrderPaymentRow[]> {
  const trx = requireTrx(ctx);
  const rows = await trx
    .selectFrom("billing.payments")
    .select(["status", "amount_minor"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("order_id", "=", orderId)
    .execute();
  return rows.map((row) => ({ status: row.status, amountMinor: String(row.amount_minor) }));
}

export async function sumSucceededRefundsForOrder(
  ctx: CommandHandlerContext,
  orderId: string,
): Promise<bigint> {
  const trx = requireTrx(ctx);
  const rows = await buildSucceededRefundsQuery(trx, ctx.tenantId, orderId).execute();
  return rows.reduce((acc, row) => acc + toMinor(row.amount_minor), 0n);
}

/** Covering CONFIRMED payments (minus succeeded refunds) cover the net. */
export async function isOrderPaymentCovered(
  ctx: CommandHandlerContext,
  order: ConversionOrderRow,
): Promise<boolean> {
  const net = toMinor(order.netMinor);
  if (net <= 0n) {
    return true;
  }
  const payments = await listPaymentsForOrder(ctx, order.id);
  const covered = payments
    .filter((p) => isCoveringPaymentStatus(p.status))
    .reduce((acc, p) => acc + toMinor(p.amountMinor), 0n);
  const refunded = await sumSucceededRefundsForOrder(ctx, order.id);
  return covered - refunded >= net;
}

/** Fully refunded/chargeback-consumed conversion (reversal signal). */
export async function isOrderFullyReversed(
  ctx: CommandHandlerContext,
  order: ConversionOrderRow,
): Promise<boolean> {
  const net = toMinor(order.netMinor);
  if (net <= 0n) {
    return false;
  }
  const refunded = await sumSucceededRefundsForOrder(ctx, order.id);
  return refunded >= net;
}

export interface ZeroValueOrderResult {
  orderId: string;
  grossMinor: string;
  currency: string;
}

/**
 * Zero-value redemption order (SPEC §10): gross X, reward credit X,
 * net 0 → AWAITING_PAYMENT → SETTLED in one transaction with NO Payment
 * row. The reward ledger (not the finance ledger — no economic movement
 * beyond the credit) records the redemption.
 */
export async function insertZeroValueRedemptionOrder(
  ctx: CommandHandlerContext,
  input: {
    personId: string;
    customerId: string;
    rewardDefinitionId: string;
    valueMinor: string;
    currency: string;
    rewardId: string;
  },
): Promise<ZeroValueOrderResult> {
  const trx = requireTrx(ctx);
  const at = now();
  const orderId = newId();
  await trx
    .insertInto("commerce.orders")
    .values({
      id: orderId,
      tenant_id: ctx.tenantId,
      person_id: input.personId,
      customer_id: input.customerId,
      source_offer_id: null,
      order_type: "ADJUSTMENT",
      status: "DRAFT",
      currency: input.currency,
      gross_amount_minor: input.valueMinor,
      discount_amount_minor: "0",
      reward_amount_minor: input.valueMinor,
      net_amount_minor: "0",
      settled_amount_minor: "0",
      created_at: at,
      awaiting_payment_at: null,
      settled_at: null,
      cancelled_at: null,
      expires_at: null,
    })
    .execute();
  const itemId = newId();
  await trx
    .insertInto("commerce.order_items")
    .values({
      id: itemId,
      tenant_id: ctx.tenantId,
      order_id: orderId,
      item_type: "OTHER",
      sellable_type: "PRODUCT",
      sellable_id: input.rewardDefinitionId,
      quantity: "1",
      unit_price_minor: input.valueMinor,
      gross_minor: input.valueMinor,
      discount_minor: "0",
      reward_minor: input.valueMinor,
      net_minor: "0",
      metadata_json: { reward_redemption: true, reward_id: input.rewardId },
      created_at: at,
    })
    .execute();
  await trx
    .insertInto("commerce.price_snapshots")
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      order_item_id: itemId,
      sale_price_minor: input.valueMinor,
      supplier_cost_minor: null,
      currency: input.currency,
      price_source_ref: `loyalty.reward_definitions:${input.rewardDefinitionId}`,
      captured_at: at,
      context_json: { quantity: 1, reward_redemption: true, reward_id: input.rewardId },
    })
    .execute();
  await trx
    .updateTable("commerce.orders")
    .set({ status: "AWAITING_PAYMENT", awaiting_payment_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", orderId)
    .where("status", "=", "DRAFT")
    .execute();
  await trx
    .updateTable("commerce.orders")
    .set({ status: "SETTLED", settled_amount_minor: "0", settled_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", orderId)
    .where("status", "=", "AWAITING_PAYMENT")
    .execute();
  return { orderId, grossMinor: input.valueMinor, currency: input.currency };
}
