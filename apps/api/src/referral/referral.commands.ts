import { z } from "zod";
import { newId, now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf } from "../crm/wave2-store.js";
import { mergePolicyRows } from "../trial/trial-policy.js";
import { UniqueViolationError } from "../trial/trial-store.js";
import { toMinor } from "../commerce/money-math.js";
import {
  REWARD_POLICY_FAMILY,
  REFERRAL_POLICY_FAMILY,
  decideQualification,
  isWithinQualificationWindow,
  parseQualificationPolicy,
  shouldReverseReferral,
  sizeAdvocateCredit,
} from "./referral-policy.js";
import {
  advisoryLockProgramPerson,
  advisoryLockReferral,
  advisoryLockReward,
  appendLedgerEntry,
  ensureAdvocateCreditDefinition,
  findActiveReferralForPerson,
  findLatestEconomicSettledOrderForPerson,
  findPersonByIdentity,
  getActiveProgram,
  getConversionOrder,
  getCustomer,
  getGiftPassByCode,
  getLatestQualification,
  getOpenQualification,
  getPersonIdForCustomer,
  getProgram,
  getReferral,
  getReward,
  hasOtherActiveReferralForPerson,
  insertGiftPass,
  insertQualification,
  insertReferral,
  insertReward,
  insertRewardLink,
  insertZeroValueRedemptionOrder,
  isOrderFullyReversed,
  isOrderPaymentCovered,
  listExpiredGiftPasses,
  listExpiredRewards,
  listLedgerByReward,
  listRewardsForReferral,
  normalizeIdentityValue,
  personExists,
  resolveQualification,
  transitionGiftPass,
  transitionReferral,
  transitionReward,
  type ConversionOrderRow,
  type ReferralRow,
} from "./referral-store.js";

/**
 * Wave 12 Referral + Rewards commands (owning context for referral
 * attribution, qualification, reward issue/redeem and gift passes).
 *
 * Canonical rules enforced here:
 * - Referral confirms ONLY on a settled economic conversion for the
 *   referred person + policy (never invite/click/Trial alone). First-touch
 *   wins: one active referral per (program, person); late referrals return
 *   the existing row (`already: true`) instead of overwriting.
 * - Self-referral is rejected up front (the migration-011 trigger is the
 *   backstop, never the primary check).
 * - Rewards move PENDING → APPROVED → ISSUED → AVAILABLE atomically on
 *   ALLOW; every economic effect is an append-only ledger row. Replays
 *   (qualification x10, redeem retry) resolve to existing rows via the
 *   link unique + ledger idempotency keys — never a double reward.
 * - Redemption settles a zero-value ADJUSTMENT order
 *   (reward_amount = gross, net = 0) with NO Payment row (SPEC §10).
 * - Reversal (refund/chargeback inside the window, manual reverse) is a
 *   compensating REVERSAL entry; history is never mutated.
 * - Events are registry-listed ONLY (referral.*, reward.*, gift_pass.*,
 *   order.created/settled). No invented ids.
 */

export const createReferralInput = z.object({
  customerId: z.string().uuid(),
  programId: z.string().uuid().optional(),
  referralCode: z.string().trim().min(1).max(64).optional(),
  referredPersonId: z.string().uuid().optional(),
  referredIdentity: z
    .object({
      type: z.string().trim().min(1).max(64),
      value: z.string().trim().min(1).max(320),
    })
    .optional(),
  sourceContext: z.string().trim().min(1).max(500).optional(),
});
export type CreateReferralInput = z.infer<typeof createReferralInput>;

export const qualifyReferralInput = z.object({
  referralId: z.string().uuid(),
  qualifiedOrderId: z.string().uuid().optional(),
  policyVersion: z.string().trim().min(1).max(64).default("v1"),
});
export type QualifyReferralInput = z.infer<typeof qualifyReferralInput>;

