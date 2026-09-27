import { newId, now } from "@iptv/domain";
import type { CommandHandlerContext } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";

/**
 * Wave 4 Trial/Provider store accessors (Kysely + in-memory).
 *
 * Both paths expose the same normalized (camelCase) row shapes. Handlers
 * stay store-agnostic; the in-memory path backs unit tests only.
 */

export class UniqueViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniqueViolationError";
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof UniqueViolationError ||
    (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505")
  );
}

export interface TrialRow {
  id: string;
  tenantId: string;
  personId: string;
  leadId: string | null;
  previousTrialId: string | null;
  trialKind: string;
  retrialReason: string | null;
  lifecycleStatus: string;
  technicalOutcome: string;
  requestedDurationMinutes: number;
  adultContentEnabled: boolean;
  providerAccountId: string | null;
  providerBindingId: string | null;
  activatedAt: Date | null;
  expiresAt: Date | null;
  endedAt: Date | null;
  invalidatedReason: string | null;
}

export interface NewTrial {
  personId: string;
  leadId?: string | null;
  previousTrialId?: string | null;
  trialKind: "TRIAL" | "RETRIAL";
  retrialReason?: string | null;
  requestedDurationMinutes: number;
  adultContentEnabled: boolean;
}

export interface ProviderOperationRow {
  id: string;
  tenantId: string;
  providerAccountId: string;
  action: string;
  entityType: string;
  entityId: string;
  status: string;
  idempotencyKey: string;
  executionChannel: string | null;
  adapterVersion: string | null;
  requestedPayload: Record<string, unknown>;
  resultSummary: Record<string, unknown> | null;
  requestedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  correlationId: string;
  effectCertainty: string;
}

export interface TechnicalResultRow {
  id: string;
  tenantId: string;
  trialId: string;
  installationSuccess: boolean | null;
  authenticationSuccess: boolean | null;
  playbackSuccess: boolean | null;
  bufferingObserved: boolean | null;
  summaryOutcome: string;
}

export interface TrialMemoryState {
  trials: Map<string, TrialRow>;
  decisions: Array<{
    id: string;
    tenantId: string;
    personId: string;
    outcome: string;
    policyVersion: string;
    previousTrialId: string | null;
    reasonCodes: string[];
    evidenceJson: Record<string, unknown>;
    actorType: string;
    actorId: string | null;
  }>;
  attempts: Array<{
    id: string;
    tenantId: string;
    trialId: string;
    attemptType: string;
    outcome: string | null;
    errorCode: string | null;
    contextJson: Record<string, unknown>;
  }>;
  technicalResults: Map<string, TechnicalResultRow>;
  deviceProfiles: Map<
    string,
    {
      id: string;
      tenantId: string;
      personId: string;
      deviceType: string;
      manufacturer: string | null;
      model: string | null;
      osName: string | null;
      osVersion: string | null;
    }
  >;
  appProfiles: Map<
    string,
    {
      id: string;
      tenantId: string | null;
      name: string;
      platform: string;
      version: string | null;
      licenseType: string | null;
      status: string;
    }
  >;
  networkObservations: Array<{
    id: string;
    tenantId: string;
    personId: string;
    trialId: string | null;
    ispName: string | null;
    networkType: string | null;
    ipv6State: string | null;
    dnsProfile: string | null;
  }>;
  compatibilityObservations: Array<{
    id: string;
    tenantId: string;
    personId: string | null;
    trialId: string | null;
    deviceProfileId: string | null;
    appProfileId: string | null;
    providerServerKey: string | null;
    networkContextJson: Record<string, unknown>;
    procedureKey: string | null;
    outcome: string;
    metricsJson: Record<string, unknown>;
  }>;
  providers: Map<string, { id: string; providerKey: string; name: string }>;
  providerAccounts: Map<string, { id: string; tenantId: string; providerId: string; name: string }>;
  providerOperations: Map<string, ProviderOperationRow>;
  providerAttempts: Array<{
    id: string;
    tenantId: string;
    operationId: string;
    attemptNo: number;
    status: string;
    errorCode: string | null;
  }>;
}

