import { z } from "zod";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { emitAndEnqueue, kyselyTrxOf } from "../crm/wave2-store.js";
import { UniqueViolationError } from "../trial/trial-store.js";
import {
  StubProviderReadback,
  adapterNameFromEnv,
  applyCapabilityGate,
  resolveOpsPort,
  type ProviderOpsPort,
  type ProviderReadbackPort,
} from "../provider/provider-port.js";
import {
  evaluateAppProcurementReadiness,
  type AppProcurementReasonCode,
} from "./app-procurement-policy.js";
import {
  advisoryLockLicenseScope,
  findOpenFinding,
  getLicenseAsset,
  insertLicenseAsset,
  latestLicenseAsset,
  openReconciliationFinding,
  resolveReconciliationFinding,
  type LicenseAssetRow,
} from "./license.store.js";
import {
  advisoryLockReservationScope,
  advisoryLockSupplierBalance,
  getProcurementOrder,
  getReservation,
  latestBalanceSnapshot,
  updateProcurementStatusIf,
  updateReservationStatusIf,
  type ProcurementOrderRow,
} from "./supplier-credit.store.js";
import {
  ensureTrialProviderAccount,
  getProviderOperation,
  insertProviderAttempt,
  insertProviderOperation,
  latestProviderOperationForEntity,
  updateProviderOperation,
} from "../trial/trial-store.js";

/**
 * Wave 7 slice S3: orchestrated app-license purchase + activation +
 * supplier reconciliation (owning context for LicenseAsset).
 *
 * Crash-safe two-phase purchase (review iptv-w7-review F1):
 * - `inventory.purchase_app_license` registers the INTENT only: gate +
 *   one PROVISIONING license row + one REQUESTED provider operation, all
 *   committed BEFORE any external effect. It never calls the provider.
 * - `inventory.execute_app_license_charge` runs the single supplier
 *   charge (same deterministic idempotency key) and finalizes. A retry
 *   never blindly re-executes: a non-terminal operation is reconciled
 *   through readback FIRST, and a port throw is captured as VERIFYING +
 *   OPEN finding (committed) instead of a silent rollback that would
 *   invite a second charge.
 * - `inventory.activate_app_license` finalizes the license from the
 *   OBSERVED provider effect (readback port, never a re-execution):
 *   KNOWN_APPLIED -> ACTIVE with activation evidence + the registry-
 *   listed `inventory.license.activated.v1`; KNOWN_NOT_APPLIED -> FAILED;
 *   INCONCLUSIVE -> stays VERIFYING with the finding OPEN (never a
 *   failure, never a close without proof).
 * - `inventory.reconcile_supplier_purchase` closes the finding with the
 *   readback result (conclusive only). It never re-executes the charge.
 *
 * Money moves only under the shared locks (review F2: supplier lock
 * first, reservation-scope lock second — the same keys and order as
 * release/expire) with conditional transitions, so purchase vs
 * release/expire of one reservation always serialize and the loser
 * observes instead of overwriting.
 */

export const purchaseAppLicenseInput = z.object({
  procurementOrderId: z.string().uuid(),
  customerId: z.string().uuid(),
  providerAccountId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  adapter: z.enum(["echo", "manual"]).optional(),
  echoOutcome: z.enum(["success", "failed", "unknown"]).optional(),
});

export type PurchaseAppLicenseInput = z.infer<typeof purchaseAppLicenseInput>;

export const activateAppLicenseInput = z.object({
  licenseId: z.string().uuid(),
});

export type ActivateAppLicenseInput = z.infer<typeof activateAppLicenseInput>;

export const executeAppLicenseChargeInput = z.object({
  licenseId: z.string().uuid(),
  adapter: z.enum(["echo", "manual"]).optional(),
  echoOutcome: z.enum(["success", "failed", "unknown"]).optional(),
});

export type ExecuteAppLicenseChargeInput = z.infer<typeof executeAppLicenseChargeInput>;

export const reconcileSupplierPurchaseInput = z.object({
  licenseId: z.string().uuid(),
});

export type ReconcileSupplierPurchaseInput = z.infer<typeof reconcileSupplierPurchaseInput>;

export interface LicenseCommandDeps {
  opsPort?: ProviderOpsPort;
  readbackPort?: ProviderReadbackPort;
}

export const GATE_MESSAGE: Record<AppProcurementReasonCode, string> = {
  PRECONDITIONS_MET: "preconditions met",
  CATALOG_ITEM_MISSING: "supplier catalog item for this app is missing",
  TRIAL_NOT_VALIDATED: "app trial is not VALIDATED",
  ORDER_NOT_SETTLED: "commerce order is not SETTLED",
  APP_COST_UNKNOWN: "app cost is unknown",
  INVALID_APP_COST: "app cost is invalid",
  SUPPLIER_BALANCE_UNKNOWN: "supplier balance is unknown",
  INVALID_SUPPLIER_BALANCE: "supplier balance is invalid",
  INVALID_CURRENCY: "currency is invalid",
  CURRENCY_MISMATCH: "cost and balance currencies differ",
  INSUFFICIENT_SUPPLIER_BALANCE: "supplier balance is insufficient (caller pauses/alerts, F15)",
};

function toPublicLicense(row: LicenseAssetRow): Record<string, unknown> {
  return {
    id: row.id,
    customerId: row.customerId,
    procurementOrderId: row.procurementOrderId,
    supplierId: row.supplierId,
    priorAssetId: row.priorAssetId,
    externalLicenseRef: row.externalLicenseRef,
    status: row.status,
    activationEvidence: row.activationEvidence,
    createdAt: row.createdAt.toISOString(),
  };
}