export const reverseReferralInput = z.object({
  referralId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type ReverseReferralInput = z.infer<typeof reverseReferralInput>;

export const redeemRewardInput = z.object({ rewardId: z.string().uuid() });
export type RedeemRewardInput = z.infer<typeof redeemRewardInput>;

export const redeemGiftPassInput = z.object({
  code: z.string().trim().min(6).max(100),
  personId: z.string().uuid(),
});
export type RedeemGiftPassInput = z.infer<typeof redeemGiftPassInput>;

export const referralExpireDueInput = z.object({
  limit: z.number().int().min(1).max(1000).default(100),
});
export type ReferralExpireDueInput = z.infer<typeof referralExpireDueInput>;

export interface ReferralView {
  id: string;
  advocateCustomerId: string;
  code: string;
  status: string;
  createdAt: string;
  referredPersonId: string | null;
  programId: string | null;
  confirmedAt: string | null;
  already: boolean;
}

function toReferralView(row: ReferralRow, already: boolean): ReferralView {
  return {
    id: row.id,
    advocateCustomerId: row.advocateCustomerId,
    code: row.code,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    referredPersonId: row.referredPersonId,
    programId: row.programId,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    already,
  };
}

function referralCode(): string {
  return `REF-${newId().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

function giftPassCode(): string {
  return `GP-${newId().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

async function emitReferral(
  ctx: CommandHandlerContext,
  eventType: string,
  referral: ReferralRow,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await emitAndEnqueue(ctx, {
    eventType,
    aggregateType: "referral",
    aggregateId: referral.id,
    data: {
      referral_id: referral.id,
      program_id: referral.programId,
      advocate_customer_id: referral.advocateCustomerId,
      referred_person_id: referral.referredPersonId,
      ...extra,
    },
  });
}

async function handleCreate(
  ctx: CommandHandlerContext,
  input: CreateReferralInput,
): Promise<CommandResult<ReferralView>> {
  const customer = await getCustomer(ctx, input.customerId);
  if (customer === null) {
    return { ok: false, code: "not_found", message: "customer not found in this tenant" };
  }
  const at = now();
  const program =
    input.programId !== undefined ? await getProgram(ctx, input.programId) : await getActiveProgram(ctx, at);
  if (program === null) {
    return { ok: false, code: "validation_failed", message: "no active referral program in this tenant" };
  }
  if (program.status !== "ACTIVE" || program.startsAt.getTime() > at.getTime()) {
    return { ok: false, code: "validation_failed", message: `referral program is ${program.status}` };
  }
  if (program.endsAt !== null && program.endsAt.getTime() <= at.getTime()) {
    return { ok: false, code: "validation_failed", message: "referral program window is closed" };
  }
  let referredPersonId: string | null = null;
  if (input.referredPersonId !== undefined) {
    if (!(await personExists(ctx, input.referredPersonId))) {
      return { ok: false, code: "not_found", message: "referred person not found in this tenant" };
    }
    referredPersonId = input.referredPersonId;
  } else if (input.referredIdentity !== undefined) {
    const normalized = normalizeIdentityValue(input.referredIdentity.type, input.referredIdentity.value);
    const found = await findPersonByIdentity(ctx, input.referredIdentity.type.trim(), normalized);
    if (found === null) {
      return {
        ok: false,
        code: "validation_failed",
        message: "referred identity is not registered in this tenant; register the person first",
      };
    }
    referredPersonId = found;
  }
  // Self-referral is rejected up front (SPEC §7/CA-02); the migration-011
  // trigger stays as a backstop, never the primary check.
  if (referredPersonId !== null && referredPersonId === customer.personId) {
    return { ok: false, code: "validation_failed", message: "self-referral is not allowed (SELF_REFERRAL)" };
  }
  const status = referredPersonId === null ? "CREATED" : "ATTRIBUTED";
  if (referredPersonId !== null) {
    const trx = kyselyTrxOf(ctx);
    if (trx !== null) {
      await advisoryLockProgramPerson(trx, ctx.tenantId, program.id, referredPersonId);
    }
    // First-touch wins (CA-07): a live referral already covers this
    // (program, person) — return it instead of overwriting attribution.
    // Privacy: the existing row belongs to whoever attributed first. The
    // same advocate gets their row back (`already: true`); a different
    // caller only learns the person is taken — never the other
    // advocate's customer, code, or referral id.
    const existing = await findActiveReferralForPerson(ctx, program.id, referredPersonId);
    if (existing !== null) {
      if (existing.advocateCustomerId !== customer.id) {
        return {
          ok: false,
          code: "precondition_failed",
          message: "referred person is already attributed in this program",
        };
      }
      return { ok: true, data: toReferralView(existing, true) };
    }
  }
  let created: ReferralRow;
  try {
    created = await insertReferral(ctx, {
      programId: program.id,
      advocateCustomerId: customer.id,
      referredPersonId,
      code: input.referralCode ?? referralCode(),
      status: status as "CREATED" | "ATTRIBUTED",
      sourceContext: input.sourceContext ?? null,
    });
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      return { ok: false, code: "precondition_failed", message: err.message };
    }
    throw err;
  }
  await emitReferral(ctx, "referral.created.v1", created, { referral_code: created.code });
  if (created.status === "ATTRIBUTED") {
    await emitReferral(ctx, "referral.attributed.v1", created, {});
  }
  return { ok: true, data: toReferralView(created, false) };
}

export interface QualifyResult {
  referralId: string;
  qualificationId: string | null;
  referralStatus: string;
  decision: string;
  reasonCodes: string[];
  qualifiedOrderId: string | null;
  rewardId: string | null;
  already: boolean;
}

/** Signed ledger mirror: EARNED positive, consumption negative (exact strings). */
function negateMinor(value: string): string {
  return (-toMinor(value)).toString();
}

async function issueAdvocateReward(
  ctx: CommandHandlerContext,
  input: { referral: ReferralRow; order: ConversionOrderRow },
): Promise<{ rewardId: string; already: boolean }> {
  // Replay-first: an existing link short-circuits before any insert, so
  // `referral.confirmed.v1` replayed x10 never double-issues (CA-03).
  const linked = await listRewardsForReferral(ctx, input.referral.id);
  const firstLinked = linked[0];
  if (firstLinked !== undefined) {
    return { rewardId: firstLinked.id, already: true };
  }
  const definition = await ensureAdvocateCreditDefinition(ctx);
  if (definition.status !== "ACTIVE") {
    throw new Error("advocate credit definition is not ACTIVE");
  }
  const credit = sizeAdvocateCredit(toMinor(input.order.netMinor));
  const valueMinor = credit > 0n ? credit.toString() : null;
  const currency = input.order.currency;
  const reward = await insertReward(ctx, {
    customerId: input.referral.advocateCustomerId,
    rewardDefinitionId: definition.id,
    sourceType: "referral",
    sourceId: input.referral.id,
    economicValueMinor: valueMinor,
    currency,
    expiresAt: null,
  });
  await insertRewardLink(ctx, { referralId: input.referral.id, rewardId: reward.id });
  const earnAsAmount = valueMinor !== null;
  await emitAndEnqueue(ctx, {
    eventType: "reward.pending_created.v1",
    aggregateType: "reward",
    aggregateId: reward.id,
    data: {
      reward_id: reward.id,
      customer_id: reward.customerId,
      referral_id: input.referral.id,
      economic_value_minor: valueMinor,
      currency,
    },
  });
  const approved = await transitionReward(ctx, { rewardId: reward.id, from: ["PENDING"], to: "APPROVED" });
  if (approved === null) {
    throw new Error("reward changed concurrently during issue");
  }
  await emitAndEnqueue(ctx, {
    eventType: "reward.approved.v1",
    aggregateType: "reward",
    aggregateId: reward.id,
    data: { reward_id: reward.id, referral_id: input.referral.id },
  });
  const issued = await transitionReward(ctx, { rewardId: reward.id, from: ["APPROVED"], to: "ISSUED" });
  if (issued === null) {
    throw new Error("reward changed concurrently during issue");
  }
  await emitAndEnqueue(ctx, {
    eventType: "reward.issued.v1",
    aggregateType: "reward",
    aggregateId: reward.id,
    data: { reward_id: reward.id, referral_id: input.referral.id },
  });
  const available = await transitionReward(ctx, { rewardId: reward.id, from: ["ISSUED"], to: "AVAILABLE" });
  if (available === null) {
    throw new Error("reward changed concurrently during issue");
  }
  await appendLedgerEntry(ctx, {
    customerId: reward.customerId,
    rewardId: reward.id,
    entryType: "EARNED",
    amountMinor: earnAsAmount ? valueMinor : null,
    pointsDelta: earnAsAmount ? null : 1,
    currency: earnAsAmount ? currency : null,
    idempotencyKey: `reward-earn:${reward.id}`,
    referenceType: "referral",
    referenceId: input.referral.id,
  });
  await emitAndEnqueue(ctx, {
    eventType: "reward.available.v1",
    aggregateType: "reward",
    aggregateId: reward.id,
    data: {
      reward_id: reward.id,
      referral_id: input.referral.id,
      economic_value_minor: valueMinor,
      currency,
    },
  });
  if (definition.rewardType === "GIFT_PASS") {
    // NOTE (W12-GAP-01): the registry declares `gift_pass.issued.v1`, but
    // the canonical envelope validator (`PUBLIC_EVENT_ID_RE` in
    // packages/domain) rejects an underscore in the domain segment, so
    // `gift_pass.*` ids cannot be emitted today. The pass row is still
    // created and the lifecycle stays queryable; the command-bus audit
    // records the issuance. Emitting needs a platform decision on the
    // validator vs the registry name (Planner call, not this slice).
    await insertGiftPass(ctx, {
      issuedToCustomerId: reward.customerId,
      sourceRewardId: reward.id,
      code: giftPassCode(),
      benefit: { reward_id: reward.id, reward_key: definition.rewardKey },
      expiresAt: new Date(now().getTime() + 30 * 86_400_000),
    });
  }
  return { rewardId: reward.id, already: false };
}

async function handleQualify(
  ctx: CommandHandlerContext,
  input: QualifyReferralInput,
): Promise<CommandResult<QualifyResult>> {
  const referral = await getReferral(ctx, input.referralId);
  if (referral === null) {
    return { ok: false, code: "not_found", message: "referral not found in this tenant" };
  }
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    await advisoryLockReferral(trx, referral.id);
  }
  const terminalDecision = (status: string): string | null => {
    if (status === "CONFIRMED") return "ALLOW";
    if (status === "REJECTED") return "DENY";
    if (status === "REVERSED") return "REVERSED";
    if (status === "EXPIRED") return "EXPIRED";
    return null;
  };
  // CONFIRMED referrals re-validate the conversion: a refund/chargeback
  // inside the window auto-reverses (compensating entries, CA-06);
  // a healthy conversion makes the replay a no-op (CA-03).
  if (referral.status === "CONFIRMED") {
    const latest = await getLatestQualification(ctx, referral.id);
    const order =
      latest?.qualifiedOrderId !== null && latest?.qualifiedOrderId !== undefined
        ? await getConversionOrder(ctx, latest.qualifiedOrderId)
        : null;
    if (order !== null) {
      const reversal = shouldReverseReferral({
        referralStatus: referral.status,
        conversionReversed: await isOrderFullyReversed(ctx, order),
      });
      if (reversal.reverse) {
        const reversed = await reverseConfirmedReferral(ctx, referral, reversal.reasonCode as string);
      return {
        ok: true,
        data: {
          referralId: referral.id,
          qualificationId: latest?.id ?? null,
          referralStatus: "REVERSED",
          decision: "REVERSED",
          reasonCodes: ["CONVERSION_REVERSED"],
          qualifiedOrderId: order.id,
          rewardId: null,
          already: reversed.already,
        },
      };
      }
    }
    return {
      ok: true,
      data: {
        referralId: referral.id,
        qualificationId: latest?.id ?? null,
        referralStatus: "CONFIRMED",
        decision: "ALLOW",
        reasonCodes: latest?.reasonCodes ?? [],
        qualifiedOrderId: latest?.qualifiedOrderId ?? null,
        rewardId: null,
        already: true,
      },
    };
  }
  const terminal = terminalDecision(referral.status);
  if (terminal !== null) {
    const latest = await getLatestQualification(ctx, referral.id);
    return {
      ok: true,
      data: {
        referralId: referral.id,
        qualificationId: latest?.id ?? null,
        referralStatus: referral.status,
        decision: terminal,
        reasonCodes: latest?.reasonCodes ?? [],
        qualifiedOrderId: latest?.qualifiedOrderId ?? null,
        rewardId: null,
        already: true,
      },
    };
  }
  if (referral.referredPersonId === null) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "referral has no attributed person yet; attribution precedes qualification",
    };
  }
  let qualification = await getOpenQualification(ctx, referral.id);
  let current = referral;
  if (current.status === "ATTRIBUTED" || current.status === "ENGAGED") {
    if (qualification === null) {
      try {
        qualification = await insertQualification(ctx, {
          referralId: referral.id,
          policyVersion: input.policyVersion,
          qualifiedOrderId: input.qualifiedOrderId ?? null,
        });
      } catch (err) {
        if (!(err instanceof UniqueViolationError)) {
          throw err;
        }
        qualification = await getOpenQualification(ctx, referral.id);
      }
    }
    const moved = await transitionReferral(ctx, {
      referralId: referral.id,
      from: ["ATTRIBUTED", "ENGAGED"],
      to: "QUALIFYING",
    });
    if (moved === null) {
      return { ok: false, code: "precondition_failed", message: "referral changed concurrently" };
    }
    current = moved;
    await emitReferral(ctx, "referral.qualification_started.v1", current, {
      qualification_id: qualification?.id ?? null,
    });
  }
  if (qualification === null) {
    // REVIEW parks the referral in QUALIFYING with a *resolved*
    // qualification (SPEC §7): the next attempt opens a fresh evaluation
    // instead of failing with `precondition_failed`.
    if (current.status === "QUALIFYING") {
      try {
        qualification = await insertQualification(ctx, {
          referralId: referral.id,
          policyVersion: input.policyVersion,
          qualifiedOrderId: input.qualifiedOrderId ?? null,
        });
      } catch (err) {
        if (!(err instanceof UniqueViolationError)) {
          throw err;
        }
        qualification = await getOpenQualification(ctx, referral.id);
      }
    }
    if (qualification === null) {
      qualification = await getOpenQualification(ctx, referral.id);
      if (qualification === null) {
        return { ok: false, code: "precondition_failed", message: "no open qualification for this referral" };
      }
    }
  }
  let order: ConversionOrderRow | null = null;
  if (input.qualifiedOrderId !== undefined) {
    order = await getConversionOrder(ctx, input.qualifiedOrderId);
    if (order === null) {
      return { ok: false, code: "not_found", message: "order not found in this tenant" };
    }
  } else {
    // Economic discovery only: redemption (zero-value ADJUSTMENT) and
    // other non-positive-net settlements never qualify, so they are
    // skipped here instead of denying the referral.
    order = await findLatestEconomicSettledOrderForPerson(ctx, referral.referredPersonId);
  }
  // No conversion yet: stay PENDING (qualification open, referral QUALIFYING).
  if (order === null) {
    return {
      ok: true,
      data: {
        referralId: referral.id,
        qualificationId: qualification.id,
        referralStatus: current.status,
        decision: "PENDING",
        reasonCodes: [],
        qualifiedOrderId: null,
        rewardId: null,
        already: false,
      },
    };
  }
  const rows = await ctx.tx.listPublishedPolicies(REFERRAL_POLICY_FAMILY, ctx.tenantId);
  const { document } = mergePolicyRows(rows);
  void REWARD_POLICY_FAMILY;
  const policy = parseQualificationPolicy(document);
  const advocatePersonId = await getPersonIdForCustomer(ctx, referral.advocateCustomerId);
  const settledAt = order.settledAt;
  const verdict = decideQualification({
    orderSettled: order.status === "SETTLED",
    orderNetMinor: toMinor(order.netMinor),
    paymentCovered: await isOrderPaymentCovered(ctx, order),
    isSelfReferral: advocatePersonId !== null && advocatePersonId === referral.referredPersonId,
    conversionPersonMismatch: order.personId !== referral.referredPersonId,
    withinWindow:
      settledAt !== null &&
      isWithinQualificationWindow(
        current.attributedAt ?? current.createdAt,
        settledAt,
        policy.windowDays,
      ),
    conversionReversed: await isOrderFullyReversed(ctx, order),
    isDuplicate: await hasOtherActiveReferralForPerson(ctx, {
      programId: referral.programId,
      personId: referral.referredPersonId,
      excludeReferralId: referral.id,
    }),
    hasRiskSignal: false,
    // Redemption (zero-value ADJUSTMENT) and any other settlement with
    // no economic counterpart never qualify — and never terminally deny.
    isNonEconomicConversion: order.orderType === "ADJUSTMENT" || toMinor(order.netMinor) <= 0n,
  });
  if (verdict.decision === "DENY") {
    // Invalid/premature candidate (wrong order, unsettled, non-economic):
    // a command error WITHOUT terminal transition — the qualification
    // stays open in QUALIFYING for a later valid conversion. DENY/REJECTED
    // is reserved for conclusive ineligibility of a real conversion.
    const candidateInvalid = verdict.reasonCodes.some((code) =>
      ["NO_SETTLED_CONVERSION", "CONVERSION_PERSON_MISMATCH", "NON_ECONOMIC_CONVERSION"].includes(code),
    );
    if (candidateInvalid) {
      return {
        ok: false,
        code: "precondition_failed",
        message: `candidate order is not an eligible conversion (${verdict.reasonCodes.join(",")})`,
      };
    }
    const rejected = await transitionReferral(ctx, {
      referralId: referral.id,
      from: ["QUALIFYING"],
      to: "REJECTED",
    });
    if (rejected === null) {
      return { ok: false, code: "precondition_failed", message: "referral changed concurrently" };
    }
    const resolved = await resolveQualification(ctx, {
      qualificationId: qualification.id,
      status: "DENY",
      reasonCodes: verdict.reasonCodes,
      qualifiedOrderId: order.id,
    });
    if (resolved === null) {
      return { ok: false, code: "precondition_failed", message: "qualification changed concurrently" };
    }
    await emitReferral(ctx, "referral.rejected.v1", rejected, {
      qualification_id: qualification.id,
      reason_codes: verdict.reasonCodes,
    });
    return {
      ok: true,
      data: {
        referralId: referral.id,
        qualificationId: qualification.id,
        referralStatus: "REJECTED",
        decision: "DENY",
        reasonCodes: verdict.reasonCodes,
        qualifiedOrderId: order.id,
        rewardId: null,
        already: false,
      },
    };
  }
  if (verdict.decision === "REVIEW") {
    const resolved = await resolveQualification(ctx, {
      qualificationId: qualification.id,
      status: "REVIEW",
      reasonCodes: verdict.reasonCodes,
      qualifiedOrderId: order.id,
    });
    if (resolved === null) {
      return { ok: false, code: "precondition_failed", message: "qualification changed concurrently" };
    }
    // Ambiguity parks the referral in QUALIFYING (SPEC §7: REVIEW over an
    // irreversible block); a later qualify re-evaluates with fresh evidence.
    return {
      ok: true,
      data: {
        referralId: referral.id,
        qualificationId: qualification.id,
        referralStatus: current.status,
        decision: "REVIEW",
        reasonCodes: verdict.reasonCodes,
        qualifiedOrderId: order.id,
        rewardId: null,
        already: false,
      },
    };
  }
  const confirmed = await transitionReferral(ctx, {
    referralId: referral.id,
    from: ["QUALIFYING"],
    to: "CONFIRMED",
  });
  if (confirmed === null) {
    return { ok: false, code: "precondition_failed", message: "referral changed concurrently" };
  }
  const resolved = await resolveQualification(ctx, {
    qualificationId: qualification.id,
    status: "ALLOW",
    reasonCodes: [],
    qualifiedOrderId: order.id,
  });
  if (resolved === null) {
    return { ok: false, code: "precondition_failed", message: "qualification changed concurrently" };
  }
  const issued = await issueAdvocateReward(ctx, { referral: confirmed, order });
  await emitReferral(ctx, "referral.confirmed.v1", confirmed, {
    qualification_id: qualification.id,
    qualified_order_id: order.id,
    reward_id: issued.rewardId,
  });
  return {
    ok: true,
    data: {
      referralId: referral.id,
      qualificationId: qualification.id,
      referralStatus: "CONFIRMED",
      decision: "ALLOW",
      reasonCodes: [],
      qualifiedOrderId: order.id,
      rewardId: issued.rewardId,
      already: issued.already,
    },
  };
}

