import { z } from "zod";
import { newId, now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type {
  CommandBus,
  CommandHandlerContext,
} from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf, memoryStateOf } from "../crm/wave2-store.js";
import { resolveSecretsPort, type SecretsPort } from "@iptv/secrets";
import {
  assertBrowserSecretReady,
  decideTrialDispatchGate,
  findExistingTrialProviderAccountId,
  getProviderAccountSecretRef,
  isCapabilityUnavailable,
  isProviderAccountActive,
  isSecretRequiringPort,
  projectSecretPortResult,
  TRIAL_CAPABILITY_KEY,
  TRIAL_GATE_MESSAGES,
  trialDisposableAccountIdFromEnv,
} from "../provider/provider-secret-gate.js";
import {
  SECRET_REQUIRED_ADAPTER_VERSION,
  adapterNameFromEnv,
  applyCapabilityGate,
  resolveOpsPort,
  type ProviderOpsPort,
} from "../provider/provider-port.js";
import {
  ELIGIBILITY_FAMILY,
  TERMINAL_TRIAL_STATUSES,
  TRUST_RENEWAL_FAMILY,
  decideTrustRenewal,
  evaluateEligibility,
  isTrialTransition,
  mergePolicyRows,
  parseEligibilityPolicy,
  parseTrustRenewalPolicy,
  type EligibilityPolicy,
} from "./trial-policy.js";
import {
  UniqueViolationError,
  applyProviderTerminalOutcome,
  ensureTrialProviderAccount,
  findOpenTrialForPerson,
  findProviderOperationByBusinessKey,
  getProviderOperation,
  getTechnicalResult,
  getTrial,
  hasPrimaryTrial,
  insertEligibilityDecision,
  insertProviderAttempt,
  insertProviderOperation,
  insertTechnicalResult,
  insertTrial,
  insertTrialAttempt,
  insertTrialProviderEvidence,
  latestEligibilityDecisionForTrial,
  latestProviderOperationForEntity,
  reopenFailedProviderOperationForRetry,
  reviewApprovedByHuman,
  trialMemoryOf,
  trialProvisionBusinessKey,
  updateProviderOperation,
  updateTrial,
  upsertTrialBinding,
} from "./trial-store.js";
import {
  TRIAL_POSTCONDITION_MISMATCH_CODE,
  TRIAL_READBACK_EVIDENCE_TYPE,
  evaluateTrialProvisionPostconditions,
  isTrialPostconditionMismatch,
  normalizeTrialExternalId,
  normalizeTrialIsTrial,
  parseTrialExpiresAt,
  trialReadbackMinFutureMsFromEnv,
  type TrialPostconditionVerdict,
  type TrialReadbackPort,
  type TrialReadbackResult,
} from "./trial-readback.js";

/**
 * Wave 4 Trial + Compatibility commands (owning context for ServiceTrial).
 *
 * Canonical rules enforced here:
 * - Persisted kind is ONLY `TRIAL | RETRIAL`; `trial.request` always creates
 *   a primary TRIAL, `trial.request_retrial` always creates a RETRIAL with
 *   `previous_trial_id` + non-blank reason.
 * - Eligibility is a policy-family decision (`trial.eligibility`) with safe
 *   defaults; REVIEW outcomes park in HumanReview and materialize only with
 *   an approved review (`approvedReviewId`).
 * - Provisioning runs behind `ProviderOpsPort` (echo/manual only — real
 *   CINEVISION is Wave-0-gated). A FAILED operation with certain
 *   non-application returns the trial to REQUESTED (retry stays possible);
 *   only an unusable provisioned trial is INVALIDATED.
 * - Technical results live in their own table and never move the lifecycle.
 * - Trust Renewal extends `expires_at` by the policy family's
 *   `extension_days` (default +3) only when ACTIVE and remaining within the
 *   policy threshold (default <= 3 days); audit-only, no invented event.
 * - Every emitted event is registry-listed (see `trial-policy.ts`
 *   `TRIAL_EVENT_ALLOWLIST`); trust-renewal and compatibility writes are
 *   audit-only.
 */

export const requestTrialInput = z.object({
  personId: z.string().uuid(),
  leadId: z.string().uuid().optional(),
  durationMinutes: z.number().int().positive().max(24 * 60).default(60),
  adultContentEnabled: z.boolean().default(false),
  approvedReviewId: z.string().uuid().optional(),
});

export type RequestTrialInput = z.infer<typeof requestTrialInput>;

export const beginProvisioningInput = z.object({
  trialId: z.string().uuid(),
  adapter: z.enum(["echo", "manual"]).optional(),
  echoOutcome: z.enum(["success", "failed", "unknown"]).optional(),
});

export type BeginProvisioningInput = z.infer<typeof beginProvisioningInput>;

export const recordTechnicalResultInput = z.object({
  trialId: z.string().uuid(),
  installationSuccess: z.boolean().optional(),
  authenticationSuccess: z.boolean().optional(),
  playbackSuccess: z.boolean().optional(),
  bufferingObserved: z.boolean().optional(),
  summaryOutcome: z.enum(["PASSED", "FAILED", "INCONCLUSIVE"]),
});

export type RecordTechnicalResultInput = z.infer<typeof recordTechnicalResultInput>;

export const trialIdInput = z.object({ trialId: z.string().uuid() });
export type TrialIdInput = z.infer<typeof trialIdInput>;

export const cancelTrialInput = z.object({
  trialId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type CancelTrialInput = z.infer<typeof cancelTrialInput>;

export const invalidateTrialInput = z.object({
  trialId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
});
export type InvalidateTrialInput = z.infer<typeof invalidateTrialInput>;

export const requestRetrialInput = z.object({
  previousTrialId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
  durationMinutes: z.number().int().positive().max(24 * 60).default(60),
  adultContentEnabled: z.boolean().default(false),
  approvedReviewId: z.string().uuid().optional(),
});
export type RequestRetrialInput = z.infer<typeof requestRetrialInput>;

export const expireDueInput = z.object({ limit: z.number().int().min(1).max(1000).default(100) });
export type ExpireDueInput = z.infer<typeof expireDueInput>;

export const recordDeviceProfileInput = z.object({
  personId: z.string().uuid(),
  deviceType: z.string().trim().min(1).max(64),
  manufacturer: z.string().trim().min(1).max(120).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  osName: z.string().trim().min(1).max(64).optional(),
  osVersion: z.string().trim().min(1).max(64).optional(),
});
export type RecordDeviceProfileInput = z.infer<typeof recordDeviceProfileInput>;

export const recordAppProfileInput = z.object({
  name: z.string().trim().min(1).max(120),
  platform: z.string().trim().min(1).max(64),
  version: z.string().trim().min(1).max(64).optional(),
  licenseType: z.string().trim().min(1).max(64).optional(),
});
export type RecordAppProfileInput = z.infer<typeof recordAppProfileInput>;

export const recordObservationInput = z.object({
  personId: z.string().uuid().optional(),
  trialId: z.string().uuid().optional(),
  deviceProfileId: z.string().uuid().optional(),
  appProfileId: z.string().uuid().optional(),
  providerServerKey: z.string().trim().min(1).max(64).optional(),
  network: z
    .object({
      ispName: z.string().trim().min(1).max(120).optional(),
      networkType: z.string().trim().min(1).max(64).optional(),
      ipv6State: z.string().trim().min(1).max(32).optional(),
      dnsProfile: z.string().trim().min(1).max(120).optional(),
    })
    .optional(),
  procedureKey: z.string().trim().min(1).max(120).optional(),
  outcome: z.enum(["SUCCESS", "DEGRADED", "FAILURE", "INCONCLUSIVE"]),
  metricsJson: z.record(z.string(), z.unknown()).default({}),
});
export type RecordObservationInput = z.infer<typeof recordObservationInput>;

const NON_TERMINAL_OPERATION_STATUSES = ["REQUESTED", "QUEUED", "RUNNING", "VERIFYING", "RETRY_WAIT", "HUMAN_REQUIRED"];
// RETRY_WAIT has no writer in this phase on purpose: retry after a conclusive
// failure is business-driven (the S1 FAILED→REQUESTED reopen above — the ONLY
// retry path), never automatic. Parking VERIFYING→HUMAN_REQUIRED on inconclusive
// readback (§16/§39) must not re-arm a send; auto-retry stays prohibited.

/**
 * SPEC §26 (CREATE_TRIAL idempotency, design (a)): single
 * `trial-provision:{trialId}` row per intent. First provisioning inserts it;
 * a retry after a conclusive failure reopens the SAME row (conditional
 * FAILED→REQUESTED, per-attempt history in the attempts tables). Any other
 * conflicting state — a non-terminal row, a lost reopen race, a duplicate
 * insert race, or a terminal row that is not a retryable FAILED — is a
 * `precondition_failed` conflict, never a second row and never a 500.
 *
 * FASE5-FIX3-R1: exported so the generic `provider.request_operation`
 * `trial.provision` entry derives the SAME canonical identity (the caller
 * `idempotencyKey` is ignored for this action, documented at the call
 * site) instead of minting a second row per caller key.
 */
export async function insertOrReopenTrialProvisionOperation(
  ctx: CommandHandlerContext,
  trialId: string,
  input: {
    providerAccountId: string;
    adapterVersion: string;
    requestedPayload: Record<string, unknown>;
  },
): Promise<
  | { ok: true; operation: { id: string } }
  | { ok: false; message: string }
> {
  const businessKey = trialProvisionBusinessKey(trialId);
  const existing = await findProviderOperationByBusinessKey(ctx, "trial", trialId, businessKey);
  if (existing !== null) {
    if (NON_TERMINAL_OPERATION_STATUSES.includes(existing.status)) {
      return {
        ok: false,
        message: `provisioning already in progress (operation ${existing.id} is ${existing.status})`,
      };
    }
    if (existing.status === "FAILED") {
      const reopened = await reopenFailedProviderOperationForRetry(ctx, existing.id, {
        providerAccountId: input.providerAccountId,
        adapterVersion: input.adapterVersion,
        requestedPayload: input.requestedPayload,
      });
      if (reopened === null) {
        return {
          ok: false,
          message: `provisioning already in progress (operation ${existing.id} changed concurrently)`,
        };
      }
      return { ok: true, operation: reopened };
    }
    return {
      ok: false,
      message: `trial already provisioned (operation ${existing.id} is ${existing.status})`,
    };
  }
  try {
    const operation = await insertProviderOperation(ctx, {
      providerAccountId: input.providerAccountId,
      action: "trial.provision",
      entityType: "trial",
      entityId: trialId,
      idempotencyKey: businessKey,
      requestedPayload: input.requestedPayload,
      adapterVersion: input.adapterVersion,
    });
    return { ok: true, operation };
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      return {
        ok: false,
        message: "provisioning already in progress (duplicate provision intent)",
      };
    }
    throw err;
  }
}

/**
 * FASE5-FIX3-R1+R2 (SPEC §25/§26): the ONE canonical preparation for a
 * trial provision intent, shared by the domain entry
 * (`trial.begin_provisioning`, secret + synthetic branches) and the generic
 * entry (`provider.request_operation action=trial.provision`, secret +
 * synthetic branches). It derives the stable business key
 * (`trial-provision:{trialId}`, eligible FAILED retries reopen the SAME row),
 * records the provisioning attempt + `operation_requested` event, and moves
 * the trial REQUESTED → PROVISIONING. Callers queue (secret/durable) or
 * port-call (synthetic inline) AFTER it returns — never before.
 */
export async function prepareTrialProvisionIntent(
  ctx: CommandHandlerContext,
  trial: {
    id: string;
    personId: string;
    requestedDurationMinutes: number;
    adultContentEnabled: boolean;
    trialKind: string;
  },
  input: {
    providerAccountId: string;
    adapterVersion: string;
    requestedPayload: Record<string, unknown>;
    effectiveAdapter: string;
    capabilityNote: string;
  },
): Promise<{ ok: true; operation: { id: string } } | { ok: false; message: string }> {
  const provisioned = await insertOrReopenTrialProvisionOperation(ctx, trial.id, {
    providerAccountId: input.providerAccountId,
    adapterVersion: input.adapterVersion,
    requestedPayload: input.requestedPayload,
  });
  if (!provisioned.ok) {
    return provisioned;
  }
  const operation = provisioned.operation;
  await insertTrialAttempt(ctx, {
    trialId: trial.id,
    attemptType: "PROVISIONING",
    outcome: "STARTED",
    contextJson: { operation_id: operation.id, adapter: input.effectiveAdapter, capability: input.capabilityNote },
  });
  await emitProvider(ctx, {
    eventType: "provider.operation_requested.v1",
    operationId: operation.id,
    data: { action: "trial.provision", entity_type: "trial", entity_id: trial.id, adapter: input.effectiveAdapter },
  });
  const provisioning = await updateTrial(ctx, trial.id, {
    lifecycleStatus: "PROVISIONING",
    providerAccountId: input.providerAccountId,
  });
  if (provisioning === null || !isTrialTransition("REQUESTED", "PROVISIONING")) {
    return { ok: false, message: "trial left REQUESTED concurrently" };
  }
  await emitTrial(ctx, {
    eventType: "trial.provisioning_started.v1",
    trialId: trial.id,
    data: { person_id: trial.personId, operation_id: operation.id, adapter: input.effectiveAdapter },
  });
  return { ok: true, operation };
}

/**
 * SPEC §25 + §44 (CREATE_TRIAL "eligibility before dispatch"): the ONE
 * pre-dispatch precondition check for trial provisioning. BOTH entries to
 * the external port run it BEFORE any ProviderOperation row or port call:
 * `trial.begin_provisioning` (domain entry) and `provider.request_operation`
 * with `action=trial.provision` (the `via:"provider.resolve"` entry) — so
 * the second can never bypass the first. Fail-closed: a trial whose latest
 * anchored decision is not ALLOW (DENY, REVIEW-pending, or no decision at
 * all) refuses with `precondition_failed` (409).
 *
 * Boundary: this is a PRE-DISPATCH check at operation creation. The durable
 * `ProviderDispatcherService` revalidates capability at dispatch but does
 * NOT re-check eligibility — re-checking at dispatch would strand
 * already-created operations; eligibility gates creation, capability gates
 * dispatch.
 *
 * Retrials need no special case: `trial.request_retrial` writes the retrial
 * its own ALLOW_RETRIAL decision anchored to the new trial id.
 */
export async function assertTrialProvisionPreconditions(
  ctx: CommandHandlerContext,
  trialId: string,
): Promise<
  | {
      ok: true;
      trial: {
        id: string;
        personId: string;
        requestedDurationMinutes: number;
        adultContentEnabled: boolean;
        trialKind: string;
      };
    }
  | { ok: false; code: "not_found"; message: string }
  | { ok: false; code: "precondition_failed"; message: string }
> {
  const trial = await getTrial(ctx, trialId);
  if (trial === null) {
    return { ok: false, code: "not_found", message: "trial not found in this tenant" };
  }
  if (trial.lifecycleStatus !== "REQUESTED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `trial is ${trial.lifecycleStatus}; provisioning starts from REQUESTED`,
    };
  }
  const latestOp = await latestProviderOperationForEntity(ctx, "trial", trial.id);
  if (latestOp !== null && NON_TERMINAL_OPERATION_STATUSES.includes(latestOp.status)) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `provisioning already in progress (operation ${latestOp.id} is ${latestOp.status})`,
    };
  }
  const decision = await latestEligibilityDecisionForTrial(ctx, trial.id);
  if (decision === null) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "trial has no eligibility decision; provisioning requires an ALLOW decision",
    };
  }
  if (decision.outcome !== "ALLOW" && decision.outcome !== "ALLOW_RETRIAL") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `trial eligibility is ${decision.outcome}; provisioning requires an ALLOW decision`,
    };
  }
  return { ok: true, trial };
}

