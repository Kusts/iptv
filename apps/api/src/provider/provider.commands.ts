import { z } from "zod";
import type { CommandResult } from "@iptv/domain";
import type {
  CommandBus,
  CommandHandlerContext,
} from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf } from "../crm/wave2-store.js";
import {
  StubProviderReadback,
  SECRET_REQUIRED_ADAPTER_VERSION,
  adapterNameFromEnv,
  applyCapabilityGate,
  providerDispatchModeFromEnv,
  resolveOpsPort,
  type ProviderOpsPort,
  type ProviderReadbackPort,
} from "./provider-port.js";
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
  PROVIDER_CALL_UNCERTAIN_CODE,
  stripSecretKeysFromPayload,
  TRIAL_CAPABILITY_KEY,
  TRIAL_GATE_MESSAGES,
  trialDisposableAccountIdFromEnv,
  validatePublicRequestPayload,
  validateSecretRequestShape,
} from "./provider-secret-gate.js";
import {
  UniqueViolationError,
  applyProviderTerminalOutcome,
  compareAndSetProviderOperation,
  ensureTrialProviderAccount,
  getProviderOperation,
  insertProviderAttempt,
  insertProviderOperation,
  latestProviderOperationForEntityAction,
  trialMemoryOf,
  trialProvisionBusinessKey,
  updateProviderOperation,
} from "../trial/trial-store.js";
import {
  applyTrialProvisionOutcome,
  assertTrialProvisionPreconditions,
  prepareTrialProvisionIntent,
} from "../trial/trial.commands.js";
import {
  type TrialReadbackPort,
  type TrialReadbackResult,
} from "../trial/trial-readback.js";
import { resumeLinkedSubscription } from "../subscription/subscription.commands.js";

/**
 * Wave 4 Provider Operation commands (owning context for ProviderOperation).
 *
 * - `provider.request_operation` creates a `REQUESTED` row and runs it
 *   through the selected `ProviderOpsPort` (echo/manual only). Echo
 *   terminal outcomes resolve inline; manual parks in `HUMAN_REQUIRED`.
 * - `provider.resolve_operation` is the human provider-operator decision
 *   (`SUCCEEDED | FAILED | UNKNOWN`). UNKNOWN parks the operation in
 *   VERIFYING for readback — never blind retry.
 * - `provider.reconcile` verifies an uncertain operation through the
 *   `ProviderReadbackPort` stub and records the observed effect. It NEVER
 *   re-executes the operation and NEVER awaits a provider/readback port
 *   while a secret-required `trial.provision` row is concerned: a VERIFYING
 *   real trial reconciliation is only SCHEDULED here (honest
 *   `reconciliation: "scheduled"`, zero writes) and executed by the durable
 *   dispatcher recovery outside any transaction. An inconclusive readback
 *   (`conclusive=false`) on a synthetic (echo/manual) operation preserves
 *   VERIFYING + UNKNOWN with no terminal write, event, retry or resume; on
 *   a secret-required non-trial operation it converges VERIFYING →
 *   HUMAN_REQUIRED through the shared outcome applier (no re-send,
 *   certainty stays UNKNOWN). A repeat reconcile over an already-converged
 *   secret-required HUMAN_REQUIRED row is an honest no-op. Only fixed
 *   outcome codes are persisted or emitted, never free-form readback
 *   evidence.
 * - When the operation is linked to a trial (`entity_type=trial`), terminal
 *   outcomes resume the trial flow (SUCCEEDED -> ACTIVE, FAILED known-not-
 *   applied -> REQUESTED) with the registry-listed trial events.
 * - When the operation is linked to a subscription
 *   (`entity_type=subscription`), terminal outcomes resume the Wave 6 flow
 *   via `resumeLinkedSubscription` (SUCCEEDED -> ACTIVE + cycle open +
 *   entitlement grants + credential notification; FAILED -> HumanReview and
 *   the subscription stays PENDING_ACTIVATION).
 * - Emitted events are registry-listed only:
 *   `provider.operation_requested|succeeded|failed.v1`. There is no
 *   `verification_required` public event (known catalog gap) — VERIFYING
 *   transitions are audit-only.
 */

export const TERMINAL_OPERATION_STATUSES = ["SUCCEEDED", "FAILED", "CANCELLED"] as const;

export const requestOperationInput = z.object({
  providerAccountId: z.string().uuid().optional(),
  action: z.string().trim().min(1).max(120),
  entityType: z.string().trim().min(1).max(64),
  entityId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(1).max(200),
  payload: z.record(z.string(), z.unknown()).default({}),
  adapter: z.enum(["echo", "manual"]).optional(),
  echoOutcome: z.enum(["success", "failed", "unknown"]).optional(),
});

export type RequestOperationInput = z.infer<typeof requestOperationInput>;

export const resolveOperationInput = z.object({
  operationId: z.string().uuid(),
  outcome: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN"]),
  note: z.string().trim().min(1).max(500).optional(),
});

export type ResolveOperationInput = z.infer<typeof resolveOperationInput>;

export const reconcileOperationInput = z.object({ operationId: z.string().uuid() });
export type ReconcileOperationInput = z.infer<typeof reconcileOperationInput>;