async function reverseConfirmedReferral(
  ctx: CommandHandlerContext,
  referral: ReferralRow,
  reasonCode: string,
): Promise<{ already: boolean; revokedRewards: string[] }> {
  if (referral.status === "REVERSED") {
    return { already: true, revokedRewards: [] };
  }
  const moved = await transitionReferral(ctx, {
    referralId: referral.id,
    from: ["CONFIRMED"],
    to: "REVERSED",
  });
  if (moved === null) {
    return { already: true, revokedRewards: [] };
  }
  const revokedRewards: string[] = [];
  for (const reward of await listRewardsForReferral(ctx, referral.id)) {
    if (reward.status !== "APPROVED" && reward.status !== "ISSUED" && reward.status !== "AVAILABLE") {
      continue;
    }
    const revoked = await transitionReward(ctx, {
      rewardId: reward.id,
      from: ["APPROVED", "ISSUED", "AVAILABLE"],
      to: "REVOKED",
    });
    if (revoked === null) {
      continue;
    }
    const hasAmount = reward.economicValueMinor !== null && toMinor(reward.economicValueMinor) > 0n;
    await appendLedgerEntry(ctx, {
      customerId: reward.customerId,
      rewardId: reward.id,
      entryType: "REVERSAL",
      amountMinor: hasAmount ? negateMinor(reward.economicValueMinor as string) : null,
      pointsDelta: hasAmount ? null : -1,
      currency: hasAmount ? reward.currency : null,
      idempotencyKey: `reward-reversal:${reward.id}`,
      referenceType: "referral",
      referenceId: referral.id,
    });
    await emitAndEnqueue(ctx, {
      eventType: "reward.revoked.v1",
      aggregateType: "reward",
      aggregateId: reward.id,
      data: { reward_id: reward.id, referral_id: referral.id, reason: reasonCode },
    });
    revokedRewards.push(reward.id);
  }
  await emitReferral(ctx, "referral.reversed.v1", moved, {
    reason_codes: [reasonCode],
    revoked_rewards: revokedRewards,
  });
  return { already: false, revokedRewards };
}