async function personExists(ctx: CommandHandlerContext, personId: string): Promise<boolean> {  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const row = await trx
      .selectFrom("identity.persons")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", personId)
      .executeTakeFirst();
    return row !== undefined;
  }
  const mem = memoryStateOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 2 store available");
  }
  const person = mem.persons.get(personId);
  return person !== undefined && person.tenantId === ctx.tenantId;
}

async function resolveEligibilityPolicy(ctx: CommandHandlerContext): Promise<{
  policy: EligibilityPolicy;
  versionRef: string;
}> {
  const rows = await ctx.tx.listPublishedPolicies(ELIGIBILITY_FAMILY, ctx.tenantId);
  const { document, versionRef } = mergePolicyRows(rows);
  return { policy: parseEligibilityPolicy(document), versionRef };
}

async function emitTrial(
  ctx: CommandHandlerContext,
  input: { eventType: string; trialId: string; data: Record<string, unknown> },
): Promise<void> {
  await emitAndEnqueue(ctx, {
    eventType: input.eventType,
    aggregateType: "trial",
    aggregateId: input.trialId,
    data: { trial_id: input.trialId, ...input.data },
  });
}

async function emitProvider(
  ctx: CommandHandlerContext,
  input: { eventType: string; operationId: string; data: Record<string, unknown> },
): Promise<void> {
  await emitAndEnqueue(ctx, {
    eventType: input.eventType,
    aggregateType: "provider_operation",
    aggregateId: input.operationId,
    data: { operation_id: input.operationId, ...input.data },
  });
}

function denialStatus(reasonCodes: string[]): "forbidden" | "precondition_failed" {
  return reasonCodes.includes("OPEN_TRIAL_EXISTS") || reasonCodes.includes("PRIMARY_ALREADY_EXISTS")
    ? "precondition_failed"
    : "forbidden";
}

async function handleRequest(
  ctx: CommandHandlerContext,
  input: RequestTrialInput,
): Promise<CommandResult<{ id: string | null; status: string; reviewRequestId?: string }>> {
  if (!(await personExists(ctx, input.personId))) {
    return { ok: false, code: "not_found", message: "person not found in this tenant" };
  }
  const { policy, versionRef } = await resolveEligibilityPolicy(ctx);
  if (!policy.durationsMinutes.includes(input.durationMinutes)) {
    return {
      ok: false,
      code: "validation_failed",
      message: `duration ${input.durationMinutes}min is not allowed by trial eligibility policy`,
    };
  }
  const open = await findOpenTrialForPerson(ctx, input.personId);
  if (open !== null) {
    await insertEligibilityDecision(ctx, {
      personId: input.personId,
      outcome: "DENY",
      policyVersion: versionRef,
      reasonCodes: ["OPEN_TRIAL_EXISTS"],
      evidenceJson: { open_trial_id: open.id, open_status: open.lifecycleStatus },
    });
    await emitTrial(ctx, {
      eventType: "trial.eligibility_denied.v1",
      trialId: open.id,
      data: { person_id: input.personId, reason_codes: ["OPEN_TRIAL_EXISTS"] },
    });
    return { ok: false, code: "precondition_failed", message: "an open trial already exists for this person" };
  }
  const hasPrimary = await hasPrimaryTrial(ctx, input.personId);
  let evaluation = evaluateEligibility(policy, {
    hasPrimary,
    hasOpen: false,
    isRetrial: false,
    previousStatus: null,
    durationMinutes: input.durationMinutes,
    adult: input.adultContentEnabled,
  });
  if (evaluation.outcome === "REVIEW" && input.approvedReviewId !== undefined) {
    const approved = await reviewApprovedByHuman(ctx, input.approvedReviewId);
    if (!approved) {
      return {
        ok: false,
        code: "precondition_failed",
        message: "review is not approved; cannot materialize the trial",
      };
    }
    evaluation = { outcome: "ALLOW", reasonCodes: ["HUMAN_APPROVED"] };
  }
  if (evaluation.outcome === "DENY") {
    await insertEligibilityDecision(ctx, {
      personId: input.personId,
      outcome: "DENY",
      policyVersion: versionRef,
      reasonCodes: evaluation.reasonCodes,
      evidenceJson: { duration_minutes: input.durationMinutes },
    });
    // No trial exists yet; anchor the denial on the person aggregate.
    await emitAndEnqueue(ctx, {
      eventType: "trial.eligibility_denied.v1",
      aggregateType: "person",
      aggregateId: input.personId,
      data: { person_id: input.personId, reason_codes: evaluation.reasonCodes },
    });
    return {
      ok: false,
      code: denialStatus(evaluation.reasonCodes),
      message: `trial eligibility denied: ${evaluation.reasonCodes.join(",")}`,
    };
  }
  if (evaluation.outcome === "REVIEW") {
    const stored = await ctx.tx.createReviewRequest({
      resourceType: "trial_request",
      resourceId: input.personId,
      reviewMode: "APPROVAL",
      reason: "RISK_REVIEW",
      riskClass: "R2",
      priority: "NORMAL",
      summary: `Trial request for person ${input.personId} requires human approval`,
      contextJson: {
        person_id: input.personId,
        duration_minutes: input.durationMinutes,
        reason_codes: evaluation.reasonCodes,
      },
      requestedByType: ctx.actor.actorType,
      requestedById: ctx.actor.userId,
    });
    await insertEligibilityDecision(ctx, {
      personId: input.personId,
      outcome: "REVIEW",
      policyVersion: versionRef,
      reasonCodes: evaluation.reasonCodes,
      evidenceJson: { review_request_id: stored.id },
    });
    await emitAndEnqueue(ctx, {
      eventType: "trial.eligibility_review_required.v1",
      aggregateType: "person",
      aggregateId: input.personId,
      data: { person_id: input.personId, review_request_id: stored.id },
    });
    return { ok: true, data: { id: null, status: "PENDING_REVIEW", reviewRequestId: stored.id } };
  }
  let trial;
  try {
    trial = await insertTrial(ctx, {
      personId: input.personId,
      leadId: input.leadId ?? null,
      trialKind: "TRIAL",
      requestedDurationMinutes: input.durationMinutes,
      adultContentEnabled: input.adultContentEnabled,
    });
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      return { ok: false, code: "precondition_failed", message: err.message };
    }
    throw err;
  }
  await insertTrialAttempt(ctx, { trialId: trial.id, attemptType: "REQUEST", outcome: "REQUESTED" });
  await insertEligibilityDecision(ctx, {
    personId: input.personId,
    outcome: "ALLOW",
    policyVersion: versionRef,
    reasonCodes: evaluation.reasonCodes,
    evidenceJson: { trial_id: trial.id, duration_minutes: input.durationMinutes },
  });
  await emitTrial(ctx, {
    eventType: "trial.eligibility_allowed.v1",
    trialId: trial.id,
    data: { person_id: input.personId, reason_codes: evaluation.reasonCodes },
  });
  await emitTrial(ctx, {
    eventType: "trial.requested.v1",
    trialId: trial.id,
    data: {
      person_id: input.personId,
      trial_kind: "TRIAL",
      duration_minutes: input.durationMinutes,
    },
  });
  return { ok: true, data: { id: trial.id, status: "REQUESTED" } };
}

