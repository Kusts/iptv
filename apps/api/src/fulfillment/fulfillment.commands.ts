import { z } from "zod";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf } from "../crm/wave2-store.js";
import type { SecretsPort } from "@iptv/secrets";
import {
  assertBrowserSecretReady,
  secretsAvailable,
  buildSubscriptionProvisionExternalPayload,
  getProviderAccountSecretRef,
  isCapabilityUnavailable,
  isSecretRequiringPort,
  projectSecretPortResult,
  PROVIDER_CALL_UNCERTAIN_CODE,
  stripSecretKeysFromPayload,
} from "../provider/provider-secret-gate.js";
import {
  SECRET_REQUIRED_ADAPTER_VERSION,
  applyCapabilityGate,
  providerDispatchModeFromEnv,
  resolveOpsPort,
  selectedAdapterNameFromEnv,
  type ProviderOpsPort,
} from "../provider/provider-port.js";
import { resolveTenantSigmaPortFromEnv } from "../provider/provider-sigma.js";
import {
  UniqueViolationError,
  countProviderOperationsForEntity,
  insertProviderAttempt,
  insertProviderOperation,
  latestProviderOperationForEntity,
  updateProviderOperation,
} from "../trial/trial-store.js";
import { activateSubscriptionInternal, handleActivateFromOrder, openFulfillmentFailureReview } from "../subscription/subscription.commands.js";
import {
  ensureFulfillmentProviderAccount,
  getCatalogPlan,
  getSubscription,
  insertProviderEvidence,
  upsertSubscriptionBinding,
} from "../subscription/subscription-store.js";

/**
 * Wave 6 Fulfillment bridge (subscription → CINEVISION-shaped provider work).
 *
 * Catalog→provider binding decision: NO new table. The binding is the
 * existing `provider.provider_bindings` row
 * (`entity_type=subscription`, `entity_id=<subscription>`), written when the
 * effect is KNOWN_APPLIED *with a provider external ref* (echo path);
 * manual handling without one records `provider_evidence` only and never
 * fabricates an external id. The plan→provider mapping rides in the
 * operation payload (`plan_id`/`plan_key`) plus the provider account.
 *
 * Wave 4 discipline preserved: operations run through `ProviderOpsPort`
 * adapters (echo/manual only — real CINEVISION stays Wave-0-gated), an
 * UNKNOWN effect parks VERIFYING for reconcile (never blind retry), and
 * postconditions are recorded as `provider_evidence` rows on activation.
 * Emitted events are registry-listed `provider.*` only.
 */

export const requestFulfillmentInput = z.object({
  subscriptionId: z.string().uuid(),
  adapter: z.enum(["echo", "manual", "sigma"]).optional(),
  echoOutcome: z.enum(["success", "failed", "unknown", "drift"]).optional(),
});
export type RequestFulfillmentInput = z.infer<typeof requestFulfillmentInput>;

export const retryDueInput = z.object({
  limit: z.number().int().min(1).max(1000).default(100),
  adapter: z.enum(["echo", "manual", "sigma"]).optional(),
  echoOutcome: z.enum(["success", "failed", "unknown", "drift"]).optional(),
});
export type RetryDueInput = z.infer<typeof retryDueInput>;

export const activatePendingSettledOrdersInput = z.object({
  limit: z.number().int().min(1).max(1000).default(100),
});
export type ActivatePendingSettledOrdersInput = z.infer<typeof activatePendingSettledOrdersInput>;

export interface FulfillmentCommandDeps {
  opsPort?: ProviderOpsPort;
  /**
   * PF-05: SecretsPort used ONLY to verify configuration for
   * secret-requiring (future BROWSER) adapters. Never `getSecret`.
   * Defaults to `secretsAvailable()` so echo/manual keep working.
   */
  secretsPort?: SecretsPort;
  /** Test seam: override the tenant-scoped `secret_ref` loader. */
  loadSecretRef?: (ctx: CommandHandlerContext, providerAccountId: string) => Promise<string | null>;
}