async function handleReverse(
  ctx: CommandHandlerContext,
  input: ReverseReferralInput,
): Promise<CommandResult<{ referralId: string; status: string; revokedRewards: string[]; already: boolean }>> {
  const referral = await getReferral(ctx, input.referralId);
  if (referral === null) {
    return { ok: false, code: "not_found", message: "referral not found in this tenant" };
  }
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    await advisoryLockReferral(trx, referral.id);
  }
  if (referral.status === "REVERSED") {
    return {
      ok: true,
      data: { referralId: referral.id, status: "REVERSED", revokedRewards: [], already: true },
    };
  }
  if (referral.status !== "CONFIRMED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `referral is ${referral.status}; only CONFIRMED referrals reverse`,
    };
  }
  const result = await reverseConfirmedReferral(ctx, referral, input.reason ?? "MANUAL_REVERSAL");
  return {
    ok: true,
    data: {
      referralId: referral.id,
      status: "REVERSED",
      revokedRewards: result.revokedRewards,
      already: result.already,
    },
  };
}

export interface RedeemResult {
  rewardId: string;
  status: string;
  orderId: string | null;
  already: boolean;
}

async function handleRedeemReward(
  ctx: CommandHandlerContext,
  input: RedeemRewardInput,
): Promise<CommandResult<RedeemResult>> {
  const reward = await getReward(ctx, input.rewardId);
  if (reward === null) {
    return { ok: false, code: "not_found", message: "reward not found in this tenant" };
  }
  // Replay-first: a prior REDEEMED ledger row carries the redemption order.
  if (reward.status === "REDEEMED") {
    const entries = await listLedgerByReward(ctx, reward.id);
    const redeemed = entries.find((e) => e.entryType === "REDEEMED" && e.referenceType === "order");
    return {
      ok: true,
      data: { rewardId: reward.id, status: "REDEEMED", orderId: redeemed?.referenceId ?? null, already: true },
    };
  }
  if (reward.status !== "AVAILABLE") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `reward is ${reward.status}; only AVAILABLE rewards redeem`,
    };
  }
  if (reward.expiresAt !== null && reward.expiresAt.getTime() <= now().getTime()) {
    const expired = await transitionReward(ctx, { rewardId: reward.id, from: ["AVAILABLE"], to: "EXPIRED" });
    if (expired !== null) {
      const hasAmount = reward.economicValueMinor !== null && toMinor(reward.economicValueMinor) > 0n;
      await appendLedgerEntry(ctx, {
        customerId: reward.customerId,
        rewardId: reward.id,
        entryType: "EXPIRED",
        amountMinor: hasAmount ? negateMinor(reward.economicValueMinor as string) : null,
        pointsDelta: hasAmount ? null : -1,
        currency: hasAmount ? reward.currency : null,
        idempotencyKey: `reward-expire:${reward.id}`,
        referenceType: null,
        referenceId: null,
      });
      await emitAndEnqueue(ctx, {
        eventType: "reward.expired.v1",
        aggregateType: "reward",
        aggregateId: reward.id,
        data: { reward_id: reward.id },
      });
    }
    return { ok: false, code: "precondition_failed", message: "reward expired before redemption" };
  }
  const personId = await getPersonIdForCustomer(ctx, reward.customerId);
  if (personId === null) {
    return { ok: false, code: "precondition_failed", message: "reward customer has no person" };
  }
  // Claim-first under a per-reward advisory lock (same transaction): the
  // AVAILABLE → REDEEMED CAS happens BEFORE the redemption order exists,
  // so a concurrent loser fails the claim having written nothing — no
  // orphan order can persist. Everything after the claim (order, ledger,
  // events) rolls back atomically with it on failure.
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    await advisoryLockReward(trx, reward.id);
    const fresh = await getReward(ctx, input.rewardId);
    if (fresh === null) {
      return { ok: false, code: "not_found", message: "reward not found in this tenant" };
    }
    if (fresh.status === "REDEEMED") {
      const entries = await listLedgerByReward(ctx, reward.id);
      const redeemedEntry = entries.find((e) => e.entryType === "REDEEMED" && e.referenceType === "order");
      return {
        ok: true,
        data: {
          rewardId: reward.id,
          status: "REDEEMED",
          orderId: redeemedEntry?.referenceId ?? null,
          already: true,
        },
      };
    }
    if (fresh.status !== "AVAILABLE") {
      return {
        ok: false,
        code: "precondition_failed",
        message: `reward is ${fresh.status}; only AVAILABLE rewards redeem`,
      };
    }
  }
  const claimed = await transitionReward(ctx, { rewardId: reward.id, from: ["AVAILABLE"], to: "REDEEMED" });
  if (claimed === null) {
    return { ok: false, code: "precondition_failed", message: "reward changed concurrently" };
  }
  const valueMinor = reward.economicValueMinor ?? "0";
  const currency = reward.currency ?? "BRL";
  const order = await insertZeroValueRedemptionOrder(ctx, {
    personId,
    customerId: reward.customerId,
    rewardDefinitionId: reward.rewardDefinitionId,
    valueMinor,
    currency,
    rewardId: reward.id,
  });
  const hasAmount = toMinor(valueMinor) > 0n;
  await appendLedgerEntry(ctx, {
    customerId: reward.customerId,
    rewardId: reward.id,
    entryType: "REDEEMED",
    amountMinor: hasAmount ? negateMinor(valueMinor) : null,
    pointsDelta: hasAmount ? null : -1,
    currency: hasAmount ? currency : null,
    idempotencyKey: `reward-redeem:${reward.id}`,
    referenceType: "order",
    referenceId: order.orderId,
  });
  await emitAndEnqueue(ctx, {
    eventType: "order.created.v1",
    aggregateType: "order",
    aggregateId: order.orderId,
    data: {
      order_id: order.orderId,
      person_id: personId,
      order_type: "ADJUSTMENT",
      net_amount_minor: "0",
      currency,
      reward_redemption: true,
      reward_id: reward.id,
    },
  });
  await emitAndEnqueue(ctx, {
    eventType: "order.settled.v1",
    aggregateType: "order",
    aggregateId: order.orderId,
    data: {
      order_id: order.orderId,
      person_id: personId,
      settled_amount_minor: "0",
      currency,
      reward_redemption: true,
      reward_id: reward.id,
    },
  });
  await emitAndEnqueue(ctx, {
    eventType: "reward.redeemed.v1",
    aggregateType: "reward",
    aggregateId: reward.id,
    data: { reward_id: reward.id, order_id: order.orderId, economic_value_minor: valueMinor, currency },
  });
  return { ok: true, data: { rewardId: reward.id, status: "REDEEMED", orderId: order.orderId, already: false } };
}