async function handleRequestRetrial(
  ctx: CommandHandlerContext,
  input: RequestRetrialInput,
): Promise<CommandResult<{ id: string | null; status: string; reviewRequestId?: string }>> {
  const previous = await getTrial(ctx, input.previousTrialId);
  if (previous === null) {
    return { ok: false, code: "not_found", message: "previous trial not found in this tenant" };
  }
  if (!(TERMINAL_TRIAL_STATUSES as readonly string[]).includes(previous.lifecycleStatus)) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `previous trial is ${previous.lifecycleStatus}; retrial requires ENDED or INVALIDATED`,
    };
  }
  const personId = previous.personId;
  const { policy, versionRef } = await resolveEligibilityPolicy(ctx);
  if (!policy.durationsMinutes.includes(input.durationMinutes)) {
    return {
      ok: false,
      code: "validation_failed",
      message: `duration ${input.durationMinutes}min is not allowed by trial eligibility policy`,
    };
  }
  const open = await findOpenTrialForPerson(ctx, personId);
  if (open !== null) {
    await insertEligibilityDecision(ctx, {
      personId,
      outcome: "DENY",
      policyVersion: versionRef,
      previousTrialId: previous.id,
      reasonCodes: ["OPEN_TRIAL_EXISTS"],
      evidenceJson: { open_trial_id: open.id },
    });
    await emitTrial(ctx, {
      eventType: "trial.eligibility_denied.v1",
      trialId: open.id,
      data: { person_id: personId, reason_codes: ["OPEN_TRIAL_EXISTS"] },
    });
    return { ok: false, code: "precondition_failed", message: "an open trial already exists for this person" };
  }
  const hasPrimary = await hasPrimaryTrial(ctx, personId);
  let evaluation = evaluateEligibility(policy, {
    hasPrimary,
    hasOpen: false,
    isRetrial: true,
    previousStatus: previous.lifecycleStatus,
    durationMinutes: input.durationMinutes,
    adult: input.adultContentEnabled,
  });
  if (evaluation.outcome === "REVIEW" && input.approvedReviewId !== undefined) {
    const approved = await reviewApprovedByHuman(ctx, input.approvedReviewId);
    if (!approved) {
      return {
        ok: false,
        code: "precondition_failed",
        message: "review is not approved; cannot materialize the retrial",
      };
    }
    evaluation = { outcome: "ALLOW_RETRIAL", reasonCodes: ["HUMAN_APPROVED"] };
  }
  if (evaluation.outcome === "DENY") {
    await insertEligibilityDecision(ctx, {
      personId,
      outcome: "DENY",
      policyVersion: versionRef,
      previousTrialId: previous.id,
      reasonCodes: evaluation.reasonCodes,
      evidenceJson: {},
    });
    await emitTrial(ctx, {
      eventType: "trial.eligibility_denied.v1",
      trialId: previous.id,
      data: { person_id: personId, reason_codes: evaluation.reasonCodes },
    });
    return {
      ok: false,
      code: denialStatus(evaluation.reasonCodes),
      message: `retrial eligibility denied: ${evaluation.reasonCodes.join(",")}`,
    };
  }
  if (evaluation.outcome === "REVIEW") {
    const stored = await ctx.tx.createReviewRequest({
      resourceType: "trial_retrial",
      resourceId: previous.id,
      reviewMode: "APPROVAL",
      reason: "RISK_REVIEW",
      riskClass: "R2",
      priority: "NORMAL",
      summary: `Retrial after ${previous.lifecycleStatus} trial ${previous.id} requires human approval`,
      contextJson: {
        person_id: personId,
        previous_trial_id: previous.id,
        previous_status: previous.lifecycleStatus,
        retrial_reason: input.reason,
        duration_minutes: input.durationMinutes,
      },
      requestedByType: ctx.actor.actorType,
      requestedById: ctx.actor.userId,
    });
    await insertEligibilityDecision(ctx, {
      personId,
      outcome: "REVIEW",
      policyVersion: versionRef,
      previousTrialId: previous.id,
      reasonCodes: evaluation.reasonCodes,
      evidenceJson: { review_request_id: stored.id },
    });
    await emitTrial(ctx, {
      eventType: "trial.eligibility_review_required.v1",
      trialId: previous.id,
      data: { person_id: personId, review_request_id: stored.id },
    });
    return { ok: true, data: { id: null, status: "PENDING_REVIEW", reviewRequestId: stored.id } };
  }
  let trial;
  try {
    trial = await insertTrial(ctx, {
      personId,
      trialKind: "RETRIAL",
      previousTrialId: previous.id,
      retrialReason: input.reason,
      requestedDurationMinutes: input.durationMinutes,
      adultContentEnabled: input.adultContentEnabled,
    });
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      return { ok: false, code: "precondition_failed", message: err.message };
    }
    throw err;
  }
  await insertTrialAttempt(ctx, { trialId: trial.id, attemptType: "REQUEST", outcome: "REQUESTED" });
  await insertEligibilityDecision(ctx, {
    personId,
    outcome: "ALLOW_RETRIAL",
    policyVersion: versionRef,
    previousTrialId: previous.id,
    reasonCodes: evaluation.reasonCodes,
    evidenceJson: { trial_id: trial.id },
  });
  await emitTrial(ctx, {
    eventType: "trial.eligibility_allowed.v1",
    trialId: trial.id,
    data: { person_id: personId, reason_codes: evaluation.reasonCodes },
  });
  await emitTrial(ctx, {
    eventType: "trial.requested.v1",
    trialId: trial.id,
    data: { person_id: personId, trial_kind: "RETRIAL", previous_trial_id: previous.id },
  });
  await emitTrial(ctx, {
    eventType: "trial.retrial_allowed.v1",
    trialId: trial.id,
    data: { person_id: personId, previous_trial_id: previous.id, retrial_reason: input.reason },
  });
  return { ok: true, data: { id: trial.id, status: "REQUESTED" } };
}

export interface TrialCommandDeps {
  opsPort?: ProviderOpsPort;
  /**
   * PF-05: SecretsPort used ONLY to verify configuration for
   * secret-requiring (future BROWSER) adapters. Never `getSecret`.
   * Defaults to `resolveSecretsPort()` so echo/manual keep working.
   */
  secretsPort?: SecretsPort;
  /** Test seam: override the tenant-scoped `secret_ref` loader. */
  loadSecretRef?: (ctx: CommandHandlerContext, providerAccountId: string) => Promise<string | null>;
  /**
   * FASE5-S4S5: override the per-action trial capability key revalidated
   * before a real `trial.provision` dispatch. Defaults to
   * `TRIAL_CAPABILITY_KEY` (production). Test suites isolate their
   * AVAILABLE flips on a private row instead of the shared gate row.
   */
  trialCapabilityKey?: string;
  /**
   * FASE5-S4S5: override the designated disposable trial account. Defaults
   * to `PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID` (absent = no designation =
   * fail-closed for real writes). Test seam so suites never touch env.
   */
  trialDisposableAccountId?: string;
  /**
   * FASE5-S6 (SPEC §25): readback port for the REAL dispatch path. The
   * durable `ProviderDispatcherService` consults it post-commit (bounded
   * by `raceTrialReadback`) after a secret-required SUCCEEDED: an isolated
   * HTTP 200 never terminates. FASE5-S6-FIX2 (SPEC §41): the inline secret
   * handler no longer dispatches at all (it queues for the dispatcher),
   * so this seam is unread on the inline path — retained for API
   * compatibility. Defaults to `StubTrialReadback` (fail-closed
   * INCONCLUSIVE → VERIFYING); tests inject a fake. Synthetic echo/manual
   * flows never consult this port.
   */
  trialReadbackPort?: TrialReadbackPort;
}

/**
 * CV-DSP-02 shared secret-branch outcome applier for `trial.provision`: the
 * ONE source of truth for secret-required trial transitions
 * (SUCCEEDED/FAILED/UNKNOWN/MANUAL → ACTIVE/REQUESTED/PROVISIONING + safe
 * evidence + the registry-listed `trial.activated|provisioning_failed` +
 * `provider.operation_*` events). The durable `ProviderDispatcherService`
 * calls it (the inline handler queues for the dispatcher since
 * FASE5-S6-FIX2) — never duplicate these transitions.
 *
 * `raw` carries the port result; projection (`projectSecretPortResult`) and
 * the invalid-ref SUCCEEDED→UNKNOWN demotion happen here so both callers
 * share them. Never persists/emits raw `detail`/`externalRef`.
 *
 * `status` is the PROVIDER OPERATION status (what the dispatcher counts);
 * `trialStatus` is the trial lifecycle the caller should report. When the
 * trial row is missing or already left PROVISIONING (only possible for a
 * dispatcher-claimed row the inline handler did not create), the operation
 * still terminalizes but no trial move/event happens (`resumed=false`, no
 * throw) — the inline handler keeps its fail-closed `precondition_failed`
 * mapping on `!resumed`. CV-DSP-02-FIX F2: the FAILED branch honors the
 * same rule (before the fix it emitted `trial.provisioning_failed` and
 * reported `REQUESTED/resumed=true` even for a CANCELLED trial); an
 * unresumed FAILED reports the trial's actual lifecycle honestly.
 * CV-DSP-02-FIX F3: `provider.request_operation` with `trial.provision`
 * shares this applier (single source of truth) passing its explicit `via`;
 * the `trial.begin_provisioning` entry leaves `via` unset.
 */