const trialMemoryStates = new WeakMap<object, TrialMemoryState>();

function emptyTrialState(): TrialMemoryState {
  return {
    trials: new Map(),
    decisions: [],
    attempts: [],
    technicalResults: new Map(),
    deviceProfiles: new Map(),
    appProfiles: new Map(),
    networkObservations: [],
    compatibilityObservations: [],
    providers: new Map(),
    providerAccounts: new Map(),
    providerOperations: new Map(),
    providerAttempts: [],
  };
}

/** In-memory Wave 4 state for unit tests (keyed by tx object). */
export function trialMemoryOf(ctx: CommandHandlerContext): TrialMemoryState | null {
  if (kyselyTrxOf(ctx) !== null) {
    return null;
  }
  const key = ctx.tx.innerDb() as object;
  let state = trialMemoryStates.get(key);
  if (state === undefined) {
    state = emptyTrialState();
    trialMemoryStates.set(key, state);
  }
  return state;
}

function toTrialRow(tenantId: string, row: {
  id: string;
  person_id: string;
  lead_id: string | null;
  previous_trial_id: string | null;
  trial_kind: string;
  retrial_reason: string | null;
  lifecycle_status: string;
  technical_outcome: string;
  requested_duration_minutes: number;
  adult_content_enabled: boolean;
  provider_account_id: string | null;
  provider_binding_id: string | null;
  activated_at: Date | null;
  expires_at: Date | null;
  ended_at: Date | null;
  invalidated_reason: string | null;
}): TrialRow {
  return {
    id: row.id,
    tenantId,
    personId: row.person_id,
    leadId: row.lead_id,
    previousTrialId: row.previous_trial_id,
    trialKind: row.trial_kind,
    retrialReason: row.retrial_reason,
    lifecycleStatus: row.lifecycle_status,
    technicalOutcome: row.technical_outcome,
    requestedDurationMinutes: Number(row.requested_duration_minutes),
    adultContentEnabled: row.adult_content_enabled,
    providerAccountId: row.provider_account_id,
    providerBindingId: row.provider_binding_id,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
    invalidatedReason: row.invalidated_reason,
  };
}

const TRIAL_COLUMNS = [
  "id",
  "person_id",
  "lead_id",
  "previous_trial_id",
  "trial_kind",
  "retrial_reason",
  "lifecycle_status",
  "technical_outcome",
  "requested_duration_minutes",
  "adult_content_enabled",
  "provider_account_id",
  "provider_binding_id",
  "activated_at",
  "expires_at",
  "ended_at",
  "invalidated_reason",
] as const;

function toOperationRow(tenantId: string, row: {
  id: string;
  provider_account_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  status: string;
  idempotency_key: string;
  execution_channel: string | null;
  adapter_version: string | null;
  requested_payload_json: unknown;
  result_summary_json: unknown;
  requested_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  correlation_id: string;
  effect_certainty: string;
}): ProviderOperationRow {
  const payload = row.requested_payload_json;
  const summary = row.result_summary_json;
  return {
    id: row.id,
    tenantId,
    providerAccountId: row.provider_account_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    executionChannel: row.execution_channel,
    adapterVersion: row.adapter_version,
    requestedPayload:
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {},
    resultSummary:
      summary !== null && typeof summary === "object" && !Array.isArray(summary)
        ? (summary as Record<string, unknown>)
        : null,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    correlationId: row.correlation_id,
    effectCertainty: row.effect_certainty,
  };
}

const OPERATION_COLUMNS = [
  "id",
  "provider_account_id",
  "action",
  "entity_type",
  "entity_id",
  "status",
  "idempotency_key",
  "execution_channel",
  "adapter_version",
  "requested_payload_json",
  "result_summary_json",
  "requested_at",
  "started_at",
  "completed_at",
  "correlation_id",
  "effect_certainty",
] as const;

