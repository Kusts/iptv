import { z } from "zod";
import { sql, type Transaction } from "kysely";
import { newId, now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type { Database } from "@iptv/database";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf } from "../crm/wave2-store.js";
import {
  isChargeTransition,
  paymentStatusAfterRefund,
  remainingRefundable,
  toMinor,
  webhookAmountMatchesCharge,
} from "../commerce/money-math.js";
import {
  asaasAdapterNameFromEnv,
  isEchoProviderReference,
  isSyntheticProviderReference,
  provenExternalChargeId,
  resolveAsaasPort,
  type AsaasPort,
  type RefundResult,
} from "./asaas-port.js";
import {
  chargebackReversalEntries,
  confirmationEntries,
  postBalanced,
  refundReversalEntries,
} from "./ledger.js";
import { evaluateOrderSettlement } from "./settlement.js";

/**
 * Wave 5 Billing slice (owning context for Charge/Payment/Refund).
 *
 * Canonical rules enforced here:
 * - Charge = external collection attempt (`PENDING|PROCESSING|PAID|...`);
 *   Payment = CONFIRMED movement ONLY (never pending/failed). `PAID` on a
 *   charge is external evidence that causes canonical confirmation after
 *   validation + idempotency — never a confirmation by itself.
 * - Webhook amounts/currency are NEVER trusted: they must equal the
 *   internal charge row exactly, or the delivery becomes a `billing`
 *   exception (never a confirmation). Dedupe is `(tenant, asaas, provider
 *   event id)` via the inbox; duplicate PAID deliveries are no-ops.
 * - Refund contract: `refund.request` creates a tenant-scoped
 *   `RefundRequest` and NEVER executes; the human decision flows through
 *   HumanReview (`refund-review.ts`: no self-approval, stale revalidation);
 *   `refund.execute_approved` revalidates under PER-PAYMENT serialization
 *   (`pg_advisory_xact_lock(hashtext(payment_id))`), reserves first, and
 *   reconciles ambiguous effects before any retry.
 * - Ledger is append-only: reversals are NEW transactions (with
 *   `reversal_of_transaction_id` pointing at the confirmation where known).
 * - Chargeback is a distinct intake/reversal path, never a human refund.
 * - Events are registry-listed ONLY (`charge.*`, `payment.*`,
 *   `order.settled`, `customer.created`, `hitl.*`). Refund request/approve
 *   steps are audit + `hitl.*` only — no `refund.*` public v1 exists.
 */

export interface BillingCommandDeps {
  asaasPort?: AsaasPort;
}

function requireTrx(ctx: CommandHandlerContext): Transaction<Database> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("billing commands require a database transaction");
  }
  return trx;
}

function approvalTtlHours(): number {
  const raw = process.env["REFUND_APPROVAL_TTL_HOURS"];
  const parsed = raw !== undefined ? Number(raw) : 168;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 168;
}

/** Map the command actor type onto the `refund_requests_requester_check` set. */
function requesterKindOf(actorType: string): string {
  if (actorType === "human") {
    return "USER";
  }
  if (actorType === "agent") {
    return "AGENT";
  }
  return "SYSTEM";
}

async function emitBilling(
  ctx: CommandHandlerContext,
  input: { eventType: string; aggregateType: string; aggregateId: string; data: Record<string, unknown> },
): Promise<void> {
  await emitAndEnqueue(ctx, {
    eventType: input.eventType,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    data: input.data,
  });
}

async function openException(
  trx: Transaction<Database>,
  tenantId: string,
  input: {
    kind: "AMOUNT_MISMATCH" | "UNKNOWN_CHARGE" | "PROVIDER_UNKNOWN_EFFECT" | "REFUND_UNKNOWN_EFFECT" | "CHARGEBACK" | "PROVIDER_ERROR";
    chargeId?: string | null;
    paymentId?: string | null;
    refundId?: string | null;
    reason: string;
    payload?: Record<string, unknown>;
  },
): Promise<string> {
  const id = newId();
  const at = now();
  await trx
    .insertInto("billing.exceptions")
    .values({
      id,
      tenant_id: tenantId,
      kind: input.kind,
      status: "OPEN",
      charge_id: input.chargeId ?? null,
      payment_id: input.paymentId ?? null,
      refund_id: input.refundId ?? null,
      reason: input.reason,
      payload_json: input.payload ?? {},
      created_at: at,
      updated_at: at,
      resolved_at: null,
    })
    .execute();
  return id;
}

async function resolveOpenExceptionForRefund(
  trx: Transaction<Database>,
  tenantId: string,
  refundId: string,
  note: string,
): Promise<void> {
  const at = now();
  await trx
    .updateTable("billing.exceptions")
    .set({ status: "RESOLVED", resolved_at: at, updated_at: at, reason: note })
    .where("tenant_id", "=", tenantId)
    .where("refund_id", "=", refundId)
    .where("status", "=", "OPEN")
    .execute();
}