export interface TrialProvisionOutcomeInput {
  operationId: string;
  trialId: string;
  raw: { outcome: string; detail: string; externalRef: string | null };
  /**
   * CV-DSP-02-FIX F3: explicit caller provenance for the shared domain
   * effect. The `trial.begin_provisioning` entry (inline + dispatcher)
   * leaves this unset; the `provider.request_operation` entry passes
   * `via: "provider.resolve"` so its long-standing rule survives as an
   * explicit parameter — never as a duplicated transition block.
   */
  via?: string;
  /**
   * FASE5-S6 (SPEC §25): the already-obtained READ_CUSTOMER readback for a
   * secret-required SUCCEEDED. The applier performs NO external I/O — the
   * durable dispatcher resolves the port post-commit (bounded, outside any
   * transaction) and passes the sanitized result here. Absent/inconclusive
   * → VERIFYING/UNKNOWN; conclusive but postcondition-violated →
   * HUMAN_REQUIRED/`POSTCONDITION_MISMATCH`; conclusive and satisfied →
   * SUCCEEDED + binding + ACTIVE. Synthetic echo/manual flows never reach
   * this applier.
   */
  trialReadback?: TrialReadbackResult | null;
}

export interface TrialProvisionOutcome {
  /** Provider operation status (SUCCEEDED | FAILED | VERIFYING | HUMAN_REQUIRED). */
  status: string;
  /** Trial lifecycle to report (ACTIVE | REQUESTED | PROVISIONING). */
  trialStatus: string;
  effectCertainty: string;
  resumed: boolean;
}

/**
 * CV-DSP-02 fencing for durable dispatch transitions. Same contract as the
 * provider applier (`SecretPortOutcomeFence`): with `fence` + a live Kysely
 * transaction the terminal status write becomes a conditional UPDATE
 * (`WHERE claimed_by=$token AND status IN ('QUEUED','RUNNING')`, lease
 * cleared atomically); zero affected rows → `null` BEFORE any
 * attempt/event/resume. Without `fence` (inline path) behavior is unchanged.
 * With `fence` on the memory path (no Kysely trx) it falls back to the
 * unfenced behavior.
 *
 * FASE5-FIX3-R4: `expectedStatus` carries the S3 reconcile CAS. When set,
 * the status predicate becomes `status = <expected>` (instead of the
 * QUEUED/RUNNING pair) and the `claimed_by` predicate applies only when
 * `claimedBy` is also set (reconcile owns no claim). On the memory path the
 * expected status is enforced by a pre-check (mismatch → `null` with zero
 * side effects) so the logical race test proves loser-silence on both
 * stores.
 */
export interface TrialProvisionFence {
  claimedBy?: string;
  expectedStatus?: string;
}

async function fencedTrialOutcomeUpdate(
  ctx: CommandHandlerContext,
  operationId: string,
  fence: TrialProvisionFence,
  patch: {
    status: string;
    effectCertainty: string;
    executionChannel: string;
    resultSummary: Record<string, unknown>;
    started: boolean;
    completed: boolean;
  },
): Promise<boolean> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    return true;
  }
  let query = trx
    .updateTable("provider.provider_operations")
    .set({
      status: patch.status,
      effect_certainty: patch.effectCertainty,
      execution_channel: patch.executionChannel,
      result_summary_json: patch.resultSummary,
      ...(patch.started ? { started_at: new Date() } : {}),
      ...(patch.completed ? { completed_at: new Date() } : {}),
      claimed_by: null,
      claimed_at: null,
      lease_expires_at: null,
    })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", operationId);
  if (fence.claimedBy !== undefined) {
    query = query.where("claimed_by", "=", fence.claimedBy);
  }
  query =
    fence.expectedStatus !== undefined
      ? query.where("status", "=", fence.expectedStatus)
      : query.where("status", "in", ["QUEUED", "RUNNING"]);
  const updated = await query.executeTakeFirst();
  return Number(updated.numUpdatedRows ?? 0) >= 1;
}

/**
 * FASE5-S6 (§31): sanitized structured evidence for the readback gate.
 * Fixed codes/booleans/ids/timestamps only — the port's free-form
 * `evidence` string is deliberately dropped at the boundary (mirroring
 * the reconcile rule), so bearer/cookie/PII/raw payloads can never reach
 * persistence through this writer. The satisfied branch additionally
 * carries the binding external id (a non-sensitive stable id per §31,
 * required to correlate the binding).
 */
function sanitizedTrialReadbackEvidence(
  readback: TrialReadbackResult | null | undefined,
  verdict: TrialPostconditionVerdict,
): Record<string, unknown> {
  const customer = readback?.customer ?? null;
  const parsedExpiresAt = customer === null ? null : parseTrialExpiresAt(customer.expiresAt);
  const evidence: Record<string, unknown> = {
    readback: readback === null || readback === undefined ? "absent" : readback.conclusive === true ? "conclusive" : "inconclusive",
    postcondition: verdict.ok ? "satisfied" : verdict.reason,
    external_id_present: customer !== null && normalizeTrialExternalId(customer.externalId) !== null,
    is_trial_normalized: customer === null ? null : normalizeTrialIsTrial(customer.isTrial),
    expires_at: parsedExpiresAt === null ? null : parsedExpiresAt.toISOString(),
  };
  if (verdict.ok) {
    evidence["external_id"] = verdict.normalized.externalId;
  }
  return evidence;
}

/**
 * FASE5-S6 (§30): idempotent trial binding record. Upserts the stable
 * `provider_bindings` row and points `trial.provider_binding_id` at it so
 * the provisioned trial stays correlated to the provider customer without
 * depending on username/email/phone search. Replays reuse the existing
 * row (upsert, never a duplicate).
 */
async function recordTrialProvisionBinding(
  ctx: CommandHandlerContext,
  operationId: string,
  trialId: string,
  externalId: string,
): Promise<void> {
  const operation = await getProviderOperation(ctx, operationId);
  if (operation === null) {
    throw new Error("trial outcome applier lost its operation row");
  }
  const binding = await upsertTrialBinding(ctx, {
    providerAccountId: operation.providerAccountId,
    trialId,
    externalId,
  });
  await updateTrial(ctx, trialId, { providerBindingId: binding.id });
}