export async function getTrial(ctx: CommandHandlerContext, trialId: string): Promise<TrialRow | null> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const row = await trx
      .selectFrom("trial.trials")
      .select(TRIAL_COLUMNS)
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", trialId)
      .executeTakeFirst();
    return row === undefined ? null : toTrialRow(ctx.tenantId, row);
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  const row = mem.trials.get(trialId);
  return row !== undefined && row.tenantId === ctx.tenantId ? row : null;
}

export async function insertTrial(ctx: CommandHandlerContext, input: NewTrial): Promise<TrialRow> {
  const id = newId();
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    try {
      const row = await trx
        .insertInto("trial.trials")
        .values({
          id,
          tenant_id: ctx.tenantId,
          person_id: input.personId,
          lead_id: input.leadId ?? null,
          previous_trial_id: input.previousTrialId ?? null,
          trial_kind: input.trialKind,
          retrial_reason: input.retrialReason ?? null,
          lifecycle_status: "REQUESTED",
          technical_outcome: "PENDING",
          requested_duration_minutes: input.requestedDurationMinutes,
          adult_content_enabled: input.adultContentEnabled,
          activated_at: null,
          expires_at: null,
          ended_at: null,
          invalidated_reason: null,
          created_at: now(),
          updated_at: now(),
        })
        .returning(TRIAL_COLUMNS)
        .executeTakeFirstOrThrow();
      return toTrialRow(ctx.tenantId, row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new UniqueViolationError("trial invariant violated (single primary / single open access)");
      }
      throw err;
    }
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  if (input.trialKind === "TRIAL") {
    for (const existing of mem.trials.values()) {
      if (existing.tenantId === ctx.tenantId && existing.personId === input.personId && existing.trialKind === "TRIAL") {
        throw new UniqueViolationError("a primary trial already exists for this person");
      }
    }
  }
  for (const existing of mem.trials.values()) {
    if (
      existing.tenantId === ctx.tenantId &&
      existing.personId === input.personId &&
      ["REQUESTED", "PROVISIONING", "ACTIVE"].includes(existing.lifecycleStatus)
    ) {
      throw new UniqueViolationError("an open trial already exists for this person");
    }
  }
  const row: TrialRow = {
    id,
    tenantId: ctx.tenantId,
    personId: input.personId,
    leadId: input.leadId ?? null,
    previousTrialId: input.previousTrialId ?? null,
    trialKind: input.trialKind,
    retrialReason: input.retrialReason ?? null,
    lifecycleStatus: "REQUESTED",
    technicalOutcome: "PENDING",
    requestedDurationMinutes: input.requestedDurationMinutes,
    adultContentEnabled: input.adultContentEnabled,
    providerAccountId: null,
    providerBindingId: null,
    activatedAt: null,
    expiresAt: null,
    endedAt: null,
    invalidatedReason: null,
  };
  mem.trials.set(id, row);
  return row;
}

