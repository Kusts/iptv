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
  resolveOpsPort,
  type ProviderOpsPort,
  type ProviderReadbackPort,
} from "./provider-port.js";
import { resolveSecretsPort, type SecretsPort } from "@iptv/secrets";
import {
  assertBrowserSecretReady,
  findExistingTrialProviderAccountId,
  getProviderAccountSecretRef,
  isCapabilityUnavailable,
  isSecretRequiringPort,
  projectSecretPortResult,
  PROVIDER_CALL_UNCERTAIN_CODE,
  stripSecretKeysFromPayload,
  validatePublicRequestPayload,
  validateSecretRequestShape,
} from "./provider-secret-gate.js";
import {
  UniqueViolationError,
  applyProviderTerminalOutcome,
  ensureTrialProviderAccount,
  getProviderOperation,
  insertProviderAttempt,
  insertProviderOperation,
  trialMemoryOf,
  updateProviderOperation,
} from "../trial/trial-store.js";
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
 *   re-executes the operation. An inconclusive readback (`conclusive=false`,
 *   e.g. stub without explicit effect or a secret-required operation under
 *   the synthetic stub) preserves VERIFYING + UNKNOWN with no terminal
 *   write, event, retry or resume; only fixed outcome codes are persisted
 *   or emitted, never free-form readback evidence.
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
  const projected = projectSecretPortResult(raw);
  const effectiveOutcome =
    projected.externalRefInvalid && projected.outcome === "SUCCEEDED" ? "UNKNOWN" : projected.outcome;
  if (effectiveOutcome === "SUCCEEDED") {
    const updated = await updateProviderOperation(ctx, operation.id, {
      status: "SUCCEEDED",
      effectCertainty: "KNOWN_APPLIED",
      executionChannel: "MANUAL",
      resultSummary:
        projected.safeExternalRef !== null ? { external_ref: projected.safeExternalRef } : {},
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
  if (effectiveOutcome === "FAILED") {
    await updateProviderOperation(ctx, operation.id, {
      status: "FAILED",
      effectCertainty: "KNOWN_NOT_APPLIED",
      executionChannel: "MANUAL",
      resultSummary: { error_code: "ADAPTER_FAILED" },
      started: true,
      completed: true,
    });
    await insertProviderAttempt(ctx, { operationId: operation.id, status: "FAILED", errorCode: "ADAPTER_FAILED" });
    await emitProvider(ctx, {
      eventType: "provider.operation_failed.v1",
      operationId: operation.id,
      data: { action: input.action, entity_id: input.entityId },
    });
    await resumeLinkedTrial(ctx, input.entityType, input.entityId, "FAILED", operation.id);
    return { ok: true, data: { id: operation.id, status: "FAILED", effectCertainty: "KNOWN_NOT_APPLIED" } };
  }
  if (effectiveOutcome === "UNKNOWN") {
    await updateProviderOperation(ctx, operation.id, {
      status: "VERIFYING",
      effectCertainty: "UNKNOWN",
      executionChannel: "MANUAL",
      resultSummary: {},
      started: true,
    });
    await insertProviderAttempt(ctx, { operationId: operation.id, status: "VERIFYING", errorCode: "EFFECT_UNKNOWN" });
    return { ok: true, data: { id: operation.id, status: "VERIFYING", effectCertainty: "UNKNOWN" } };
  }
  await updateProviderOperation(ctx, operation.id, {
    status: "HUMAN_REQUIRED",
    effectCertainty: "UNKNOWN",
    executionChannel: "MANUAL",
    resultSummary: {},
    started: true,
  });
  await insertProviderAttempt(ctx, { operationId: operation.id, status: "HUMAN_REQUIRED" });
  return { ok: true, data: { id: operation.id, status: "HUMAN_REQUIRED", effectCertainty: "UNKNOWN" } };
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
    const updated = await updateProviderOperation(ctx, operation.id, {
      status: "VERIFYING",
      effectCertainty: "UNKNOWN",
      resultSummary: { ...(operation.resultSummary ?? {}), resolve_note: input.note ?? null },
    });
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
  // resolution path is `provider.reconcile` with trusted/conclusive
  // readback. UNKNOWN above still parks VERIFYING (no terminal claim).
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

function handleReconcileFactory(deps: ProviderCommandDeps) {
  const readback: ProviderReadbackPort = deps.readbackPort ?? new StubProviderReadback();
  return async (
    ctx: CommandHandlerContext,
    input: ReconcileOperationInput,
  ): Promise<
    CommandResult<{ id: string; status: string; effectCertainty: string; effectApplied: boolean; resumedTrial: boolean }>
  > => {
    const operation = await getProviderOperation(ctx, input.operationId);
    if (operation === null) {
      return { ok: false, code: "not_found", message: "provider operation not found in this tenant" };
    }
    if (operation.status !== "VERIFYING") {
      return {
        ok: false,
        code: "precondition_failed",
        message: `operation is ${operation.status}; reconcile requires VERIFYING`,
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
    // PF-05 (MVP-PF05-SECRETREF-03): inconclusive readback preserves
    // VERIFYING + UNKNOWN with zero terminal side effects — no status or
    // certainty write, no completed_at, no succeeded/failed event, no
    // retry, no resume. The response asserts no terminal decision.
    if (observed.conclusive !== true) {
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
    const terminal = observed.effectApplied ? "SUCCEEDED" : "FAILED";
    const effectCertainty = observed.effectApplied ? "KNOWN_APPLIED" : "KNOWN_NOT_APPLIED";
    const reconcileOutcome = observed.effectApplied ? "APPLIED" : "NOT_APPLIED";
    await updateProviderOperation(ctx, operation.id, {
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