export interface ProviderCommandDeps {
  opsPort?: ProviderOpsPort;
  readbackPort?: ProviderReadbackPort;
  /**
   * PF-05: SecretsPort used ONLY to verify configuration (present + not
   * Noop) for secret-requiring (future BROWSER) adapters. The gate never
   * calls `getSecret`. Defaults to `resolveSecretsPort()` (env-gated;
   * Noop locally) so echo/manual keep working with no config.
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
   * FASE5-S6 (SPEC §25): readback port for the REAL `trial.provision`
   * dispatch through this entry. FASE5-S6-FIX2 (SPEC §41): the
   * secret-required `trial.provision` entry always queues for the durable
   * dispatcher (which carries its own bounded readback seam), so this seam
   * is unread on the inline path — retained for API compatibility.
   * Defaults to `StubTrialReadback` (fail-closed INCONCLUSIVE).
   */
  trialReadbackPort?: TrialReadbackPort;
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

/**
 * Resume a linked trial after a terminal provider outcome. Only
 * `entity_type=trial` operations resume a trial, and only a trial still
 * in PROVISIONING moves (see `applyProviderTerminalOutcome`).
 * `entity_type=subscription` operations resume the Wave 6 subscription flow
 * (SUCCEEDED -> ACTIVE with postcondition readback, FAILED -> human review)
 * via `resumeLinkedSubscription`.
 *
 * FASE5-FIX3-S1 (kept) + FASE5-FIX4-N3: the linked operation must be the
 * trial's own LATEST PROVISION operation — `action=trial.provision` on the
 * latest operation WITH THAT ACTION for the trial. A synthetic operation
 * with an ARBITRARY action and `entity_type=trial` never resumes a real
 * trial (even when it carries the trial id), AND it never blocks the
 * legitimate provision operation from resuming it: only a NEWER
 * `trial.provision` row supersedes. Echo `trial.provision` synthetic rows
 * keep working (dev convenience): they are the trial's provision operation
 * by action.
 */
async function resumeLinkedTrial(
  ctx: CommandHandlerContext,
  entityType: string,
  entityId: string,
  terminal: "SUCCEEDED" | "FAILED",
  operationId: string,
): Promise<{ resumedTrial: boolean }> {
  if (entityType === "subscription") {
    await resumeLinkedSubscription(ctx, entityId, terminal, operationId);
    return { resumedTrial: false };
  }
  if (entityType !== "trial") {
    return { resumedTrial: false };
  }
  const operation = await getProviderOperation(ctx, operationId);
  if (operation === null || operation.action !== "trial.provision" || operation.entityId !== entityId) {
    return { resumedTrial: false };
  }
  // FASE5-FIX4-N3: latest PROVISION op wins — an arbitrary newer op with
  // another action neither resumes nor blocks the legitimate provision op.
  const latestProvision = await latestProviderOperationForEntityAction(ctx, "trial", entityId, "trial.provision");
  if (latestProvision === null || latestProvision.id !== operation.id) {
    return { resumedTrial: false };
  }
  const { resumed, trial } = await applyProviderTerminalOutcome(ctx, entityId, terminal);
  if (!resumed || trial === null) {
    return { resumedTrial: false };
  }
  if (terminal === "SUCCEEDED") {
    await emitTrial(ctx, {
      eventType: "trial.activated.v1",
      trialId: entityId,
      data: { person_id: trial.personId, operation_id: operationId, via: "provider.resolve" },
    });
  } else {
    await emitTrial(ctx, {
      eventType: "trial.provisioning_failed.v1",
      trialId: entityId,
      data: { person_id: trial.personId, operation_id: operationId, via: "provider.resolve" },
    });
  }
  return { resumedTrial: true };
}

async function resolveAccountId(
  ctx: CommandHandlerContext,
  providerAccountId: string | undefined,
): Promise<{ id: string } | { error: CommandResult<never> }> {
  if (providerAccountId === undefined) {
    return ensureTrialProviderAccount(ctx);
  }
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const row = await trx
      .selectFrom("provider.provider_accounts")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", providerAccountId)
      .executeTakeFirst();
    if (row === undefined) {
      return { error: { ok: false, code: "not_found", message: "provider account not found in this tenant" } };
    }
    return { id: row.id };
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  const account = mem.providerAccounts.get(providerAccountId);
  if (account === undefined || account.tenantId !== ctx.tenantId) {
    return { error: { ok: false, code: "not_found", message: "provider account not found in this tenant" } };
  }
  return { id: account.id };
}

/**
 * Secret-required `provider.request_operation` path: restrictive action +
 * payload contract, lookup-only account resolution (no placeholder creation
 * before the gate), fail-closed secret gate, allowlist-projected
 * persistence, and safe port-result projection. Never persists/emits raw
 * `detail`/`externalRef`; an invalid ref demotes SUCCEEDED to UNKNOWN
 * (ambiguous effect, reservation retained).
 */
async function handleSecretRequest(
  ctx: CommandHandlerContext,
  input: RequestOperationInput,
  deps: ProviderCommandDeps,
  resolved: { port: ProviderOpsPort; capabilityNote: string },
): Promise<CommandResult<{ id: string; status: string; effectCertainty: string }>> {
  const shape = validateSecretRequestShape({
    action: input.action,
    entityType: input.entityType,
    payload: input.payload,
  });
  if (!shape.ok) {
    return { ok: false, code: "validation_failed", message: shape.message };
  }
  let accountId: string;
  if (input.providerAccountId !== undefined) {
    const found = await resolveAccountId(ctx, input.providerAccountId);
    if ("error" in found) {
      return found.error;
    }
    accountId = found.id;
  } else {
    const existing = await findExistingTrialProviderAccountId(ctx);
    if (existing === null) {
      return {
        ok: false,
        code: "precondition_failed",
        message: "browser operations require a configured provider secret (secret_ref is missing)",
      };
    }
    accountId = existing;
  }
  const loader = deps.loadSecretRef ?? getProviderAccountSecretRef;
  const secretRef = await loader(ctx, accountId);
  const gate = assertBrowserSecretReady({
    secretRef,
    secretsPort: deps.secretsPort ?? resolveSecretsPort(),
  });
  if (!gate.ok) {
    return { ok: false, code: "precondition_failed", message: gate.message };
  }
  if (input.action === "trial.provision" && input.entityType === "trial") {
    // SPEC §25: the `provider.resolve` entry enforces the same pre-dispatch
    // trial preconditions as the domain entry — after the secret gate (so
    // gate refusals keep their codes) but before any insert or port call.
    // Never HUMAN_REQUIRED here: this is an invalid request, not an
    // uncertain operational effect.
    const pre = await assertTrialProvisionPreconditions(ctx, input.entityId);
    if (!pre.ok) {
      return pre;
    }
    // FASE5-S4S5: per-action trial gate — the real dispatch additionally
    // requires the `provider.cinevision.trial` row AVAILABLE (a flipped
    // GLOBAL row alone never releases trial writes) plus an explicit
    // disposable designation naming exactly the resolved account. No
    // designation, another account, or an inactive account fails closed
    // BEFORE any insert or port call. Other secret actions (notably
    // `subscription.provision`) are NOT governed here.
    const trialGate = decideTrialDispatchGate({
      action: input.action,
      trialCapability: await ctx.tx.getCapability(deps.trialCapabilityKey ?? TRIAL_CAPABILITY_KEY),
      designatedAccountId: deps.trialDisposableAccountId ?? trialDisposableAccountIdFromEnv(),
      providerAccountId: accountId,
    });
    if (trialGate !== "allow") {
      return { ok: false, code: "precondition_failed", message: TRIAL_GATE_MESSAGES[trialGate] };
    }
    if (!(await isProviderAccountActive(ctx, accountId))) {
      return { ok: false, code: "precondition_failed", message: TRIAL_GATE_MESSAGES.account_inactive };
    }
    // FASE5-FIX3-R1+R2 (SPEC §25/§26): canonical trial intent — the SAME
    // preparation the domain entry runs (`prepareTrialProvisionIntent`):
    // stable business key `trial-provision:{trialId}` (the caller-supplied
    // `idempotencyKey` is IGNORED for this action, so two caller keys for
    // the same trial can never mint two operations; an eligible FAILED
    // retry reopens the SAME row instead of inserting anew), the
    // REQUESTED→PROVISIONING move and the `provisioning_started` event.
    // Without the move the dispatcher applier would return early on a
    // REQUESTED trial and persist SUCCEEDED with no activation/binding.
    const { port: trialPort, capabilityNote: trialCapabilityNote } = resolved;
    const prepared = await prepareTrialProvisionIntent(
      ctx,
      pre.trial,
      {
        providerAccountId: accountId,
        // Branch-derived provenance: the reserved constant, never
        // `${port.name}-v1`, so a secret-requiring port named
        // `manual`/`echo` is never mistaken for synthetic.
        adapterVersion: SECRET_REQUIRED_ADAPTER_VERSION,
        requestedPayload: {
          ...shape.projectedPayload,
          adapter: trialPort.name,
          capability: trialCapabilityNote,
        },
        effectiveAdapter: trialPort.name,
        capabilityNote: trialCapabilityNote,
      },
    );
    if (!prepared.ok) {
      return { ok: false, code: "precondition_failed", message: prepared.message };
    }
    const trialOperation = prepared.operation;
    // FASE5-S6-FIX2 (SPEC §41): `trial.provision` ALWAYS queues — even in
    // inline mode — because its READ_CUSTOMER readback gate must run
    // post-commit with no open transaction. The durable dispatcher is the
    // single certified path for it.
    return { ok: true, data: { id: trialOperation.id, status: "QUEUED", effectCertainty: "UNKNOWN" } };
  }
  const { port, capabilityNote } = resolved;
  let operation;
  try {
    operation = await insertProviderOperation(ctx, {
      providerAccountId: accountId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      idempotencyKey: input.idempotencyKey,
      requestedPayload: {
        ...shape.projectedPayload,
        adapter: port.name,
        capability: capabilityNote,
      },
      // Branch-derived provenance: the reserved constant, never
      // `${port.name}-v1`, so a secret-requiring port named
      // `manual`/`echo` is never mistaken for synthetic.
      adapterVersion: SECRET_REQUIRED_ADAPTER_VERSION,
    });
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      return { ok: false, code: "precondition_failed", message: err.message };
    }
    throw err;
  }
  await emitProvider(ctx, {
    eventType: "provider.operation_requested.v1",
    operationId: operation.id,
    data: {
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      adapter: port.name,
    },
  });
  // CV-DSP-01 durable cut: the REQUESTED row + `operation_requested` event
  // are already committed by the caller transaction. In durable mode the
  // external port call moves to `ProviderDispatcherService.drainOnce`
  // (claim with lease → RUNNING + `dispatch_started_at` frontier → port
  // call → outcome via `applySecretPortOutcome`), so a crash here can never
  // strand an uncertain external effect. The response reports the logical
  // queue position (QUEUED/UNKNOWN, shape-CHECK-clean); the row flips
  // REQUESTED → QUEUED when the dispatcher claims it. Other secret actions
  // keep the current in-transaction port call untouched in inline mode.
  // FASE5-S6-FIX2 (SPEC §41): `trial.provision` ALWAYS queues — even in
  // inline mode — because its READ_CUSTOMER readback gate must run
  // post-commit with no open transaction (the former inline readback call
  // lived inside the command transaction, violating the reviewer
  // invariant). The durable dispatcher is the single certified path for it.
  if (providerDispatchModeFromEnv() === "durable" || (input.action === "trial.provision" && input.entityType === "trial")) {
    return { ok: true, data: { id: operation.id, status: "QUEUED", effectCertainty: "UNKNOWN" } };
  }
  // The port call may throw AFTER its external effect happened. Catch ONLY
  // this call (DB failures above/below still propagate and roll back): park
  // the already-REQUESTED operation in VERIFYING/UNKNOWN with the fixed
  // code, preserving the attempt/reservation with no completed_at, no
  // terminal event, no resume and no second call. The response is generic —
  // never the exception text or a ref. Crash/commit-failure protection is
  // explicitly NOT claimed here: that waits for durable post-commit
  // dispatch + readback, so Browser real stays blocked.
  let raw: Awaited<ReturnType<ProviderOpsPort["requestOperation"]>>;
  try {
    raw = await port.requestOperation({
      tenantId: ctx.tenantId,
      providerAccountId: accountId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      idempotencyKey: input.idempotencyKey,
      payload: { ...shape.projectedPayload },
      correlationId: ctx.correlationId,
      secretRef: gate.secretRef,
    });
  } catch {
    await updateProviderOperation(ctx, operation.id, {
      status: "VERIFYING",
      effectCertainty: "UNKNOWN",
      executionChannel: "MANUAL",
      resultSummary: { error_code: PROVIDER_CALL_UNCERTAIN_CODE },
      started: true,
    });
    await insertProviderAttempt(ctx, {
      operationId: operation.id,
      status: "VERIFYING",
      errorCode: PROVIDER_CALL_UNCERTAIN_CODE,
    });
    return { ok: true, data: { id: operation.id, status: "VERIFYING", effectCertainty: "UNKNOWN" } };
  }
  const applied = await applySecretPortOutcome(ctx, {
    operationId: operation.id,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    raw: { outcome: raw.outcome, detail: raw.detail, externalRef: raw.externalRef },
  });
  if (applied === null) {
    throw new Error("secret outcome applier lost its own inline row");
  }
  return { ok: true, data: { id: operation.id, status: applied.status, effectCertainty: applied.effectCertainty } };
}