export async function applyTrialProvisionOutcome(
  ctx: CommandHandlerContext,
  input: TrialProvisionOutcomeInput,
  fence?: TrialProvisionFence,
): Promise<TrialProvisionOutcome | null> {
  // FASE5-FIX3-R4 (S3 CAS): when the caller carries an expected status
  // (reconcile convergence), enforce it BEFORE any write on both stores —
  // mismatch means a concurrent resolution already moved the row, so the
  // loser exits silently with zero attempts/events. (On Kysely the fenced
  // writes below re-enforce it in the UPDATE's WHERE as well.)
  if (fence?.expectedStatus !== undefined) {
    const current = await getProviderOperation(ctx, input.operationId);
    if (current === null || current.status !== fence.expectedStatus) {
      return null;
    }
  }
  const trial = await getTrial(ctx, input.trialId);
  const projected = projectSecretPortResult(input.raw);
  const effectiveOutcome =
    projected.externalRefInvalid && projected.outcome === "SUCCEEDED" ? "UNKNOWN" : projected.outcome;
  if (effectiveOutcome === "SUCCEEDED") {
    // FASE5-S6 (SPEC §25): an isolated HTTP 200 never terminates the
    // operation. The SUCCEEDED port result must still pass the READ_CUSTOMER
    // readback gate (already resolved by the caller, outside any
    // transaction) before the operation may terminalize.
    const verdict = evaluateTrialProvisionPostconditions(input.trialReadback ?? null, {
      minFutureMs: trialReadbackMinFutureMsFromEnv(),
    });
    if (!verdict.ok && !isTrialPostconditionMismatch(verdict.reason)) {
      // Absent/inconclusive readback ("no proof either way") → the same
      // VERIFYING/UNKNOWN park as an UNKNOWN port outcome. The S3
      // reconcile convergence owns what follows; the POST is never
      // re-sent. No readback evidence is recorded without proof.
      if (fence !== undefined && kyselyTrxOf(ctx) !== null) {
        const claimed = await fencedTrialOutcomeUpdate(ctx, input.operationId, fence, {
          status: "VERIFYING",
          effectCertainty: "UNKNOWN",
          executionChannel: "MANUAL",
          resultSummary: {},
          started: true,
          completed: false,
        });
        if (!claimed) {
          return null;
        }
        await insertProviderAttempt(ctx, { operationId: input.operationId, status: "VERIFYING", errorCode: "EFFECT_UNKNOWN" });
        return { status: "VERIFYING", trialStatus: "PROVISIONING", effectCertainty: "UNKNOWN", resumed: false };
      }
      await updateProviderOperation(ctx, input.operationId, {
        status: "VERIFYING",
        effectCertainty: "UNKNOWN",
        executionChannel: "MANUAL",
        resultSummary: {},
        started: true,
      });
      await insertProviderAttempt(ctx, { operationId: input.operationId, status: "VERIFYING", errorCode: "EFFECT_UNKNOWN" });
      return { status: "VERIFYING", trialStatus: "PROVISIONING", effectCertainty: "UNKNOWN", resumed: false };
    }
    if (!verdict.ok) {
      // Conclusive readback with a violated postcondition (§18): park
      // HUMAN_REQUIRED with the fixed `POSTCONDITION_MISMATCH` class and
      // sanitized evidence — never SUCCEEDED, never ACTIVE, never a
      // re-send. The trial stays PROVISIONING for the operator.
      const mismatchSummary = {
        error_code: TRIAL_POSTCONDITION_MISMATCH_CODE,
        postcondition: verdict.reason,
        readback: "conclusive" as const,
      };
      if (fence !== undefined && kyselyTrxOf(ctx) !== null) {
        const claimed = await fencedTrialOutcomeUpdate(ctx, input.operationId, fence, {
          status: "HUMAN_REQUIRED",
          effectCertainty: "UNKNOWN",
          executionChannel: "MANUAL",
          resultSummary: mismatchSummary,
          started: true,
          completed: false,
        });
        if (!claimed) {
          return null;
        }
        await insertProviderAttempt(ctx, {
          operationId: input.operationId,
          status: "HUMAN_REQUIRED",
          errorCode: TRIAL_POSTCONDITION_MISMATCH_CODE,
        });
        await insertTrialProviderEvidence(ctx, {
          operationId: input.operationId,
          evidenceType: TRIAL_READBACK_EVIDENCE_TYPE,
          objectRef: `trial:${input.trialId}`,
          structured: sanitizedTrialReadbackEvidence(input.trialReadback ?? null, verdict),
        });
        return { status: "HUMAN_REQUIRED", trialStatus: "PROVISIONING", effectCertainty: "UNKNOWN", resumed: false };
      }
      await updateProviderOperation(ctx, input.operationId, {
        status: "HUMAN_REQUIRED",
        effectCertainty: "UNKNOWN",
        executionChannel: "MANUAL",
        resultSummary: mismatchSummary,
        started: true,
      });
      await insertProviderAttempt(ctx, {
        operationId: input.operationId,
        status: "HUMAN_REQUIRED",
        errorCode: TRIAL_POSTCONDITION_MISMATCH_CODE,
      });
      await insertTrialProviderEvidence(ctx, {
        operationId: input.operationId,
        evidenceType: TRIAL_READBACK_EVIDENCE_TYPE,
        objectRef: `trial:${input.trialId}`,
        structured: sanitizedTrialReadbackEvidence(input.trialReadback ?? null, verdict),
      });
      return { status: "HUMAN_REQUIRED", trialStatus: "PROVISIONING", effectCertainty: "UNKNOWN", resumed: false };
    }
    // Satisfied postconditions: the ONLY path to SUCCEEDED/KNOWN_APPLIED
    // on the real dispatch. Records the stable provider binding (§30) and
    // sanitized evidence (§31) before activating the trial.
    const bindingExternalId = verdict.normalized.externalId;
    if (fence !== undefined && kyselyTrxOf(ctx) !== null) {
      const claimed = await fencedTrialOutcomeUpdate(ctx, input.operationId, fence, {
        status: "SUCCEEDED",
        effectCertainty: "KNOWN_APPLIED",
        executionChannel: "MANUAL",
        resultSummary: { external_ref: bindingExternalId, readback: "conclusive", postcondition: "satisfied" },
        started: true,
        completed: true,
      });
      if (!claimed) {
        return null;
      }
      await insertProviderAttempt(ctx, { operationId: input.operationId, status: "SUCCEEDED" });
      await emitProvider(ctx, {
        eventType: "provider.operation_succeeded.v1",
        operationId: input.operationId,
        data: { action: "trial.provision", entity_id: input.trialId },
      });
      if (trial === null) {
        return { status: "SUCCEEDED", trialStatus: "PROVISIONING", effectCertainty: "KNOWN_APPLIED", resumed: false };
      }
      const { resumed, trial: updated } = await applyProviderTerminalOutcome(ctx, input.trialId, "SUCCEEDED", verdict.normalized.expiresAt);
      if (!resumed || updated === null) {
        return { status: "SUCCEEDED", trialStatus: "PROVISIONING", effectCertainty: "KNOWN_APPLIED", resumed: false };
      }
      await recordTrialProvisionBinding(ctx, input.operationId, input.trialId, bindingExternalId);
      await insertTrialProviderEvidence(ctx, {
        operationId: input.operationId,
        evidenceType: TRIAL_READBACK_EVIDENCE_TYPE,
        objectRef: `trial:${input.trialId}`,
        structured: sanitizedTrialReadbackEvidence(input.trialReadback ?? null, verdict),
      });
      await emitTrial(ctx, {
        eventType: "trial.activated.v1",
        trialId: input.trialId,
        data: {
          person_id: updated.personId,
          operation_id: input.operationId,
          duration_minutes: updated.requestedDurationMinutes,
          ...(input.via !== undefined ? { via: input.via } : {}),
        },
      });
      return { status: "SUCCEEDED", trialStatus: "ACTIVE", effectCertainty: "KNOWN_APPLIED", resumed: true };
    }
    await updateProviderOperation(ctx, input.operationId, {
      status: "SUCCEEDED",
      effectCertainty: "KNOWN_APPLIED",
      executionChannel: "MANUAL",
      resultSummary: { external_ref: bindingExternalId, readback: "conclusive", postcondition: "satisfied" },
      started: true,
      completed: true,
    });
    await insertProviderAttempt(ctx, { operationId: input.operationId, status: "SUCCEEDED" });
    await emitProvider(ctx, {
      eventType: "provider.operation_succeeded.v1",
      operationId: input.operationId,
      data: { action: "trial.provision", entity_id: input.trialId },
    });
    if (trial === null) {
      return { status: "SUCCEEDED", trialStatus: "PROVISIONING", effectCertainty: "KNOWN_APPLIED", resumed: false };
    }
    const { resumed, trial: updated } = await applyProviderTerminalOutcome(ctx, input.trialId, "SUCCEEDED", verdict.normalized.expiresAt);
    if (!resumed || updated === null) {
      return { status: "SUCCEEDED", trialStatus: "PROVISIONING", effectCertainty: "KNOWN_APPLIED", resumed: false };
    }
    await recordTrialProvisionBinding(ctx, input.operationId, input.trialId, bindingExternalId);
    await insertTrialProviderEvidence(ctx, {
      operationId: input.operationId,
      evidenceType: TRIAL_READBACK_EVIDENCE_TYPE,
      objectRef: `trial:${input.trialId}`,
      structured: sanitizedTrialReadbackEvidence(input.trialReadback ?? null, verdict),
    });
    await emitTrial(ctx, {
      eventType: "trial.activated.v1",
      trialId: input.trialId,
      data: {
        person_id: updated.personId,
        operation_id: input.operationId,
        duration_minutes: updated.requestedDurationMinutes,
        ...(input.via !== undefined ? { via: input.via } : {}),
      },
    });
    return { status: "SUCCEEDED", trialStatus: "ACTIVE", effectCertainty: "KNOWN_APPLIED", resumed: true };
  }
  if (effectiveOutcome === "FAILED") {
    if (fence !== undefined && kyselyTrxOf(ctx) !== null) {
      const claimed = await fencedTrialOutcomeUpdate(ctx, input.operationId, fence, {
        status: "FAILED",
        effectCertainty: "KNOWN_NOT_APPLIED",
        executionChannel: "MANUAL",
        resultSummary: { error_code: "PROVISION_FAILED" },
        started: true,
        completed: true,
      });
      if (!claimed) {
        return null;
      }
      await insertProviderAttempt(ctx, { operationId: input.operationId, status: "FAILED", errorCode: "PROVISION_FAILED" });
      await emitProvider(ctx, {
        eventType: "provider.operation_failed.v1",
        operationId: input.operationId,
        data: { action: "trial.provision", entity_id: input.trialId },
      });
      // CV-DSP-02-FIX F2: the transition return drives the event and the
      // result. No transition (trial missing or already left PROVISIONING,
      // e.g. CANCELLED) → no event, honest `trialStatus`/`resumed`.
      if (trial !== null) {
        const { resumed } = await applyProviderTerminalOutcome(ctx, input.trialId, "FAILED");
        if (resumed) {
          await emitTrial(ctx, {
            eventType: "trial.provisioning_failed.v1",
            trialId: input.trialId,
            data: {
              person_id: trial.personId,
              operation_id: input.operationId,
              ...(input.via !== undefined ? { via: input.via } : {}),
            },
          });
          return { status: "FAILED", trialStatus: "REQUESTED", effectCertainty: "KNOWN_NOT_APPLIED", resumed: true };
        }
        return {
          status: "FAILED",
          trialStatus: trial.lifecycleStatus,
          effectCertainty: "KNOWN_NOT_APPLIED",
          resumed: false,
        };
      }
      return { status: "FAILED", trialStatus: "PROVISIONING", effectCertainty: "KNOWN_NOT_APPLIED", resumed: false };
    }
    await updateProviderOperation(ctx, input.operationId, {
      status: "FAILED",
      effectCertainty: "KNOWN_NOT_APPLIED",
      executionChannel: "MANUAL",
      resultSummary: { error_code: "PROVISION_FAILED" },
      started: true,
      completed: true,
    });
    await insertProviderAttempt(ctx, { operationId: input.operationId, status: "FAILED", errorCode: "PROVISION_FAILED" });
    await emitProvider(ctx, {
      eventType: "provider.operation_failed.v1",
      operationId: input.operationId,
      data: { action: "trial.provision", entity_id: input.trialId },
    });
    // CV-DSP-02-FIX F2: same honesty rule on the unfenced (inline/memory) path.
    if (trial !== null) {
      const { resumed } = await applyProviderTerminalOutcome(ctx, input.trialId, "FAILED");
      if (resumed) {
        await emitTrial(ctx, {
          eventType: "trial.provisioning_failed.v1",
          trialId: input.trialId,
          data: {
            person_id: trial.personId,
            operation_id: input.operationId,
            ...(input.via !== undefined ? { via: input.via } : {}),
          },
        });
        return { status: "FAILED", trialStatus: "REQUESTED", effectCertainty: "KNOWN_NOT_APPLIED", resumed: true };
      }
      return {
        status: "FAILED",
        trialStatus: trial.lifecycleStatus,
        effectCertainty: "KNOWN_NOT_APPLIED",
        resumed: false,
      };
    }
    return { status: "FAILED", trialStatus: "PROVISIONING", effectCertainty: "KNOWN_NOT_APPLIED", resumed: false };
  }
  if (effectiveOutcome === "UNKNOWN") {
    if (fence !== undefined && kyselyTrxOf(ctx) !== null) {
      const claimed = await fencedTrialOutcomeUpdate(ctx, input.operationId, fence, {
        status: "VERIFYING",
        effectCertainty: "UNKNOWN",
        executionChannel: "MANUAL",
        resultSummary: {},
        started: true,
        completed: false,
      });
      if (!claimed) {
        return null;
      }
      await insertProviderAttempt(ctx, { operationId: input.operationId, status: "VERIFYING", errorCode: "EFFECT_UNKNOWN" });
      return { status: "VERIFYING", trialStatus: "PROVISIONING", effectCertainty: "UNKNOWN", resumed: false };
    }
    await updateProviderOperation(ctx, input.operationId, {
      status: "VERIFYING",
      effectCertainty: "UNKNOWN",
      executionChannel: "MANUAL",
      resultSummary: {},
      started: true,
    });
    await insertProviderAttempt(ctx, { operationId: input.operationId, status: "VERIFYING", errorCode: "EFFECT_UNKNOWN" });
    return { status: "VERIFYING", trialStatus: "PROVISIONING", effectCertainty: "UNKNOWN", resumed: false };
  }
  if (fence !== undefined && kyselyTrxOf(ctx) !== null) {
    const claimed = await fencedTrialOutcomeUpdate(ctx, input.operationId, fence, {
      status: "HUMAN_REQUIRED",
      effectCertainty: "UNKNOWN",
      executionChannel: "MANUAL",
      resultSummary: {},
      started: true,
      completed: false,
    });
    if (!claimed) {
      return null;
    }
    await insertProviderAttempt(ctx, { operationId: input.operationId, status: "HUMAN_REQUIRED" });
    return { status: "HUMAN_REQUIRED", trialStatus: "PROVISIONING", effectCertainty: "UNKNOWN", resumed: false };
  }
  await updateProviderOperation(ctx, input.operationId, {
    status: "HUMAN_REQUIRED",
    effectCertainty: "UNKNOWN",
    executionChannel: "MANUAL",
    resultSummary: {},
    started: true,
  });
  await insertProviderAttempt(ctx, { operationId: input.operationId, status: "HUMAN_REQUIRED" });
  return { status: "HUMAN_REQUIRED", trialStatus: "PROVISIONING", effectCertainty: "UNKNOWN", resumed: false };
}

/**
 * Secret-required `trial.begin_provisioning` path: lookup-only account
 * resolution (no placeholder creation before the gate), fail-closed secret
 * gate, then the same provisioning flow with safe port-result projection
 * (no raw detail/externalRef persisted or emitted; invalid ref demotes
 * SUCCEEDED to VERIFYING).
 */
