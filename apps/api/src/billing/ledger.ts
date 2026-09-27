import { newId, now } from "@iptv/domain";
import type { Transaction } from "kysely";
import type { Database } from "@iptv/database";
import { assertLedgerBalanced, type LedgerEntryInput } from "../commerce/money-math.js";

/**
 * Wave 5 finance postings (append-only; reversals are NEW transactions).
 *
 * Canonical account codes (per tenant + currency):
 * - `CASH_ASAAS_PIX` (ASSET): confirmed PIX cash collected via Asaas.
 * - `RECEIVABLE_ORDERS` (ASSET): order obligations awaiting collection;
 *   credited on confirmation, debited on settlement against revenue.
 * - `REVENUE_SERVICES` (REVENUE): settled economic revenue.
 * - `REFUNDS_CONTRA` (CONTRA): human-authorized refund reversals.
 * - `CHARGEBACK_LOSS` (EXPENSE): issuer-initiated dispute losses (a
 *   distinct path from refunds — never forged as a human refund).
 */

export const CASH_ACCOUNT = { code: "CASH_ASAAS_PIX", name: "Asaas PIX cash", type: "ASSET" } as const;
export const RECEIVABLE_ACCOUNT = { code: "RECEIVABLE_ORDERS", name: "Order receivables", type: "ASSET" } as const;
export const REVENUE_ACCOUNT = { code: "REVENUE_SERVICES", name: "Service revenue", type: "REVENUE" } as const;
export const REFUNDS_CONTRA_ACCOUNT = { code: "REFUNDS_CONTRA", name: "Refund contra-revenue", type: "CONTRA" } as const;
export const CHARGEBACK_ACCOUNT = { code: "CHARGEBACK_LOSS", name: "Chargeback losses", type: "EXPENSE" } as const;

export interface PostingEntry extends LedgerEntryInput {
  accountName: string;
  accountType: string;
}

export interface PostingInput {
  transactionType: string;
  referenceType: string;
  referenceId: string | null;
  idempotencyKey: string;
  reversalOfTransactionId?: string | null;
  metadata?: Record<string, unknown>;
  entries: PostingEntry[];
}

/** Idempotent per-tenant account provisioning (unique on tenant/code/currency). */
export async function ensureAccount(
  trx: Transaction<Database>,
  tenantId: string,
  account: { code: string; name: string; type: string },
  currency: string,
): Promise<string> {
  const existing = await trx
    .selectFrom("finance.financial_accounts")
    .select(["id"])
    .where("tenant_id", "=", tenantId)
    .where("account_code", "=", account.code)
    .where("currency", "=", currency)
    .executeTakeFirst();
  if (existing !== undefined) {
    return existing.id;
  }
  const inserted = await trx
    .insertInto("finance.financial_accounts")
    .values({
      id: newId(),
      tenant_id: tenantId,
      account_code: account.code,
      name: account.name,
      account_type: account.type,
      currency,
      status: "ACTIVE",
      created_at: now(),
    })
    .onConflict((oc) => oc.columns(["tenant_id", "account_code", "currency"]).doNothing())
    .returning(["id"])
    .executeTakeFirst();
  if (inserted !== undefined) {
    return inserted.id;
  }
  const raced = await trx
    .selectFrom("finance.financial_accounts")
    .select(["id"])
    .where("tenant_id", "=", tenantId)
    .where("account_code", "=", account.code)
    .where("currency", "=", currency)
    .executeTakeFirstOrThrow();
  return raced.id;
}

/**
 * Post one balanced double-entry transaction. The pure
 * `assertLedgerBalanced` check runs first (fast failure with the offending
 * account), and the deferred `financial_ledger_balanced_at_commit` trigger
 * enforces the same invariant at commit. Idempotent on
 * `(tenant, idempotency_key)`: a replay returns the existing transaction id
 * without writing new entries.
 */