async function findConfirmationTransactionId(
  trx: Transaction<Database>,
  tenantId: string,
  paymentId: string,
): Promise<string | null> {
  const row = await trx
    .selectFrom("finance.financial_transactions")
    .select(["id"])
    .where("tenant_id", "=", tenantId)
    .where("transaction_type", "=", "PAYMENT_CONFIRMATION")
    .where("reference_type", "=", "payment")
    .where("reference_id", "=", paymentId)
    .orderBy("occurred_at", "asc")
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Charge creation + lifecycle
// ---------------------------------------------------------------------------

export const chargeCreateInput = z.object({
  orderId: z.string().uuid(),
  paymentMethod: z.string().trim().min(1).max(64).default("PIX"),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
});
export type ChargeCreateInput = z.infer<typeof chargeCreateInput>;

export const chargeIdInput = z.object({ chargeId: z.string().uuid() });
export type ChargeIdInput = z.infer<typeof chargeIdInput>;

export const chargeExpireDueInput = z.object({ limit: z.number().int().min(1).max(1000).default(100) });
export type ChargeExpireDueInput = z.infer<typeof chargeExpireDueInput>;

interface ChargeRow {
  id: string;
  orderId: string;
  status: string;
  amountMinor: bigint;
  currency: string;
}

async function loadChargeForUpdate(
  trx: Transaction<Database>,
  tenantId: string,
  chargeId: string,
): Promise<ChargeRow | null> {
  const row = await trx
    .selectFrom("billing.charges")
    .select(["id", "order_id", "status", "amount_minor", "currency"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", chargeId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    orderId: row.order_id,
    status: row.status,
    amountMinor: toMinor(row.amount_minor),
    currency: row.currency,
  };
}

function handleChargeCreateFactory(deps: BillingCommandDeps) {
  return async (
    ctx: CommandHandlerContext,
    input: ChargeCreateInput,
  ): Promise<
    CommandResult<{ id: string; status: string; providerChargeId: string | null; effectUncertain: boolean }>
  > => {
    const trx = requireTrx(ctx);
    const order = await trx
      .selectFrom("commerce.orders")
      .select(["id", "person_id", "status", "net_amount_minor", "currency"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.orderId)
      .forUpdate()
      .executeTakeFirst();
    if (order === undefined) {
      return { ok: false, code: "not_found", message: "order not found in this tenant" };
    }
    if (order.status !== "AWAITING_PAYMENT") {
      return {
        ok: false,
        code: "precondition_failed",
        message: `order is ${order.status}; charges are created on AWAITING_PAYMENT orders`,
      };
    }
    const amountMinor = toMinor(order.net_amount_minor);
    if (amountMinor <= 0n) {
      return { ok: false, code: "precondition_failed", message: "order net is zero; nothing to collect" };
    }
    const chargeId = newId();
    const at = now();
    // Duplicate-safe insert: on conflict the tx stays healthy (a caught
    // unique violation would abort it — FIX-WAVE5-LIVE-2 #2).
    const chargeInsert = await trx
      .insertInto("billing.charges")
      .values({
        id: chargeId,
        tenant_id: ctx.tenantId,
        order_id: order.id,
        status: "PENDING",
        amount_minor: amountMinor.toString(),
        currency: order.currency,
        payment_method: input.paymentMethod,
        idempotency_key: input.idempotencyKey ?? `charge:${order.id}:${chargeId}`,
        due_at: input.dueAt !== undefined ? new Date(input.dueAt) : null,
        paid_at: null,
        created_at: at,
        updated_at: at,
      })
      .onConflict((oc) => oc.columns(["tenant_id", "idempotency_key"]).doNothing())
      .returning(["id"])
      .executeTakeFirst();
    if (chargeInsert === undefined) {
      return { ok: false, code: "precondition_failed", message: "duplicate charge creation (idempotency key in use)" };
    }
    await trx
      .insertInto("billing.charge_attempts")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        charge_id: chargeId,
        attempt_no: 1,
        status: "STARTED",
        provider_request_id: null,
        error_code: null,
        started_at: at,
        finished_at: null,
      })
      .execute();
    await emitBilling(ctx, {
      eventType: "charge.created.v1",
      aggregateType: "charge",
      aggregateId: chargeId,
      data: {
        charge_id: chargeId,
        order_id: order.id,
        amount_minor: amountMinor.toString(),
        currency: order.currency,
      },
    });
    const port = deps.asaasPort ?? resolveAsaasPort(asaasAdapterNameFromEnv());
    let created;
    try {
      created = await port.createPixCharge({
        chargeId,
        valueMinor: amountMinor,
        currency: order.currency,
        payer: { personId: order.person_id },
      });
    } catch {
      await trx
        .updateTable("billing.charge_attempts")
        .set({ status: "FAILED", error_code: "PROVIDER_MISCONFIGURED", finished_at: now() })
        .where("tenant_id", "=", ctx.tenantId)
        .where("charge_id", "=", chargeId)
        .where("attempt_no", "=", 1)
        .execute();
      // Provider never accepted: the charge stays PENDING for an explicit
      // operator retry with a new idempotency key — NEVER an auto-retry.
      return { ok: true, data: { id: chargeId, status: "PENDING", providerChargeId: null, effectUncertain: false } };
    }
    if (created.effect === "KNOWN_NOT_APPLIED") {
      await trx
        .updateTable("billing.charge_attempts")
        .set({ status: "FAILED", error_code: "PROVIDER_REJECTED", finished_at: now() })
        .where("tenant_id", "=", ctx.tenantId)
        .where("charge_id", "=", chargeId)
        .where("attempt_no", "=", 1)
        .execute();
      // Provider provably did NOT accept: stays PENDING, no retry here.
      return { ok: true, data: { id: chargeId, status: "PENDING", providerChargeId: created.providerChargeId, effectUncertain: false } };
    }
    await trx
      .insertInto("billing.charge_provider_bindings")
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        charge_id: chargeId,
        provider: "ASAAS",
        external_customer_id: null,
        external_charge_id: created.providerChargeId,
        status_raw: created.effect === "KNOWN_APPLIED" ? "ACCEPTED" : "UNKNOWN",
        last_synced_at: at,
        created_at: at,
      })
      .execute();
    await trx
      .updateTable("billing.charge_attempts")
      .set({
        status: created.effect === "KNOWN_APPLIED" ? "SUCCEEDED" : "UNKNOWN_EFFECT",
        provider_request_id: created.providerChargeId,
        error_code: created.effect === "KNOWN_APPLIED" ? null : "EFFECT_UNKNOWN",
        finished_at: now(),
      })
      .where("tenant_id", "=", ctx.tenantId)
      .where("charge_id", "=", chargeId)
      .where("attempt_no", "=", 1)
      .execute();
    await trx
      .updateTable("billing.charges")
      .set({ status: "PROCESSING", updated_at: now() })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", chargeId)
      .where("status", "=", "PENDING")
      .execute();
    await emitBilling(ctx, {
      eventType: "charge.processing.v1",
      aggregateType: "charge",
      aggregateId: chargeId,
      data: {
        charge_id: chargeId,
        order_id: order.id,
        provider: "ASAAS",
        provider_charge_id: created.providerChargeId,
      },
    });
    if (created.effect === "UNKNOWN") {
      // Uncertain create effect: the charge stays PROCESSING and a reconcile
      // task (exception row) owns resolution — NEVER an automatic re-create.
      await openException(trx, ctx.tenantId, {
        kind: "PROVIDER_UNKNOWN_EFFECT",
        chargeId,
        reason: `Asaas create effect unknown for charge ${chargeId}; reconcile before any retry`,
        payload: { provider_charge_id: created.providerChargeId, detail: created.detail },
      });
      return { ok: true, data: { id: chargeId, status: "PROCESSING", providerChargeId: created.providerChargeId, effectUncertain: true } };
    }
    return { ok: true, data: { id: chargeId, status: "PROCESSING", providerChargeId: created.providerChargeId, effectUncertain: false } };
  };
}