async function handleSecretBeginProvisioning(
  ctx: CommandHandlerContext,
  input: BeginProvisioningInput,
  deps: TrialCommandDeps,
  resolved: {
    trial: { id: string; personId: string; requestedDurationMinutes: number; adultContentEnabled: boolean; trialKind: string };
    port: ProviderOpsPort;
    capabilityNote: string;
    effectiveAdapter: string;
  },
): Promise<CommandResult<{ id: string; status: string; operationId: string; effectUncertain: boolean }>> {
  const { trial, capabilityNote, effectiveAdapter } = resolved;
  const existingAccountId = await findExistingTrialProviderAccountId(ctx);
  if (existingAccountId === null) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "browser operations require a configured provider secret (secret_ref is missing)",
    };
  }
  // FASE5-S4S5: per-action trial gate — the real dispatch additionally
  // requires the `provider.cinevision.trial` row AVAILABLE (a flipped GLOBAL
  // row alone never releases trial writes) plus an explicit disposable
  // designation naming exactly this account. No designation, another
  // account, or an inactive account fails closed BEFORE any secret check,
  // insert, trial move, or port call. Synthetic echo/manual never reach
  // this branch.
  const trialGate = decideTrialDispatchGate({
    action: "trial.provision",
    trialCapability: await ctx.tx.getCapability(deps.trialCapabilityKey ?? TRIAL_CAPABILITY_KEY),
    designatedAccountId: deps.trialDisposableAccountId ?? trialDisposableAccountIdFromEnv(),
    providerAccountId: existingAccountId,
  });
  if (trialGate !== "allow") {
    return { ok: false, code: "precondition_failed", message: TRIAL_GATE_MESSAGES[trialGate] };
  }
  if (!(await isProviderAccountActive(ctx, existingAccountId))) {
    return { ok: false, code: "precondition_failed", message: TRIAL_GATE_MESSAGES.account_inactive };
  }
  const loader = deps.loadSecretRef ?? getProviderAccountSecretRef;
  const secretRef = await loader(ctx, existingAccountId);
  const gate = assertBrowserSecretReady({
    secretRef,
    secretsPort: deps.secretsPort ?? resolveSecretsPort(),
  });
  if (!gate.ok) {
    return { ok: false, code: "precondition_failed", message: gate.message };
  }
  const accountId = existingAccountId;
  const prepared = await prepareTrialProvisionIntent(
    ctx,
    trial,
    {
      providerAccountId: accountId,
      // Branch-derived provenance: reserved constant, never `${port.name}-v1`.
      adapterVersion: SECRET_REQUIRED_ADAPTER_VERSION,
      requestedPayload: {
        duration_minutes: trial.requestedDurationMinutes,
        adult_content_enabled: trial.adultContentEnabled,
        trial_kind: trial.trialKind,
        adapter: effectiveAdapter,
        capability: capabilityNote,
      },
      effectiveAdapter,
      capabilityNote,
    },
  );
  if (!prepared.ok) {
    return { ok: false, code: "precondition_failed", message: prepared.message };
  }
  const operation = prepared.operation;
  // CV-DSP-02 durable cut (same point as the provider cut): the REQUESTED
  // row + `operation_requested` event (+ the PROVISIONING move above) are
  // the committed intent. FASE5-S6-FIX2 (SPEC §41): the secret-required
  // `trial.provision` NEVER executes inline — the external port call and
  // the READ_CUSTOMER readback move to `ProviderDispatcherService.drainOnce`
  // (claim with lease → RUNNING + `dispatch_started_at` frontier → bounded
  // port call → bounded readback → outcome via `applyTrialProvisionOutcome`),
  // all post-commit with no open transaction. The former inline
  // port/readback call lived inside the command transaction (command-bus
  // `withTransaction`), violating the reviewer invariant; the durable
  // dispatcher is the single certified path. Synthetic echo/manual flows
  // keep their inline dev-convenience behavior untouched below.
  return { ok: true, data: { id: trial.id, status: "PROVISIONING", operationId: operation.id, effectUncertain: true } };
}

function handleBeginProvisioningFactory(deps: TrialCommandDeps) {
  return async (
    ctx: CommandHandlerContext,
    input: BeginProvisioningInput,
  ): Promise<CommandResult<{ id: string; status: string; operationId: string; effectUncertain: boolean }>> => {
    // SPEC §25: single pre-dispatch gate (lifecycle + open operation +
    // persisted ALLOW) shared with the `provider.request_operation`
    // trial.provision entry — before any operation row or port call.
    const pre = await assertTrialProvisionPreconditions(ctx, input.trialId);
    if (!pre.ok) {
      return pre;
    }
    const trial = pre.trial;
    const fallback: "echo" | "manual" =
      deps.opsPort !== undefined
        ? deps.opsPort.name === "echo"
          ? "echo"
          : "manual"
        : adapterNameFromEnv();
    // A per-call adapter overrides the injected/env default (test seam and
    // per-case operator choice); the capability gate still applies.
    const requested: "echo" | "manual" = input.adapter ?? fallback;
    const capability = await ctx.tx.getCapability("provider.cinevision");
    const { name: adapterName, note: capabilityNote } = applyCapabilityGate(requested, capability);
    // PF-05: an injected secret-requiring (future BROWSER) port bypasses the
    // echo/manual selection so the gate below always runs for it.
    const injectedSecretPort =
      deps.opsPort !== undefined && isSecretRequiringPort(deps.opsPort) ? deps.opsPort : null;
    const port =
      injectedSecretPort ??
      (deps.opsPort !== undefined && (deps.opsPort.name === "echo") === (adapterName === "echo")
        ? deps.opsPort
        : resolveOpsPort(adapterName));
    const secretRequired = isSecretRequiringPort(port);
    // Capability UNAVAILABLE wins over injection: no account creation, no
    // operation, no trial move, no port call.
    if (secretRequired && isCapabilityUnavailable(capability)) {
      return {
        ok: false,
        code: "precondition_failed",
        message: "provider capability unavailable; secret-required operations are blocked",
      };
    }
    if (secretRequired) {
      return handleSecretBeginProvisioning(ctx, input, deps, {
        trial,
        port,
        capabilityNote,
        effectiveAdapter: port.name,
      });
    }
    const account = await ensureTrialProviderAccount(ctx);
    const effectiveAdapter = injectedSecretPort !== null ? port.name : adapterName;
    // SPEC §26: same stable business key as the secret branch — parity for
    // the same intent; eligible retries reopen the row, races get 409.
    // (FASE5-FIX3-R1+R2: via the shared `prepareTrialProvisionIntent`, so
    // the synthetic entry moves the trial to PROVISIONING exactly like the
    // secret branch instead of leaving it REQUESTED.)
    const echoPrepared = await prepareTrialProvisionIntent(
      ctx,
      trial,
      {
        providerAccountId: account.id,
        adapterVersion: `${port.name}-v1`,
        requestedPayload: {
          duration_minutes: trial.requestedDurationMinutes,
          adult_content_enabled: trial.adultContentEnabled,
          trial_kind: trial.trialKind,
          adapter: effectiveAdapter,
          capability: capabilityNote,
          ...(input.echoOutcome !== undefined ? { __echo_outcome: input.echoOutcome } : {}),
        },
        effectiveAdapter,
        capabilityNote,
      },
    );
    if (!echoPrepared.ok) {
      return { ok: false, code: "precondition_failed", message: echoPrepared.message };
    }
    const operation = echoPrepared.operation;
    const result = await port.requestOperation({
      tenantId: ctx.tenantId,
      providerAccountId: account.id,
      action: "trial.provision",
      entityType: "trial",
      entityId: trial.id,
      idempotencyKey: trialProvisionBusinessKey(trial.id),
      payload: {
        duration_minutes: trial.requestedDurationMinutes,
        adult_content_enabled: trial.adultContentEnabled,
        ...(input.echoOutcome !== undefined ? { __echo_outcome: input.echoOutcome } : {}),
      },
      correlationId: ctx.correlationId,
    });
    if (result.outcome === "SUCCEEDED") {
      await updateProviderOperation(ctx, operation.id, {
        status: "SUCCEEDED",
        effectCertainty: "KNOWN_APPLIED",
        executionChannel: "MANUAL",
        resultSummary: { detail: result.detail, external_ref: result.externalRef },
        started: true,
        completed: true,
      });
      await insertProviderAttempt(ctx, { operationId: operation.id, status: "SUCCEEDED" });
      await emitProvider(ctx, {
        eventType: "provider.operation_succeeded.v1",
        operationId: operation.id,
        data: { action: "trial.provision", entity_id: trial.id },
      });
      const { resumed } = await applyProviderTerminalOutcome(ctx, trial.id, "SUCCEEDED");
      if (!resumed) {
        return { ok: false, code: "precondition_failed", message: "trial left PROVISIONING concurrently" };
      }
      await emitTrial(ctx, {
        eventType: "trial.activated.v1",
        trialId: trial.id,
        data: { person_id: trial.personId, operation_id: operation.id, duration_minutes: trial.requestedDurationMinutes },
      });
      return { ok: true, data: { id: trial.id, status: "ACTIVE", operationId: operation.id, effectUncertain: false } };
    }
    if (result.outcome === "FAILED") {
      await updateProviderOperation(ctx, operation.id, {
        status: "FAILED",
        effectCertainty: "KNOWN_NOT_APPLIED",
        executionChannel: "MANUAL",
        resultSummary: { detail: result.detail },
        started: true,
        completed: true,
      });
      await insertProviderAttempt(ctx, { operationId: operation.id, status: "FAILED", errorCode: "PROVISION_FAILED" });
      await emitProvider(ctx, {
        eventType: "provider.operation_failed.v1",
        operationId: operation.id,
        data: { action: "trial.provision", entity_id: trial.id, detail: result.detail },
      });
      // Nothing was applied: the trial returns to REQUESTED so provisioning
      // can be retried; the failure is recorded on the provider attempt.
      await applyProviderTerminalOutcome(ctx, trial.id, "FAILED");
      await emitTrial(ctx, {
        eventType: "trial.provisioning_failed.v1",
        trialId: trial.id,
        data: { person_id: trial.personId, operation_id: operation.id, detail: result.detail },
      });
      return { ok: true, data: { id: trial.id, status: "REQUESTED", operationId: operation.id, effectUncertain: false } };
    }
    if (result.outcome === "UNKNOWN") {
      await updateProviderOperation(ctx, operation.id, {
        status: "VERIFYING",
        effectCertainty: "UNKNOWN",
        executionChannel: "MANUAL",
        resultSummary: { detail: result.detail },
        started: true,
      });
      await insertProviderAttempt(ctx, { operationId: operation.id, status: "VERIFYING", errorCode: "EFFECT_UNKNOWN" });
      return { ok: true, data: { id: trial.id, status: "PROVISIONING", operationId: operation.id, effectUncertain: true } };
    }
    await updateProviderOperation(ctx, operation.id, {
      status: "HUMAN_REQUIRED",
      effectCertainty: "UNKNOWN",
      executionChannel: "MANUAL",
      resultSummary: { detail: result.detail },
      started: true,
    });
    await insertProviderAttempt(ctx, { operationId: operation.id, status: "HUMAN_REQUIRED" });
    return { ok: true, data: { id: trial.id, status: "PROVISIONING", operationId: operation.id, effectUncertain: true } };
  };
}

