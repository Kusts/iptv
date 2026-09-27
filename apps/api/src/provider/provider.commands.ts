import { z } from "zod";
import type { CommandResult } from "@iptv/domain";
import type {
  CommandBus,
  CommandHandlerContext,
} from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf } from "../crm/wave2-store.js";
import {
  StubProviderReadback,
  adapterNameFromEnv,
  applyCapabilityGate,
  resolveOpsPort,
  type ProviderOpsPort,
  type ProviderReadbackPort,
} from "./provider-port.js";
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
 *   re-executes the operation.
 * - When the operation is linked to a trial (`entity_type=trial`), terminal
 *   outcomes resume the trial flow (SUCCEEDED -> ACTIVE, FAILED known-not-
 *   applied -> REQUESTED) with the registry-listed trial events.
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
 * `entity_type=trial` operations resume anything, and only a trial still
 * in PROVISIONING moves (see `applyProviderTerminalOutcome`).
 */
async function resumeLinkedTrial(
  ctx: CommandHandlerContext,
  entityType: string,
  entityId: string,
  terminal: "SUCCEEDED" | "FAILED",
  operationId: string,
): Promise<{ resumedTrial: boolean }> {
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

function handleRequestFactory(deps: ProviderCommandDeps) {
  return async (
    ctx: CommandHandlerContext,
    input: RequestOperationInput,
  ): Promise<CommandResult<{ id: string; status: string; effectCertainty: string }>> => {
    const account = await resolveAccountId(ctx, input.providerAccountId);
    if ("error" in account) {
      return account.error;
    }
    const fallback: "echo" | "manual" =
      deps.opsPort !== undefined
        ? deps.opsPort.name === "echo"
          ? "echo"
          : "manual"
        : adapterNameFromEnv();
    const requested: "echo" | "manual" = input.adapter ?? fallback;
    const capability = await ctx.tx.getCapability("provider.cinevision");
    const { name: adapterName, note: capabilityNote } = applyCapabilityGate(requested, capability);
    const port =
      deps.opsPort !== undefined && (deps.opsPort.name === "echo") === (adapterName === "echo")
        ? deps.opsPort
        : resolveOpsPort(adapterName);
    let operation;
    try {
      operation = await insertProviderOperation(ctx, {
        providerAccountId: account.id,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        idempotencyKey: input.idempotencyKey,
        requestedPayload: { ...input.payload, adapter: adapterName, capability: capabilityNote },
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
        adapter: adapterName,
      },
    });
    const result = await port.requestOperation({
      tenantId: ctx.tenantId,
      providerAccountId: account.id,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      idempotencyKey: input.idempotencyKey,
      payload: { ...input.payload, ...(input.echoOutcome !== undefined ? { __echo_outcome: input.echoOutcome } : {}) },
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
    // Readback observes; reconcile never re-executes the operation.
    const observed = await readback.verify({
      tenantId: ctx.tenantId,
      operationId: operation.id,
      action: operation.action,
      externalRef:
        typeof operation.resultSummary?.["external_ref"] === "string"
          ? (operation.resultSummary["external_ref"] as string)
          : null,
    });
    const terminal = observed.effectApplied ? "SUCCEEDED" : "FAILED";
    const effectCertainty = observed.effectApplied ? "KNOWN_APPLIED" : "KNOWN_NOT_APPLIED";
    await updateProviderOperation(ctx, operation.id, {
      status: terminal,
      effectCertainty,
      resultSummary: {
        ...(operation.resultSummary ?? {}),
        reconcile_evidence: observed.evidence,
        effect_applied: observed.effectApplied,
      },
      completed: true,
    });
    await insertProviderAttempt(ctx, { operationId: operation.id, status: terminal });
    await emitProvider(ctx, {
      eventType: observed.effectApplied ? "provider.operation_succeeded.v1" : "provider.operation_failed.v1",
      operationId: operation.id,
      data: { action: operation.action, entity_id: operation.entityId, reconcile_evidence: observed.evidence },
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