export interface GiftPassRedeemResult {
  giftPassId: string;
  code: string;
  status: string;
  redeemedByPersonId: string | null;
  already: boolean;
}

async function handleRedeemGiftPass(
  ctx: CommandHandlerContext,
  input: RedeemGiftPassInput,
): Promise<CommandResult<GiftPassRedeemResult>> {
  // Tenant-scoped by (tenant_id, code): a foreign-tenant code is NOT_FOUND.
  const pass = await getGiftPassByCode(ctx, input.code.trim());
  if (pass === null) {
    return { ok: false, code: "not_found", message: "gift pass not found in this tenant" };
  }
  if (pass.status === "REDEEMED") {
    if (pass.redeemedByPersonId === input.personId) {
      return {
        ok: true,
        data: {
          giftPassId: pass.id,
          code: pass.code,
          status: "REDEEMED",
          redeemedByPersonId: pass.redeemedByPersonId,
          already: true,
        },
      };
    }
    return { ok: false, code: "precondition_failed", message: "gift pass was already redeemed" };
  }
  if (pass.status !== "AVAILABLE") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `gift pass is ${pass.status}; only AVAILABLE passes redeem`,
    };
  }
  if (pass.expiresAt.getTime() <= now().getTime()) {
    // NOTE (W12-GAP-01): `gift_pass.expired.v1` is registry-declared but
    // envelope-invalid (underscore domain); expiry stays audit-only until
    // the platform resolves the validator vs registry conflict.
    await transitionGiftPass(ctx, { giftPassId: pass.id, from: ["AVAILABLE"], to: "EXPIRED" });
    return { ok: false, code: "precondition_failed", message: "gift pass expired before redemption" };
  }
  if (!(await personExists(ctx, input.personId))) {
    return { ok: false, code: "not_found", message: "person not found in this tenant" };
  }
  // Baseline anti-abuse (SPEC §7/§12): the issuer cannot redeem their own
  // pass — legitimate ambiguity elsewhere prefers REVIEW, but self-
  // redemption is deterministic and denied.
  const issuerPersonId = await getPersonIdForCustomer(ctx, pass.issuedToCustomerId);
  if (issuerPersonId !== null && issuerPersonId === input.personId) {
    return {
      ok: false,
      code: "validation_failed",
      message: "gift pass self-redemption is not allowed (GIFT_SELF_REDEMPTION)",
    };
  }
  const redeemed = await transitionGiftPass(ctx, {
    giftPassId: pass.id,
    from: ["AVAILABLE"],
    to: "REDEEMED",
    redeemedByPersonId: input.personId,
  });
  if (redeemed === null) {
    return { ok: false, code: "precondition_failed", message: "gift pass changed concurrently" };
  }
  // NOTE (W12-GAP-01): `gift_pass.redeemed.v1` is registry-declared but
  // envelope-invalid (underscore domain); redemption stays audit-only until
  // the platform resolves the validator vs registry conflict.
  return {
    ok: true,
    data: {
      giftPassId: pass.id,
      code: pass.code,
      status: "REDEEMED",
      redeemedByPersonId: input.personId,
      already: false,
    },
  };
}