export async function updateTrial(
  ctx: CommandHandlerContext,
  trialId: string,
  patch: Partial<
    Pick<
      TrialRow,
      | "lifecycleStatus"
      | "technicalOutcome"
      | "providerAccountId"
      | "activatedAt"
      | "expiresAt"
      | "endedAt"
      | "invalidatedReason"
    >
  >,
): Promise<TrialRow | null> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const row = await trx
      .updateTable("trial.trials")
      .set({
        ...(patch.lifecycleStatus !== undefined ? { lifecycle_status: patch.lifecycleStatus } : {}),
        ...(patch.technicalOutcome !== undefined ? { technical_outcome: patch.technicalOutcome } : {}),
        ...(patch.providerAccountId !== undefined ? { provider_account_id: patch.providerAccountId } : {}),
        ...(patch.activatedAt !== undefined ? { activated_at: patch.activatedAt } : {}),
        ...(patch.expiresAt !== undefined ? { expires_at: patch.expiresAt } : {}),
        ...(patch.endedAt !== undefined ? { ended_at: patch.endedAt } : {}),
        ...(patch.invalidatedReason !== undefined ? { invalidated_reason: patch.invalidatedReason } : {}),
        updated_at: now(),
      })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", trialId)
      .returning(TRIAL_COLUMNS)
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    return toTrialRow(ctx.tenantId, row);
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  const row = mem.trials.get(trialId);
  if (row === undefined || row.tenantId !== ctx.tenantId) {
    return null;
  }
  if (patch.lifecycleStatus !== undefined) {
    if (["REQUESTED", "PROVISIONING", "ACTIVE"].includes(patch.lifecycleStatus)) {
      for (const existing of mem.trials.values()) {
        if (
          existing.id !== trialId &&
          existing.tenantId === ctx.tenantId &&
          existing.personId === row.personId &&
          ["REQUESTED", "PROVISIONING", "ACTIVE"].includes(existing.lifecycleStatus)
        ) {
          throw new UniqueViolationError("an open trial already exists for this person");
        }
      }
    }
    row.lifecycleStatus = patch.lifecycleStatus;
  }
  if (patch.technicalOutcome !== undefined) {
    row.technicalOutcome = patch.technicalOutcome;
  }
  if (patch.providerAccountId !== undefined) {
    row.providerAccountId = patch.providerAccountId;
  }
  if (patch.activatedAt !== undefined) {
    row.activatedAt = patch.activatedAt;
  }
  if (patch.expiresAt !== undefined) {
    row.expiresAt = patch.expiresAt;
  }
  if (patch.endedAt !== undefined) {
    row.endedAt = patch.endedAt;
  }
  if (patch.invalidatedReason !== undefined) {
    row.invalidatedReason = patch.invalidatedReason;
  }
  return row;
}

export async function findOpenTrialForPerson(
  ctx: CommandHandlerContext,
  personId: string,
): Promise<TrialRow | null> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const row = await trx
      .selectFrom("trial.trials")
      .select(TRIAL_COLUMNS)
      .where("tenant_id", "=", ctx.tenantId)
      .where("person_id", "=", personId)
      .where("lifecycle_status", "in", ["REQUESTED", "PROVISIONING", "ACTIVE"])
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    return row === undefined ? null : toTrialRow(ctx.tenantId, row);
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  for (const row of mem.trials.values()) {
    if (
      row.tenantId === ctx.tenantId &&
      row.personId === personId &&
      ["REQUESTED", "PROVISIONING", "ACTIVE"].includes(row.lifecycleStatus)
    ) {
      return row;
    }
  }
  return null;
}

export async function hasPrimaryTrial(ctx: CommandHandlerContext, personId: string): Promise<boolean> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const row = await trx
      .selectFrom("trial.trials")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("person_id", "=", personId)
      .where("trial_kind", "=", "TRIAL")
      .executeTakeFirst();
    return row !== undefined;
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  for (const row of mem.trials.values()) {
    if (row.tenantId === ctx.tenantId && row.personId === personId && row.trialKind === "TRIAL") {
      return true;
    }
  }
  return false;
}

export async function listTrialsForPerson(
  ctx: CommandHandlerContext,
  personId: string,
): Promise<TrialRow[]> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const rows = await trx
      .selectFrom("trial.trials")
      .select(TRIAL_COLUMNS)
      .where("tenant_id", "=", ctx.tenantId)
      .where("person_id", "=", personId)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map((row) => toTrialRow(ctx.tenantId, row));
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  return [...mem.trials.values()].filter(
    (row) => row.tenantId === ctx.tenantId && row.personId === personId,
  );
}

export async function insertEligibilityDecision(
  ctx: CommandHandlerContext,
  input: {
    personId: string;
    outcome: string;
    policyVersion: string;
    previousTrialId?: string | null;
    reasonCodes: string[];
    evidenceJson: Record<string, unknown>;
  },
): Promise<{ id: string }> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const row = await trx
      .insertInto("trial.trial_eligibility_decisions")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        person_id: input.personId,
        outcome: input.outcome,
        policy_version: input.policyVersion,
        previous_trial_id: input.previousTrialId ?? null,
        reason_codes: input.reasonCodes,
        evidence_json: input.evidenceJson,
        actor_type: ctx.actor.actorType,
        actor_id: ctx.actor.userId,
        created_at: now(),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    return { id: row.id };
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  const id = newId();
  mem.decisions.push({
    id,
    tenantId: ctx.tenantId,
    personId: input.personId,
    outcome: input.outcome,
    policyVersion: input.policyVersion,
    previousTrialId: input.previousTrialId ?? null,
    reasonCodes: input.reasonCodes,
    evidenceJson: input.evidenceJson,
    actorType: ctx.actor.actorType,
    actorId: ctx.actor.userId,
  });
  return { id };
}