/**
 * CV-DSP-01 shared secret-branch outcome applier: the ONE source of truth
 * for secret-required operation transitions (SUCCEEDED/FAILED/UNKNOWN/MANUAL
 * → terminal/VERIFYING/HUMAN_REQUIRED + safe evidence + resume + the fixed
 * `succeeded|failed` events). The inline request handler and the durable
 * dispatcher both call it — never duplicate these transitions.
 *
 * CV-DSP-02-FIX F3: for `trial.provision` on `entity_type=trial` this
 * function is a thin delegate to `applyTrialProvisionOutcome` (the trial
 * applier is the single source of truth for the trial domain effect). The
 * provider entry keeps its one genuine rule — the `via: "provider.resolve"`
 * trial-event provenance — as an explicit parameter, never as a duplicated
 * transition block. All other actions keep the generic transitions below
 * untouched.
 *
 * `raw` carries the port result; projection (`projectSecretPortResult`) and
 * the invalid-ref SUCCEEDED→UNKNOWN demotion happen in the delegated
 * applier (trial path) or here (generic path) so both callers share them.
 * Never persists/emits raw `detail`/`externalRef`.
 */
export interface SecretPortOutcomeInput {
  operationId: string;
  action: string;
  entityType: string;
  entityId: string;
  raw: { outcome: string; detail: string; externalRef: string | null };
  /**
   * FASE5-S6 (SPEC §25): the already-obtained READ_CUSTOMER readback for a
   * secret-required `trial.provision` SUCCEEDED, resolved by the caller
   * outside any transaction. Repassed to the trial applier, which owns the
   * postcondition decision. Other actions ignore it.
   */
  trialReadback?: TrialReadbackResult | null;
}

/**
 * CV-DSP-01-FIX D1: fencing for durable dispatch transitions.
 *
 * When `fence` is present AND the context carries a live Kysely transaction,
 * the terminal status write becomes a conditional UPDATE:
 * `WHERE claimed_by=$token AND status IN ('QUEUED','RUNNING')` (+ lease
 * cleared atomically in the same statement). Zero affected rows means the
 * claim was lost (recovery or a concurrent worker moved the row) — the
 * function returns `null` BEFORE writing any attempt/event/resume, so the
 * caller aborts without persisting a result. Terminal rows are never matched
 * by the WHERE, so a lost claim can never overwrite a terminal outcome.
 *
 * Without `fence` (inline path) behavior is unchanged (unconditional, never
 * returns null in practice). With `fence` on the memory path (unit tests,
 * no Kysely trx) it falls back to the unfenced behavior — durable fencing
 * is proven by the Postgres integration tests, not the memory fake (which
 * models no lease columns).
 */
export interface SecretPortOutcomeFence {
  claimedBy?: string;
  /**
   * FASE5-FIX3-R4: S3 reconcile CAS. When set, the status predicate becomes
   * `status = <expected>` (instead of the QUEUED/RUNNING pair) and the
   * `claimed_by` predicate applies only when `claimedBy` is also set
   * (reconcile owns no claim). On the memory path the expected status is
   * enforced by a pre-check (mismatch → `null` with zero side effects).
   */
  expectedStatus?: string;
}

