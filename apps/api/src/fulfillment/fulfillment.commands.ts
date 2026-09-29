import { z } from "zod";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf } from "../crm/wave2-store.js";
import {
  adapterNameFromEnv,
  applyCapabilityGate,
  resolveOpsPort,
  type ProviderOpsPort,
} from "../provider/provider-port.js";
import {
  UniqueViolationError,
  countProviderOperationsForEntity,
  insertProviderAttempt,
  insertProviderOperation,
  latestProviderOperationForEntity,
  updateProviderOperation,
} from "../trial/trial-store.js";
import { activateSubscriptionInternal, openFulfillmentFailureReview } from "../subscription/subscription.commands.js";
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
  adapter: z.enum(["echo", "manual"]).optional(),
  echoOutcome: z.enum(["success", "failed", "unknown", "drift"]).optional(),
});
export type RequestFulfillmentInput = z.infer<typeof requestFulfillmentInput>;

export const retryDueInput = z.object({
  limit: z.number().int().min(1).max(1000).default(100),
  adapter: z.enum(["echo", "manual"]).optional(),
  echoOutcome: z.enum(["success", "failed", "unknown", "drift"]).optional(),
});
export type RetryDueInput = z.infer<typeof retryDueInput>;

export interface FulfillmentCommandDeps {
  opsPort?: ProviderOpsPort;
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
    const fallback: "echo" | "manual" =
      deps.opsPort !== undefined ? (deps.opsPort.name === "echo" ? "echo" : "manual") : adapterNameFromEnv();
    const requested: "echo" | "manual" = input.adapter ?? fallback;
    const capability = await ctx.tx.getCapability("provider.cinevision");
    const { name: adapterName, note: capabilityNote } = applyCapabilityGate(requested, capability);
    const port =
      deps.opsPort !== undefined && (deps.opsPort.name === "echo") === (adapterName === "echo")
        ? deps.opsPort
        : resolveOpsPort(adapterName);
    const account = await ensureFulfillmentProviderAccount(ctx);
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
          customer_id: subscription.customerId,
          adapter: adapterName,
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
        adapter: adapterName,
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
        plan_id: plan.id,
        plan_key: plan.planKey,
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