async function handleExpireDue(
  ctx: CommandHandlerContext,
  input: ReferralExpireDueInput,
): Promise<CommandResult<{ expiredRewards: string[]; expiredGiftPasses: string[] }>> {
  const at = now();
  const expiredRewards: string[] = [];
  for (const reward of await listExpiredRewards(ctx, { at, limit: input.limit })) {
    const expired = await transitionReward(ctx, { rewardId: reward.id, from: ["AVAILABLE"], to: "EXPIRED" });
    if (expired === null) {
      continue;
    }
    const hasAmount = reward.economicValueMinor !== null && toMinor(reward.economicValueMinor) > 0n;
    await appendLedgerEntry(ctx, {
      customerId: reward.customerId,
      rewardId: reward.id,
      entryType: "EXPIRED",
      amountMinor: hasAmount ? negateMinor(reward.economicValueMinor as string) : null,
      pointsDelta: hasAmount ? null : -1,
      currency: hasAmount ? reward.currency : null,
      idempotencyKey: `reward-expire:${reward.id}`,
      referenceType: null,
      referenceId: null,
    });
    await emitAndEnqueue(ctx, {
      eventType: "reward.expired.v1",
      aggregateType: "reward",
      aggregateId: reward.id,
      data: { reward_id: reward.id },
    });
    expiredRewards.push(reward.id);
  }
  const expiredGiftPasses: string[] = [];
  for (const pass of await listExpiredGiftPasses(ctx, { at, limit: input.limit })) {
    const expired = await transitionGiftPass(ctx, { giftPassId: pass.id, from: ["AVAILABLE"], to: "EXPIRED" });
    if (expired === null) {
      continue;
    }
    // NOTE (W12-GAP-01): `gift_pass.expired.v1` stays audit-only (see above).
    expiredGiftPasses.push(pass.id);
  }
  return { ok: true, data: { expiredRewards, expiredGiftPasses } };
}