async function fencedSecretOutcomeUpdate(
  ctx: CommandHandlerContext,
  operationId: string,
  fence: SecretPortOutcomeFence,
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

export async function applySecretPortOutcome(
  ctx: CommandHandlerContext,
  input: SecretPortOutcomeInput,
  fence?: SecretPortOutcomeFence,
): Promise<{ status: string; effectCertainty: string } | null> {
  // FASE5-FIX3-R4 (S3 CAS): same loser-silence contract as the trial
  // applier — a stale reconcile convergence over an already-moved row
  // writes nothing (no attempt/event/resume) on either store.
  if (fence?.expectedStatus !== undefined) {
    const current = await getProviderOperation(ctx, input.operationId);
    if (current === null || current.status !== fence.expectedStatus) {
      return null;
    }
  }
  // CV-DSP-02-FIX F3: the trial domain effect lives in exactly one place.
  // `provider.request_operation` with `trial.provision` (inline) and the
  // dispatcher (durable, via `selectDispatchApplier`) now run the SAME
  // applier; only the explicit `via` provenance differs per entry.
  if (input.action === "trial.provision" && input.entityType === "trial") {
    const applied = await applyTrialProvisionOutcome(
      ctx,
      {
        operationId: input.operationId,
        trialId: input.entityId,
        raw: input.raw,
        via: "provider.resolve",
        ...(input.trialReadback !== undefined ? { trialReadback: input.trialReadback } : {}),
      },
      fence !== undefined
        ? {
            ...(fence.claimedBy !== undefined ? { claimedBy: fence.claimedBy } : {}),
            ...(fence.expectedStatus !== undefined ? { expectedStatus: fence.expectedStatus } : {}),
          }
        : undefined,
    );
    if (applied === null) {
      return null;
    }
    return { status: applied.status, effectCertainty: applied.effectCertainty };
  }
  const projected = projectSecretPortResult(input.raw);
  const effectiveOutcome =
    projected.externalRefInvalid && projected.outcome === "SUCCEEDED" ? "UNKNOWN" : projected.outcome;
  if (effectiveOutcome === "SUCCEEDED") {
    if (fence !== undefined && kyselyTrxOf(ctx) !== null) {
      const claimed = await fencedSecretOutcomeUpdate(
        ctx,
        input.operationId,
        fence,
        {
          status: "SUCCEEDED",
          effectCertainty: "KNOWN_APPLIED",
          executionChannel: "MANUAL",
          resultSummary:
            projected.safeExternalRef !== null ? { external_ref: projected.safeExternalRef } : {},
          started: true,
          completed: true,
        },
      );
      if (!claimed) {
        return null;
      }
      await insertProviderAttempt(ctx, { operationId: input.operationId, status: "SUCCEEDED" });
      await emitProvider(ctx, {
        eventType: "provider.operation_succeeded.v1",
        operationId: input.operationId,
        data: { action: input.action, entity_id: input.entityId },
      });
      await resumeLinkedTrial(ctx, input.entityType, input.entityId, "SUCCEEDED", input.operationId);
      return { status: "SUCCEEDED", effectCertainty: "KNOWN_APPLIED" };
    }
    const updated = await updateProviderOperation(ctx, input.operationId, {
      status: "SUCCEEDED",
      effectCertainty: "KNOWN_APPLIED",
      executionChannel: "MANUAL",
      resultSummary:
        projected.safeExternalRef !== null ? { external_ref: projected.safeExternalRef } : {},
      started: true,
      completed: true,
    });
    await insertProviderAttempt(ctx, { operationId: input.operationId, status: "SUCCEEDED" });
    await emitProvider(ctx, {
      eventType: "provider.operation_succeeded.v1",
      operationId: input.operationId,
      data: { action: input.action, entity_id: input.entityId },
    });
    await resumeLinkedTrial(ctx, input.entityType, input.entityId, "SUCCEEDED", input.operationId);
    return {
      status: updated?.status ?? "SUCCEEDED",
      effectCertainty: "KNOWN_APPLIED",
    };
  }
  if (effectiveOutcome === "FAILED") {
    if (fence !== undefined && kyselyTrxOf(ctx) !== null) {
      const claimed = await fencedSecretOutcomeUpdate(
        ctx,
        input.operationId,
        fence,
        {
          status: "FAILED",
          effectCertainty: "KNOWN_NOT_APPLIED",
          executionChannel: "MANUAL",
          resultSummary: { error_code: "ADAPTER_FAILED" },
          started: true,
          completed: true,
        },
      );
      if (!claimed) {
        return null;
      }
      await insertProviderAttempt(ctx, { operationId: input.operationId, status: "FAILED", errorCode: "ADAPTER_FAILED" });
      await emitProvider(ctx, {
        eventType: "provider.operation_failed.v1",
        operationId: input.operationId,
        data: { action: input.action, entity_id: input.entityId },
      });
      await resumeLinkedTrial(ctx, input.entityType, input.entityId, "FAILED", input.operationId);
      return { status: "FAILED", effectCertainty: "KNOWN_NOT_APPLIED" };
    }
    await updateProviderOperation(ctx, input.operationId, {
      status: "FAILED",
      effectCertainty: "KNOWN_NOT_APPLIED",
      executionChannel: "MANUAL",
      resultSummary: { error_code: "ADAPTER_FAILED" },
      started: true,
      completed: true,
    });
    await insertProviderAttempt(ctx, { operationId: input.operationId, status: "FAILED", errorCode: "ADAPTER_FAILED" });
    await emitProvider(ctx, {
      eventType: "provider.operation_failed.v1",
      operationId: input.operationId,
      data: { action: input.action, entity_id: input.entityId },
    });
    await resumeLinkedTrial(ctx, input.entityType, input.entityId, "FAILED", input.operationId);
    return { status: "FAILED", effectCertainty: "KNOWN_NOT_APPLIED" };
  }
  if (effectiveOutcome === "UNKNOWN") {
    if (fence !== undefined && kyselyTrxOf(ctx) !== null) {
      const claimed = await fencedSecretOutcomeUpdate(
        ctx,
        input.operationId,
        fence,
        {
          status: "VERIFYING",
          effectCertainty: "UNKNOWN",
          executionChannel: "MANUAL",
          resultSummary: {},
          started: true,
          completed: false,
        },
      );
      if (!claimed) {
        return null;
      }
      await insertProviderAttempt(ctx, { operationId: input.operationId, status: "VERIFYING", errorCode: "EFFECT_UNKNOWN" });
      return { status: "VERIFYING", effectCertainty: "UNKNOWN" };
    }
    await updateProviderOperation(ctx, input.operationId, {
      status: "VERIFYING",
      effectCertainty: "UNKNOWN",
      executionChannel: "MANUAL",
      resultSummary: {},
      started: true,
    });
    await insertProviderAttempt(ctx, { operationId: input.operationId, status: "VERIFYING", errorCode: "EFFECT_UNKNOWN" });
    return { status: "VERIFYING", effectCertainty: "UNKNOWN" };
  }
  if (fence !== undefined && kyselyTrxOf(ctx) !== null) {
    const claimed = await fencedSecretOutcomeUpdate(
      ctx,
      input.operationId,
      fence,
      {
        status: "HUMAN_REQUIRED",
        effectCertainty: "UNKNOWN",
        executionChannel: "MANUAL",
        resultSummary: {},
        started: true,
        completed: false,
      },
    );
    if (!claimed) {
      return null;
    }
    await insertProviderAttempt(ctx, { operationId: input.operationId, status: "HUMAN_REQUIRED" });
    return { status: "HUMAN_REQUIRED", effectCertainty: "UNKNOWN" };
  }
  await updateProviderOperation(ctx, input.operationId, {
    status: "HUMAN_REQUIRED",
    effectCertainty: "UNKNOWN",
    executionChannel: "MANUAL",
    resultSummary: {},
    started: true,
  });
  await insertProviderAttempt(ctx, { operationId: input.operationId, status: "HUMAN_REQUIRED" });
  return { status: "HUMAN_REQUIRED", effectCertainty: "UNKNOWN" };
}

function handleRequestFactory(deps: ProviderCommandDeps) {
  return async (
    ctx: CommandHandlerContext,
    input: RequestOperationInput,
  ): Promise<CommandResult<{ id: string; status: string; effectCertainty: string }>> => {
    const fallback: "echo" | "manual" =
      deps.opsPort !== undefined
        ? deps.opsPort.name === "echo"
          ? "echo"
          : "manual"
        : adapterNameFromEnv();
    const requested: "echo" | "manual" = input.adapter ?? fallback;
    const capability = await ctx.tx.getCapability("provider.cinevision");
    const { name: adapterName, note: capabilityNote } = applyCapabilityGate(requested, capability);
    // PF-05: an injected secret-requiring (future BROWSER) port bypasses the
    // echo/manual selection so the gate below always runs for it. Public
    // inputs stay `echo | manual`; no real BROWSER is enabled here.
    const injectedSecretPort =
      deps.opsPort !== undefined && isSecretRequiringPort(deps.opsPort) ? deps.opsPort : null;
    const port =
      injectedSecretPort ??
      (deps.opsPort !== undefined && (deps.opsPort.name === "echo") === (adapterName === "echo")
        ? deps.opsPort
        : resolveOpsPort(adapterName));
    const secretRequired = isSecretRequiringPort(port);
    // Capability UNAVAILABLE wins over injection: never call the port and
    // never create a REQUESTED operation on the secret-required path.
    if (secretRequired && isCapabilityUnavailable(capability)) {
      return {
        ok: false,
        code: "precondition_failed",
        message: "provider capability unavailable; secret-required operations are blocked",
      };
    }
    if (secretRequired) {
      return handleSecretRequest(ctx, input, deps, { port, capabilityNote });
    }
    // Public echo/manual frontier: reject secret-like nested payloads,
    // ref-like values and abusive shapes BEFORE any insert/event/port
    // call. Never merely strip. (The secret-required path above enforces
    // its stricter allowlist instead — not weakened here.)
    const publicShape = validatePublicRequestPayload(input.payload);
    if (!publicShape.ok) {
      return { ok: false, code: "validation_failed", message: publicShape.message };
    }
    if (input.action === "trial.provision" && input.entityType === "trial") {
      // SPEC §25: the public echo/manual entry to `trial.provision` enforces
      // the same pre-dispatch trial preconditions as the domain entry —
      // before account resolution (which CREATES the placeholder) so a
      // refused trial request leaves zero rows anywhere and never calls
      // the port.
      const pre = await assertTrialProvisionPreconditions(ctx, input.entityId);
      if (!pre.ok) {
        return pre;
      }
      // FASE5-FIX3-R1+R2: keep the canonical trial intent for the shared
      // preparation below (business key + PROVISIONING move, exactly like
      // the domain entry). Synthetic echo/manual stays inline dev
      // convenience — only the identity/preparation is canonicalized.
      const canonicalTrial = pre.trial;
      const trialAccount = await resolveAccountId(ctx, input.providerAccountId);
      if ("error" in trialAccount) {
        return trialAccount.error;
      }
      const trialEffectiveAdapter = injectedSecretPort !== null ? port.name : adapterName;
      const trialPrepared = await prepareTrialProvisionIntent(
        ctx,
        canonicalTrial,
        {
          providerAccountId: trialAccount.id,
          adapterVersion: `${port.name}-v1`,
          // Never persist caller secret keys nor the validated ref: the row
          // carries only routing metadata.
          requestedPayload: {
            ...stripSecretKeysFromPayload(input.payload),
            adapter: trialEffectiveAdapter,
            capability: capabilityNote,
          },
          effectiveAdapter: trialEffectiveAdapter,
          capabilityNote,
        },
      );
      if (!trialPrepared.ok) {
        return { ok: false, code: "precondition_failed", message: trialPrepared.message };
      }
      const trialOperation = trialPrepared.operation;
      const trialResult = await port.requestOperation({
        tenantId: ctx.tenantId,
        providerAccountId: trialAccount.id,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        idempotencyKey: trialProvisionBusinessKey(input.entityId),
        payload: {
          ...stripSecretKeysFromPayload(input.payload),
          ...(input.echoOutcome !== undefined ? { __echo_outcome: input.echoOutcome } : {}),
        },
        correlationId: ctx.correlationId,
      });
      if (trialResult.outcome === "SUCCEEDED") {
        const trialUpdated = await updateProviderOperation(ctx, trialOperation.id, {
          status: "SUCCEEDED",
          effectCertainty: "KNOWN_APPLIED",
          executionChannel: "MANUAL",
          resultSummary: { detail: trialResult.detail, external_ref: trialResult.externalRef },
          started: true,
          completed: true,
        });
        await insertProviderAttempt(ctx, { operationId: trialOperation.id, status: "SUCCEEDED" });
        await emitProvider(ctx, {
          eventType: "provider.operation_succeeded.v1",
          operationId: trialOperation.id,
          data: { action: input.action, entity_id: input.entityId },
        });
        await resumeLinkedTrial(ctx, input.entityType, input.entityId, "SUCCEEDED", trialOperation.id);
        return {
          ok: true,
          data: { id: trialOperation.id, status: trialUpdated?.status ?? "SUCCEEDED", effectCertainty: "KNOWN_APPLIED" },
        };
      }
      if (trialResult.outcome === "FAILED") {
        await updateProviderOperation(ctx, trialOperation.id, {
          status: "FAILED",
          effectCertainty: "KNOWN_NOT_APPLIED",
          executionChannel: "MANUAL",
          resultSummary: { detail: trialResult.detail },
          started: true,
          completed: true,
        });
        await insertProviderAttempt(ctx, { operationId: trialOperation.id, status: "FAILED", errorCode: "ADAPTER_FAILED" });
        await emitProvider(ctx, {
          eventType: "provider.operation_failed.v1",
          operationId: trialOperation.id,
          data: { action: input.action, entity_id: input.entityId, detail: trialResult.detail },
        });
        await resumeLinkedTrial(ctx, input.entityType, input.entityId, "FAILED", trialOperation.id);
        return { ok: true, data: { id: trialOperation.id, status: "FAILED", effectCertainty: "KNOWN_NOT_APPLIED" } };
      }
      if (trialResult.outcome === "UNKNOWN") {
        await updateProviderOperation(ctx, trialOperation.id, {
          status: "VERIFYING",
          effectCertainty: "UNKNOWN",
          executionChannel: "MANUAL",
          resultSummary: { detail: trialResult.detail },
          started: true,
        });
        await insertProviderAttempt(ctx, { operationId: trialOperation.id, status: "VERIFYING", errorCode: "EFFECT_UNKNOWN" });
        return { ok: true, data: { id: trialOperation.id, status: "VERIFYING", effectCertainty: "UNKNOWN" } };
      }
      await updateProviderOperation(ctx, trialOperation.id, {
        status: "HUMAN_REQUIRED",
        effectCertainty: "UNKNOWN",
        executionChannel: "MANUAL",
        resultSummary: { detail: trialResult.detail },
        started: true,
      });
      await insertProviderAttempt(ctx, { operationId: trialOperation.id, status: "HUMAN_REQUIRED" });
      return { ok: true, data: { id: trialOperation.id, status: "HUMAN_REQUIRED", effectCertainty: "UNKNOWN" } };
    }
    const account = await resolveAccountId(ctx, input.providerAccountId);
    if ("error" in account) {
      return account.error;
    }
    let operation;
    try {
      operation = await insertProviderOperation(ctx, {
        providerAccountId: account.id,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        idempotencyKey: input.idempotencyKey,
        // Never persist caller secret keys nor the validated ref: the row
        // carries only routing metadata; the worker resolves credentials
        // via providerAccountId (+ the in-memory secretRef below).
        requestedPayload: {
          ...stripSecretKeysFromPayload(input.payload),
          adapter: injectedSecretPort !== null ? port.name : adapterName,
          capability: capabilityNote,
        },
        adapterVersion: `${port.name}-v1`,
      });
    } catch (err) {
      if (err instanceof UniqueViolationError) {
        return { ok: false, code: "precondition_failed", message: err.message };
      }
      throw err;
    }
    await emitProvider(ctx, {
      eventType: "provider.operation_requested.v1",
      operationId: operation.id,
      data: {
        action: input.action,
        entity_type: input.entityType,
        entity_id: input.entityId,
        adapter: injectedSecretPort !== null ? port.name : adapterName,
      },
    });
    const result = await port.requestOperation({
      tenantId: ctx.tenantId,
      providerAccountId: account.id,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      idempotencyKey: input.idempotencyKey,
      payload: {
        ...stripSecretKeysFromPayload(input.payload),
        ...(input.echoOutcome !== undefined ? { __echo_outcome: input.echoOutcome } : {}),
      },
      correlationId: ctx.correlationId,
    });
    if (result.outcome === "SUCCEEDED") {
      const updated = await updateProviderOperation(ctx, operation.id, {
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
        data: { action: input.action, entity_id: input.entityId },
      });
      await resumeLinkedTrial(ctx, input.entityType, input.entityId, "SUCCEEDED", operation.id);
      return {
        ok: true,
        data: { id: operation.id, status: updated?.status ?? "SUCCEEDED", effectCertainty: "KNOWN_APPLIED" },
      };
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
      await insertProviderAttempt(ctx, { operationId: operation.id, status: "FAILED", errorCode: "ADAPTER_FAILED" });
      await emitProvider(ctx, {
        eventType: "provider.operation_failed.v1",
        operationId: operation.id,
        data: { action: input.action, entity_id: input.entityId, detail: result.detail },
      });
      await resumeLinkedTrial(ctx, input.entityType, input.entityId, "FAILED", operation.id);
      return { ok: true, data: { id: operation.id, status: "FAILED", effectCertainty: "KNOWN_NOT_APPLIED" } };
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
      return { ok: true, data: { id: operation.id, status: "VERIFYING", effectCertainty: "UNKNOWN" } };
    }
    await updateProviderOperation(ctx, operation.id, {
      status: "HUMAN_REQUIRED",
      effectCertainty: "UNKNOWN",
      executionChannel: "MANUAL",
      resultSummary: { detail: result.detail },
      started: true,
    });
    await insertProviderAttempt(ctx, { operationId: operation.id, status: "HUMAN_REQUIRED" });
    return { ok: true, data: { id: operation.id, status: "HUMAN_REQUIRED", effectCertainty: "UNKNOWN" } };
  };
}

async function handleResolve(
  ctx: CommandHandlerContext,
  input: ResolveOperationInput,
): Promise<CommandResult<{ id: string; status: string; effectCertainty: string; resumedTrial: boolean }>> {
  const operation = await getProviderOperation(ctx, input.operationId);
  if (operation === null) {
    return { ok: false, code: "not_found", message: "provider operation not found in this tenant" };
  }
  if ((TERMINAL_OPERATION_STATUSES as readonly string[]).includes(operation.status)) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `operation is already ${operation.status}`,
    };
  }
  if (input.outcome === "UNKNOWN") {
    // FASE5-FIX4-N4 (SPEC §16): the park is fenced on the status observed
    // at read time — a concurrent `reconcileOnce` convergence (CAS-fenced
    // on VERIFYING) that terminalized the row between the read and this
    // write makes the fenced write lose (null) instead of overwriting
    // convergence back to VERIFYING with a stale merged resultSummary.
    // Snapshot the observation BEFORE the write: on the memory store
    // `operation` is a live row reference, so a concurrent move would
    // otherwise rewrite both the fence predicate and the loser message.
    const observedStatus = operation.status;
    const updated = await updateProviderOperation(
      ctx,
      operation.id,
      {
        status: "VERIFYING",
        effectCertainty: "UNKNOWN",
        resultSummary: { ...(operation.resultSummary ?? {}), resolve_note: input.note ?? null },
      },
      { expectedStatuses: [observedStatus] },
    );
    if (updated === null) {
      return {
        ok: false,
        code: "precondition_failed",
        message: `operation changed concurrently (observed ${observedStatus}); retry against current state`,
      };
    }
    await insertProviderAttempt(ctx, { operationId: operation.id, status: "VERIFYING", errorCode: "EFFECT_UNKNOWN" });
    // No `verification_required` public event exists (known catalog gap):
    // audit-only by design.
    return {
      ok: true,
      data: { id: operation.id, status: updated?.status ?? "VERIFYING", effectCertainty: "UNKNOWN", resumedTrial: false },
    };
  }
  // PF-05 (MVP-PF05-SECRETREF-05 finding 1, HIGH): a secret-required
  // operation (persisted branch-derived `adapter_version`, never taken from
  // request input — `resolveOperationInput` carries no adapterVersion and
  // `requestedPayload` copies never feed this check) can never be
  // terminalized by manual resolve. SUCCEEDED/FAILED here would conclude an
  // uncertain external effect without conclusive readback. Reject BEFORE any
  // mutation/event/resume with a generic precondition failure; the only
  // resolution path is `provider.reconcile` (which schedules the durable
  // dispatcher recovery — conclusive readback terminalizes there,
  // inconclusive readback converges the op to HUMAN_REQUIRED per §16/§39).
  // UNKNOWN above still parks VERIFYING (no terminal claim).
  if (
    typeof operation.adapterVersion === "string" &&
    operation.adapterVersion.toLowerCase() === SECRET_REQUIRED_ADAPTER_VERSION.toLowerCase()
  ) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "secret-required operations resolve only via provider.reconcile with conclusive readback",
    };
  }
  const terminal = input.outcome;
  const effectCertainty = terminal === "SUCCEEDED" ? "KNOWN_APPLIED" : "KNOWN_NOT_APPLIED";
  await updateProviderOperation(ctx, operation.id, {
    status: terminal,
    effectCertainty,
    resultSummary: { ...(operation.resultSummary ?? {}), resolve_note: input.note ?? null },
    started: true,
    completed: true,
  });
  await insertProviderAttempt(ctx, { operationId: operation.id, status: terminal });
  await emitProvider(ctx, {
    eventType: terminal === "SUCCEEDED" ? "provider.operation_succeeded.v1" : "provider.operation_failed.v1",
    operationId: operation.id,
    data: { action: operation.action, entity_id: operation.entityId, resolve_note: input.note ?? null },
  });
  const { resumedTrial } = await resumeLinkedTrial(
    ctx,
    operation.entityType,
    operation.entityId,
    terminal,
    operation.id,
  );
  return { ok: true, data: { id: operation.id, status: terminal, effectCertainty, resumedTrial } };
}

