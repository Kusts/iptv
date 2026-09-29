import { z } from "zod";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";
import { UniqueViolationError } from "../trial/trial-store.js";
import {
  advisoryLockAppTrial,
  advisoryLockAppTrialScope,
  findDueAppTrials,
  findOpenAppTrial,
  getAppTrial,
  insertAppTrial,
  nextAppTrialStatus,
  updateAppTrial,
  type AppTrialRow,
  type AppTrialStatus,
} from "./app-trial.store.js";

/**
 * Wave 7 slice S1: AppTrial commands (owning context for AppTrial).
 *
 * - `inventory.request_app_trial` opens a REQUESTED trial after resolving
 *   person/customer/supplier inside the same tenant. The customer (when
 *   given) must belong to the person — a cross-customer mix inside one
 *   tenant is rejected, mirroring the blueprint's cross-customer rule.
 * - `inventory.validate_app_trial` moves REQUESTED|ACTIVE to VALIDATED
 *   (customer confirmed) or INVALIDATED (customer rejected). VALIDATED is
 *   the S3 purchase gate's trial proof.
 * - `inventory.expire_app_trials` sweeps due open trials to EXPIRED.
 * - No public event in this slice (no registry-listed app-trial event).
 */

export const requestAppTrialInput = z.object({
  personId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  supplierId: z.string().uuid(),
  supplierAppExternalId: z.string().trim().min(1).max(200),
  expiresAt: z.string().datetime().optional(),
});

export type RequestAppTrialInput = z.infer<typeof requestAppTrialInput>;

export const validateAppTrialInput = z.object({
  trialId: z.string().uuid(),
  outcome: z.enum(["VALIDATED", "INVALIDATED"]),
  reason: z.string().trim().min(1).max(500).optional(),
});

export type ValidateAppTrialInput = z.infer<typeof validateAppTrialInput>;

export const expireAppTrialsInput = z.object({
  limit: z.number().int().min(1).max(500).default(100),
});

export type ExpireAppTrialsInput = z.infer<typeof expireAppTrialsInput>;

function toPublic(row: AppTrialRow): Record<string, unknown> {
  return {
    id: row.id,
    personId: row.personId,
    customerId: row.customerId,
    supplierId: row.supplierId,
    supplierAppExternalId: row.supplierAppExternalId,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    activatedAt: row.activatedAt?.toISOString() ?? null,
    validatedAt: row.validatedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    invalidatedReason: row.invalidatedReason,
  };
}

async function handleRequest(
  ctx: CommandHandlerContext,
  input: RequestAppTrialInput,
): Promise<CommandResult<{ id: string; status: string; already: boolean }>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("app trial commands require a database transaction");
  }
  await advisoryLockAppTrialScope(trx, ctx.tenantId, input.personId, input.supplierId);

  const person = await trx
    .selectFrom("identity.persons")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.personId)
    .executeTakeFirst();
  if (person === undefined) {
    return { ok: false, code: "not_found", message: "person not found in this tenant" };
  }
  if (input.customerId !== undefined) {
    const customer = await trx
      .selectFrom("crm.customers")
      .select(["id", "person_id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", input.customerId)
      .executeTakeFirst();
    if (customer === undefined) {
      return { ok: false, code: "not_found", message: "customer not found in this tenant" };
    }
    if (customer.person_id !== input.personId) {
      return { ok: false, code: "precondition_failed", message: "customer does not belong to this person" };
    }
  }
  const supplier = await trx
    .selectFrom("inventory.suppliers")
    .select(["id"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", input.supplierId)
    .executeTakeFirst();
  if (supplier === undefined) {
    return { ok: false, code: "not_found", message: "supplier not found in this tenant" };
  }

  const open = await findOpenAppTrial(ctx, input.personId, input.supplierId);
  if (open !== null) {
    return { ok: true, data: { id: open.id, status: open.status, already: true } };
  }

  let expiresAt: Date | null = null;
  if (input.expiresAt !== undefined) {
    expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      return { ok: false, code: "validation_failed", message: "expiresAt must be a valid date-time" };
    }
  }

  try {
    const created = await insertAppTrial(ctx, {
      personId: input.personId,
      customerId: input.customerId ?? null,
      supplierId: input.supplierId,
      supplierAppExternalId: input.supplierAppExternalId.trim(),
      expiresAt,
    });
    return { ok: true, data: { id: created.id, status: created.status, already: false } };
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      const raced = await findOpenAppTrial(ctx, input.personId, input.supplierId);
      if (raced !== null) {
        return { ok: true, data: { id: raced.id, status: raced.status, already: true } };
      }
      return { ok: false, code: "precondition_failed", message: err.message };
    }
    throw err;
  }
}