async function emitLicense(
  ctx: CommandHandlerContext,
  input: { eventType: string; licenseId: string; data: Record<string, unknown> },
): Promise<void> {
  await emitAndEnqueue(ctx, {
    eventType: input.eventType,
    aggregateType: "license_asset",
    aggregateId: input.licenseId,
    data: { license_id: input.licenseId, ...input.data },
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

async function resolveAccountId(
  ctx: CommandHandlerContext,
  providerAccountId: string | undefined,
): Promise<{ id: string } | { error: CommandResult<never> }> {
  if (providerAccountId === undefined) {
    // Wave-7 fake path anchors on the tenant's synthetic provider account
    // until a real MK provider catalog exists (no credentials anywhere).
    return ensureTrialProviderAccount(ctx);
  }
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("license commands require a database transaction");
  }
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

interface PurchaseGate {
  procurement: {
    id: string;
    supplierId: string;
    commerceOrderId: string;
    appTrialId: string;
    creditReservationId: string | null;
    status: string;
  };
  reservationId: string;
  amountMinor: string;
  currency: string;
}

/**
 * Wave 7 review fix F3: the purchase gate validates, in the SAME
 * transaction, that the trial belongs to the procurement's supplier, that
 * the SETTLED commerce Order belongs to the trial's customer/person, and
 * that the supplier catalog snapshot actually carries the trialed app
 * (the procurement carries no snapshot/item ref of its own, so the
 * latest-snapshot proof on the procurement supplier is the binding
 * evidence). Pure reads + fail-closed precondition results.
 */
async function loadAndCheckGate(
  ctx: CommandHandlerContext,
  input: { procurementOrderId: string; customerId: string },
): Promise<CommandResult<PurchaseGate>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("license commands require a database transaction");
  }
  const procurement = await getProcurementOrder(ctx, input.procurementOrderId);
  if (procurement === null) {
    return { ok: false, code: "not_found", message: "procurement order not found in this tenant" };
  }
  if (procurement.status !== "RESERVED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `procurement order is ${procurement.status}; purchase requires RESERVED (reserve credit first)`,
    };
  }

  const customer = await trx
    .selectFrom("crm.customers")
    .select(["id", "person_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.customerId)
    .executeTakeFirst();
  if (customer === undefined) {
    return { ok: false, code: "not_found", message: "customer not found in this tenant" };
  }

  const trialRow = await trx
    .selectFrom("inventory.app_trials")
    .select(["id", "person_id", "customer_id", "supplier_id", "supplier_app_external_id", "status"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", procurement.appTrialId)
    .executeTakeFirst();
  if (trialRow === undefined) {
    return { ok: false, code: "not_found", message: "app trial not found in this tenant" };
  }
  if (trialRow.supplier_id !== procurement.supplierId) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "app trial does not belong to the procurement supplier",
    };
  }
  if (customer.person_id !== trialRow.person_id) {
    return { ok: false, code: "precondition_failed", message: "customer does not own this app trial" };
  }
  if (trialRow.customer_id !== null && trialRow.customer_id !== input.customerId) {
    return { ok: false, code: "precondition_failed", message: "customer does not match the trial customer" };
  }

  const orderRow = await trx
    .selectFrom("commerce.orders")
    .select(["id", "status", "customer_id", "person_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", procurement.commerceOrderId)
    .executeTakeFirst();
  if (orderRow === undefined) {
    return { ok: false, code: "not_found", message: "commerce order not found in this tenant" };
  }
  if (orderRow.person_id !== customer.person_id) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "commerce order does not belong to the trial person",
    };
  }
  if (orderRow.customer_id !== null && orderRow.customer_id !== input.customerId) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "commerce order does not belong to this customer",
    };
  }

  const reservationRow = await trx
    .selectFrom("inventory.credit_reservations")
    .select(["id", "status", "total_minor", "currency"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", procurement.creditReservationId ?? "__none__")
    .executeTakeFirst();
  if (reservationRow === undefined || reservationRow.status !== "ACTIVE") {
    return {
      ok: false,
      code: "precondition_failed",
      message: "linked credit reservation is not ACTIVE (reserve credit first)",
    };
  }

  // Catalog proof: the latest supplier snapshot must carry the trialed app.
  const latestSnapshot = await trx
    .selectFrom("inventory.supplier_app_snapshots")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("supplier_id", "=", procurement.supplierId)
    .orderBy("captured_at", "desc")
    .executeTakeFirst();
  let catalogItemExists = false;
  if (latestSnapshot !== undefined) {
    const item = await trx
      .selectFrom("inventory.supplier_app_items")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("snapshot_id", "=", latestSnapshot.id)
      .where("external_id", "=", trialRow.supplier_app_external_id)
      .executeTakeFirst();
    catalogItemExists = item !== undefined;
  }

  await advisoryLockSupplierBalance(trx, ctx.tenantId, procurement.supplierId);
  const balance = await latestBalanceSnapshot(ctx, procurement.supplierId);

  const gate = evaluateAppProcurementReadiness({
    catalogItemExists,
    trialValidated: trialRow.status === "VALIDATED",
    orderStatus: orderRow.status,
    appCostMinor: String(reservationRow.total_minor),
    appCurrency: reservationRow.currency,
    supplierBalanceMinor: balance === null ? null : balance.balanceMinor,
    supplierCurrency: balance === null ? null : balance.currency,
  });
  if (gate.status !== "READY_FOR_RESERVATION") {
    const reason = gate.reasonCodes[0];
    return { ok: false, code: "precondition_failed", message: `BLOCKED ${reason}: ${GATE_MESSAGE[reason]}` };
  }
  return {
    ok: true,
    data: {
      procurement,
      reservationId: reservationRow.id,
      amountMinor: String(reservationRow.total_minor),
      currency: reservationRow.currency,
    },
  };
}

/**
 * Wave 7 review fix F3 (execute path): re-validate ownership + hold
 * liveness right before the charge, in the same transaction. The
 * balance-pool math is intentionally NOT re-run here: the ACTIVE hold
 * already earmarks these funds (re-running would double-count our own
 * hold against the pool and spuriously block).
 */
async function recheckGateForExecution(
  ctx: CommandHandlerContext,
  input: { procurementOrderId: string; customerId: string },
): Promise<CommandResult<PurchaseGate>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("license commands require a database transaction");
  }
  const procurement = await getProcurementOrder(ctx, input.procurementOrderId);
  if (procurement === null) {
    return { ok: false, code: "not_found", message: "procurement order not found in this tenant" };
  }
  if (procurement.status !== "RESERVED") {
    return {
      ok: false,
      code: "precondition_failed",
      message: `procurement order is ${procurement.status}; charge requires RESERVED`,
    };
  }
  const customer = await trx
    .selectFrom("crm.customers")
    .select(["id", "person_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.customerId)
    .executeTakeFirst();
  if (customer === undefined) {
    return { ok: false, code: "not_found", message: "customer not found in this tenant" };
  }
  const trialRow = await trx
    .selectFrom("inventory.app_trials")
    .select(["id", "person_id", "customer_id", "supplier_id", "status"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", procurement.appTrialId)
    .executeTakeFirst();
  if (trialRow === undefined) {
    return { ok: false, code: "not_found", message: "app trial not found in this tenant" };
  }
  if (trialRow.supplier_id !== procurement.supplierId) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "app trial does not belong to the procurement supplier",
    };
  }
  if (customer.person_id !== trialRow.person_id) {
    return { ok: false, code: "precondition_failed", message: "customer does not own this app trial" };
  }
  if (trialRow.customer_id !== null && trialRow.customer_id !== input.customerId) {
    return { ok: false, code: "precondition_failed", message: "customer does not match the trial customer" };
  }
  if (trialRow.status !== "VALIDATED") {
    return { ok: false, code: "precondition_failed", message: "BLOCKED TRIAL_NOT_VALIDATED: app trial is not VALIDATED" };
  }
  const orderRow = await trx
    .selectFrom("commerce.orders")
    .select(["id", "status", "customer_id", "person_id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", procurement.commerceOrderId)
    .executeTakeFirst();
  if (orderRow === undefined) {
    return { ok: false, code: "not_found", message: "commerce order not found in this tenant" };
  }
  if (orderRow.status !== "SETTLED") {
    return { ok: false, code: "precondition_failed", message: "BLOCKED ORDER_NOT_SETTLED: commerce order is not SETTLED" };
  }
  if (orderRow.person_id !== customer.person_id) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "commerce order does not belong to the trial person",
    };
  }
  if (orderRow.customer_id !== null && orderRow.customer_id !== input.customerId) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "commerce order does not belong to this customer",
    };
  }
  const reservationRow = await trx
    .selectFrom("inventory.credit_reservations")
    .select(["id", "status", "total_minor", "currency"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", procurement.creditReservationId ?? "__none__")
    .executeTakeFirst();
  if (reservationRow === undefined || reservationRow.status !== "ACTIVE") {
    return {
      ok: false,
      code: "precondition_failed",
      message: "linked credit reservation is not ACTIVE (it was released, expired or consumed)",
    };
  }
  return {
    ok: true,
    data: {
      procurement,
      reservationId: reservationRow.id,
      amountMinor: String(reservationRow.total_minor),
      currency: reservationRow.currency,
    },
  };
}

function handlePurchaseFactory() {
  return async (
    ctx: CommandHandlerContext,
    input: PurchaseAppLicenseInput,
  ): Promise<CommandResult<Record<string, unknown>>> => {
    const trx = kyselyTrxOf(ctx);
    if (trx === null) {
      throw new Error("license commands require a database transaction");
    }
    await advisoryLockLicenseScope(trx, ctx.tenantId, input.procurementOrderId);

    const procurement = await getProcurementOrder(ctx, input.procurementOrderId);
    if (procurement === null) {
      return { ok: false, code: "not_found", message: "procurement order not found in this tenant" };
    }
    if (procurement.status === "PURCHASED") {
      const current = await latestLicenseAsset(ctx, procurement.id);
      return {
        ok: true,
        data: { ...(current === null ? {} : toPublicLicense(current)), already: true },
      };
    }
    if (procurement.status !== "RESERVED") {
      return {
        ok: false,
        code: "precondition_failed",
        message: `procurement order is ${procurement.status}; purchase requires RESERVED (reserve credit first)`,
      };
    }
    // One charge per purchase, G07: an existing license row means this
    // procurement already ran its intent — never re-register blindly.
    // A non-terminal operation still needs execution (the execute step
    // reconciles through readback FIRST); a terminal one replays.
    const existing = await latestLicenseAsset(ctx, procurement.id);
    if (existing !== null) {
      const existingOp = await latestProviderOperationForEntity(ctx, "app_license", existing.id);
      if (existingOp !== null && existingOp.status === "SUCCEEDED" && existingOp.effectCertainty === "KNOWN_APPLIED") {
        return { ok: true, data: { ...toPublicLicense(existing), already: true, operationId: existingOp.id } };
      }
      if (existingOp === null) {
        // Defensive repair: intent without an operation (never happens in
        // the normal flow) — register the REQUESTED operation now so the
        // execute step has a reconciliable intention.
        const repairAccount = await resolveAccountId(ctx, input.providerAccountId);
        const repairAccountId = "error" in repairAccount
          ? (await ensureTrialProviderAccount(ctx)).id
          : repairAccount.id;
        const repaired = await insertProviderOperation(ctx, {
          providerAccountId: repairAccountId,
          action: "app_license.purchase",
          entityType: "app_license",
          entityId: existing.id,
          idempotencyKey: input.idempotencyKey?.trim() || `app-license-purchase:${procurement.id}`,
          requestedPayload: { procurement_order_id: procurement.id, repaired: true },
          adapterVersion: "repair-v1",
        });
        await emitProvider(ctx, {
          eventType: "provider.operation_requested.v1",
          operationId: repaired.id,
          data: { action: "app_license.purchase", entity_type: "app_license", entity_id: existing.id, repaired: true },
        });
        return {
          ok: true,
          data: { ...toPublicLicense(existing), already: true, operationId: repaired.id, needsExecution: true },
        };
      }
      return {
        ok: true,
        data: {
          ...toPublicLicense(existing),
          already: true,
          operationId: existingOp.id,
          needsExecution: true,
        },
      };
    }

    const gate = await loadAndCheckGate(ctx, {
      procurementOrderId: input.procurementOrderId,
      customerId: input.customerId,
    });
    if (!gate.ok) {
      return gate;
    }

    const account = await resolveAccountId(ctx, input.providerAccountId);
    if ("error" in account) {
      return account.error;
    }

    // INTENT (F1): PROVISIONING license + REQUESTED operation commit here,
    // BEFORE any external effect. The execute step performs the charge.
    const idempotencyKey = input.idempotencyKey?.trim() || `app-license-purchase:${procurement.id}`;
    let license;
    try {
      license = await insertLicenseAsset(ctx, {
        customerId: input.customerId,
        procurementOrderId: procurement.id,
        supplierId: procurement.supplierId,
        priorAssetId: null,
        externalLicenseRef: null,
        status: "PROVISIONING",
        evidence: { procurement_order_id: procurement.id, idempotency_key: idempotencyKey },
      });
    } catch (err) {
      if (err instanceof UniqueViolationError || (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505")) {
        const raced = await latestLicenseAsset(ctx, procurement.id);
        return { ok: true, data: { ...(raced === null ? {} : toPublicLicense(raced)), already: true, needsExecution: true } };
      }
      throw err;
    }

    let operation;
    try {
      operation = await insertProviderOperation(ctx, {
        providerAccountId: account.id,
        action: "app_license.purchase",
        entityType: "app_license",
        entityId: license.id,
        idempotencyKey,
        requestedPayload: {
          procurement_order_id: procurement.id,
          customer_id: input.customerId,
          amount_minor: gate.data.amountMinor,
          currency: gate.data.currency,
        },
        adapterVersion: "intent-v1",
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
      data: { action: "app_license.purchase", entity_type: "app_license", entity_id: license.id },
    });
    return {
      ok: true,
      data: { ...toPublicLicense(license), already: false, operationId: operation.id, needsExecution: true },
    };
  };
}

/**
 * Wave 7 review fix F4: consume the hold atomically on finalization with
 * an applied effect. Conditional ACTIVE -> CONSUMED with the ownership
 * check (reservation supplier == procurement supplier); an already-
 * CONSUMED hold replays idempotently; anything else fails closed so a
 * concurrent release/expire winner is never overwritten.
 */
async function consumeHoldForProcurement(
  ctx: CommandHandlerContext,
  procurement: ProcurementOrderRow,
): Promise<CommandResult<null>> {
  if (procurement.creditReservationId === null) {
    return { ok: false, code: "precondition_failed", message: "procurement has no linked credit reservation" };
  }
  const reservation = await getReservation(ctx, procurement.creditReservationId);
  if (reservation === null) {
    return { ok: false, code: "not_found", message: "linked credit reservation not found in this tenant" };
  }
  if (reservation.supplierId !== procurement.supplierId) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "linked reservation does not belong to the procurement supplier",
    };
  }
  if (reservation.status === "CONSUMED") {
    return { ok: true, data: null };
  }
  const consumed = await updateReservationStatusIf(ctx, reservation.id, "ACTIVE", "CONSUMED");
  if (consumed !== null) {
    return { ok: true, data: null };
  }
  const raced = await getReservation(ctx, reservation.id);
  if (raced !== null && raced.status === "CONSUMED") {
    return { ok: true, data: null };
  }
  return {
    ok: false,
    code: "precondition_failed",
    message: "linked credit reservation changed concurrently; retry",
  };
}

/**
 * Proven-not-applied compensation: the charge demonstrably never happened,
 * so the hold returns to the pool (ACTIVE -> RELEASED, conditional) for
 * accounting exactness. Terminal holds are left untouched.
 */
async function releaseHoldForProcurement(
  ctx: CommandHandlerContext,
  procurement: ProcurementOrderRow,
): Promise<void> {
  if (procurement.creditReservationId === null) {
    return;
  }
  const reservation = await getReservation(ctx, procurement.creditReservationId);
  if (reservation === null || reservation.supplierId !== procurement.supplierId) {
    return;
  }
  if (reservation.status !== "ACTIVE") {
    return;
  }
  await updateReservationStatusIf(ctx, reservation.id, "ACTIVE", "RELEASED");
}

async function markProcurementPurchased(
  ctx: CommandHandlerContext,
  procurementId: string,
): Promise<CommandResult<null>> {
  const moved = await updateProcurementStatusIf(ctx, procurementId, "RESERVED", "PURCHASED");
  if (moved !== null) {
    return { ok: true, data: null };
  }
  const reread = await getProcurementOrder(ctx, procurementId);
  if (reread !== null && reread.status === "PURCHASED") {
    return { ok: true, data: null };
  }
  return {
    ok: false,
    code: "precondition_failed",
    message: "procurement order changed concurrently; retry",
  };
}

/**
 * CV-DSP-02 fencing for durable dispatch transitions on `app_license.purchase`
 * outcomes. Same contract as the provider/trial/fulfillment appliers: with
 * `fence` + a live Kysely transaction the terminal status write becomes a
 * conditional UPDATE (`WHERE claimed_by=$token AND status IN
 * ('QUEUED','RUNNING')`, lease cleared atomically); zero affected rows →
 * `null` BEFORE any attempt/hold/procurement/finding write. Without `fence`
 * (inline execute path) behavior is unchanged.
 *
 * NOTE (CV-DSP-02 scope, reaffirmed CV-DSP-02-FIX F4): `app_license.purchase`
 * has NO secret-required branch — the intent row persists
 * `adapter_version=intent-v1` (echo/manual synthetic), so the dispatcher
 * claim filter (`secret-required-v1` only) never picks these rows up. The
 * fenced applier below is the shared source of truth for that future
 * migration, but the durable license path stays DISABLED in this wave:
 * inventing a license secret branch would require widening the secret-gate
 * allowlist (`SECRET_REQUIRED_ALLOWED_ACTIONS` covers only
 * `trial.provision`/`subscription.provision`) AND centralizing the money
 * locks at the dispatch seam (this wrapper acquires none) — both are
 * architectural decisions left to the Planner.
 */
export interface LicenseChargeFence {
  claimedBy: string;
}

async function fencedLicenseOutcomeUpdate(
  ctx: CommandHandlerContext,
  operationId: string,
  fence: LicenseChargeFence,
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
  const updated = await trx
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
    .where("id", "=", operationId)
    .where("claimed_by", "=", fence.claimedBy)
    .where("status", "in", ["QUEUED", "RUNNING"])
    .executeTakeFirst();
  return Number(updated.numUpdatedRows ?? 0) >= 1;
}

/**
 * CV-DSP-02 pure branch decision for `app_license.purchase` outcomes
 * (unit-tested): which finalizer owns a port outcome. Anything that is not
 * a proven success or a proven failure parks uncertain — never a retry.
 */
export function decideLicenseChargeBranch(outcome: string): "charged" | "not_applied" | "uncertain" {
  if (outcome === "SUCCEEDED") {
    return "charged";
  }
  if (outcome === "FAILED") {
    return "not_applied";
  }
  return "uncertain";
}

interface FinalizeSuccessInput {
  license: LicenseAssetRow;
  procurement: ProcurementOrderRow;
  operationId: string;
  amountMinor: string;
  currency: string;
  detail: string;
  externalRef: string | null;
}

async function applyChargedSuccess(
  ctx: CommandHandlerContext,
  input: FinalizeSuccessInput,
  fence?: LicenseChargeFence,
): Promise<CommandResult<Record<string, unknown>> | null> {
  if (fence !== undefined && kyselyTrxOf(ctx) !== null) {
    const claimed = await fencedLicenseOutcomeUpdate(ctx, input.operationId, fence, {
      status: "SUCCEEDED",
      effectCertainty: "KNOWN_APPLIED",
      executionChannel: "MANUAL",
      resultSummary: { detail: input.detail, external_ref: input.externalRef },
      started: true,
      completed: true,
    });
    if (!claimed) {
      return null;
    }
  } else {
    await updateProviderOperation(ctx, input.operationId, {
      status: "SUCCEEDED",
      effectCertainty: "KNOWN_APPLIED",
      executionChannel: "MANUAL",
      resultSummary: { detail: input.detail, external_ref: input.externalRef },
      started: true,
      completed: true,
    });
  }
  await insertProviderAttempt(ctx, { operationId: input.operationId, status: "SUCCEEDED" });
  await emitProvider(ctx, {
    eventType: "provider.operation_succeeded.v1",
    operationId: input.operationId,
    data: { action: "app_license.purchase", entity_id: input.license.id },
  });
  const consumed = await consumeHoldForProcurement(ctx, input.procurement);
  if (!consumed.ok) {
    return consumed;
  }
  const moved = await markProcurementPurchased(ctx, input.procurement.id);
  if (!moved.ok) {
    return moved;
  }
  return {
    ok: true,
    data: {
      ...toPublicLicense(input.license),
      already: false,
      operationId: input.operationId,
      effectCertainty: "KNOWN_APPLIED",
    },
  };
}

interface FinalizeFailureInput {
  license: LicenseAssetRow;
  procurement: ProcurementOrderRow;
  operationId: string;
  amountMinor: string;
  currency: string;
  detail: string;
}

async function applyProvenNotApplied(
  ctx: CommandHandlerContext,
  input: FinalizeFailureInput,
  fence?: LicenseChargeFence,
): Promise<CommandResult<Record<string, unknown>> | null> {
  if (fence !== undefined && kyselyTrxOf(ctx) !== null) {
    const claimed = await fencedLicenseOutcomeUpdate(ctx, input.operationId, fence, {
      status: "FAILED",
      effectCertainty: "KNOWN_NOT_APPLIED",
      executionChannel: "MANUAL",
      resultSummary: { detail: input.detail },
      started: true,
      completed: true,
    });
    if (!claimed) {
      return null;
    }
  } else {
    await updateProviderOperation(ctx, input.operationId, {
      status: "FAILED",
      effectCertainty: "KNOWN_NOT_APPLIED",
      executionChannel: "MANUAL",
      resultSummary: { detail: input.detail },
      started: true,
      completed: true,
    });
  }
  await insertProviderAttempt(ctx, { operationId: input.operationId, status: "FAILED", errorCode: "ADAPTER_FAILED" });
  await emitProvider(ctx, {
    eventType: "provider.operation_failed.v1",
    operationId: input.operationId,
    data: { action: "app_license.purchase", entity_id: input.license.id, detail: input.detail },
  });
  await releaseHoldForProcurement(ctx, input.procurement);
  await updateProcurementStatusIf(ctx, input.procurement.id, "RESERVED", "FAILED");
  await openReconciliationFinding(ctx, {
    entityType: "app_license",
    entityId: input.license.id,
    expected: {
      supplier_charge: "APPLIED",
      amount_minor: input.amountMinor,
      currency: input.currency,
    },
    observed: { effect: "KNOWN_NOT_APPLIED", operation_id: input.operationId, detail: input.detail },
  });
  return {
    ok: true,
    data: {
      ...toPublicLicense(input.license),
      already: false,
      operationId: input.operationId,
      effectCertainty: "KNOWN_NOT_APPLIED",
    },
  };
}

async function parkUncertainEffect(
  ctx: CommandHandlerContext,
  input: FinalizeFailureInput & { outcome: "UNKNOWN" | "MANUAL" },
  fence?: LicenseChargeFence,
): Promise<CommandResult<Record<string, unknown>> | null> {
  const parked = input.outcome === "UNKNOWN" ? "VERIFYING" : "HUMAN_REQUIRED";
  if (fence !== undefined && kyselyTrxOf(ctx) !== null) {
    const claimed = await fencedLicenseOutcomeUpdate(ctx, input.operationId, fence, {
      status: parked,
      effectCertainty: "UNKNOWN",
      executionChannel: "MANUAL",
      resultSummary: { detail: input.detail },
      started: true,
      completed: false,
    });
    if (!claimed) {
      return null;
    }
  } else {
    await updateProviderOperation(ctx, input.operationId, {
      status: parked,
      effectCertainty: "UNKNOWN",
      executionChannel: "MANUAL",
      resultSummary: { detail: input.detail },
      started: true,
    });
  }
  await insertProviderAttempt(ctx, {
    operationId: input.operationId,
    status: parked,
    errorCode: input.outcome === "UNKNOWN" ? "EFFECT_UNKNOWN" : undefined,
  });
  await openReconciliationFinding(ctx, {
    entityType: "app_license",
    entityId: input.license.id,
    expected: {
      supplier_charge: "APPLIED",
      amount_minor: input.amountMinor,
      currency: input.currency,
    },
    observed: { effect: "UNKNOWN", operation_id: input.operationId, detail: input.detail },
  });
  return {
    ok: true,
    data: {
      ...toPublicLicense(input.license),
      already: false,
      operationId: input.operationId,
      effectCertainty: "UNKNOWN",
      status: parked,
    },
  };
}

/**
 * CV-DSP-02-FIX F4: pure dispatch-status decision for
 * `app_license.purchase` outcomes (unit-tested). Maps the branch plus the
 * REAL domain-finalizer result to the provider operation status the
 * dispatcher counts. A failed domain finalization (`finalizerOk=false` —
 * lost hold race, concurrent procurement move) NEVER reports its branch
 * status: it surfaces as HUMAN_REQUIRED/UNKNOWN so an operator reconciles
 * instead of a masked SUCCEEDED.
 */
export function resolveLicenseDispatchStatus(input: {
  branch: "charged" | "not_applied" | "uncertain";
  finalizerOk: boolean;
  rawOutcome: string;
}): { status: string; effectCertainty: string } {
  if (!input.finalizerOk) {
    return { status: "HUMAN_REQUIRED", effectCertainty: "UNKNOWN" };
  }
  if (input.branch === "charged") {
    return { status: "SUCCEEDED", effectCertainty: "KNOWN_APPLIED" };
  }
  if (input.branch === "not_applied") {
    return { status: "FAILED", effectCertainty: "KNOWN_NOT_APPLIED" };
  }
  return {
    status: input.rawOutcome === "MANUAL" ? "HUMAN_REQUIRED" : "VERIFYING",
    effectCertainty: "UNKNOWN",
  };
}

/**
 * CV-DSP-02 unified `app_license.purchase` outcome applier for the durable
 * dispatcher: loads the operation + license + procurement, routes the raw
 * port outcome through the shared finalizers above (the ONE source of truth
 * — the inline execute path calls the same three functions), and reports
 * the provider operation status for dispatch accounting. Returns `null`
 * when the row/license/procurement is missing or when a fenced write loses
 * its claim (caller aborts with no result write).
 *
 * CV-DSP-02-FIX F4 preconditions + scope: this wrapper is NOT durable-ready
 * in this wave and must stay INERT — `app_license.purchase` intent rows
 * persist `adapter_version=intent-v1`, so the dispatcher claim filter
 * (`secret-required-v1` only) never picks them up. The inline execute path
 * holds the shared money locks before finalizing (`advisoryLockLicenseScope`
 * + `advisoryLockSupplierBalance` + `advisoryLockReservationScope`, supplier
 * first — the same keys and order as release/expire); this wrapper acquires
 * NONE of them. Do NOT route license rows through the dispatcher until those
 * locks are centralized at the dispatch seam. Domain-finalizer failures are
 * propagated honestly via `resolveLicenseDispatchStatus` (never masked).
 */
export interface AppLicensePurchaseOutcomeInput {
  operationId: string;
  raw: { outcome: string; detail: string; externalRef: string | null };
}

export async function applyAppLicensePurchaseOutcome(
  ctx: CommandHandlerContext,
  input: AppLicensePurchaseOutcomeInput,
  fence?: LicenseChargeFence,
): Promise<{ status: string; effectCertainty: string } | null> {
  const operation = await getProviderOperation(ctx, input.operationId);
  if (operation === null) {
    return null;
  }
  const license = await getLicenseAsset(ctx, operation.entityId);
  if (license === null) {
    return null;
  }
  const procurement = await getProcurementOrder(ctx, license.procurementOrderId);
  if (procurement === null) {
    return null;
  }
  const finalizeInput = {
    license,
    procurement,
    operationId: operation.id,
    amountMinor: String((operation.requestedPayload?.["amount_minor"] as string | undefined) ?? ""),
    currency: String((operation.requestedPayload?.["currency"] as string | undefined) ?? ""),
  };
  const branch = decideLicenseChargeBranch(input.raw.outcome);
  if (branch === "charged") {
    const charged = await applyChargedSuccess(
      ctx,
      { ...finalizeInput, detail: input.raw.detail, externalRef: input.raw.externalRef },
      fence,
    );
    if (charged === null) {
      return null;
    }
    // CV-DSP-02-FIX F4: propagate the REAL finalizer outcome — a failed
    // hold/procurement finalization surfaces as HUMAN_REQUIRED, never as a
    // masked SUCCEEDED.
    return resolveLicenseDispatchStatus({ branch, finalizerOk: charged.ok, rawOutcome: input.raw.outcome });
  }
  if (branch === "not_applied") {
    const notApplied = await applyProvenNotApplied(ctx, { ...finalizeInput, detail: input.raw.detail }, fence);
    if (notApplied === null) {
      return null;
    }
    return resolveLicenseDispatchStatus({ branch, finalizerOk: notApplied.ok, rawOutcome: input.raw.outcome });
  }
  const parked = await parkUncertainEffect(
    ctx,
    {
      ...finalizeInput,
      detail: input.raw.detail,
      outcome: input.raw.outcome === "MANUAL" ? "MANUAL" : "UNKNOWN",
    },
    fence,
  );
  if (parked === null) {
    return null;
  }
  return resolveLicenseDispatchStatus({ branch, finalizerOk: parked.ok, rawOutcome: input.raw.outcome });
}

function handleExecuteChargeFactory(deps: LicenseCommandDeps) {
  const readback: ProviderReadbackPort = deps.readbackPort ?? new StubProviderReadback();
  return async (
    ctx: CommandHandlerContext,
    input: ExecuteAppLicenseChargeInput,
  ): Promise<CommandResult<Record<string, unknown>>> => {
    const trx = kyselyTrxOf(ctx);
    if (trx === null) {
      throw new Error("license commands require a database transaction");
    }
    const license = await getLicenseAsset(ctx, input.licenseId);
    if (license === null) {
      return { ok: false, code: "not_found", message: "license asset not found in this tenant" };
    }
    if (license.status === "ACTIVE") {
      return { ok: true, data: { ...toPublicLicense(license), already: true } };
    }
    if (license.status !== "PROVISIONING") {
      return {
        ok: false,
        code: "precondition_failed",
        message: `license is ${license.status}; only a PROVISIONING license can be charged`,
      };
    }
    await advisoryLockLicenseScope(trx, ctx.tenantId, license.procurementOrderId);
    const current = await latestLicenseAsset(ctx, license.procurementOrderId);
    if (current === null || current.status !== "PROVISIONING") {
      return {
        ok: false,
        code: "precondition_failed",
        message: "license is already finalized; charge requires PROVISIONING",
      };
    }
    const operation = await latestProviderOperationForEntity(ctx, "app_license", license.id);
    if (operation === null) {
      return { ok: false, code: "precondition_failed", message: "no supplier charge was attempted for this license" };
    }
    if (operation.status === "SUCCEEDED" && operation.effectCertainty === "KNOWN_APPLIED") {
      return {
        ok: true,
        data: { ...toPublicLicense(license), already: true, operationId: operation.id, effectCertainty: "KNOWN_APPLIED" },
      };
    }
    if (operation.status === "FAILED" && operation.effectCertainty === "KNOWN_NOT_APPLIED") {
      // Decided before: proven not-applied. Never re-execute.
      return {
        ok: true,
        data: {
          ...toPublicLicense(license),
          already: true,
          operationId: operation.id,
          effectCertainty: "KNOWN_NOT_APPLIED",
        },
      };
    }
    if (operation.status === "VERIFYING" || operation.status === "HUMAN_REQUIRED") {
      // F1/F6: reconcile the uncertain effect BEFORE any retry. An
      // inconclusive readback keeps VERIFYING + finding OPEN with no new
      // charge; a conclusive one finalizes without re-executing.
      const observed = await readback.verify({
        tenantId: ctx.tenantId,
        operationId: operation.id,
        action: operation.action,
        externalRef: typeof operation.resultSummary?.["external_ref"] === "string"
          ? (operation.resultSummary["external_ref"] as string)
          : null,
      });
      if (!observed.conclusive) {
        return {
          ok: true,
          data: {
            ...toPublicLicense(license),
            already: false,
            operationId: operation.id,
            effectCertainty: "UNKNOWN",
            conclusive: false,
            retried: false,
          },
        };
      }
      const procurement = await getProcurementOrder(ctx, license.procurementOrderId);
      if (procurement === null) {
        return { ok: false, code: "not_found", message: "procurement order not found in this tenant" };
      }
      await advisoryLockSupplierBalance(trx, ctx.tenantId, procurement.supplierId);
      if (procurement.creditReservationId !== null) {
        await advisoryLockReservationScope(trx, ctx.tenantId, procurement.creditReservationId);
      }
      if (observed.effectApplied) {
        const finalized = await applyChargedSuccess(ctx, {
          license,
          procurement,
          operationId: operation.id,
          amountMinor: String((operation.requestedPayload?.["amount_minor"] as string | undefined) ?? ""),
          currency: String((operation.requestedPayload?.["currency"] as string | undefined) ?? ""),
          detail: observed.evidence,
          externalRef: null,
        });
        if (finalized === null) {
          throw new Error("license outcome applier lost its own inline row");
        }
        if (!finalized.ok) {
          return finalized;
        }
        await closeFindingFor(ctx, license.id, operation.id, true, observed.evidence);
        return {
          ok: true,
          data: { ...(finalized.data as Record<string, unknown>), retried: true },
        };
      }
      const failed = await applyProvenNotApplied(ctx, {
        license,
        procurement,
        operationId: operation.id,
        amountMinor: String((operation.requestedPayload?.["amount_minor"] as string | undefined) ?? ""),
        currency: String((operation.requestedPayload?.["currency"] as string | undefined) ?? ""),
        detail: observed.evidence,
      });
      if (failed === null) {
        throw new Error("license outcome applier lost its own inline row");
      }
      if (!failed.ok) {
        return failed;
      }
      await closeFindingFor(ctx, license.id, operation.id, false, observed.evidence);
      return {
        ok: true,
        data: { ...(failed.data as Record<string, unknown>), retried: true },
      };
    }
    if (operation.status !== "REQUESTED") {
      return {
        ok: false,
        code: "precondition_failed",
        message: `supplier operation is ${operation.status}; charge requires REQUESTED or a verifiable effect`,
      };
    }
    // REQUESTED: first execution attempt. Re-validate ownership + hold
    // liveness in this transaction, serialize on the shared money locks
    // (F2), then run the single charge with the intent's idempotency key.
    const gate = await recheckGateForExecution(ctx, {
      procurementOrderId: license.procurementOrderId,
      customerId: license.customerId,
    });
    if (!gate.ok) {
      return gate;
    }
    await advisoryLockSupplierBalance(trx, ctx.tenantId, gate.data.procurement.supplierId);
    await advisoryLockReservationScope(trx, ctx.tenantId, gate.data.reservationId);

    const fallback: "echo" | "manual" =
      deps.opsPort !== undefined ? (deps.opsPort.name === "echo" ? "echo" : "manual") : adapterNameFromEnv();
    const requested: "echo" | "manual" = input.adapter ?? fallback;
    const capability = await ctx.tx.getCapability("provider.cinevision");
    const { name: adapterName } = applyCapabilityGate(requested, capability);
    const port =
      deps.opsPort !== undefined && (deps.opsPort.name === "echo") === (adapterName === "echo")
        ? deps.opsPort
        : resolveOpsPort(adapterName);

    let result;
    try {
      result = await port.requestOperation({
        tenantId: ctx.tenantId,
        providerAccountId: operation.providerAccountId,
        action: "app_license.purchase",
        entityType: "app_license",
        entityId: license.id,
        idempotencyKey: operation.idempotencyKey,
        payload: {
          ...(operation.requestedPayload ?? {}),
          adapter: adapterName,
          ...(input.echoOutcome !== undefined ? { __echo_outcome: input.echoOutcome } : {}),
        },
        correlationId: ctx.correlationId,
      });
    } catch (err) {
      // F1 crash path: the port threw AFTER a possible external effect.
      // Commit the VERIFYING trace (operation + OPEN finding) instead of
      // rolling back silently — the retry reconciles before re-charging.
      await updateProviderOperation(ctx, operation.id, {
        status: "VERIFYING",
        effectCertainty: "UNKNOWN",
        executionChannel: "MANUAL",
        resultSummary: {
          ...(operation.resultSummary ?? {}),
          crash_detail: err instanceof Error ? err.message : String(err),
        },
        started: true,
      });
      await insertProviderAttempt(ctx, { operationId: operation.id, status: "VERIFYING", errorCode: "EFFECT_UNKNOWN" });
      await openReconciliationFinding(ctx, {
        entityType: "app_license",
        entityId: license.id,
        expected: {
          supplier_charge: "APPLIED",
          amount_minor: gate.data.amountMinor,
          currency: gate.data.currency,
        },
        observed: {
          effect: "UNKNOWN",
          operation_id: operation.id,
          detail: "charge execution threw; effect uncertain",
        },
      });
      return {
        ok: true,
        data: {
          ...toPublicLicense(license),
          already: false,
          operationId: operation.id,
          effectCertainty: "UNKNOWN",
          status: "VERIFYING",
        },
      };
    }

    const finalizeInput = {
      license,
      procurement: {
        ...gate.data.procurement,
        creditReservationId: gate.data.procurement.creditReservationId,
        status: gate.data.procurement.status,
        supplierId: gate.data.procurement.supplierId,
      } as ProcurementOrderRow,
      operationId: operation.id,
      amountMinor: gate.data.amountMinor,
      currency: gate.data.currency,
    };
    if (result.outcome === "SUCCEEDED") {
      const charged = await applyChargedSuccess(ctx, {
        ...finalizeInput,
        detail: result.detail,
        externalRef: result.externalRef,
      });
      if (charged === null) {
        throw new Error("license outcome applier lost its own inline row");
      }
      return charged;
    }
    if (result.outcome === "FAILED") {
      const notApplied = await applyProvenNotApplied(ctx, { ...finalizeInput, detail: result.detail });
      if (notApplied === null) {
        throw new Error("license outcome applier lost its own inline row");
      }
      return notApplied;
    }
    const parked = await parkUncertainEffect(ctx, { ...finalizeInput, detail: result.detail, outcome: result.outcome });
    if (parked === null) {
      throw new Error("license outcome applier lost its own inline row");
    }
    return parked;
  };
}

function handleActivateFactory(deps: LicenseCommandDeps) {
  const readback: ProviderReadbackPort = deps.readbackPort ?? new StubProviderReadback();
  return async (
    ctx: CommandHandlerContext,
    input: ActivateAppLicenseInput,
  ): Promise<CommandResult<Record<string, unknown>>> => {
    const trx = kyselyTrxOf(ctx);
    if (trx === null) {
      throw new Error("license commands require a database transaction");
    }
    const root = await getLicenseAsset(ctx, input.licenseId);
    if (root === null) {
      return { ok: false, code: "not_found", message: "license asset not found in this tenant" };
    }
    await advisoryLockLicenseScope(trx, ctx.tenantId, root.procurementOrderId);
    const current = await latestLicenseAsset(ctx, root.procurementOrderId);
    if (current === null) {
      return { ok: false, code: "not_found", message: "license asset not found in this tenant" };
    }
    if (current.status === "ACTIVE") {
      return { ok: true, data: { ...toPublicLicense(current), already: true } };
    }
    if (current.status !== "PROVISIONING") {
      return {
        ok: false,
        code: "precondition_failed",
        message: `license is ${current.status}; only a PROVISIONING license can be activated`,
      };
    }
    const operation = await latestProviderOperationForEntity(ctx, "app_license", root.id);
    if (operation === null) {
      return { ok: false, code: "precondition_failed", message: "no supplier charge was attempted for this license" };
    }

    if (operation.status === "SUCCEEDED" && operation.effectCertainty === "KNOWN_APPLIED") {
      return finalizeActivation(ctx, current, operation.id, {
        effectApplied: true,
        evidence: `provider-op:${operation.id}:KNOWN_APPLIED`,
        externalRef: typeof operation.resultSummary?.["external_ref"] === "string"
          ? (operation.resultSummary["external_ref"] as string)
          : null,
      });
    }
    if (operation.status === "FAILED" && operation.effectCertainty === "KNOWN_NOT_APPLIED") {
      const failed = await insertLicenseAsset(ctx, {
        customerId: current.customerId,
        procurementOrderId: current.procurementOrderId,
        supplierId: current.supplierId,
        priorAssetId: current.id,
        externalLicenseRef: null,
        status: "FAILED",
        evidence: { operation_id: operation.id, effect: "KNOWN_NOT_APPLIED" },
      });
      return { ok: true, data: { ...toPublicLicense(failed), already: false } };
    }
    if (operation.status !== "VERIFYING" && operation.status !== "HUMAN_REQUIRED") {
      return {
        ok: false,
        code: "precondition_failed",
        message: `supplier operation is ${operation.status}; activation requires a decided or verifiable effect`,
      };
    }
    // Uncertain effect: readback observes, never re-executes.
    const observed = await readback.verify({
      tenantId: ctx.tenantId,
      operationId: operation.id,
      action: operation.action,
      externalRef: typeof operation.resultSummary?.["external_ref"] === "string"
        ? (operation.resultSummary["external_ref"] as string)
        : null,
    });
    if (!observed.conclusive) {
      // Wave 7 review fix F6: inconclusive readback is an explicit state —
      // the operation stays VERIFYING/HUMAN_REQUIRED and the finding stays
      // OPEN. Never a FAILED license, never a close without proof.
      return {
        ok: true,
        data: {
          ...toPublicLicense(current),
          already: false,
          operationId: operation.id,
          effectCertainty: "UNKNOWN",
          conclusive: false,
          activationDeferred: true,
        },
      };
    }
    const procurement = await getProcurementOrder(ctx, current.procurementOrderId);
    if (procurement === null) {
      return { ok: false, code: "not_found", message: "procurement order not found in this tenant" };
    }
    await advisoryLockSupplierBalance(trx, ctx.tenantId, procurement.supplierId);
    if (procurement.creditReservationId !== null) {
      await advisoryLockReservationScope(trx, ctx.tenantId, procurement.creditReservationId);
    }
    const terminal = observed.effectApplied ? "SUCCEEDED" : "FAILED";
    await updateProviderOperation(ctx, operation.id, {
      status: terminal,
      effectCertainty: observed.effectApplied ? "KNOWN_APPLIED" : "KNOWN_NOT_APPLIED",
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
      data: { action: operation.action, entity_id: root.id, reconcile_evidence: observed.evidence },
    });
    if (!observed.effectApplied) {
      await releaseHoldForProcurement(ctx, procurement);
      await updateProcurementStatusIf(ctx, current.procurementOrderId, "RESERVED", "FAILED");
      await closeFindingFor(ctx, root.id, operation.id, observed.effectApplied, observed.evidence);
      const failed = await insertLicenseAsset(ctx, {
        customerId: current.customerId,
        procurementOrderId: current.procurementOrderId,
        supplierId: current.supplierId,
        priorAssetId: current.id,
        externalLicenseRef: null,
        status: "FAILED",
        evidence: { operation_id: operation.id, reconcile_evidence: observed.evidence },
      });
      return { ok: true, data: { ...toPublicLicense(failed), already: false } };
    }
    return finalizeActivation(ctx, current, operation.id, {
      effectApplied: true,
      evidence: observed.evidence,
      externalRef: null,
    });
  };
}

async function finalizeActivation(
  ctx: CommandHandlerContext,
  current: LicenseAssetRow,
  operationId: string,
  input: { effectApplied: boolean; evidence: string; externalRef: string | null },
): Promise<CommandResult<Record<string, unknown>>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("license commands require a database transaction");
  }
  const procurement = await getProcurementOrder(ctx, current.procurementOrderId);
  if (procurement === null) {
    return { ok: false, code: "not_found", message: "procurement order not found in this tenant" };
  }
  // Wave 7 review fix F4: the hold is consumed HERE, atomically with the
  // applied effect (conditional ACTIVE -> CONSUMED, ownership verified).
  // finalizeActivation runs under the license-scope lock; take the shared
  // money locks in the global order (supplier, then reservation).
  await advisoryLockSupplierBalance(trx, ctx.tenantId, procurement.supplierId);
  if (procurement.creditReservationId !== null) {
    await advisoryLockReservationScope(trx, ctx.tenantId, procurement.creditReservationId);
  }
  const consumed = await consumeHoldForProcurement(ctx, procurement);
  if (!consumed.ok) {
    return consumed;
  }
  const moved = await markProcurementPurchased(ctx, procurement.id);
  if (!moved.ok) {
    return moved;
  }
  const activated = await insertLicenseAsset(ctx, {
    customerId: current.customerId,
    procurementOrderId: current.procurementOrderId,
    supplierId: current.supplierId,
    priorAssetId: current.id,
    externalLicenseRef: input.externalRef,
    status: "ACTIVE",
    evidence: { operation_id: operationId, reconcile_evidence: input.evidence },
  });
  await closeFindingFor(ctx, current.id, operationId, input.effectApplied, input.evidence);
  await emitLicense(ctx, {
    eventType: "inventory.license.activated.v1",
    licenseId: activated.id,
    data: {
      customer_id: activated.customerId,
      procurement_order_id: activated.procurementOrderId,
      supplier_id: activated.supplierId,
      operation_id: operationId,
    },
  });
  return { ok: true, data: { ...toPublicLicense(activated), already: false } };
}