/**
 * FASE5-S3: branch-derived provenance check shared by the reconcile path.
 * True only for the reserved `secret-required-v1` adapter version persisted
 * by the secret-required branches — never request input, never a port name.
 * (Same predicate `handleResolve` inlines; kept as a helper here so the
 * reconcile guard and the inconclusive-convergence branch cannot drift.)
 */
function isSecretRequiredRow(operation: { adapterVersion: string | null }): boolean {
  return (
    typeof operation.adapterVersion === "string" &&
    operation.adapterVersion.toLowerCase() === SECRET_REQUIRED_ADAPTER_VERSION.toLowerCase()
  );
}

/**
 * FASE5-FIX4-N1/N2 (SPEC §12/§41): pure reconcile decision for a
 * VERIFYING secret-required `trial.provision` — NO I/O, safe to unit-test.
 * The caller resolves BOTH readbacks OUTSIDE any transaction (durable
 * dispatcher recovery) and applies the decision in a short CAS-fenced
 * write (`expectedStatus: "VERIFYING"`):
 *
 * - generic readback inconclusive → `converge-human-required` (S3, never a
 *   re-send, certainty stays UNKNOWN);
 * - generic conclusive NOT_APPLIED WITH a persisted `external_ref` anchor
 *   → `fail-not-applied` (FAILED/REQUESTED, no effect proven, trial
 *   readback never consulted);
 * - generic conclusive NOT_APPLIED WITHOUT an anchor →
 *   `converge-human-required` (FIX4-N5: the timeout/uncertainty parks
 *   persist `result_summary_json` WITHOUT `external_ref` - a "not applied"
 *   answer on such a row is indistinguishable from having observed the
 *   wrong resource or stale provider state. Treating it as proof would
 *   re-arm the trial (REQUESTED) and authorize a SECOND real write from
 *   uncertainty (SPEC §16/§39). Without the anchor only a human decides);
 * - generic conclusive APPLIED + conclusive trial readback WITH a customer
 *   → `gate-succeeded` (postcondition + binding owned by the applier);
 * - generic conclusive APPLIED but trial readback absent/inconclusive OR
 *   conclusive-WITHOUT-customer → `converge-human-required` DIRECTLY (N2:
 *   a conclusive snapshot with `customer: null` carries no proof, so it
 *   converges HUMAN_REQUIRED instead of re-parking VERIFYING through the
 *   applier — no self-loop on repeated recovery).
 */