async function recordBinding(
  ctx: CommandHandlerContext,
  input: { providerAccountId: string; subscriptionId: string; externalId: string },
): Promise<void> {
  await upsertSubscriptionBinding(ctx, input);
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

/**
 * Lookup-only fulfillment provider account for the secret-required pre-gate.
 * Returns the existing account id or null. NEVER creates provider/account
 * rows (unlike `ensureFulfillmentProviderAccount`).
 */
async function findExistingFulfillmentProviderAccountId(
  ctx: CommandHandlerContext,
): Promise<string | null> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("subscription commands require a database transaction");
  }
  const provider = await trx
    .selectFrom("provider.providers")
    .select(["id"])
    .where("provider_key", "=", "cinevision")
    .executeTakeFirst();
  if (provider === undefined) {
    return null;
  }
  const existing = await trx
    .selectFrom("provider.provider_accounts")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("provider_id", "=", provider.id)
    .where("status", "=", "ACTIVE")
    .orderBy("created_at", "asc")
    .executeTakeFirst();
  return existing?.id ?? null;
}

/** Sigma catalog binding: plan metadata wins; internal plan ids are never assumed equal to Sigma ids. */
function sigmaIdsFromPlan(plan: { metadata: Record<string, unknown> }): {
  serverId: string | null;
  packageId: string | null;
} {
  const serverId = plan.metadata["sigma_server_id"] ?? plan.metadata["server_id"];
  const packageId = plan.metadata["sigma_package_id"] ?? plan.metadata["package_id"];
  return {
    serverId: typeof serverId === "string" && serverId.trim().length > 0 ? serverId : null,
    packageId: typeof packageId === "string" && packageId.trim().length > 0 ? packageId : null,
  };
}