async function handleRecordTechnicalResult(
  ctx: CommandHandlerContext,
  input: RecordTechnicalResultInput,
): Promise<CommandResult<{ id: string; summaryOutcome: string }>> {
  const trial = await getTrial(ctx, input.trialId);
  if (trial === null) {
    return { ok: false, code: "not_found", message: "trial not found in this tenant" };
  }
  if (trial.lifecycleStatus !== "ACTIVE") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `trial is ${trial.lifecycleStatus}; technical results are recorded on ACTIVE trials`,
    };
  }
  const existing = await getTechnicalResult(ctx, trial.id);
  if (existing !== null) {
    return { ok: false, code: "precondition_failed", message: "a technical result is already recorded for this trial" };
  }
  let stored;
  try {
    stored = await insertTechnicalResult(ctx, {
      trialId: trial.id,
      installationSuccess: input.installationSuccess,
      authenticationSuccess: input.authenticationSuccess,
      playbackSuccess: input.playbackSuccess,
      bufferingObserved: input.bufferingObserved,
      summaryOutcome: input.summaryOutcome,
    });
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      return { ok: false, code: "precondition_failed", message: err.message };
    }
    throw err;
  }
  // The assessment mirrors onto the trial row; the lifecycle is untouched.
  await updateTrial(ctx, trial.id, { technicalOutcome: input.summaryOutcome });
  const eventType =
    input.summaryOutcome === "PASSED"
      ? "trial.technical_passed.v1"
      : input.summaryOutcome === "FAILED"
        ? "trial.technical_failed.v1"
        : "trial.technical_inconclusive.v1";
  await emitTrial(ctx, {
    eventType,
    trialId: trial.id,
    data: { person_id: trial.personId, summary_outcome: input.summaryOutcome },
  });
  return { ok: true, data: { id: stored.id, summaryOutcome: input.summaryOutcome } };
}

async function handleEnd(
  ctx: CommandHandlerContext,
  input: TrialIdInput,
): Promise<CommandResult<{ id: string; status: string; event: string }>> {
  const trial = await getTrial(ctx, input.trialId);
  if (trial === null) {
    return { ok: false, code: "not_found", message: "trial not found in this tenant" };
  }
  if (trial.lifecycleStatus !== "ACTIVE") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `trial is ${trial.lifecycleStatus}; only ACTIVE trials end`,
    };
  }
  if (!isTrialTransition("ACTIVE", "ENDED")) {
    return { ok: false, code: "precondition_failed", message: "invalid trial transition: ACTIVE -> ENDED" };
  }
  const at = new Date();
  // Ended-after-expiry is expiry; an early operator end keeps status ENDED
  // (access is over either way) and is recorded as a cancellation event.
  const due = trial.expiresAt === null || at.getTime() >= trial.expiresAt.getTime();
  const eventType = due ? "trial.expired.v1" : "trial.cancelled.v1";
  await updateTrial(ctx, trial.id, { lifecycleStatus: "ENDED", endedAt: at });
  await insertTrialAttempt(ctx, { trialId: trial.id, attemptType: "END", outcome: "ENDED" });
  await emitTrial(ctx, {
    eventType,
    trialId: trial.id,
    data: { person_id: trial.personId, ended_by: ctx.actor.actorType },
  });
  return { ok: true, data: { id: trial.id, status: "ENDED", event: eventType } };
}

/**
 * PF-05 (MVP-PF05-SECRETREF-03/05): pure-manual provenance check for
 * `trial.cancel` auto-cancel. True only for the EXACT pair written
 * internally by the manual branch — adapter `manual` TOGETHER WITH
 * `adapter_version` `manual-v1` (case-insensitive) — which never touches an
 * external effect, so marking it CANCELLED/KNOWN_NOT_APPLIED cannot lie.
 * Everything else is ambiguous and returns false (no auto-cancel):
 * null/blank/missing version, legacy or mismatched versions, prefix/suffix
 * spoofs (`manual-v2`, `manual-v1-extra`), the reserved `secret-required-v1`
 * version, or any non-manual adapter. Secret-required (`browser`/flagged)
 * or otherwise real operations that already called their port keep
 * UNKNOWN/HUMAN_REQUIRED after a trial cancel: the reservation/state stays
 * without automatic conclusion and only explicit reconcile may resolve it.
 */
function isPureManualOperation(input: {
  requestedPayload: Record<string, unknown> | null;
  adapterVersion: string | null;
}): boolean {
  const version = input.adapterVersion;
  // Branch-derived provenance wins over the port name: a secret-required
  // operation keeps the reserved version even when its port is named
  // `manual`, and must never auto-conclude.
  if (typeof version === "string" && version.toLowerCase() === SECRET_REQUIRED_ADAPTER_VERSION.toLowerCase()) {
    return false;
  }
  const adapter = input.requestedPayload?.["adapter"];
  if (typeof adapter !== "string" || adapter.toLowerCase() !== "manual") {
    return false;
  }
  return typeof version === "string" && version.toLowerCase() === "manual-v1";
}

async function handleCancel(
  ctx: CommandHandlerContext,
  input: CancelTrialInput,
): Promise<CommandResult<{ id: string; status: string; cancelledOperations: string[] }>> {
  const trial = await getTrial(ctx, input.trialId);
  if (trial === null) {
    return { ok: false, code: "not_found", message: "trial not found in this tenant" };
  }
  if (trial.lifecycleStatus !== "REQUESTED" && trial.lifecycleStatus !== "PROVISIONING") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `trial is ${trial.lifecycleStatus}; only REQUESTED/PROVISIONING trials cancel`,
    };
  }
  // Auto-cancel only operations that provably never executed. Anything that
  // may have touched the provider (RUNNING/VERIFYING/RETRY_WAIT, or any
  // non-pure-manual operation whose port may have run) stays for explicit
  // reconcile — cancelling it as KNOWN_NOT_APPLIED would lie. In
  // particular a secret-required HUMAN_REQUIRED parked AFTER its port call
  // keeps UNKNOWN/HUMAN_REQUIRED with no automatic conclusion.
  const latestOp = await latestProviderOperationForEntity(ctx, "trial", trial.id);
  const cancelledOperations: string[] = [];
  if (
    latestOp !== null &&
    ["REQUESTED", "QUEUED", "HUMAN_REQUIRED"].includes(latestOp.status) &&
    isPureManualOperation({ requestedPayload: latestOp.requestedPayload, adapterVersion: latestOp.adapterVersion })
  ) {
    await updateProviderOperation(ctx, latestOp.id, {
      status: "CANCELLED",
      effectCertainty: "KNOWN_NOT_APPLIED",
      resultSummary: { ...(latestOp.resultSummary ?? {}), cancelled_with_trial: trial.id },
      completed: true,
    });
    await insertProviderAttempt(ctx, { operationId: latestOp.id, status: "CANCELLED" });
    cancelledOperations.push(latestOp.id);
  }
  await updateTrial(ctx, trial.id, { lifecycleStatus: "CANCELLED", endedAt: new Date() });
  await insertTrialAttempt(ctx, {
    trialId: trial.id,
    attemptType: "CANCEL",
    outcome: "CANCELLED",
    contextJson: { reason: input.reason ?? null, cancelled_operations: cancelledOperations },
  });
  await emitTrial(ctx, {
    eventType: "trial.cancelled.v1",
    trialId: trial.id,
    data: { person_id: trial.personId, reason: input.reason ?? null },
  });
  return { ok: true, data: { id: trial.id, status: "CANCELLED", cancelledOperations } };
}

async function handleInvalidate(
  ctx: CommandHandlerContext,
  input: InvalidateTrialInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const trial = await getTrial(ctx, input.trialId);
  if (trial === null) {
    return { ok: false, code: "not_found", message: "trial not found in this tenant" };
  }
  if (trial.lifecycleStatus !== "ACTIVE") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `trial is ${trial.lifecycleStatus}; only ACTIVE trials invalidate`,
    };
  }
  await updateTrial(ctx, trial.id, {
    lifecycleStatus: "INVALIDATED",
    invalidatedReason: input.reason,
    endedAt: new Date(),
  });
  await insertTrialAttempt(ctx, {
    trialId: trial.id,
    attemptType: "INVALIDATE",
    outcome: "INVALIDATED",
    contextJson: { reason: input.reason },
  });
  await emitTrial(ctx, {
    eventType: "trial.invalidated.v1",
    trialId: trial.id,
    data: { person_id: trial.personId, reason: input.reason },
  });
  return { ok: true, data: { id: trial.id, status: "INVALIDATED" } };
}

async function handleTrustRenewal(
  ctx: CommandHandlerContext,
  input: TrialIdInput,
): Promise<CommandResult<{ id: string; expiresAt: string }>> {
  const trial = await getTrial(ctx, input.trialId);
  if (trial === null) {
    return { ok: false, code: "not_found", message: "trial not found in this tenant" };
  }
  const rows = await ctx.tx.listPublishedPolicies(TRUST_RENEWAL_FAMILY, ctx.tenantId);
  const { document } = mergePolicyRows(rows);
  const policy = parseTrustRenewalPolicy(document);
  const decision = decideTrustRenewal(policy, { status: trial.lifecycleStatus, expiresAt: trial.expiresAt, at: new Date() });
  if (!decision.allowed) {
    return { ok: false, code: "forbidden", message: `trust renewal denied: ${decision.reason}` };
  }
  const currentExpires = trial.expiresAt as Date;
  const nextExpires = new Date(currentExpires.getTime() + decision.extensionDays * 86_400_000);
  await updateTrial(ctx, trial.id, { expiresAt: nextExpires });
  await insertTrialAttempt(ctx, {
    trialId: trial.id,
    attemptType: "TRUST_RENEWAL",
    outcome: "SUCCEEDED",
    contextJson: {
      extension_days: decision.extensionDays,
      previous_expires_at: currentExpires.toISOString(),
      next_expires_at: nextExpires.toISOString(),
    },
  });
  // No registry-listed event exists for trust renewal: audit-only by design.
  return { ok: true, data: { id: trial.id, expiresAt: nextExpires.toISOString() } };
}