export type VerifyingTrialReconcileDecision =
  | { kind: "converge-human-required" }
  | { kind: "fail-not-applied" }
  | { kind: "gate-succeeded"; trialReadback: TrialReadbackResult };

/**
 * `anchor.externalRef` is the provider-acknowledged reference persisted in
 * `result_summary_json.external_ref`. It is REQUIRED (not optional) so a
 * future caller cannot "forget" it: without an anchor the NOT_APPLIED
 * branch is unreachable and the decision fails closed to HITL.
 */
export function decideVerifyingTrialReconcile(
  observed: { conclusive: boolean; effectApplied: boolean },
  trialReadback: TrialReadbackResult | null,
  anchor: { externalRef: string | null },
): VerifyingTrialReconcileDecision {
  if (observed.conclusive !== true) {
    return { kind: "converge-human-required" };
  }
  if (!observed.effectApplied) {
    // FIX4-N5: no identity anchor → the readback cannot be tied to THIS
    // operation's external effect; "not applied" is not proof. Converge to
    // HUMAN_REQUIRED - never an automatic re-arm for a second real write.
    if (anchor.externalRef === null) {
      return { kind: "converge-human-required" };
    }
    return { kind: "fail-not-applied" };
  }
  if (trialReadback === null || trialReadback.conclusive !== true || trialReadback.customer === null) {
    return { kind: "converge-human-required" };
  }
  return { kind: "gate-succeeded", trialReadback };
}