async function closeFindingFor(
  ctx: CommandHandlerContext,
  licenseRootId: string,
  operationId: string,
  effectApplied: boolean,
  evidence: string,
): Promise<void> {
  const finding = await findOpenFinding(ctx, "app_license", licenseRootId);
  if (finding === null) {
    return;
  }
  await resolveReconciliationFinding(ctx, finding.id, {
    observed: { effect: effectApplied ? "KNOWN_APPLIED" : "KNOWN_NOT_APPLIED", operation_id: operationId, evidence },
    resolutionRef: operationId,
  });
}

function handleReconcileFactory(deps: LicenseCommandDeps) {
  const readback: ProviderReadbackPort = deps.readbackPort ?? new StubProviderReadback();
  return async (
    ctx: CommandHandlerContext,
    input: ReconcileSupplierPurchaseInput,
  ): Promise<
    CommandResult<{ findingId: string; status: string; effectApplied: boolean; operationId: string; conclusive?: boolean }>
  > => {
    const trx = kyselyTrxOf(ctx);
    if (trx === null) {
      throw new Error("license commands require a database transaction");
    }
    const root = await getLicenseAsset(ctx, input.licenseId);
    if (root === null) {
      return { ok: false, code: "not_found", message: "license asset not found in this tenant" };
    }
    await advisoryLockLicenseScope(trx, ctx.tenantId, root.procurementOrderId);
    const current = await latestLicenseAsset(ctx, root.procurementOrderId);
    if (current === null || current.status !== "PROVISIONING") {
      return {
        ok: false,
        code: "precondition_failed",
        message: "license is already finalized; reconcile requires PROVISIONING",
      };
    }
    const finding = await findOpenFinding(ctx, "app_license", root.id);
    if (finding === null) {
      return { ok: false, code: "precondition_failed", message: "no OPEN reconciliation finding for this license" };
    }
    const operation = await latestProviderOperationForEntity(ctx, "app_license", root.id);
    if (operation === null) {
      return { ok: false, code: "precondition_failed", message: "no supplier charge was attempted for this license" };
    }
    if (operation.status !== "VERIFYING") {
      return {
        ok: false,
        code: "precondition_failed",
        message: `operation is ${operation.status}; reconcile requires VERIFYING`,
      };
    }
    // Readback observes; reconcile never re-executes the charge.
    const observed = await readback.verify({
      tenantId: ctx.tenantId,
      operationId: operation.id,
      action: operation.action,
      externalRef: typeof operation.resultSummary?.["external_ref"] === "string"
        ? (operation.resultSummary["external_ref"] as string)
        : null,
    });
    if (!observed.conclusive) {
      // Wave 7 review fix F6: inconclusive readback keeps the finding OPEN
      // and the operation VERIFYING — no terminal write, no close.
      return {
        ok: true,
        data: {
          findingId: finding.id,
          status: "OPEN",
          effectApplied: false,
          operationId: operation.id,
          conclusive: false,
        },
      };
    }
    const procurement = await getProcurementOrder(ctx, root.procurementOrderId);
    if (procurement === null) {
      return { ok: false, code: "not_found", message: "procurement order not found in this tenant" };
    }
    await advisoryLockSupplierBalance(trx, ctx.tenantId, procurement.supplierId);
    if (procurement.creditReservationId !== null) {
      await advisoryLockReservationScope(trx, ctx.tenantId, procurement.creditReservationId);
    }
    const terminal = observed.effectApplied ? "SUCCEEDED" : "FAILED";
    await updateProviderOperation(ctx, operation.id, {
      status: terminal,
      effectCertainty: observed.effectApplied ? "KNOWN_APPLIED" : "KNOWN_NOT_APPLIED",
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
      data: { action: operation.action, entity_id: root.id, reconcile_evidence: observed.evidence },
    });
    // Wave 7 review fix F4: an applied effect consumes the hold here,
    // atomically (conditional ACTIVE -> CONSUMED, ownership verified); a
    // proven-absent effect releases it back to the pool instead.
    if (observed.effectApplied) {
      const consumed = await consumeHoldForProcurement(ctx, procurement);
      if (!consumed.ok) {
        return consumed;
      }
      const moved = await markProcurementPurchased(ctx, procurement.id);
      if (!moved.ok) {
        return moved;
      }
    } else {
      await releaseHoldForProcurement(ctx, procurement);
      await updateProcurementStatusIf(ctx, procurement.id, "RESERVED", "FAILED");
    }
    await closeFindingFor(ctx, root.id, operation.id, observed.effectApplied, observed.evidence);
    return {
      ok: true,
      data: { findingId: finding.id, status: "RESOLVED", effectApplied: observed.effectApplied, operationId: operation.id, conclusive: true },
    };
  };
}