export async function insertTrialAttempt(
  ctx: CommandHandlerContext,
  input: { trialId: string; attemptType: string; outcome?: string | null; errorCode?: string | null; contextJson?: Record<string, unknown> },
): Promise<void> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    await trx
      .insertInto("trial.trial_attempts")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        trial_id: input.trialId,
        attempt_type: input.attemptType,
        started_at: now(),
        completed_at: now(),
        outcome: input.outcome ?? null,
        error_code: input.errorCode ?? null,
        context_json: input.contextJson ?? {},
      })
      .execute();
    return;
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  mem.attempts.push({
    id: newId(),
    tenantId: ctx.tenantId,
    trialId: input.trialId,
    attemptType: input.attemptType,
    outcome: input.outcome ?? null,
    errorCode: input.errorCode ?? null,
    contextJson: input.contextJson ?? {},
  });
}

export async function getTechnicalResult(
  ctx: CommandHandlerContext,
  trialId: string,
): Promise<TechnicalResultRow | null> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const row = await trx
      .selectFrom("trial.trial_technical_results")
      .select([
        "id",
        "trial_id",
        "installation_success",
        "authentication_success",
        "playback_success",
        "buffering_observed",
        "summary_outcome",
      ])
      .where("tenant_id", "=", ctx.tenantId)
      .where("trial_id", "=", trialId)
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      tenantId: ctx.tenantId,
      trialId: row.trial_id,
      installationSuccess: row.installation_success,
      authenticationSuccess: row.authentication_success,
      playbackSuccess: row.playback_success,
      bufferingObserved: row.buffering_observed,
      summaryOutcome: row.summary_outcome,
    };
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  const row = mem.technicalResults.get(trialId);
  return row !== undefined && row.tenantId === ctx.tenantId ? row : null;
}

export async function insertTechnicalResult(
  ctx: CommandHandlerContext,
  input: {
    trialId: string;
    installationSuccess?: boolean | null;
    authenticationSuccess?: boolean | null;
    playbackSuccess?: boolean | null;
    bufferingObserved?: boolean | null;
    summaryOutcome: string;
  },
): Promise<TechnicalResultRow> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    try {
      const row = await trx
        .insertInto("trial.trial_technical_results")
        .values({
          id: newId(),
          tenant_id: ctx.tenantId,
          trial_id: input.trialId,
          installation_success: input.installationSuccess ?? null,
          authentication_success: input.authenticationSuccess ?? null,
          playback_success: input.playbackSuccess ?? null,
          buffering_observed: input.bufferingObserved ?? null,
          summary_outcome: input.summaryOutcome,
          assessed_at: now(),
          assessment_version: "technical-assessment-v1",
        })
        .returning([
          "id",
          "trial_id",
          "installation_success",
          "authentication_success",
          "playback_success",
          "buffering_observed",
          "summary_outcome",
        ])
        .executeTakeFirstOrThrow();
      return {
        id: row.id,
        tenantId: ctx.tenantId,
        trialId: row.trial_id,
        installationSuccess: row.installation_success,
        authenticationSuccess: row.authentication_success,
        playbackSuccess: row.playback_success,
        bufferingObserved: row.buffering_observed,
        summaryOutcome: row.summary_outcome,
      };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new UniqueViolationError("a technical result is already recorded for this trial");
      }
      throw err;
    }
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  const existing = mem.technicalResults.get(input.trialId);
  if (existing !== undefined && existing.tenantId === ctx.tenantId) {
    throw new UniqueViolationError("a technical result is already recorded for this trial");
  }
  const row: TechnicalResultRow = {
    id: newId(),
    tenantId: ctx.tenantId,
    trialId: input.trialId,
    installationSuccess: input.installationSuccess ?? null,
    authenticationSuccess: input.authenticationSuccess ?? null,
    playbackSuccess: input.playbackSuccess ?? null,
    bufferingObserved: input.bufferingObserved ?? null,
    summaryOutcome: input.summaryOutcome,
  };
  mem.technicalResults.set(input.trialId, row);
  return row;
}