export function registerReferralCommands(bus: CommandBus): void {
  bus.register<CreateReferralInput, ReferralView>({
    name: "referral.create",
    permission: "crm.lead.write",
    auditAction: "referral.create",
    auditResource: "referral",
    input: createReferralInput,
    handler: handleCreate,
  });
  bus.register<QualifyReferralInput, QualifyResult>({
    name: "referral.qualify",
    permission: "crm.lead.write",
    auditAction: "referral.qualify",
    auditResource: "referral",
    input: qualifyReferralInput,
    handler: handleQualify,
  });
  bus.register<ReverseReferralInput, { referralId: string; status: string; revokedRewards: string[]; already: boolean }>({
    name: "referral.reverse",
    permission: "crm.lead.write",
    auditAction: "referral.reverse",
    auditResource: "referral",
    input: reverseReferralInput,
    handler: handleReverse,
  });
  bus.register<RedeemRewardInput, RedeemResult>({
    name: "reward.redeem",
    permission: "commerce.order.write",
    auditAction: "reward.redeem",
    auditResource: "reward",
    input: redeemRewardInput,
    handler: handleRedeemReward,
  });
  bus.register<RedeemGiftPassInput, GiftPassRedeemResult>({
    name: "giftpass.redeem",
    permission: "crm.lead.write",
    auditAction: "giftpass.redeem",
    auditResource: "gift_pass",
    input: redeemGiftPassInput,
    handler: handleRedeemGiftPass,
  });
  bus.register<ReferralExpireDueInput, { expiredRewards: string[]; expiredGiftPasses: string[] }>({
    name: "referral.expire_due",
    permission: "crm.lead.write",
    auditAction: "referral.expire_due",
    auditResource: "reward",
    input: referralExpireDueInput,
    handler: handleExpireDue,
  });
}
