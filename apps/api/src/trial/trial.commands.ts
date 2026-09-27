import { z } from "zod";
import { newId, now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type {
  CommandBus,
  CommandHandlerContext,
} from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf, memoryStateOf } from "../crm/wave2-store.js";
import {
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
  countProviderOperationsForEntity,
  ensureTrialProviderAccount,
  findOpenTrialForPerson,
  getTechnicalResult,
  getTrial,
  hasPrimaryTrial,
  insertEligibilityDecision,
  insertProviderAttempt,
  insertProviderOperation,
  insertTechnicalResult,
  insertTrial,
  insertTrialAttempt,
  latestProviderOperationForEntity,
  reviewApprovedByHuman,
  trialMemoryOf,
  updateProviderOperation,
  updateTrial,
} from "./trial-store.js";

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

async function personExists(ctx: CommandHandlerContext, personId: string): Promise<boolean> {
  const trx = kyselyTrxOf(ctx);
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
}

function handleBeginProvisioningFactory(deps: TrialCommandDeps) {
  return async (
    ctx: CommandHandlerContext,
    input: BeginProvisioningInput,
  ): Promise<CommandResult<{ id: string; status: string; operationId: string; effectUncertain: boolean }>> => {
    const trial = await getTrial(ctx, input.trialId);
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
    const port =
      deps.opsPort !== undefined &&
      (deps.opsPort.name === "echo") === (adapterName === "echo")
        ? deps.opsPort
        : resolveOpsPort(adapterName);
    const account = await ensureTrialProviderAccount(ctx);
    const attemptIndex = (await countProviderOperationsForEntity(ctx, "trial", trial.id)) + 1;
    const operation = await insertProviderOperation(ctx, {
      providerAccountId: account.id,
      action: "trial.provision",
      entityType: "trial",
      entityId: trial.id,
      idempotencyKey: `trial-provision:${trial.id}:${attemptIndex}`,
      requestedPayload: {
        duration_minutes: trial.requestedDurationMinutes,
        adult_content_enabled: trial.adultContentEnabled,
        trial_kind: trial.trialKind,
        adapter: adapterName,
        capability: capabilityNote,
        ...(input.echoOutcome !== undefined ? { __echo_outcome: input.echoOutcome } : {}),
      },
      adapterVersion: `${port.name}-v1`,
    });
    await insertTrialAttempt(ctx, {
      trialId: trial.id,
      attemptType: "PROVISIONING",
      outcome: "STARTED",
      contextJson: { operation_id: operation.id, adapter: adapterName, capability: capabilityNote },
    });
    await emitProvider(ctx, {
      eventType: "provider.operation_requested.v1",
      operationId: operation.id,
      data: { action: "trial.provision", entity_type: "trial", entity_id: trial.id, adapter: adapterName },
    });
    const provisioning = await updateTrial(ctx, trial.id, { lifecycleStatus: "PROVISIONING", providerAccountId: account.id });
    if (provisioning === null || !isTrialTransition("REQUESTED", "PROVISIONING")) {
      return { ok: false, code: "precondition_failed", message: "trial left REQUESTED concurrently" };
    }
    await emitTrial(ctx, {
      eventType: "trial.provisioning_started.v1",
      trialId: trial.id,
      data: { person_id: trial.personId, operation_id: operation.id, adapter: adapterName },
    });
    const result = await port.requestOperation({
      tenantId: ctx.tenantId,
      providerAccountId: account.id,
      action: "trial.provision",
      entityType: "trial",
      entityId: trial.id,
      idempotencyKey: `trial-provision:${trial.id}:${attemptIndex}`,
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
  // may have touched the provider (RUNNING/VERIFYING/RETRY_WAIT) stays for
  // explicit reconcile — cancelling it as KNOWN_NOT_APPLIED would lie.
  const latestOp = await latestProviderOperationForEntity(ctx, "trial", trial.id);
  const cancelledOperations: string[] = [];
  if (
    latestOp !== null &&
    ["REQUESTED", "QUEUED", "HUMAN_REQUIRED"].includes(latestOp.status)
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