/** Provider account used for trial provisioning (find-or-create placeholder). */
export async function ensureTrialProviderAccount(ctx: CommandHandlerContext): Promise<{ id: string }> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    let provider = await trx
      .selectFrom("provider.providers")
      .select(["id"])
      .where("provider_key", "=", "cinevision")
      .executeTakeFirst();
    if (provider === undefined) {
      provider = await trx
        .insertInto("provider.providers")
        .values({
          id: newId(),
          provider_key: "cinevision",
          name: "CINEVISION",
          provider_type: "FULFILLMENT",
          status: "ACTIVE",
          created_at: now(),
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();
    }
    const existing = await trx
      .selectFrom("provider.provider_accounts")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("provider_id", "=", provider.id)
      .where("status", "=", "ACTIVE")
      .orderBy("created_at", "asc")
      .executeTakeFirst();
    if (existing !== undefined) {
      return { id: existing.id };
    }
    const created = await trx
      .insertInto("provider.provider_accounts")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        provider_id: provider.id,
        name: "CINEVISION Trial Placeholder",
        status: "ACTIVE",
        // Wave-0 gate: placeholder reference only, never a live credential.
        secret_ref: "wave4://no-real-credential",
        settings_json: { synthetic: true },
        last_recharge_at: null,
        created_at: now(),
        updated_at: now(),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    return { id: created.id };
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  let provider = [...mem.providers.values()].find((p) => p.providerKey === "cinevision");
  if (provider === undefined) {
    provider = { id: newId(), providerKey: "cinevision", name: "CINEVISION" };
    mem.providers.set(provider.id, provider);
  }
  const existing = [...mem.providerAccounts.values()].find(
    (a) => a.tenantId === ctx.tenantId && a.providerId === provider.id,
  );
  if (existing !== undefined) {
    return { id: existing.id };
  }
  const created = { id: newId(), tenantId: ctx.tenantId, providerId: provider.id, name: "CINEVISION Trial Placeholder" };
  mem.providerAccounts.set(created.id, created);
  return { id: created.id };
}

export async function insertProviderOperation(
  ctx: CommandHandlerContext,
  input: {
    providerAccountId: string;
    action: string;
    entityType: string;
    entityId: string;
    idempotencyKey: string;
    requestedPayload: Record<string, unknown>;
    adapterVersion: string;
  },
): Promise<ProviderOperationRow> {
  const id = newId();
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    try {
      const row = await trx
        .insertInto("provider.provider_operations")
        .values({
          id,
          tenant_id: ctx.tenantId,
          provider_account_id: input.providerAccountId,
          action: input.action,
          entity_type: input.entityType,
          entity_id: input.entityId,
          status: "REQUESTED",
          idempotency_key: input.idempotencyKey,
          execution_channel: null,
          adapter_version: input.adapterVersion,
          requested_payload_json: input.requestedPayload,
          result_summary_json: null,
          requested_at: now(),
          started_at: null,
          completed_at: null,
          correlation_id: ctx.correlationId,
          effect_certainty: "UNKNOWN",
        })
        .returning(OPERATION_COLUMNS)
        .executeTakeFirstOrThrow();
      return toOperationRow(ctx.tenantId, row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new UniqueViolationError("provider operation idempotency key already used");
      }
      throw err;
    }
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  for (const existing of mem.providerOperations.values()) {
    if (
      existing.tenantId === ctx.tenantId &&
      existing.providerAccountId === input.providerAccountId &&
      existing.idempotencyKey === input.idempotencyKey
    ) {
      throw new UniqueViolationError("provider operation idempotency key already used");
    }
  }
  const row: ProviderOperationRow = {
    id,
    tenantId: ctx.tenantId,
    providerAccountId: input.providerAccountId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    status: "REQUESTED",
    idempotencyKey: input.idempotencyKey,
    executionChannel: null,
    adapterVersion: input.adapterVersion,
    requestedPayload: input.requestedPayload,
    resultSummary: null,
    requestedAt: new Date(),
    startedAt: null,
    completedAt: null,
    correlationId: ctx.correlationId,
    effectCertainty: "UNKNOWN",
  };
  mem.providerOperations.set(id, row);
  return row;
}

export async function getProviderOperation(
  ctx: CommandHandlerContext,
  operationId: string,
): Promise<ProviderOperationRow | null> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const row = await trx
      .selectFrom("provider.provider_operations")
      .select(OPERATION_COLUMNS)
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", operationId)
      .executeTakeFirst();
    return row === undefined ? null : toOperationRow(ctx.tenantId, row);
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  const row = mem.providerOperations.get(operationId);
  return row !== undefined && row.tenantId === ctx.tenantId ? row : null;
}