export async function postBalanced(
  trx: Transaction<Database>,
  tenantId: string,
  input: PostingInput,
): Promise<{ transactionId: string; duplicate: boolean }> {
  assertLedgerBalanced(input.entries);
  const at = now();
  // Idempotent on (tenant, idempotency_key) via insert-on-conflict-do-nothing.
  // A plain try/catch around the insert is WRONG here: a caught unique
  // violation aborts the Postgres transaction and every later statement in
  // this tx fails with "current transaction is aborted" (FIX-WAVE5-LIVE-2 #2).
  const inserted = await trx
    .insertInto("finance.financial_transactions")
    .values({
      id: newId(),
      tenant_id: tenantId,
      transaction_type: input.transactionType,
      reference_type: input.referenceType,
      reference_id: input.referenceId,
      idempotency_key: input.idempotencyKey,
      occurred_at: at,
      recorded_at: at,
      reversal_of_transaction_id: input.reversalOfTransactionId ?? null,
      metadata_json: input.metadata ?? {},
    })
    .onConflict((oc) => oc.columns(["tenant_id", "idempotency_key"]).doNothing())
    .returning(["id"])
    .executeTakeFirst();
  if (inserted === undefined) {
    const existing = await trx
      .selectFrom("finance.financial_transactions")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirstOrThrow();
    return { transactionId: existing.id, duplicate: true };
  }
  const transactionId = inserted.id;
  for (const entry of input.entries) {
    const accountId = await ensureAccount(
      trx,
      tenantId,
      { code: entry.accountCode, name: entry.accountName, type: entry.accountType },
      entry.currency,
    );
    await trx
      .insertInto("finance.financial_ledger_entries")
      .values({
        id: newId(),
        tenant_id: tenantId,
        financial_transaction_id: transactionId,
        financial_account_id: accountId,
        direction: entry.direction,
        amount_minor: entry.amountMinor.toString(),
        currency: entry.currency,
        created_at: at,
      })
      .execute();
  }
  return { transactionId, duplicate: false };
}

/** Payment-confirmation posting: Dr cash / Cr receivable (exact minor units). */
export function confirmationEntries(amountMinor: bigint, currency: string): PostingEntry[] {
  return [
    { accountCode: CASH_ACCOUNT.code, accountName: CASH_ACCOUNT.name, accountType: CASH_ACCOUNT.type, currency, direction: "DEBIT", amountMinor },
    { accountCode: RECEIVABLE_ACCOUNT.code, accountName: RECEIVABLE_ACCOUNT.name, accountType: RECEIVABLE_ACCOUNT.type, currency, direction: "CREDIT", amountMinor },
  ];
}

/** Settlement posting: Dr receivable / Cr revenue (recognize settled revenue). */
export function settlementEntries(amountMinor: bigint, currency: string): PostingEntry[] {
  return [
    { accountCode: RECEIVABLE_ACCOUNT.code, accountName: RECEIVABLE_ACCOUNT.name, accountType: RECEIVABLE_ACCOUNT.type, currency, direction: "DEBIT", amountMinor },
    { accountCode: REVENUE_ACCOUNT.code, accountName: REVENUE_ACCOUNT.name, accountType: REVENUE_ACCOUNT.type, currency, direction: "CREDIT", amountMinor },
  ];
}

/** Refund-reversal posting: Dr contra-revenue / Cr cash (new transaction). */
export function refundReversalEntries(amountMinor: bigint, currency: string): PostingEntry[] {
  return [
    { accountCode: REFUNDS_CONTRA_ACCOUNT.code, accountName: REFUNDS_CONTRA_ACCOUNT.name, accountType: REFUNDS_CONTRA_ACCOUNT.type, currency, direction: "DEBIT", amountMinor },
    { accountCode: CASH_ACCOUNT.code, accountName: CASH_ACCOUNT.name, accountType: CASH_ACCOUNT.type, currency, direction: "CREDIT", amountMinor },
  ];
}

/** Chargeback-reversal posting: Dr chargeback loss / Cr cash (distinct path). */
export function chargebackReversalEntries(amountMinor: bigint, currency: string): PostingEntry[] {
  return [
    { accountCode: CHARGEBACK_ACCOUNT.code, accountName: CHARGEBACK_ACCOUNT.name, accountType: CHARGEBACK_ACCOUNT.type, currency, direction: "DEBIT", amountMinor },
    { accountCode: CASH_ACCOUNT.code, accountName: CASH_ACCOUNT.name, accountType: CASH_ACCOUNT.type, currency, direction: "CREDIT", amountMinor },
  ];
}