export function registerLicenseCommands(bus: CommandBus, deps: LicenseCommandDeps = {}): void {
  bus.register<PurchaseAppLicenseInput, Record<string, unknown>>({
    name: "inventory.purchase_app_license",
    permission: "commerce.order.write",
    auditAction: "inventory.purchase_app_license",
    auditResource: "license_asset",
    input: purchaseAppLicenseInput,
    handler: handlePurchaseFactory(),
  });
  bus.register<ExecuteAppLicenseChargeInput, Record<string, unknown>>({
    name: "inventory.execute_app_license_charge",
    permission: "commerce.order.write",
    auditAction: "inventory.execute_app_license_charge",
    auditResource: "license_asset",
    input: executeAppLicenseChargeInput,
    handler: handleExecuteChargeFactory(deps),
  });
  bus.register<ActivateAppLicenseInput, Record<string, unknown>>({
    name: "inventory.activate_app_license",
    permission: "provider.operation.write",
    auditAction: "inventory.activate_app_license",
    auditResource: "license_asset",
    input: activateAppLicenseInput,
    handler: handleActivateFactory(deps),
  });
  bus.register<ReconcileSupplierPurchaseInput, { findingId: string; status: string; effectApplied: boolean; operationId: string; conclusive?: boolean }>({
    name: "inventory.reconcile_supplier_purchase",
    permission: "provider.operation.write",
    auditAction: "inventory.reconcile_supplier_purchase",
    auditResource: "reconciliation_finding",
    input: reconcileSupplierPurchaseInput,
    handler: handleReconcileFactory(deps),
  });
}