export async function latestProviderOperationForEntity(
  ctx: CommandHandlerContext,
  entityType: string,
  entityId: string,
): Promise<ProviderOperationRow | null> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const row = await trx
      .selectFrom("provider.provider_operations")
      .select(OPERATION_COLUMNS)
      .where("tenant_id", "=", ctx.tenantId)
      .where("entity_type", "=", entityType)
      .where("entity_id", "=", entityId)
      .orderBy("requested_at", "desc")
      .executeTakeFirst();
    return row === undefined ? null : toOperationRow(ctx.tenantId, row);
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  let latest: ProviderOperationRow | null = null;
  for (const row of mem.providerOperations.values()) {
    if (row.tenantId === ctx.tenantId && row.entityType === entityType && row.entityId === entityId) {
      if (latest === null || row.requestedAt.getTime() >= latest.requestedAt.getTime()) {
        latest = row;
      }
    }
  }
  return latest;
}

export async function countProviderOperationsForEntity(
  ctx: CommandHandlerContext,
  entityType: string,
  entityId: string,
): Promise<number> {
  const latest = await latestProviderOperationForEntity(ctx, entityType, entityId);
  if (latest === null) {
    return 0;
  }
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const rows = await trx
      .selectFrom("provider.provider_operations")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("entity_type", "=", entityType)
      .where("entity_id", "=", entityId)
      .execute();
    return rows.length;
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  return [...mem.providerOperations.values()].filter(
    (row) => row.tenantId === ctx.tenantId && row.entityType === entityType && row.entityId === entityId,
  ).length;
}

export async function updateProviderOperation(
  ctx: CommandHandlerContext,
  operationId: string,
  patch: {
    status: string;
    effectCertainty: string;
    executionChannel?: string | null;
    resultSummary?: Record<string, unknown> | null;
    started?: boolean;
    completed?: boolean;
  },
): Promise<ProviderOperationRow | null> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const row = await trx
      .updateTable("provider.provider_operations")
      .set({
        status: patch.status,
        effect_certainty: patch.effectCertainty,
        ...(patch.executionChannel !== undefined ? { execution_channel: patch.executionChannel } : {}),
        ...(patch.resultSummary !== undefined ? { result_summary_json: patch.resultSummary } : {}),
        ...(patch.started === true ? { started_at: now() } : {}),
        ...(patch.completed === true ? { completed_at: now() } : {}),
      })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", operationId)
      .returning(OPERATION_COLUMNS)
      .executeTakeFirst();
    return row === undefined ? null : toOperationRow(ctx.tenantId, row);
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  const row = mem.providerOperations.get(operationId);
  if (row === undefined || row.tenantId !== ctx.tenantId) {
    return null;
  }
  row.status = patch.status;
  row.effectCertainty = patch.effectCertainty;
  if (patch.executionChannel !== undefined) {
    row.executionChannel = patch.executionChannel;
  }
  if (patch.resultSummary !== undefined) {
    row.resultSummary = patch.resultSummary;
  }
  if (patch.started === true && row.startedAt === null) {
    row.startedAt = new Date();
  }
  if (patch.completed === true) {
    row.completedAt = new Date();
  }
  return row;
}