async function handleValidate(
  ctx: CommandHandlerContext,
  input: ValidateAppTrialInput,
): Promise<CommandResult<Record<string, unknown>>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("app trial commands require a database transaction");
  }
  await advisoryLockAppTrial(trx, input.trialId);
  const trial = await getAppTrial(ctx, input.trialId);
  if (trial === null) {
    return { ok: false, code: "not_found", message: "app trial not found in this tenant" };
  }
  let next: AppTrialStatus;
  try {
    next = nextAppTrialStatus(trial.status, input.outcome === "VALIDATED" ? "VALIDATE" : "INVALIDATE");
  } catch {
    return {
      ok: false,
      code: "precondition_failed",
      message: `app trial is ${trial.status}; only an open trial can be validated`,
    };
  }
  const updated = await updateAppTrial(
    ctx,
    trial.id,
    next === "INVALIDATED" ? { status: next, invalidatedReason: input.reason ?? null } : { status: next },
  );
  if (updated === null) {
    return { ok: false, code: "not_found", message: "app trial not found in this tenant" };
  }
  return { ok: true, data: toPublic(updated) };
}

async function handleExpire(
  ctx: CommandHandlerContext,
  input: ExpireAppTrialsInput,
): Promise<CommandResult<{ expiredTrialIds: string[] }>> {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("app trial commands require a database transaction");
  }
  const due = await findDueAppTrials(trx, ctx.tenantId, input.limit);
  const expiredTrialIds: string[] = [];
  for (const candidate of due) {
    await advisoryLockAppTrial(trx, candidate.id);
    const trial = await getAppTrial(ctx, candidate.id);
    if (trial === null) {
      continue;
    }
    let next: AppTrialStatus;
    try {
      next = nextAppTrialStatus(trial.status, "EXPIRE");
    } catch {
      continue;
    }
    // Re-check expiry after the lock: a concurrent validate wins.
    if (trial.expiresAt !== null && trial.expiresAt.getTime() > Date.now()) {
      continue;
    }
    await updateAppTrial(ctx, trial.id, { status: next });
    expiredTrialIds.push(trial.id);
  }
  return { ok: true, data: { expiredTrialIds } };
}

export function registerAppTrialCommands(bus: CommandBus): void {
  bus.register<RequestAppTrialInput, { id: string; status: string; already: boolean }>({
    name: "inventory.request_app_trial",
    permission: "trial.write",
    auditAction: "inventory.request_app_trial",
    auditResource: "app_trial",
    input: requestAppTrialInput,
    handler: handleRequest,
  });
  bus.register<ValidateAppTrialInput, Record<string, unknown>>({
    name: "inventory.validate_app_trial",
    permission: "trial.write",
    auditAction: "inventory.validate_app_trial",
    auditResource: "app_trial",
    input: validateAppTrialInput,
    handler: handleValidate,
  });
  bus.register<ExpireAppTrialsInput, { expiredTrialIds: string[] }>({
    name: "inventory.expire_app_trials",
    permission: "trial.write",
    auditAction: "inventory.expire_app_trials",
    auditResource: "app_trial",
    input: expireAppTrialsInput,
    handler: handleExpire,
  });
}