/** Existing provider external id (renew path): binding wins, never creates a duplicate client. */
async function findSubscriptionExternalId(
  ctx: CommandHandlerContext,
  providerAccountId: string,
  subscriptionId: string,
): Promise<string | null> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    return null;
  }
  const row = await trx
    .selectFrom("provider.provider_bindings")
    .select(["external_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("provider_account_id", "=", providerAccountId)
    .where("entity_type", "=", "subscription")
    .where("entity_id", "=", subscriptionId)
    .where("status", "=", "ACTIVE")
    .executeTakeFirst();
  const externalId = (row as { external_id: unknown } | undefined)?.external_id;
  return typeof externalId === "string" && externalId.trim().length > 0 ? externalId : null;
}

async function executeFulfillmentRequest(
  ctx: CommandHandlerContext,
  input: RequestFulfillmentInput,
  deps: FulfillmentCommandDeps,
): Promise<
  CommandResult<{ operationId: string; status: string; subscriptionStatus: string; already: boolean }>
> {
    const subscription = await getSubscription(ctx, input.subscriptionId);
    if (subscription === null) {
      return { ok: false, code: "not_found", message: "subscription not found in this tenant" };
    }
    if (subscription.status !== "PENDING_ACTIVATION") {
      return {
        ok: false,
        code: "precondition_failed",
        message: `subscription is ${subscription.status}; fulfillment runs for PENDING_ACTIVATION only`,
      };
    }
    const inFlight = await latestProviderOperationForEntity(ctx, "subscription", subscription.id);
    if (inFlight !== null && !(["SUCCEEDED", "FAILED", "CANCELLED"] as string[]).includes(inFlight.status)) {
      return {
        ok: true,
        data: {
          operationId: inFlight.id,
          status: inFlight.status,
          subscriptionStatus: subscription.status,
          already: true,
        },
      };
    }
    const plan = await getCatalogPlan(ctx, subscription.planId);
    if (plan === null) {
      return { ok: false, code: "not_found", message: "catalog plan not found in this tenant" };
    }
    const fallback = deps.opsPort?.name === "sigma" ? "sigma" : deps.opsPort !== undefined ? (deps.opsPort.name === "echo" ? "echo" : "manual") : selectedAdapterNameFromEnv();
    const requested = input.adapter ?? fallback;
    const capability = await ctx.tx.getCapability("provider.cinevision");
    const { name: adapterName, note: capabilityNote } = applyCapabilityGate(requested, capability);
    // PF-05: an injected secret-requiring (future BROWSER) port bypasses the
    // echo/manual selection so the gate below always runs for it.
    const injectedSecretPort =
      deps.opsPort !== undefined && isSecretRequiringPort(deps.opsPort) ? deps.opsPort : null;
    const port =
      injectedSecretPort ??
      (deps.opsPort !== undefined && deps.opsPort.name === adapterName
        ? deps.opsPort
        : adapterName === "sigma"
          ? resolveTenantSigmaPortFromEnv({ tenantId: ctx.tenantId, trx: kyselyTrxOf(ctx), overrideSecretsPort: deps.secretsPort ?? null })
          : resolveOpsPort(adapterName));
    const secretRequired = isSecretRequiringPort(port);
    // Capability UNAVAILABLE wins over injection: no account creation, no
    // operation, no port call; the subscription stays PENDING_ACTIVATION.
    if (secretRequired && isCapabilityUnavailable(capability)) {
      return {
        ok: false,
        code: "precondition_failed",
        message: "provider capability unavailable; secret-required operations are blocked",
      };
    }
    if (secretRequired) {
      return executeSecretFulfillmentRequest(ctx, input, deps, {
        subscription,
        plan,
        port,
        capabilityNote,
        effectiveAdapter: port.name,
      });
    }
    const account = await ensureFulfillmentProviderAccount(ctx);
    const effectiveAdapter = injectedSecretPort !== null ? port.name : adapterName;
    const attemptIndex = (await countProviderOperationsForEntity(ctx, "subscription", subscription.id)) + 1;
    const idempotencyKey = `subscription-provision:${subscription.id}:${attemptIndex}`;
    let operation;
    try {
      operation = await insertProviderOperation(ctx, {
        providerAccountId: account.id,
        action: "subscription.provision",
        entityType: "subscription",
        entityId: subscription.id,
        idempotencyKey,
        requestedPayload: {
          plan_id: plan.id,
          plan_key: plan.planKey,
          ...(sigmaIdsFromPlan(plan).serverId !== null ? { server_id: sigmaIdsFromPlan(plan).serverId } : {}),
          ...(sigmaIdsFromPlan(plan).packageId !== null ? { package_id: sigmaIdsFromPlan(plan).packageId } : {}),
          customer_id: subscription.customerId,
          adapter: effectiveAdapter,
          capability: capabilityNote,
          ...(input.echoOutcome !== undefined ? { __echo_outcome: input.echoOutcome } : {}),
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
        action: "subscription.provision",
        entity_type: "subscription",
        entity_id: subscription.id,
        adapter: effectiveAdapter,
      },
    });
    const result = await port.requestOperation({
      tenantId: ctx.tenantId,
      providerAccountId: account.id,
      action: "subscription.provision",
      entityType: "subscription",
      entityId: subscription.id,
      idempotencyKey,
      payload: {
        ...stripSecretKeysFromPayload({
          plan_id: plan.id,
          plan_key: plan.planKey,
          ...(input.echoOutcome !== undefined ? { __echo_outcome: input.echoOutcome } : {}),
        }),
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
        data: { action: "subscription.provision", entity_id: subscription.id },
      });
      if (result.externalRef !== null) {
        await recordBinding(ctx, {
          providerAccountId: account.id,
          subscriptionId: subscription.id,
          externalId: result.externalRef,
        });
      }
      const activated = await activateSubscriptionInternal(ctx, subscription.id, operation.id);
      const status = activated.ok ? activated.data.status : subscription.status;
      return {
        ok: true,
        data: { operationId: operation.id, status: "SUCCEEDED", subscriptionStatus: status, already: false },
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
        data: { action: "subscription.provision", entity_id: subscription.id, detail: result.detail },
      });
      // Certain non-application: no access granted; a manual-exception
      // review carries the failure to a provider operator.
      await openFulfillmentFailureReview(ctx, subscription.id, operation.id);
      return {
        ok: true,
        data: {
          operationId: operation.id,
          status: "FAILED",
          subscriptionStatus: "PENDING_ACTIVATION",
          already: false,
        },
      };
    }
    if (result.outcome === "UNKNOWN") {
      const drifted = input.echoOutcome === "drift" || result.detail.includes("drift");
      await updateProviderOperation(ctx, operation.id, {
        status: "VERIFYING",
        effectCertainty: "UNKNOWN",
        executionChannel: "MANUAL",
        resultSummary: drifted
          ? { detail: result.detail, degraded: true, drift_detected: true }
          : { detail: result.detail },
        started: true,
      });
      await insertProviderAttempt(ctx, {
        operationId: operation.id,
        status: "VERIFYING",
        errorCode: drifted ? "DOM_DRIFT" : "EFFECT_UNKNOWN",
      });
      if (drifted) {
        await insertProviderEvidence(ctx, {
          operationId: operation.id,
          evidenceType: "FULFILLMENT_DEGRADED",
          objectRef: `subscription:${subscription.id}`,
          structured: { degraded: true, drift: true, detail: result.detail },
        });
      }
      return {
        ok: true,
        data: {
          operationId: operation.id,
          status: "VERIFYING",
          subscriptionStatus: "PENDING_ACTIVATION",
          already: false,
        },
      };
    }
    await updateProviderOperation(ctx, operation.id, {
      status: "HUMAN_REQUIRED",
      effectCertainty: "UNKNOWN",
      executionChannel: "MANUAL",
      resultSummary: { detail: result.detail },
      started: true,
    });
    await insertProviderAttempt(ctx, { operationId: operation.id, status: "HUMAN_REQUIRED" });
    return {
      ok: true,
      data: {
        operationId: operation.id,
        status: "HUMAN_REQUIRED",
        subscriptionStatus: "PENDING_ACTIVATION",
        already: false,
      },
    };
}

/**
 * CV-DSP-02 shared secret-branch outcome applier for
 * `subscription.provision`: the ONE source of truth for secret-required
 * fulfillment transitions (SUCCEEDED/FAILED/UNKNOWN/MANUAL → terminal /
 * VERIFYING / HUMAN_REQUIRED + binding + activation + failure review + safe
 * evidence + the registry-listed `provider.operation_*` events). The inline
 * fulfillment handler and the durable `ProviderDispatcherService` both call
 * it — never duplicate these transitions.
 *
 * `raw` carries the port result; projection (`projectSecretPortResult`) and
 * the invalid-ref SUCCEEDED→UNKNOWN demotion happen here so both callers
 * share them. Never persists/emits raw `detail`/`externalRef`.
 *
 * `status` is the PROVIDER OPERATION status (what the dispatcher counts).
 * When the subscription row is missing (only possible for a
 * dispatcher-claimed row the inline handler did not create), the operation
 * still terminalizes but activation/review are skipped best-effort
 * (`subscriptionStatus` stays `PENDING_ACTIVATION`) — the inline handler
 * validated the subscription first, so it never hits that path.
 */
export interface SubscriptionProvisionOutcomeInput {
  operationId: string;
  subscriptionId: string;
  providerAccountId: string;
  raw: { outcome: string; detail: string; externalRef: string | null; expiresBefore?: string | null };
}

export interface SubscriptionProvisionOutcome {
  /** Provider operation status (SUCCEEDED | FAILED | VERIFYING | HUMAN_REQUIRED). */
  status: string;
  subscriptionStatus: string;
  effectCertainty: string;
}

/**
 * CV-DSP-02 fencing for durable dispatch transitions. Same contract as the
 * provider/trial appliers: with `fence` + a live Kysely transaction the
 * terminal status write becomes a conditional UPDATE
 * (`WHERE claimed_by=$token AND status IN ('QUEUED','RUNNING')`, lease
 * cleared atomically); zero affected rows → `null` BEFORE any
 * attempt/event/binding/activation/review. Without `fence` (inline path)
 * behavior is unchanged.
 */
export interface SubscriptionProvisionFence {
  claimedBy?: string;
  /**
   * Reconcile CAS (FASE5-FIX3-R4 shape): when set, the status predicate
   * becomes `status = <expected>` (e.g. `VERIFYING`) and the `claimed_by`
   * predicate applies only when `claimedBy` is also set. Dispatch passes
   * `{ claimedBy }` (QUEUED/RUNNING); reconcile passes
   * `{ expectedStatus: "VERIFYING" }` (no claim).
   */
  expectedStatus?: string;
}

async function fencedSubscriptionOutcomeUpdate(
  ctx: CommandHandlerContext,
  operationId: string,
  fence: SubscriptionProvisionFence,
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

export async function applySubscriptionProvisionOutcome(
  ctx: CommandHandlerContext,
  input: SubscriptionProvisionOutcomeInput,
  fence?: SubscriptionProvisionFence,
): Promise<SubscriptionProvisionOutcome | null> {
  const fenced = fence !== undefined && kyselyTrxOf(ctx) !== null;
  async function writeTerminal(patch: {
    status: string;
    effectCertainty: string;
    resultSummary: Record<string, unknown>;
    completed: boolean;
  }): Promise<boolean> {
    if (fenced) {
      return fencedSubscriptionOutcomeUpdate(ctx, input.operationId, fence as SubscriptionProvisionFence, {
        ...patch,
        executionChannel: "MANUAL",
        started: true,
      });
    }
    await updateProviderOperation(ctx, input.operationId, {
      ...patch,
      executionChannel: "MANUAL",
      started: true,
    });
    return true;
  }
  const projected = projectSecretPortResult(input.raw);
  const effectiveOutcome =
    projected.outcome === "SUCCEEDED" &&
    (projected.externalRefInvalid || projected.safeExternalRef === null)
      ? "UNKNOWN"
      : projected.outcome;
  const sigmaSummary = (base: Record<string, unknown>): Record<string, unknown> =>
    projected.safeExpiresBefore !== null ? { ...base, sigma_expires_before: projected.safeExpiresBefore } : base;
  if (effectiveOutcome === "SUCCEEDED") {
    const claimed = await writeTerminal({
      status: "SUCCEEDED",
      effectCertainty: "KNOWN_APPLIED",
      resultSummary: sigmaSummary(
        projected.safeExternalRef !== null ? { external_ref: projected.safeExternalRef } : {},
      ),
      completed: true,
    });
    if (!claimed) {
      return null;
    }
    await insertProviderAttempt(ctx, { operationId: input.operationId, status: "SUCCEEDED" });
    await emitProvider(ctx, {
      eventType: "provider.operation_succeeded.v1",
      operationId: input.operationId,
      data: { action: "subscription.provision", entity_id: input.subscriptionId },
    });
    if (projected.safeExternalRef !== null) {
      await recordBinding(ctx, {
        providerAccountId: input.providerAccountId,
        subscriptionId: input.subscriptionId,
        externalId: projected.safeExternalRef,
      });
    }
    const activated = await activateSubscriptionInternal(ctx, input.subscriptionId, input.operationId);
    const status = activated.ok ? activated.data.status : "PENDING_ACTIVATION";
    return { status: "SUCCEEDED", subscriptionStatus: status, effectCertainty: "KNOWN_APPLIED" };
  }
  if (effectiveOutcome === "FAILED") {
    const claimed = await writeTerminal({
      status: "FAILED",
      effectCertainty: "KNOWN_NOT_APPLIED",
      resultSummary: { error_code: "ADAPTER_FAILED" },
      completed: true,
    });
    if (!claimed) {
      return null;
    }
    await insertProviderAttempt(ctx, { operationId: input.operationId, status: "FAILED", errorCode: "ADAPTER_FAILED" });
    await emitProvider(ctx, {
      eventType: "provider.operation_failed.v1",
      operationId: input.operationId,
      data: { action: "subscription.provision", entity_id: input.subscriptionId },
    });
    await openFulfillmentFailureReview(ctx, input.subscriptionId, input.operationId);
    return { status: "FAILED", subscriptionStatus: "PENDING_ACTIVATION", effectCertainty: "KNOWN_NOT_APPLIED" };
  }
  if (effectiveOutcome === "UNKNOWN") {
    const unknownSummary = sigmaSummary(
      projected.safeExternalRef !== null ? { external_ref: projected.safeExternalRef } : {},
    );
    const claimed = await writeTerminal({
      status: "VERIFYING",
      effectCertainty: "UNKNOWN",
      resultSummary: unknownSummary,
      completed: false,
    });
    if (!claimed) {
      return null;
    }
    await insertProviderAttempt(ctx, { operationId: input.operationId, status: "VERIFYING", errorCode: "EFFECT_UNKNOWN" });
    return { status: "VERIFYING", subscriptionStatus: "PENDING_ACTIVATION", effectCertainty: "UNKNOWN" };
  }
  const claimed = await writeTerminal({
    status: "HUMAN_REQUIRED",
    effectCertainty: "UNKNOWN",
    resultSummary: {},
    completed: false,
  });
  if (!claimed) {
    return null;
  }
  await insertProviderAttempt(ctx, { operationId: input.operationId, status: "HUMAN_REQUIRED" });
  return { status: "HUMAN_REQUIRED", subscriptionStatus: "PENDING_ACTIVATION", effectCertainty: "UNKNOWN" };
}

/**
 * Secret-required fulfillment path: lookup-only account (no placeholder
 * creation before the gate), fail-closed secret gate, server-built payload
 * only (no echoOutcome passthrough), and safe port-result projection. Raw
 * `detail`/`externalRef` never persist to resultSummary/evidence/bindings
 * and never emit; an invalid ref demotes SUCCEEDED to VERIFYING.
 */
async function executeSecretFulfillmentRequest(
  ctx: CommandHandlerContext,
  input: RequestFulfillmentInput,
  deps: FulfillmentCommandDeps,
  resolved: {
    subscription: { id: string; customerId: string };
    plan: { id: string; planKey: string; metadata: Record<string, unknown> };
    port: ProviderOpsPort;
    capabilityNote: string;
    effectiveAdapter: string;
  },
): Promise<
  CommandResult<{ operationId: string; status: string; subscriptionStatus: string; already: boolean }>
> {
  const { subscription, plan, port, capabilityNote, effectiveAdapter } = resolved;
  const existingAccountId = await findExistingFulfillmentProviderAccountId(ctx);
  if (existingAccountId === null) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "browser operations require a configured provider secret (secret_ref is missing)",
    };
  }
  const loader = deps.loadSecretRef ?? getProviderAccountSecretRef;
  const secretRef = await loader(ctx, existingAccountId);
  const gate = assertBrowserSecretReady({
    secretRef,
    secretsConfigured: secretsAvailable(deps.secretsPort),
  });
  if (!gate.ok) {
    return { ok: false, code: "precondition_failed", message: gate.message };
  }
  const accountId = existingAccountId;
  const sigmaIds = sigmaIdsFromPlan(plan);
  const existingExternalId = await findSubscriptionExternalId(ctx, accountId, subscription.id);
  const attemptIndex = (await countProviderOperationsForEntity(ctx, "subscription", subscription.id)) + 1;
  const idempotencyKey = `subscription-provision:${subscription.id}:${attemptIndex}`;
  let operation;
  try {
    operation = await insertProviderOperation(ctx, {
      providerAccountId: accountId,
      action: "subscription.provision",
      entityType: "subscription",
      entityId: subscription.id,
      idempotencyKey,
      requestedPayload: {
        plan_id: plan.id,
        plan_key: plan.planKey,
        ...(sigmaIds.serverId !== null ? { server_id: sigmaIds.serverId } : {}),
        ...(sigmaIds.packageId !== null ? { package_id: sigmaIds.packageId } : {}),
        ...(existingExternalId !== null ? { sigma_customer_id: existingExternalId } : {}),
        customer_id: subscription.customerId,
        adapter: effectiveAdapter,
        capability: capabilityNote,
      },
      // Branch-derived provenance: reserved constant, never `${port.name}-v1`.
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
      action: "subscription.provision",
      entity_type: "subscription",
      entity_id: subscription.id,
      adapter: effectiveAdapter,
    },
  });
  // CV-DSP-02 durable cut (same point as the provider cut): the REQUESTED
  // row + `operation_requested` event are already committed by the caller
  // transaction. In durable mode the external port call moves to
  // `ProviderDispatcherService.drainOnce` (claim with lease → RUNNING +
  // `dispatch_started_at` frontier → port call → outcome via
  // `applySubscriptionProvisionOutcome`). Inline (default) keeps the current
  // in-transaction port call untouched.
  if (providerDispatchModeFromEnv() === "durable") {
    return {
      ok: true,
      data: {
        operationId: operation.id,
        status: "QUEUED",
        subscriptionStatus: "PENDING_ACTIVATION",
        already: false,
      },
    };
  }
  // Post-effect throw shape: catch ONLY the port call (DB failures still
  // propagate). The subscription stays PENDING_ACTIVATION and the operation
  // parks VERIFYING/UNKNOWN with the fixed code — no completed_at, no
  // terminal event, no activation/binding/review, no second call.
  let raw: Awaited<ReturnType<ProviderOpsPort["requestOperation"]>>;
  try {
    raw = await port.requestOperation({
      tenantId: ctx.tenantId,
      providerAccountId: accountId,
      action: "subscription.provision",
      entityType: "subscription",
      entityId: subscription.id,
      idempotencyKey,
      // CV-DSP-02-FIX F1: shared projection with the dispatcher — the port
      // frontier carries only certified fields (domain metadata such as
      // `customer_id` stays on the persisted operation row). For Sigma the
      // frontier additionally carries server_id/package_id from plan
      // metadata and sigma_customer_id from the existing binding (renew
      // path) — never the internal plan ids as Sigma ids.
      payload: buildSubscriptionProvisionExternalPayload({
        plan_id: plan.id,
        plan_key: plan.planKey,
        ...(sigmaIds.serverId !== null ? { server_id: sigmaIds.serverId } : {}),
        ...(sigmaIds.packageId !== null ? { package_id: sigmaIds.packageId } : {}),
        ...(existingExternalId !== null ? { sigma_customer_id: existingExternalId } : {}),
      }),
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
    return {
      ok: true,
      data: {
        operationId: operation.id,
        status: "VERIFYING",
        subscriptionStatus: "PENDING_ACTIVATION",
        already: false,
      },
    };
  }
  const applied = await applySubscriptionProvisionOutcome(ctx, {
    operationId: operation.id,
    subscriptionId: subscription.id,
    providerAccountId: accountId,
    raw: { outcome: raw.outcome, detail: raw.detail, externalRef: raw.externalRef, expiresBefore: raw.expiresBefore ?? null },
  });
  if (applied === null) {
    throw new Error("fulfillment outcome applier lost its own inline row");
  }
  return {
    ok: true,
    data: {
      operationId: operation.id,
      status: applied.status,
      subscriptionStatus: applied.subscriptionStatus,
      already: false,
    },
  };
}

function handleRequestFactory(deps: FulfillmentCommandDeps) {
  return async (
    ctx: CommandHandlerContext,
    input: RequestFulfillmentInput,
  ): Promise<
    CommandResult<{ operationId: string; status: string; subscriptionStatus: string; already: boolean }>
  > => executeFulfillmentRequest(ctx, input, deps);
}

export interface RetryDueResult {
  scanned: number;
  queued: number;
  retried: number;
  succeeded: number;
  stillPending: number;
}

function handleRetryDueFactory(deps: FulfillmentCommandDeps) {
  return async (ctx: CommandHandlerContext, input: RetryDueInput): Promise<CommandResult<RetryDueResult>> => {
    const trx = kyselyTrxOf(ctx);
    if (trx === null) {
      throw new Error("fulfillment retry requires a database transaction");
    }
    const rows = await trx
      .selectFrom("subscription.subscriptions")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("status", "=", "PENDING_ACTIVATION")
      .orderBy("created_at", "asc")
      .limit(input.limit)
      .execute();
    let queued = 0;
    let retried = 0;
    let succeeded = 0;
    for (const row of rows) {
      const latest = await latestProviderOperationForEntity(ctx, "subscription", row.id);
      if (latest === null) {
        continue;
      }
      if (latest.status === "HUMAN_REQUIRED" || latest.status === "VERIFYING") {
        queued += 1;
        continue;
      }
      if (latest.status !== "FAILED") {
        continue;
      }
      retried += 1;
      try {
        const resumed = await executeFulfillmentRequest(
          ctx,
          {
            subscriptionId: row.id,
            ...(input.adapter !== undefined ? { adapter: input.adapter } : {}),
            ...(input.echoOutcome !== undefined ? { echoOutcome: input.echoOutcome } : {}),
          },
          deps,
        );
        if (resumed.ok && resumed.data.status === "SUCCEEDED") {
          succeeded += 1;
        }
      } catch {
        continue;
      }
    }
    return {
      ok: true,
      data: { scanned: rows.length, queued, retried, succeeded, stillPending: queued + (retried - succeeded) },
    };
  };
}

function handleActivatePendingSettledOrdersFactory(deps: FulfillmentCommandDeps) {
  return async (
    ctx: CommandHandlerContext,
    input: ActivatePendingSettledOrdersInput,
  ): Promise<CommandResult<{ activated: string[]; requested: string[] }>> => {
    const trx = kyselyTrxOf(ctx);
    if (trx === null) {
      throw new Error("activate pending settled orders requires a database transaction");
    }
    const limit = input.limit ?? 100;
    const activated: string[] = [];
    const requested: string[] = [];

    // Phase 1 — SETTLED NEW_SUBSCRIPTION orders without a linked subscription.
    // Filter in SQL (not in-loop) so already-processed orders never starve
    // newer eligible ones when they dominate the head of the scan.
    const orders = await trx
      .selectFrom("commerce.orders as o")
      .leftJoin("subscription.subscriptions as s", (join) =>
        join
          .onRef("s.originating_order_id", "=", "o.id")
          .on("s.tenant_id", "=", ctx.tenantId),
      )
      .select(["o.id"])
      .where("o.tenant_id", "=", ctx.tenantId)
      .where("o.status", "=", "SETTLED")
      .where("o.order_type", "=", "NEW_SUBSCRIPTION")
      .where("s.id", "is", null)
      .orderBy("o.created_at", "asc")
      .limit(limit)
      .execute();
    for (const row of orders) {
      const orderId = row.id as string;
      try {
        const result = await handleActivateFromOrder(ctx, { orderId });
        if (result.ok && result.data.already === false) {
          activated.push(result.data.id);
        }
      } catch {
        // not eligible (no PLAN line, etc.) — skip
      }
    }

    // Phase 2 — PENDING_ACTIVATION subscriptions without an initial fulfillment op.
    // Same SQL-level exclusion: subscriptions that already carry any provider
    // operation must not consume the scan budget ahead of pending ones.
    const subs = await trx
      .selectFrom("subscription.subscriptions as sub")
      .leftJoin("provider.provider_operations as op", (join) =>
        join
          .onRef("op.entity_id", "=", "sub.id")
          .on("op.tenant_id", "=", ctx.tenantId)
          .on("op.entity_type", "=", "subscription"),
      )
      .select(["sub.id"])
      .where("sub.tenant_id", "=", ctx.tenantId)
      .where("sub.status", "=", "PENDING_ACTIVATION")
      .where("op.id", "is", null)
      .orderBy("sub.created_at", "asc")
      .limit(limit)
      .execute();
    for (const row of subs) {
      try {
        const result = await executeFulfillmentRequest(ctx, { subscriptionId: row.id as string }, deps);
        if (result.ok) {
          requested.push(row.id as string);
        }
      } catch {
        // continue
      }
    }

    return { ok: true, data: { activated, requested } };
  };
}

export function registerFulfillmentCommands(bus: CommandBus, deps: FulfillmentCommandDeps = {}): void {
  bus.register<
    RequestFulfillmentInput,
    { operationId: string; status: string; subscriptionStatus: string; already: boolean }
  >({
    name: "fulfillment.request_for_subscription",
    permission: "subscription.write",
    auditAction: "fulfillment.request_for_subscription",
    auditResource: "provider_operation",
    input: requestFulfillmentInput,
    handler: handleRequestFactory(deps),
  });
  bus.register<RetryDueInput, RetryDueResult>({
    name: "fulfillment.retry_due",
    permission: "subscription.write",
    auditAction: "fulfillment.retry_due",
    auditResource: "provider_operation",
    input: retryDueInput,
    handler: handleRetryDueFactory(deps),
  });
  bus.register<ActivatePendingSettledOrdersInput, { activated: string[]; requested: string[] }>({
    name: "subscription.activate_pending_settled_orders",
    permission: "subscription.write",
    auditAction: "subscription.activate_pending_settled_orders",
    auditResource: "subscription",
    input: activatePendingSettledOrdersInput,
    handler: handleActivatePendingSettledOrdersFactory(deps),
  });
}

export async function getSubscriptionFulfillmentStatus(
  ctx: CommandHandlerContext,
  subscriptionId: string,
): Promise<{ operationId: string; status: string; effectCertainty: string } | null> {
  const op = await latestProviderOperationForEntity(ctx, "subscription", subscriptionId);
  if (op === null) {
    return null;
  }
  return { operationId: op.id, status: op.status, effectCertainty: op.effectCertainty };
}