async function handleExpireDue(
  ctx: CommandHandlerContext,
  input: ExpireDueInput,
): Promise<CommandResult<{ expired: string[] }>> {
  const at = new Date();
  const expired: string[] = [];
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const rows = await trx
      .selectFrom("trial.trials")
      .select(["id", "person_id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("lifecycle_status", "=", "ACTIVE")
      .where("expires_at", "<=", at)
      .orderBy("expires_at", "asc")
      .limit(input.limit)
      .execute();
    for (const row of rows) {
      await trx
        .updateTable("trial.trials")
        .set({ lifecycle_status: "ENDED", ended_at: at, updated_at: now() })
        .where("tenant_id", "=", ctx.tenantId)
        .where("id", "=", row.id)
        .where("lifecycle_status", "=", "ACTIVE")
        .execute();
      await trx
        .insertInto("trial.trial_attempts")
        .values({
          id: newId(),
          tenant_id: ctx.tenantId,
          trial_id: row.id,
          attempt_type: "EXPIRE",
          started_at: at,
          completed_at: at,
          outcome: "ENDED",
          error_code: null,
          context_json: { scheduler: "trial.expire_due" },
        })
        .execute();
      await emitTrial(ctx, {
        eventType: "trial.expired.v1",
        trialId: row.id,
        data: { person_id: row.person_id, scheduler: "trial.expire_due" },
      });
      expired.push(row.id);
    }
    return { ok: true, data: { expired } };
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  for (const row of mem.trials.values()) {
    if (expired.length >= input.limit) {
      break;
    }
    if (
      row.tenantId === ctx.tenantId &&
      row.lifecycleStatus === "ACTIVE" &&
      row.expiresAt !== null &&
      row.expiresAt.getTime() <= at.getTime()
    ) {
      row.lifecycleStatus = "ENDED";
      row.endedAt = at;
      mem.attempts.push({
        id: newId(),
        tenantId: ctx.tenantId,
        trialId: row.id,
        attemptType: "EXPIRE",
        outcome: "ENDED",
        errorCode: null,
        contextJson: { scheduler: "trial.expire_due" },
      });
      await emitTrial(ctx, {
        eventType: "trial.expired.v1",
        trialId: row.id,
        data: { person_id: row.personId, scheduler: "trial.expire_due" },
      });
      expired.push(row.id);
    }
  }
  return { ok: true, data: { expired } };
}

async function handleRecordDeviceProfile(
  ctx: CommandHandlerContext,
  input: RecordDeviceProfileInput,
): Promise<CommandResult<{ id: string }>> {
  if (!(await personExists(ctx, input.personId))) {
    return { ok: false, code: "not_found", message: "person not found in this tenant" };
  }
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const row = await trx
      .insertInto("trial.device_profiles")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        person_id: input.personId,
        device_type: input.deviceType,
        manufacturer: input.manufacturer ?? null,
        model: input.model ?? null,
        os_name: input.osName ?? null,
        os_version: input.osVersion ?? null,
        first_seen_at: now(),
        last_seen_at: now(),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    return { ok: true, data: { id: row.id } };
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  const id = newId();
  mem.deviceProfiles.set(id, {
    id,
    tenantId: ctx.tenantId,
    personId: input.personId,
    deviceType: input.deviceType,
    manufacturer: input.manufacturer ?? null,
    model: input.model ?? null,
    osName: input.osName ?? null,
    osVersion: input.osVersion ?? null,
  });
  return { ok: true, data: { id } };
}

async function handleRecordAppProfile(
  ctx: CommandHandlerContext,
  input: RecordAppProfileInput,
): Promise<CommandResult<{ id: string }>> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const row = await trx
      .insertInto("trial.app_profiles")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        name: input.name,
        platform: input.platform,
        version: input.version ?? null,
        license_type: input.licenseType ?? null,
        status: "ACTIVE",
        created_at: now(),
        updated_at: now(),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    return { ok: true, data: { id: row.id } };
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  const id = newId();
  mem.appProfiles.set(id, {
    id,
    tenantId: ctx.tenantId,
    name: input.name,
    platform: input.platform,
    version: input.version ?? null,
    licenseType: input.licenseType ?? null,
    status: "ACTIVE",
  });
  return { ok: true, data: { id } };
}

async function handleRecordObservation(
  ctx: CommandHandlerContext,
  input: RecordObservationInput,
): Promise<CommandResult<{ id: string }>> {
  if (input.network !== undefined && input.personId === undefined) {
    return { ok: false, code: "validation_failed", message: "network observations require a personId" };
  }
  if (input.personId !== undefined && !(await personExists(ctx, input.personId))) {
    return { ok: false, code: "not_found", message: "person not found in this tenant" };
  }
  if (input.trialId !== undefined) {
    const trial = await getTrial(ctx, input.trialId);
    if (trial === null) {
      return { ok: false, code: "not_found", message: "trial not found in this tenant" };
    }
  }
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    if (input.deviceProfileId !== undefined) {
      const device = await trx
        .selectFrom("trial.device_profiles")
        .select(["id"])
        .where("tenant_id", "=", ctx.tenantId)
        .where("id", "=", input.deviceProfileId)
        .executeTakeFirst();
      if (device === undefined) {
        return { ok: false, code: "not_found", message: "device profile not found in this tenant" };
      }
    }
    if (input.appProfileId !== undefined) {
      const app = await trx
        .selectFrom("trial.app_profiles")
        .select(["id", "tenant_id"])
        .where("id", "=", input.appProfileId)
        .executeTakeFirst();
      if (app === undefined || (app.tenant_id !== null && app.tenant_id !== ctx.tenantId)) {
        return { ok: false, code: "not_found", message: "app profile not found" };
      }
    }
    if (input.network !== undefined && input.personId !== undefined) {
      await trx
        .insertInto("trial.network_observations")
        .values({
          id: newId(),
          tenant_id: ctx.tenantId,
          person_id: input.personId,
          trial_id: input.trialId ?? null,
          isp_name: input.network.ispName ?? null,
          network_type: input.network.networkType ?? null,
          ipv6_state: input.network.ipv6State ?? null,
          dns_profile: input.network.dnsProfile ?? null,
          observed_at: now(),
        })
        .execute();
    }
    const row = await trx
      .insertInto("trial.compatibility_observations")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        person_id: input.personId ?? null,
        trial_id: input.trialId ?? null,
        device_profile_id: input.deviceProfileId ?? null,
        app_profile_id: input.appProfileId ?? null,
        provider_server_key: input.providerServerKey ?? null,
        network_context_json: input.network ?? {},
        procedure_key: input.procedureKey ?? null,
        outcome: input.outcome,
        metrics_json: input.metricsJson,
        observed_at: now(),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    return { ok: true, data: { id: row.id } };
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  if (input.deviceProfileId !== undefined) {
    const device = mem.deviceProfiles.get(input.deviceProfileId);
    if (device === undefined || device.tenantId !== ctx.tenantId) {
      return { ok: false, code: "not_found", message: "device profile not found in this tenant" };
    }
  }
  if (input.appProfileId !== undefined) {
    const app = mem.appProfiles.get(input.appProfileId);
    if (app === undefined || (app.tenantId !== null && app.tenantId !== ctx.tenantId)) {
      return { ok: false, code: "not_found", message: "app profile not found" };
    }
  }
  if (input.network !== undefined && input.personId !== undefined) {
    mem.networkObservations.push({
      id: newId(),
      tenantId: ctx.tenantId,
      personId: input.personId,
      trialId: input.trialId ?? null,
      ispName: input.network.ispName ?? null,
      networkType: input.network.networkType ?? null,
      ipv6State: input.network.ipv6State ?? null,
      dnsProfile: input.network.dnsProfile ?? null,
    });
  }
  const id = newId();
  mem.compatibilityObservations.push({
    id,
    tenantId: ctx.tenantId,
    personId: input.personId ?? null,
    trialId: input.trialId ?? null,
    deviceProfileId: input.deviceProfileId ?? null,
    appProfileId: input.appProfileId ?? null,
    providerServerKey: input.providerServerKey ?? null,
    networkContextJson: input.network ?? {},
    procedureKey: input.procedureKey ?? null,
    outcome: input.outcome,
    metricsJson: input.metricsJson,
  });
  return { ok: true, data: { id } };
}

export function registerTrialCommands(bus: CommandBus, deps: TrialCommandDeps = {}): void {
  bus.register<RequestTrialInput, { id: string | null; status: string; reviewRequestId?: string }>({
    name: "trial.request",
    permission: "trial.write",
    auditAction: "trial.request",
    auditResource: "trial",
    input: requestTrialInput,
    handler: handleRequest,
  });
  bus.register<RequestRetrialInput, { id: string | null; status: string; reviewRequestId?: string }>({
    name: "trial.request_retrial",
    permission: "trial.write",
    auditAction: "trial.request_retrial",
    auditResource: "trial",
    input: requestRetrialInput,
    handler: handleRequestRetrial,
  });
  bus.register<
    BeginProvisioningInput,
    { id: string; status: string; operationId: string; effectUncertain: boolean }
  >({
    name: "trial.begin_provisioning",
    permission: "trial.write",
    auditAction: "trial.begin_provisioning",
    auditResource: "trial",
    input: beginProvisioningInput,
    handler: handleBeginProvisioningFactory(deps),
  });
  bus.register<RecordTechnicalResultInput, { id: string; summaryOutcome: string }>({
    name: "trial.record_technical_result",
    permission: "trial.write",
    auditAction: "trial.record_technical_result",
    auditResource: "trial",
    input: recordTechnicalResultInput,
    handler: handleRecordTechnicalResult,
  });
  bus.register<TrialIdInput, { id: string; status: string; event: string }>({
    name: "trial.end",
    permission: "trial.write",
    auditAction: "trial.end",
    auditResource: "trial",
    input: trialIdInput,
    handler: handleEnd,
  });
  bus.register<CancelTrialInput, { id: string; status: string; cancelledOperations: string[] }>({
    name: "trial.cancel",
    permission: "trial.write",
    auditAction: "trial.cancel",
    auditResource: "trial",
    input: cancelTrialInput,
    handler: handleCancel,
  });
  bus.register<InvalidateTrialInput, { id: string; status: string }>({
    name: "trial.invalidate",
    permission: "trial.write",
    auditAction: "trial.invalidate",
    auditResource: "trial",
    input: invalidateTrialInput,
    handler: handleInvalidate,
  });
  bus.register<TrialIdInput, { id: string; expiresAt: string }>({
    name: "trial.apply_trust_renewal",
    permission: "trial.write",
    auditAction: "trial.apply_trust_renewal",
    auditResource: "trial",
    input: trialIdInput,
    handler: handleTrustRenewal,
  });
  bus.register<ExpireDueInput, { expired: string[] }>({
    name: "trial.expire_due",
    permission: "trial.write",
    auditAction: "trial.expire_due",
    auditResource: "trial",
    input: expireDueInput,
    handler: handleExpireDue,
  });
  bus.register<RecordDeviceProfileInput, { id: string }>({
    name: "compatibility.record_device_profile",
    permission: "trial.write",
    auditAction: "compatibility.record_device_profile",
    auditResource: "device_profile",
    input: recordDeviceProfileInput,
    handler: handleRecordDeviceProfile,
  });
  bus.register<RecordAppProfileInput, { id: string }>({
    name: "compatibility.record_app_profile",
    permission: "trial.write",
    auditAction: "compatibility.record_app_profile",
    auditResource: "app_profile",
    input: recordAppProfileInput,
    handler: handleRecordAppProfile,
  });
  bus.register<RecordObservationInput, { id: string }>({
    name: "compatibility.record_observation",
    permission: "trial.write",
    auditAction: "compatibility.record_observation",
    auditResource: "compatibility_observation",
    input: recordObservationInput,
    handler: handleRecordObservation,
  });
}