async function confirmChargePaid(
  ctx: CommandHandlerContext,
  trx: Transaction<Database>,
  charge: ChargeRow,
  origin: { providerEventId: string },
): Promise<{ paymentId: string; duplicate: boolean; settled: boolean }> {
  const existing = await trx
    .selectFrom("billing.payments")
    .select(["id", "order_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("charge_id", "=", charge.id)
    .executeTakeFirst();
  if (existing !== undefined) {
    return { paymentId: existing.id, duplicate: true, settled: false };
  }
  const at = now();
  const paymentId = newId();
  // Race-safe insert: a concurrent confirm for the same charge resolves to
  // the duplicate path via on-conflict-do-nothing (a caught violation would
  // abort this tx — FIX-WAVE5-LIVE-2 #2).
  const paymentInsert = await trx
    .insertInto("billing.payments")
    .values({
      id: paymentId,
      tenant_id: ctx.tenantId,
      order_id: charge.orderId,
      charge_id: charge.id,
      status: "CONFIRMED",
      amount_minor: charge.amountMinor.toString(),
      currency: charge.currency,
      payment_method: "PIX",
      confirmed_at: at,
      created_at: at,
      updated_at: at,
    })
    .onConflict((oc) => oc.columns(["tenant_id", "charge_id"]).doNothing())
    .returning(["id"])
    .executeTakeFirst();
  if (paymentInsert === undefined) {
    const raced = await trx
      .selectFrom("billing.payments")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("charge_id", "=", charge.id)
      .executeTakeFirstOrThrow();
    return { paymentId: raced.id, duplicate: true, settled: false };
  }
  await trx
    .updateTable("billing.charges")
    .set({ status: "PAID", paid_at: at, updated_at: at })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", charge.id)
    .execute();
  await postBalanced(trx, ctx.tenantId, {
    transactionType: "PAYMENT_CONFIRMATION",
    referenceType: "payment",
    referenceId: paymentId,
    idempotencyKey: `payment-confirmation:${charge.id}`,
    metadata: { provider_event_id: origin.providerEventId, charge_id: charge.id },
    entries: confirmationEntries(charge.amountMinor, charge.currency),
  });
  await emitBilling(ctx, {
    eventType: "charge.paid.v1",
    aggregateType: "charge",
    aggregateId: charge.id,
    data: {
      charge_id: charge.id,
      order_id: charge.orderId,
      provider_event_id: origin.providerEventId,
    },
  });
  await emitBilling(ctx, {
    eventType: "payment.confirmed.v1",
    aggregateType: "payment",
    aggregateId: paymentId,
    data: {
      payment_id: paymentId,
      charge_id: charge.id,
      order_id: charge.orderId,
      amount_minor: charge.amountMinor.toString(),
      currency: charge.currency,
    },
  });
  const settlement = await evaluateOrderSettlement(ctx, trx, charge.orderId);
  return { paymentId, duplicate: false, settled: settlement.settled };
}

// ---------------------------------------------------------------------------
// Webhook confirmation (async normalize stage calls this command)
// ---------------------------------------------------------------------------

export const webhookConfirmInput = z.object({
  externalChargeId: z.string().trim().min(1).max(200),
  externalEventId: z.string().trim().min(1).max(200),
  reportedAmountMinor: z.string().regex(/^\d+$/).nullable(),
  reportedCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(),
});
export type WebhookConfirmInput = z.infer<typeof webhookConfirmInput>;

async function handleWebhookConfirm(
  ctx: CommandHandlerContext,
  input: WebhookConfirmInput,
): Promise<CommandResult<{ outcome: "confirmed" | "duplicate" | "exception"; paymentId: string | null; exceptionId: string | null }>> {
  const trx = requireTrx(ctx);
  const binding = await trx
    .selectFrom("billing.charge_provider_bindings")
    .select(["charge_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("provider", "=", "ASAAS")
    .where("external_charge_id", "=", input.externalChargeId)
    .executeTakeFirst();
  if (binding === undefined) {
    const exceptionId = await openException(trx, ctx.tenantId, {
      kind: "UNKNOWN_CHARGE",
      reason: `Asaas event for unknown external charge ${input.externalChargeId}; no domain mutation`,
      payload: { external_charge_id: input.externalChargeId, external_event_id: input.externalEventId },
    });
    return { ok: true, data: { outcome: "exception", paymentId: null, exceptionId } };
  }
  const charge = await loadChargeForUpdate(trx, ctx.tenantId, binding.charge_id);
  if (charge === null) {
    const exceptionId = await openException(trx, ctx.tenantId, {
      kind: "UNKNOWN_CHARGE",
      reason: `binding points at missing charge for external ${input.externalChargeId}`,
      payload: { external_charge_id: input.externalChargeId, external_event_id: input.externalEventId },
    });
    return { ok: true, data: { outcome: "exception", paymentId: null, exceptionId } };
  }
  if (charge.status === "PAID") {
    const payment = await trx
      .selectFrom("billing.payments")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("charge_id", "=", charge.id)
      .executeTakeFirst();
    return { ok: true, data: { outcome: "duplicate", paymentId: payment?.id ?? null, exceptionId: null } };
  }
  if (charge.status !== "PROCESSING") {
    const exceptionId = await openException(trx, ctx.tenantId, {
      kind: "PROVIDER_ERROR",
      chargeId: charge.id,
      reason: `Asaas PAID event for charge in ${charge.status}; PROCESSING→PAID is the only legal confirm transition`,
      payload: { external_charge_id: input.externalChargeId, external_event_id: input.externalEventId },
    });
    return { ok: true, data: { outcome: "exception", paymentId: null, exceptionId } };
  }
  // NEVER trust webhook amounts: validate against the internal charge row.
  const matches = webhookAmountMatchesCharge({
    reportedAmountMinor: input.reportedAmountMinor !== null ? toMinor(input.reportedAmountMinor) : null,
    reportedCurrency: input.reportedCurrency,
    chargeAmountMinor: charge.amountMinor,
    chargeCurrency: charge.currency,
  });
  if (!matches) {
    const exceptionId = await openException(trx, ctx.tenantId, {
      kind: "AMOUNT_MISMATCH",
      chargeId: charge.id,
      reason: `Asaas amount/currency does not match charge ${charge.id}; confirmation refused`,
      payload: {
        external_charge_id: input.externalChargeId,
        external_event_id: input.externalEventId,
        reported_amount_minor: input.reportedAmountMinor,
        reported_currency: input.reportedCurrency,
        expected_amount_minor: charge.amountMinor.toString(),
        expected_currency: charge.currency,
      },
    });
    return { ok: true, data: { outcome: "exception", paymentId: null, exceptionId } };
  }
  const confirmed = await confirmChargePaid(ctx, trx, charge, { providerEventId: input.externalEventId });
  if (confirmed.duplicate) {
    return { ok: true, data: { outcome: "duplicate", paymentId: confirmed.paymentId, exceptionId: null } };
  }
  return { ok: true, data: { outcome: "confirmed", paymentId: confirmed.paymentId, exceptionId: null } };
}

function handleChargeReconcileFactory(deps: BillingCommandDeps) {
  return async (
    ctx: CommandHandlerContext,
    input: ChargeIdInput,
  ): Promise<CommandResult<{ id: string; status: string; outcome: string }>> => {
    const trx = requireTrx(ctx);
    const charge = await loadChargeForUpdate(trx, ctx.tenantId, input.chargeId);
    if (charge === null) {
      return { ok: false, code: "not_found", message: "charge not found in this tenant" };
    }
    if (charge.status !== "PROCESSING") {
      return {
        ok: false,
        code: "precondition_failed",
        message: `charge is ${charge.status}; reconcile requires PROCESSING`,
      };
    }
    const binding = await trx
      .selectFrom("billing.charge_provider_bindings")
      .select(["external_charge_id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("charge_id", "=", charge.id)
      .where("provider", "=", "ASAAS")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (binding === undefined) {
      return { ok: false, code: "precondition_failed", message: "charge has no provider binding to reconcile" };
    }
    const port = deps.asaasPort ?? resolveAsaasPort(asaasAdapterNameFromEnv());
    // Namespace guard (MVP-ASAAS-04): the adapter identity lives in the
    // persisted reference, NOT in `port.name`. An echo-configured process
    // must never confirm a real (or otherwise foreign) reference with a
    // synthetic echo outcome — that would post ledger/confirmation without
    // provider proof after a config swap. Echo resolves ONLY `echo-` refs;
    // anything else under echo stays PROCESSING behind a human exception
    // (no provider call, no ledger). Null/blank retains the UNKNOWN hold.
    const chargeRefRaw = binding.external_charge_id;
    const chargeRef = typeof chargeRefRaw === "string" ? chargeRefRaw.trim() : "";
    const isEchoChargeRef = isEchoProviderReference(chargeRefRaw);
    if (chargeRef.length === 0) {
      await openException(trx, ctx.tenantId, {
        kind: "PROVIDER_UNKNOWN_EFFECT",
        chargeId: charge.id,
        reason: `charge ${charge.id} has no provider reference to reconcile; awaiting binding`,
        payload: { provider_charge_id: binding.external_charge_id, detail: "blank reference" },
      });
      return { ok: true, data: { id: charge.id, status: "PROCESSING", outcome: "unknown" } };
    }
    if (port.name === "echo" && !isEchoChargeRef) {
      await openException(trx, ctx.tenantId, {
        kind: "AMOUNT_MISMATCH",
        chargeId: charge.id,
        reason: `echo adapter cannot confirm non-echo reference for charge ${charge.id}; confirmation refused`,
        payload: { provider_charge_id: binding.external_charge_id, adapter: port.name },
      });
      return { ok: true, data: { id: charge.id, status: "PROCESSING", outcome: "exception" } };
    }
    // Readback observes; reconcile never re-executes the charge.
    const observed = await port.getCharge({ providerChargeId: binding.external_charge_id });
    await trx
      .updateTable("billing.charge_provider_bindings")
      .set({ status_raw: observed.status, last_synced_at: now() })
      .where("tenant_id", "=", ctx.tenantId)
      .where("charge_id", "=", charge.id)
      .where("provider", "=", "ASAAS")
      .where("external_charge_id", "=", binding.external_charge_id)
      .execute();
    if (observed.status === "PAID") {
      // Echo transport is synthetic-local by design: it carries no provider
      // money evidence (value/currency are null by contract), so a configured
      // PAID outcome confirms directly — but ONLY for echo-namespace refs
      // (guarded above). EVERY non-echo reference must prove value+currency
      // exactly (mirrors the webhook check), regardless of which adapter is
      // configured; otherwise the charge stays PROCESSING behind a human
      // exception — never a confirmation plus ledger posting on unproven data.
      // `port.name` routes the echo path but is never the proof of identity.
      if (!isEchoChargeRef) {
        // NEVER trust readback amounts: the provider value/currency must equal
        // the internal charge row exactly (mirrors the webhook check above), or
        // the charge stays PROCESSING behind a human exception — never a
        // confirmation plus ledger posting on unproven data.
        const matches = webhookAmountMatchesCharge({
          reportedAmountMinor: observed.valueMinor,
          reportedCurrency: observed.currency,
          chargeAmountMinor: charge.amountMinor,
          chargeCurrency: charge.currency,
        });
        if (!matches) {
          await openException(trx, ctx.tenantId, {
            kind: "AMOUNT_MISMATCH",
            chargeId: charge.id,
            reason: `Asaas readback amount/currency does not match charge ${charge.id}; confirmation refused`,
            payload: {
              provider_charge_id: binding.external_charge_id,
              reported_amount_minor: observed.valueMinor?.toString() ?? null,
              reported_currency: observed.currency,
              expected_amount_minor: charge.amountMinor.toString(),
              expected_currency: charge.currency,
              detail: observed.detail,
            },
          });
          return { ok: true, data: { id: charge.id, status: "PROCESSING", outcome: "exception" } };
        }
      }
      const confirmed = await confirmChargePaid(ctx, trx, charge, {
        providerEventId: `reconcile:${binding.external_charge_id}`,
      });
      return {
        ok: true,
        data: { id: charge.id, status: "PAID", outcome: confirmed.duplicate ? "duplicate" : "confirmed" },
      };
    }
    if (observed.status === "FAILED") {
      if (!isChargeTransition("PROCESSING", "FAILED")) {
        return { ok: false, code: "precondition_failed", message: "illegal charge transition" };
      }
      await trx
        .updateTable("billing.charges")
        .set({ status: "FAILED", updated_at: now() })
        .where("tenant_id", "=", ctx.tenantId)
        .where("id", "=", charge.id)
        .execute();
      await emitBilling(ctx, {
        eventType: "charge.failed.v1",
        aggregateType: "charge",
        aggregateId: charge.id,
        data: { charge_id: charge.id, order_id: charge.orderId, detail: observed.detail },
      });
      return { ok: true, data: { id: charge.id, status: "FAILED", outcome: "failed" } };
    }
    // Still UNKNOWN: keep PROCESSING, keep an OPEN reconcile task.
    const open = await trx
      .selectFrom("billing.exceptions")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("charge_id", "=", charge.id)
      .where("kind", "=", "PROVIDER_UNKNOWN_EFFECT")
      .where("status", "=", "OPEN")
      .executeTakeFirst();
    if (open === undefined) {
      await openException(trx, ctx.tenantId, {
        kind: "PROVIDER_UNKNOWN_EFFECT",
        chargeId: charge.id,
        reason: `charge ${charge.id} effect still unknown after reconcile; awaiting provider readback`,
        payload: { provider_charge_id: binding.external_charge_id, detail: observed.detail },
      });
    }
    return { ok: true, data: { id: charge.id, status: "PROCESSING", outcome: "unknown" } };
  };
}

async function handleChargeCancel(
  ctx: CommandHandlerContext,
  input: ChargeIdInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const trx = requireTrx(ctx);
  const charge = await loadChargeForUpdate(trx, ctx.tenantId, input.chargeId);
  if (charge === null) {
    return { ok: false, code: "not_found", message: "charge not found in this tenant" };
  }
  if (!isChargeTransition(charge.status, "CANCELLED")) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `charge is ${charge.status}; only PENDING/PROCESSING charges cancel`,
    };
  }
  await trx
    .updateTable("billing.charges")
    .set({ status: "CANCELLED", updated_at: now() })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", charge.id)
    .execute();
  await emitBilling(ctx, {
    eventType: "charge.cancelled.v1",
    aggregateType: "charge",
    aggregateId: charge.id,
    data: { charge_id: charge.id, order_id: charge.orderId },
  });
  return { ok: true, data: { id: charge.id, status: "CANCELLED" } };
}

async function handleChargeExpireDue(
  ctx: CommandHandlerContext,
  input: ChargeExpireDueInput,
): Promise<CommandResult<{ expired: string[] }>> {
  const trx = requireTrx(ctx);
  const at = new Date();
  const rows = await trx
    .selectFrom("billing.charges")
    .select(["id", "order_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("status", "in", ["PENDING", "PROCESSING"])
    .where("due_at", "is not", null)
    .where("due_at", "<=", at)
    .orderBy("due_at", "asc")
    .limit(input.limit)
    .execute();
  const expired: string[] = [];
  for (const row of rows) {
    const updated = await trx
      .updateTable("billing.charges")
      .set({ status: "EXPIRED", updated_at: at })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", row.id)
      .where("status", "in", ["PENDING", "PROCESSING"])
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      continue;
    }
    await emitBilling(ctx, {
      eventType: "charge.expired.v1",
      aggregateType: "charge",
      aggregateId: row.id,
      data: { charge_id: row.id, order_id: row.order_id, scheduler: "charge.expire_due" },
    });
    expired.push(row.id);
  }
  return { ok: true, data: { expired } };
}

// ---------------------------------------------------------------------------
// Refund contract
// ---------------------------------------------------------------------------

export const refundRequestInput = z.object({
  paymentId: z.string().uuid(),
  amountMinor: z.string().regex(/^\d+$/, "amountMinor must be integer minor units"),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reason: z.string().trim().min(1).max(500),
  /** Optional cross-check: when present it must equal the order's person. */
  personId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type RefundRequestInput = z.infer<typeof refundRequestInput>;

export const refundRequestIdInput = z.object({ refundRequestId: z.string().uuid() });
export type RefundRequestIdInput = z.infer<typeof refundRequestIdInput>;

export const refundIdInput = z.object({ refundId: z.string().uuid() });
export type RefundIdInput = z.infer<typeof refundIdInput>;

const REFUNDABLE_PAYMENT_STATUSES = ["CONFIRMED", "PARTIALLY_REFUNDED"] as const;

async function paymentRemainingMinor(
  trx: Transaction<Database>,
  tenantId: string,
  paymentId: string,
): Promise<{ found: boolean; status: string; paidMinor: bigint; remaining: bigint; currency: string; orderId: string }> {
  const payment = await trx
    .selectFrom("billing.payments")
    .select(["id", "order_id", "status", "amount_minor", "currency"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", paymentId)
    .forUpdate()
    .executeTakeFirst();
  if (payment === undefined) {
    return { found: false, status: "", paidMinor: 0n, remaining: 0n, currency: "", orderId: "" };
  }
  const consumed = await trx
    .selectFrom("billing.refunds")
    .select(["amount_minor"])
    .where("tenant_id", "=", tenantId)
    .where("payment_id", "=", paymentId)
    .where("status", "in", ["PROCESSING", "RECONCILING", "SUCCEEDED"])
    .execute();
  const consumedMinor = consumed.reduce((acc, r) => acc + toMinor(r.amount_minor), 0n);
  const paidMinor = toMinor(payment.amount_minor);
  return {
    found: true,
    status: payment.status,
    paidMinor,
    remaining: remainingRefundable({ paidMinor, consumedMinor }),
    currency: payment.currency,
    orderId: payment.order_id,
  };
}

async function handleRefundRequest(
  ctx: CommandHandlerContext,
  input: RefundRequestInput,
): Promise<CommandResult<{ id: string; status: string; reviewRequestId: string }>> {
  const trx = requireTrx(ctx);
  const amountMinor = toMinor(input.amountMinor);
  if (amountMinor <= 0n) {
    return { ok: false, code: "validation_failed", message: "refund amount must be positive" };
  }
  const payment = await paymentRemainingMinor(trx, ctx.tenantId, input.paymentId);
  if (!payment.found) {
    return { ok: false, code: "not_found", message: "payment not found in this tenant" };
  }
  if (!(REFUNDABLE_PAYMENT_STATUSES as readonly string[]).includes(payment.status)) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `payment is ${payment.status}; only CONFIRMED/PARTIALLY_REFUNDED payments refund`,
    };
  }
  if (input.currency !== payment.currency) {
    return {
      ok: false,
      code: "validation_failed",
      message: `currency mismatch: refund ${input.currency} vs payment ${payment.currency}`,
    };
  }
  if (input.personId !== undefined) {
    const order = await trx
      .selectFrom("commerce.orders")
      .select(["person_id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", payment.orderId)
      .executeTakeFirst();
    if (order === undefined || order.person_id !== input.personId) {
      return { ok: false, code: "precondition_failed", message: "cross-customer refund rejected: person does not own this payment" };
    }
  }
  if (amountMinor > payment.remaining) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `over-refund rejected: ${amountMinor} exceeds remaining refundable ${payment.remaining}`,
    };
  }
  // The HumanReview row is created first so the refund row can carry its id
  // (the `refund_requests_review_shape_check` CHECK requires it past REQUESTED).
  // Note the two requester vocabularies: `agent.human_review_requests`
  // wants the lowercase actor type, `billing.refund_requests` wants the
  // uppercase economic-actor kind.
  const refundRequestId = newId();
  const requestedByRefund = requesterKindOf(ctx.actor.actorType);
  const stored = await ctx.tx.createReviewRequest({
    resourceType: "refund_request",
    resourceId: refundRequestId,
    reviewMode: "APPROVAL",
    reason: "FINANCIAL_REVIEW",
    riskClass: "R3",
    priority: "HIGH",
    summary: `Refund ${amountMinor} ${payment.currency} on payment ${input.paymentId}: ${input.reason}`,
    contextJson: {
      payment_id: input.paymentId,
      amount_minor: amountMinor.toString(),
      currency: payment.currency,
      // Linkage marker consumed by refund-review.ts: only reviews carrying
      // `refund_request_id === resourceId` engage the refund revalidator and
      // resolve hook. Generic `refund_request`-typed reviews pass through.
      refund_request_id: refundRequestId,
    },
    requestedByType: ctx.actor.actorType,
    requestedById: ctx.actor.userId,
  });
  // Duplicate-safe insert: on conflict the tx stays healthy (a caught
  // unique violation would abort it — FIX-WAVE5-LIVE-2 #2).
  const requestInsert = await trx
    .insertInto("billing.refund_requests")
    .values({
      id: refundRequestId,
      tenant_id: ctx.tenantId,
      payment_id: input.paymentId,
      status: "UNDER_REVIEW",
      amount_minor: amountMinor.toString(),
      currency: payment.currency,
      reason: input.reason,
      requested_by_type: requestedByRefund,
      requested_by_id: ctx.actor.userId,
      idempotency_key: input.idempotencyKey,
      human_review_request_id: stored.id,
      requested_at: now(),
      decided_at: null,
      executed_at: null,
    })
    .onConflict((oc) => oc.columns(["tenant_id", "idempotency_key"]).doNothing())
    .returning(["id"])
    .executeTakeFirst();
  if (requestInsert === undefined) {
    return { ok: false, code: "precondition_failed", message: "duplicate refund request (idempotency key in use)" };
  }
  // The linked review carries the same resource id; emit the
  // review-requested event for the real linkage.
  await emitBilling(ctx, {
    eventType: "hitl.review_requested.v1",
    aggregateType: "human_review",
    aggregateId: stored.id,
    data: {
      review_id: stored.id,
      review_mode: "APPROVAL",
      reason: "FINANCIAL_REVIEW",
      resource_type: "refund_request",
      resource_id: refundRequestId,
      risk_class: "R3",
    },
  });
  return { ok: true, data: { id: refundRequestId, status: "UNDER_REVIEW", reviewRequestId: stored.id } };
}

async function advisoryLockPayment(trx: Transaction<Database>, paymentId: string): Promise<void> {
  // Per-payment serialization: concurrent executes on the SAME payment queue
  // here; different payments never block each other.
  await sql`SELECT pg_advisory_xact_lock(hashtext(${paymentId}))`.execute(trx);
}

async function approvedActionByOther(
  trx: Transaction<Database>,
  tenantId: string,
  reviewId: string,
  requesterId: string | null,
): Promise<{ approved: boolean; approverId: string | null }> {
  const actions = await trx
    .selectFrom("agent.human_review_actions")
    .select(["action_type", "actor_user_id"])
    .where("tenant_id", "=", tenantId)
    .where("human_review_request_id", "=", reviewId)
    .where("action_type", "=", "APPROVE")
    .execute();
  if (actions.length === 0) {
    return { approved: false, approverId: null };
  }
  const first = actions[0];
  if (first === undefined) {
    return { approved: false, approverId: null };
  }
  const approverId = first.actor_user_id;
  if (requesterId !== null && approverId === requesterId) {
    return { approved: false, approverId };
  }
  return { approved: true, approverId };
}

async function finalizeAppliedRefund(
  ctx: CommandHandlerContext,
  trx: Transaction<Database>,
  input: { refundId: string; refundRequestId: string; paymentId: string; amountMinor: bigint; currency: string; providerRefundId: string | null },
): Promise<{ paymentStatus: string }> {
  const at = now();
  await trx
    .updateTable("billing.refunds")
    .set({ status: "SUCCEEDED", effect_certainty: "KNOWN_APPLIED", provider_external_id: input.providerRefundId, completed_at: at })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.refundId)
    .execute();
  const payment = await paymentRemainingMinor(trx, ctx.tenantId, input.paymentId);
  const nextStatus = paymentStatusAfterRefund(payment.remaining);
  await trx
    .updateTable("billing.payments")
    .set({ status: nextStatus, updated_at: at })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.paymentId)
    .execute();
  const confirmationId = await findConfirmationTransactionId(trx, ctx.tenantId, input.paymentId);
  await postBalanced(trx, ctx.tenantId, {
    transactionType: "REFUND_REVERSAL",
    referenceType: "refund",
    referenceId: input.refundId,
    idempotencyKey: `refund-reversal:${input.refundId}`,
    reversalOfTransactionId: confirmationId,
    metadata: { payment_id: input.paymentId, provider_refund_id: input.providerRefundId },
    entries: refundReversalEntries(input.amountMinor, input.currency),
  });
  await trx
    .updateTable("billing.refund_requests")
    .set({ status: "EXECUTED", executed_at: at })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.refundRequestId)
    .execute();
  await emitBilling(ctx, {
    eventType: nextStatus === "REFUNDED" ? "payment.refunded.v1" : "payment.partially_refunded.v1",
    aggregateType: "payment",
    aggregateId: input.paymentId,
    data: {
      payment_id: input.paymentId,
      refund_id: input.refundId,
      amount_minor: input.amountMinor.toString(),
      currency: input.currency,
    },
  });
  return { paymentStatus: nextStatus };
}

function handleRefundExecuteFactory(deps: BillingCommandDeps) {
  return async (
    ctx: CommandHandlerContext,
    input: RefundRequestIdInput,
  ): Promise<CommandResult<{ refundId: string; status: string; effectCertainty: string }>> => {
    const trx = requireTrx(ctx);
    const rr = await trx
      .selectFrom("billing.refund_requests")
      .select(["id", "payment_id", "status", "amount_minor", "currency", "requested_by_id", "human_review_request_id", "decided_at"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.refundRequestId)
      .forUpdate()
      .executeTakeFirst();
    if (rr === undefined) {
      return { ok: false, code: "not_found", message: "refund request not found in this tenant" };
    }
    if (rr.status !== "APPROVED") {
      return {
        ok: false,
        code: "precondition_failed",
        message: `refund request is ${rr.status}; execution requires an APPROVED request (stale approvals are rejected)`,
      };
    }
    if (rr.human_review_request_id === null) {
      return { ok: false, code: "precondition_failed", message: "refund request has no linked human review" };
    }
    const review = await ctx.tx.getReviewRequest(rr.human_review_request_id);
    if (review === null || review.status !== "RESOLVED") {
      return { ok: false, code: "precondition_failed", message: "linked human review is not resolved; approval is stale" };
    }
    const approval = await approvedActionByOther(trx, ctx.tenantId, rr.human_review_request_id, rr.requested_by_id);
    if (!approval.approved) {
      return { ok: false, code: "precondition_failed", message: "no valid human approval by someone other than the requester" };
    }
    if (rr.decided_at !== null) {
      const ageHours = (Date.now() - new Date(rr.decided_at).getTime()) / 3_600_000;
      if (ageHours > approvalTtlHours()) {
        await trx
          .updateTable("billing.refund_requests")
          .set({ status: "EXPIRED" })
          .where("tenant_id", "=", ctx.tenantId)
          .where("id", "=", rr.id)
          .execute();
        return { ok: false, code: "precondition_failed", message: "stale approval rejected: decision expired" };
      }
    }
    const amountMinor = toMinor(rr.amount_minor);
    await advisoryLockPayment(trx, rr.payment_id);
    const payment = await paymentRemainingMinor(trx, ctx.tenantId, rr.payment_id);
    if (!payment.found) {
      return { ok: false, code: "not_found", message: "linked payment not found in this tenant" };
    }
    if (!(REFUNDABLE_PAYMENT_STATUSES as readonly string[]).includes(payment.status)) {
      return { ok: false, code: "precondition_failed", message: `linked payment is ${payment.status}; cannot execute` };
    }
    if (amountMinor > payment.remaining) {
      return {
        ok: false,
        code: "precondition_failed",
        message: `over-refund rejected: ${amountMinor} exceeds remaining refundable ${payment.remaining}`,
      };
    }
    // Reserve first: one refund row per request (unique) in PROCESSING/UNKNOWN.
    // On-conflict-do-nothing keeps the tx healthy (FIX-WAVE5-LIVE-2 #2).
    const refundId = newId();
    const reserveInsert = await trx
      .insertInto("billing.refunds")
      .values({
        id: refundId,
        tenant_id: ctx.tenantId,
        refund_request_id: rr.id,
        payment_id: rr.payment_id,
        status: "PROCESSING",
        effect_certainty: "UNKNOWN",
        amount_minor: amountMinor.toString(),
        currency: rr.currency,
        provider_external_id: null,
        started_at: now(),
        completed_at: null,
      })
      .onConflict((oc) => oc.columns(["tenant_id", "refund_request_id"]).doNothing())
      .returning(["id"])
      .executeTakeFirst();
    if (reserveInsert === undefined) {
      return { ok: false, code: "precondition_failed", message: "refund already executed for this request" };
    }
    const port = deps.asaasPort ?? resolveAsaasPort(asaasAdapterNameFromEnv());
    // CRITICAL: the provider refund targets the EXTERNAL Asaas charge id
    // (Payment → Charge → charge_provider_bindings), never the internal
    // `billing.payments` UUID. Without a proven external id the effect is
    // uncertain: hold the reservation (RECONCILING + exception) and NEVER
    // call the provider with a local id.
    const paymentCharge = await trx
      .selectFrom("billing.payments")
      .select(["charge_id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", rr.payment_id)
      .executeTakeFirst();
    const binding = paymentCharge === undefined
      ? undefined
      : await trx
        .selectFrom("billing.charge_provider_bindings")
        .select(["external_charge_id"])
        .where("tenant_id", "=", ctx.tenantId)
        .where("charge_id", "=", paymentCharge.charge_id)
        .where("provider", "=", "ASAAS")
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst();
    const bindingRaw = binding?.external_charge_id ?? null;
    const externalChargeId = provenExternalChargeId(port.name, bindingRaw);
    // Namespace fast-path (MVP-ASAAS-05): never call the provider adapter
    // for a foreign binding. Echo owns ONLY `echo-` refs; real owns ONLY
    // proven external ids (`echo-` ⊂ synthetic → null → hold). A mismatch
    // holds the reservation (RECONCILING + exception) with zero adapter I/O.
    // The adapter chokepoint (UNKNOWN on foreign refs, never KNOWN_APPLIED)
    // is the slow-path backstop if this guard is ever bypassed — UNKNOWN
    // also retains via the branch below and can never reach
    // finalizeAppliedRefund.
    const isEchoPort = port.name === "echo";
    const namespaceMismatch = isEchoPort
      ? !isEchoProviderReference(bindingRaw)
      : externalChargeId === null;
    const shouldHoldWithoutCalling = externalChargeId === null || namespaceMismatch;
    const result: RefundResult =
      shouldHoldWithoutCalling
        ? {
          effect: "UNKNOWN",
          providerRefundId: null,
          detail: isEchoPort && namespaceMismatch
            ? "echo adapter cannot execute refund for non-echo binding; reservation held (provider never called)"
            : "no proven external Asaas charge for this payment; refund not attempted (reservation held)",
        }
        : await port.executeRefund({
          paymentId: rr.payment_id,
          refundId,
          providerChargeId: externalChargeId,
          valueMinor: amountMinor,
          currency: rr.currency,
        });
    if (result.effect === "KNOWN_APPLIED") {
      const { paymentStatus } = await finalizeAppliedRefund(ctx, trx, {
        refundId,
        refundRequestId: rr.id,
        paymentId: rr.payment_id,
        amountMinor,
        currency: rr.currency,
        providerRefundId: result.providerRefundId,
      });
      return { ok: true, data: { refundId, status: paymentStatus, effectCertainty: "KNOWN_APPLIED" } };
    }
    if (result.effect === "KNOWN_NOT_APPLIED") {
      await trx
        .updateTable("billing.refunds")
        .set({ status: "FAILED", effect_certainty: "KNOWN_NOT_APPLIED", completed_at: now() })
        .where("tenant_id", "=", ctx.tenantId)
        .where("id", "=", refundId)
        .execute();
      // Consumed: a retry needs a fresh human-approved request.
      await trx
        .updateTable("billing.refund_requests")
        .set({ status: "EXECUTED", executed_at: now() })
        .where("tenant_id", "=", ctx.tenantId)
        .where("id", "=", rr.id)
        .execute();
      return { ok: true, data: { refundId, status: "FAILED", effectCertainty: "KNOWN_NOT_APPLIED" } };
    }
    await trx
      .updateTable("billing.refunds")
      .set({ status: "RECONCILING", effect_certainty: "UNKNOWN", provider_external_id: result.providerRefundId })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", refundId)
      .execute();
    await openException(trx, ctx.tenantId, {
      kind: "REFUND_UNKNOWN_EFFECT",
      paymentId: rr.payment_id,
      refundId,
      reason: `refund ${refundId} effect unknown; reconcile before any retry (reservation held)`,
      payload: { provider_refund_id: result.providerRefundId, detail: result.detail },
    });
    return { ok: true, data: { refundId, status: "RECONCILING", effectCertainty: "UNKNOWN" } };
  };
}

async function ensureRefundUnknownException(
  trx: Transaction<Database>,
  tenantId: string,
  refund: { id: string; payment_id: string },
  detail: string,
): Promise<void> {
  const open = await trx
    .selectFrom("billing.exceptions")
    .select(["id"])
    .where("tenant_id", "=", tenantId)
    .where("refund_id", "=", refund.id)
    .where("status", "=", "OPEN")
    .executeTakeFirst();
  if (open === undefined) {
    await openException(trx, tenantId, {
      kind: "REFUND_UNKNOWN_EFFECT",
      paymentId: refund.payment_id,
      refundId: refund.id,
      reason: `refund ${refund.id} still unknown after reconcile; reservation held`,
      payload: { detail },
    });
  }
}

function handleRefundReconcileFactory(deps: BillingCommandDeps) {
  return async (
    ctx: CommandHandlerContext,
    input: RefundIdInput,
  ): Promise<CommandResult<{ refundId: string; status: string; effectCertainty: string }>> => {
    const trx = requireTrx(ctx);
    const refund = await trx
      .selectFrom("billing.refunds")
      .select(["id", "refund_request_id", "payment_id", "status", "effect_certainty", "amount_minor", "currency", "provider_external_id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.refundId)
      .forUpdate()
      .executeTakeFirst();
    if (refund === undefined) {
      return { ok: false, code: "not_found", message: "refund not found in this tenant" };
    }
    if (refund.status !== "RECONCILING") {
      return {
        ok: false,
        code: "precondition_failed",
        message: `refund is ${refund.status}; reconcile requires RECONCILING`,
      };
    }
    await advisoryLockPayment(trx, refund.payment_id);
    const port = deps.asaasPort ?? resolveAsaasPort(asaasAdapterNameFromEnv());
    // Namespace guard (MVP-ASAAS-04): reconcile safety comes from the
    // persisted reference namespace, never from `port.name` alone.
    // - REAL resolves ONLY proven external refs (synthetic/local → hold).
    // - ECHO resolves ONLY `echo-` refs; a real (or otherwise foreign)
    //   reference under echo stays RECONCILING behind a conservative
    //   exception — it must never resolve with a synthetic echo outcome
    //   after a config swap (no ledger, reservation retained).
    // - Null/blank can never be proven on either adapter → always hold.
    // No proven external refund id (execute timed out / 5xx / was never
    // attempted, so `provider_external_id` is null or a local/synthetic
    // reference): a 404 here could never prove non-execution. Hold the
    // reservation as UNKNOWN — NEVER convert it into KNOWN_NOT_APPLIED.
    const refundRef = refund.provider_external_id;
    const isBlankRefundRef = typeof refundRef !== "string" || refundRef.trim().length === 0;
    const isEchoRefundRef = isEchoProviderReference(refundRef);
    if (
      isBlankRefundRef ||
      (port.name !== "echo" && isSyntheticProviderReference(refundRef)) ||
      (port.name === "echo" && !isEchoRefundRef)
    ) {
      await ensureRefundUnknownException(
        trx,
        ctx.tenantId,
        refund,
        "no proven external refund id; reconcile cannot prove non-execution (reservation held)",
      );
      return { ok: true, data: { refundId: refund.id, status: "RECONCILING", effectCertainty: "UNKNOWN" } };
    }
    const observed = await port.getRefund({ providerRefundId: refundRef as string });
    if (observed.effect === "KNOWN_APPLIED") {
      const { paymentStatus } = await finalizeAppliedRefund(ctx, trx, {
        refundId: refund.id,
        refundRequestId: refund.refund_request_id,
        paymentId: refund.payment_id,
        amountMinor: toMinor(refund.amount_minor),
        currency: refund.currency,
        providerRefundId: observed.providerRefundId ?? refund.provider_external_id,
      });
      await resolveOpenExceptionForRefund(trx, ctx.tenantId, refund.id, `refund ${refund.id} reconciled as applied`);
      return { ok: true, data: { refundId: refund.id, status: paymentStatus, effectCertainty: "KNOWN_APPLIED" } };
    }
    if (observed.effect === "KNOWN_NOT_APPLIED") {
      await trx
        .updateTable("billing.refunds")
        .set({ status: "FAILED", effect_certainty: "KNOWN_NOT_APPLIED", completed_at: now() })
        .where("tenant_id", "=", ctx.tenantId)
        .where("id", "=", refund.id)
        .execute();
      await trx
        .updateTable("billing.refund_requests")
        .set({ status: "EXECUTED", executed_at: now() })
        .where("tenant_id", "=", ctx.tenantId)
        .where("id", "=", refund.refund_request_id)
        .execute();
      await resolveOpenExceptionForRefund(trx, ctx.tenantId, refund.id, `refund ${refund.id} reconciled as not applied; reservation released`);
      return { ok: true, data: { refundId: refund.id, status: "FAILED", effectCertainty: "KNOWN_NOT_APPLIED" } };
    }
    await ensureRefundUnknownException(trx, ctx.tenantId, refund, observed.detail);
    return { ok: true, data: { refundId: refund.id, status: "RECONCILING", effectCertainty: "UNKNOWN" } };
  };
}

// ---------------------------------------------------------------------------
// Chargeback (distinct path) + exception resolution
// ---------------------------------------------------------------------------

export const chargebackInput = z.object({
  paymentId: z.string().uuid(),
  providerEventId: z.string().trim().min(1).max(200),
  amountMinor: z.string().regex(/^\d+$/).optional(),
});
export type ChargebackInput = z.infer<typeof chargebackInput>;

async function handleChargeback(
  ctx: CommandHandlerContext,
  input: ChargebackInput,
): Promise<CommandResult<{ paymentId: string; status: string; duplicate: boolean; exceptionId: string | null }>> {
  const trx = requireTrx(ctx);
  const payment = await trx
    .selectFrom("billing.payments")
    .select(["id", "order_id", "status", "amount_minor", "currency"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.paymentId)
    .forUpdate()
    .executeTakeFirst();
  if (payment === undefined) {
    return { ok: false, code: "not_found", message: "payment not found in this tenant" };
  }
  if (payment.status === "CHARGEBACK") {
    return { ok: true, data: { paymentId: payment.id, status: "CHARGEBACK", duplicate: true, exceptionId: null } };
  }
  const paidMinor = toMinor(payment.amount_minor);
  const amountMinor = input.amountMinor !== undefined ? toMinor(input.amountMinor) : paidMinor;
  if (amountMinor <= 0n || amountMinor > paidMinor) {
    return { ok: false, code: "validation_failed", message: "chargeback amount must be within the paid amount" };
  }
  const at = now();
  await trx
    .updateTable("billing.payments")
    .set({ status: "CHARGEBACK", updated_at: at })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", payment.id)
    .execute();
  const confirmationId = await findConfirmationTransactionId(trx, ctx.tenantId, payment.id);
  await postBalanced(trx, ctx.tenantId, {
    transactionType: "CHARGEBACK_REVERSAL",
    referenceType: "payment",
    referenceId: payment.id,
    idempotencyKey: `chargeback-reversal:${input.providerEventId}`,
    reversalOfTransactionId: confirmationId,
    metadata: { provider_event_id: input.providerEventId },
    entries: chargebackReversalEntries(amountMinor, payment.currency),
  });
  const exceptionId = await openException(trx, ctx.tenantId, {
    kind: "CHARGEBACK",
    paymentId: payment.id,
    reason: `issuer chargeback on payment ${payment.id}; reversal posted, human review required (distinct from refunds)`,
    payload: { provider_event_id: input.providerEventId, amount_minor: amountMinor.toString() },
  });
  await emitBilling(ctx, {
    eventType: "payment.chargeback.v1",
    aggregateType: "payment",
    aggregateId: payment.id,
    data: {
      payment_id: payment.id,
      order_id: payment.order_id,
      amount_minor: amountMinor.toString(),
      currency: payment.currency,
      provider_event_id: input.providerEventId,
    },
  });
  return { ok: true, data: { paymentId: payment.id, status: "CHARGEBACK", duplicate: false, exceptionId } };
}

export const exceptionResolveInput = z.object({
  exceptionId: z.string().uuid(),
  decision: z.enum(["RESOLVED", "DISCARDED"]),
  note: z.string().trim().min(1).max(500).optional(),
});
export type ExceptionResolveInput = z.infer<typeof exceptionResolveInput>;

async function handleExceptionResolve(
  ctx: CommandHandlerContext,
  input: ExceptionResolveInput,
): Promise<CommandResult<{ id: string; status: string }>> {
  const trx = requireTrx(ctx);
  const at = now();
  const updated = await trx
    .updateTable("billing.exceptions")
    .set({ status: input.decision, resolved_at: at, updated_at: at })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.exceptionId)
    .where("status", "=", "OPEN")
    .returning(["id", "status"])
    .executeTakeFirst();
  if (updated === undefined) {
    return { ok: false, code: "precondition_failed", message: "exception is not OPEN in this tenant" };
  }
  return { ok: true, data: { id: updated.id, status: updated.status } };
}

export function registerBillingCommands(bus: CommandBus, deps: BillingCommandDeps = {}): void {
  bus.register<ChargeCreateInput, { id: string; status: string; providerChargeId: string | null; effectUncertain: boolean }>({
    name: "charge.create",
    permission: "billing.charge.write",
    auditAction: "charge.create",
    auditResource: "charge",
    input: chargeCreateInput,
    handler: handleChargeCreateFactory(deps),
  });
  bus.register<WebhookConfirmInput, { outcome: "confirmed" | "duplicate" | "exception"; paymentId: string | null; exceptionId: string | null }>({
    name: "charge.webhook_confirm",
    permission: "billing.charge.write",
    auditAction: "charge.webhook_confirm",
    auditResource: "charge",
    input: webhookConfirmInput,
    handler: handleWebhookConfirm,
  });
  bus.register<ChargeIdInput, { id: string; status: string; outcome: string }>({
    name: "charge.reconcile",
    permission: "billing.charge.write",
    auditAction: "charge.reconcile",
    auditResource: "charge",
    input: chargeIdInput,
    handler: handleChargeReconcileFactory(deps),
  });
  bus.register<ChargeIdInput, { id: string; status: string }>({
    name: "charge.cancel",
    permission: "billing.charge.write",
    auditAction: "charge.cancel",
    auditResource: "charge",
    input: chargeIdInput,
    handler: handleChargeCancel,
  });
  bus.register<ChargeExpireDueInput, { expired: string[] }>({
    name: "charge.expire_due",
    permission: "billing.charge.write",
    auditAction: "charge.expire_due",
    auditResource: "charge",
    input: chargeExpireDueInput,
    handler: handleChargeExpireDue,
  });
  bus.register<RefundRequestInput, { id: string; status: string; reviewRequestId: string }>({
    name: "refund.request",
    permission: "billing.refund.request",
    auditAction: "refund.request",
    auditResource: "refund_request",
    input: refundRequestInput,
    handler: handleRefundRequest,
  });
  bus.register<RefundRequestIdInput, { refundId: string; status: string; effectCertainty: string }>({
    name: "refund.execute_approved",
    permission: "billing.refund.execute",
    auditAction: "refund.execute_approved",
    auditResource: "refund",
    input: refundRequestIdInput,
    handler: handleRefundExecuteFactory(deps),
  });
  bus.register<RefundIdInput, { refundId: string; status: string; effectCertainty: string }>({
    name: "refund.reconcile",
    permission: "billing.refund.execute",
    auditAction: "refund.reconcile",
    auditResource: "refund",
    input: refundIdInput,
    handler: handleRefundReconcileFactory(deps),
  });
  bus.register<ChargebackInput, { paymentId: string; status: string; duplicate: boolean; exceptionId: string | null }>({
    name: "payment.record_chargeback",
    permission: "billing.charge.write",
    auditAction: "payment.record_chargeback",
    auditResource: "payment",
    input: chargebackInput,
    handler: handleChargeback,
  });
  bus.register<ExceptionResolveInput, { id: string; status: string }>({
    name: "billing.exception_resolve",
    permission: "billing.exception.resolve",
    auditAction: "billing.exception_resolve",
    auditResource: "billing_exception",
    input: exceptionResolveInput,
    handler: handleExceptionResolve,
  });
}