export async function insertProviderAttempt(
  ctx: CommandHandlerContext,
  input: { operationId: string; status: string; errorCode?: string | null },
): Promise<void> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const prev = await trx
      .selectFrom("provider.provider_operation_attempts")
      .select(["attempt_no"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("provider_operation_id", "=", input.operationId)
      .orderBy("attempt_no", "desc")
      .limit(1)
      .executeTakeFirst();
    const attemptNo = Number(prev?.attempt_no ?? 0) + 1;
    await trx
      .insertInto("provider.provider_operation_attempts")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        provider_operation_id: input.operationId,
        attempt_no: attemptNo,
        status: input.status,
        started_at: now(),
        completed_at: now(),
        error_class: null,
        error_code: input.errorCode ?? null,
        trace_ref: null,
      })
      .execute();
    return;
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  const attemptNo = mem.providerAttempts.filter(
    (a) => a.tenantId === ctx.tenantId && a.operationId === input.operationId,
  ).length + 1;
  mem.providerAttempts.push({
    id: newId(),
    tenantId: ctx.tenantId,
    operationId: input.operationId,
    attemptNo,
    status: input.status,
    errorCode: input.errorCode ?? null,
  });
}

/**
 * Whether the linked trial may resume from a provider terminal outcome.
 * Only a trial still waiting in PROVISIONING resumes; anything else means
 * the trial moved on (cancelled/ended) while the operation was pending.
 */
export async function applyProviderTerminalOutcome(
  ctx: CommandHandlerContext,
  trialId: string,
  terminal: "SUCCEEDED" | "FAILED",
): Promise<{ resumed: boolean; trial: TrialRow | null }> {
  const trial = await getTrial(ctx, trialId);
  if (trial === null || trial.lifecycleStatus !== "PROVISIONING") {
    return { resumed: false, trial };
  }
  if (terminal === "SUCCEEDED") {
    const activatedAt = new Date();
    const expiresAt = new Date(activatedAt.getTime() + trial.requestedDurationMinutes * 60_000);
    const updated = await updateTrial(ctx, trialId, { lifecycleStatus: "ACTIVE", activatedAt, expiresAt });
    return { resumed: true, trial: updated };
  }
  const updated = await updateTrial(ctx, trialId, { lifecycleStatus: "REQUESTED" });
  return { resumed: true, trial: updated };
}

/**
 * Human-approval evidence for a review-gated retrial: the review request
 * must be RESOLVED and carry an APPROVE action. Both stores supported
 * without importing test fakes (structural narrowing only).
 */
export async function reviewApprovedByHuman(
  ctx: CommandHandlerContext,
  requestId: string,
): Promise<boolean> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const request = await trx
      .selectFrom("agent.human_review_requests")
      .select(["status"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", requestId)
      .executeTakeFirst();
    if (request === undefined || request.status !== "RESOLVED") {
      return false;
    }
    const approval = await trx
      .selectFrom("agent.human_review_actions")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("human_review_request_id", "=", requestId)
      .where("action_type", "=", "APPROVE")
      .executeTakeFirst();
    return approval !== undefined;
  }
  const inner = ctx.tx.innerDb() as {
    reviews?: Map<string, { tenantId: string; status: string }>;
    actions?: Array<{ requestId: string; actionType: string }>;
  } | null;
  const review = inner?.reviews?.get(requestId);
  if (review === undefined || review.tenantId !== ctx.tenantId || review.status !== "RESOLVED") {
    return false;
  }
  return (inner?.actions ?? []).some((a) => a.requestId === requestId && a.actionType === "APPROVE");
}