function handleReconcileFactory(deps: ProviderCommandDeps) {
  const readback: ProviderReadbackPort = deps.readbackPort ?? new StubProviderReadback();
  return async (
    ctx: CommandHandlerContext,
    input: ReconcileOperationInput,
  ): Promise<
    CommandResult<{ id: string; status: string; effectCertainty: string; effectApplied: boolean; resumedTrial: boolean; reconciliation?: "scheduled" }>
  > => {
    const operation = await getProviderOperation(ctx, input.operationId);
    if (operation === null) {
      return { ok: false, code: "not_found", message: "provider operation not found in this tenant" };
    }
    if (operation.status !== "VERIFYING") {
      // FASE5-S3 (SPEC §16/§39): a secret-required op already converged to
      // HUMAN_REQUIRED by an earlier inconclusive reconcile is stable — a
      // repeat reconcile is an honest no-op (same state echoed, zero writes,
      // zero events). Synthetic (echo/manual) HUMAN_REQUIRED rows keep the
      // strict refusal below: their resolve path owns them.
      if (operation.status === "HUMAN_REQUIRED" && isSecretRequiredRow(operation)) {
        return {
          ok: true,
          data: {
            id: operation.id,
            status: operation.status,
            effectCertainty: operation.effectCertainty,
            effectApplied: false,
            resumedTrial: false,
          },
        };
      }
      return {
        ok: false,
        code: "precondition_failed",
        message: `operation is ${operation.status}; reconcile requires VERIFYING`,
      };
    }
    // FASE5-FIX4-N1 (SPEC §12/§41, reviewer invariant): a secret-required
    // `trial.provision` in VERIFYING NEVER awaits a provider/readback port
    // inside this command transaction — the READ_CUSTOMER readback used to
    // run here with the tx open. Reconcile only SCHEDULES: the row stays
    // VERIFYING/UNKNOWN with zero writes, and the durable dispatcher
    // recovery (`reconcileOnce`, via scheduler/admin drain, outside any
    // transaction with CAS on VERIFYING) executes the shared
    // readback+postcondition+binding gate. The response is honest: still
    // VERIFYING, nothing resumed, reconciliation scheduled. Synthetic
    // (echo/manual) rows keep the direct in-transaction behavior below (dev
    // convenience); other secret-required actions keep their existing path.
    if (
      isSecretRequiredRow(operation) &&
      operation.action === "trial.provision" &&
      operation.entityType === "trial"
    ) {
      return {
        ok: true,
        data: {
          id: operation.id,
          status: "VERIFYING",
          effectCertainty: "UNKNOWN",
          effectApplied: false,
          resumedTrial: false,
          reconciliation: "scheduled" as const,
        },
      };
    }
    // Readback observes; reconcile never re-executes the operation. The
    // persisted adapter provenance gates the stub (strict mode): an
    // inconclusive readback is "no proof either way", never a default
    // not-applied. The free-form `observed.evidence` string is NEVER
    // persisted or emitted — only fixed outcome codes cross the boundary.
    const requestedAdapter =
      operation.requestedPayload !== null &&
      typeof operation.requestedPayload === "object" &&
      typeof (operation.requestedPayload as Record<string, unknown>)["adapter"] === "string"
        ? ((operation.requestedPayload as Record<string, unknown>)["adapter"] as string)
        : null;
    const observed = await readback.verify({
      tenantId: ctx.tenantId,
      operationId: operation.id,
      action: operation.action,
      externalRef:
        typeof operation.resultSummary?.["external_ref"] === "string"
          ? (operation.resultSummary["external_ref"] as string)
          : null,
      adapter: requestedAdapter,
      adapterVersion: operation.adapterVersion,
    });
    // PF-05 (MVP-PF05-SECRETREF-03): inconclusive readback on a SYNTHETIC
    // operation preserves VERIFYING + UNKNOWN with zero terminal side
    // effects — no status or certainty write, no completed_at, no
    // succeeded/failed event, no retry, no resume. The response asserts no
    // terminal decision.
    //
    // FASE5-S3 (SPEC §16 write incerta → VERIFYING → readback, §39 HITL
    // fallback): inconclusive readback on a SECRET-REQUIRED operation
    // converges VERIFYING → HUMAN_REQUIRED through the SAME shared outcome
    // applier the dispatcher uses (`applySecretPortOutcome`, which delegates
    // `trial.provision` to the trial applier). Raw MANUAL keeps certainty at
    // UNKNOWN, emits no terminal event, resumes nothing and NEVER re-sends
    // the operation.
    //
    // FASE5-FIX3-R4 (SPEC §16): the convergence is CAS-fenced on
    // `status='VERIFYING'` — a delayed loser whose row already moved writes
    // nothing (no attempt/event/resume) and exits silently.
    if (observed.conclusive !== true) {
      if (!isSecretRequiredRow(operation)) {
        return {
          ok: true,
          data: {
            id: operation.id,
            status: "VERIFYING",
            effectCertainty: "UNKNOWN",
            effectApplied: false,
            resumedTrial: false,
          },
        };
      }
      const converged = await applySecretPortOutcome(
        ctx,
        {
          operationId: operation.id,
          action: operation.action,
          entityType: operation.entityType,
          entityId: operation.entityId,
          raw: { outcome: "MANUAL", detail: "reconcile: inconclusive readback", externalRef: null },
        },
        { expectedStatus: "VERIFYING" },
      );
      if (converged === null) {
        const loser = await getProviderOperation(ctx, operation.id);
        return {
          ok: true,
          data: {
            id: operation.id,
            status: loser?.status ?? operation.status,
            effectCertainty: loser?.effectCertainty ?? operation.effectCertainty,
            effectApplied: false,
            resumedTrial: false,
          },
        };
      }
      return {
        ok: true,
        data: {
          id: operation.id,
          status: converged.status,
          effectCertainty: converged.effectCertainty,
          effectApplied: false,
          resumedTrial: false,
        },
      };
    }
    // FASE5-FIX4-N1: the secret-required `trial.provision` gate (conclusive
    // readback → readback+postcondition+binding via `applyTrialProvisionOutcome`)
    // no longer runs here — it moved to the durable dispatcher recovery
    // (`reconcileOnce`: readback outside any transaction, CAS-fenced write,
    // decided by the shared `decideVerifyingTrialReconcile`). The scheduled
    // branch above returns before any port await, so a real trial
    // reconciliation never holds this command transaction open during
    // provider I/O. Echo/manual conclusive reconcile keeps the direct
    // terminalization below (dev convenience).
    const terminal = observed.effectApplied ? "SUCCEEDED" : "FAILED";
    const effectCertainty = observed.effectApplied ? "KNOWN_APPLIED" : "KNOWN_NOT_APPLIED";
    const reconcileOutcome = observed.effectApplied ? "APPLIED" : "NOT_APPLIED";
    // FASE5-FIX3-R4: CAS on the expected VERIFYING status — a concurrent
    // conclusive resolution already terminalized the row when this matches
    // zero rows, so the loser writes no attempt/event/resume.
    const claimed = await compareAndSetProviderOperation(ctx, operation.id, "VERIFYING", {
      status: terminal,
      effectCertainty,
      resultSummary: {
        ...(operation.resultSummary ?? {}),
        reconcile_outcome: reconcileOutcome,
        effect_applied: observed.effectApplied,
        reconcile_evidence_code: observed.effectApplied ? "READBACK_APPLIED" : "READBACK_NOT_APPLIED",
      },
      completed: true,
    });
    if (claimed === null) {
      const loser = await getProviderOperation(ctx, operation.id);
      return {
        ok: true,
        data: {
          id: operation.id,
          status: loser?.status ?? operation.status,
          effectCertainty: loser?.effectCertainty ?? operation.effectCertainty,
          effectApplied: observed.effectApplied,
          resumedTrial: false,
        },
      };
    }
    await insertProviderAttempt(ctx, { operationId: operation.id, status: terminal });
    await emitProvider(ctx, {
      eventType: observed.effectApplied ? "provider.operation_succeeded.v1" : "provider.operation_failed.v1",
      operationId: operation.id,
      data: { action: operation.action, entity_id: operation.entityId, reconcile_outcome: reconcileOutcome },
    });
    const { resumedTrial } = await resumeLinkedTrial(
      ctx,
      operation.entityType,
      operation.entityId,
      terminal,
      operation.id,
    );
    return {
      ok: true,
      data: { id: operation.id, status: terminal, effectCertainty, effectApplied: observed.effectApplied, resumedTrial },
    };
  };
}

export function registerProviderCommands(bus: CommandBus, deps: ProviderCommandDeps = {}): void {
  bus.register<RequestOperationInput, { id: string; status: string; effectCertainty: string }>({
    name: "provider.request_operation",
    permission: "provider.operation.write",
    auditAction: "provider.request_operation",
    auditResource: "provider_operation",
    input: requestOperationInput,
    handler: handleRequestFactory(deps),
  });
  bus.register<
    ResolveOperationInput,
    { id: string; status: string; effectCertainty: string; resumedTrial: boolean }
  >({
    name: "provider.resolve_operation",
    permission: "provider.operation.write",
    auditAction: "provider.resolve_operation",
    auditResource: "provider_operation",
    input: resolveOperationInput,
    handler: handleResolve,
  });
  bus.register<
    ReconcileOperationInput,
    { id: string; status: string; effectCertainty: string; effectApplied: boolean; resumedTrial: boolean }
  >({
    name: "provider.reconcile",
    permission: "provider.operation.write",
    auditAction: "provider.reconcile",
    auditResource: "provider_operation",
    input: reconcileOperationInput,
    handler: handleReconcileFactory(deps),
  });
}
