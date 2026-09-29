/**
 * MK supplier-balance port (Wave 7 slice S2).
 *
 * The real MK Ativador integration requires operator credentials and a
 * Browser Worker that do not exist in this environment, so the ONLY
 * implementations shipped here are:
 * - `EchoSupplierBalanceAdapter`: deterministic synthetic reading for
 *   tests and local flows (`SUPPLIER_BALANCE_ECHO_MINOR` + `..._CURRENCY`).
 * - `ManualSupplierBalanceAdapter`: the provider operator supplies the
 *   reading in the command input (no network, no credentials); without an
 *   operator-supplied reading the outcome is UNKNOWN and the refresh
 *   command fails closed.
 *
 * Selection: `SUPPLIER_BALANCE_ADAPTER=echo|manual` (default `manual`);
 * a per-command `adapter` input overrides the env for that call.
 * Mirrors the `ProviderOpsPort` echo/manual discipline (Wave 4).
 */

export interface SupplierBalanceQuery {
  tenantId: string;
  supplierId: string;
  correlationId: string;
}

export interface OperatorSuppliedReading {
  balanceMinor?: string | null;
  currency?: string | null;
  evidenceRef?: string | null;
}

export type BalanceCertainty = "KNOWN" | "UNKNOWN";

export interface SupplierBalanceReading {
  balanceMinor: string;
  currency: string;
  observedAt: Date;
  evidenceRef: string;
  certainty: BalanceCertainty;
}

export interface SupplierBalancePort {
  readonly name: string;
  readBalance(query: SupplierBalanceQuery, operator?: OperatorSuppliedReading): Promise<SupplierBalanceReading>;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

/** Deterministic synthetic adapter: no network, no credentials. */
export class EchoSupplierBalanceAdapter implements SupplierBalancePort {
  readonly name = "echo";

  async readBalance(query: SupplierBalanceQuery): Promise<SupplierBalanceReading> {
    const rawMinor = (process.env["SUPPLIER_BALANCE_ECHO_MINOR"] ?? "100000").trim();
    const currency = (process.env["SUPPLIER_BALANCE_ECHO_CURRENCY"] ?? "BRL").trim().toUpperCase();
    if (!/^\d+$/.test(rawMinor)) {
      throw new Error("SUPPLIER_BALANCE_ECHO_MINOR must be integer minor units");
    }
    if (!CURRENCY_RE.test(currency)) {
      throw new Error("SUPPLIER_BALANCE_ECHO_CURRENCY must be a 3-letter code");
    }
    return {
      balanceMinor: BigInt(rawMinor).toString(),
      currency,
      observedAt: new Date(),
      evidenceRef: `echo:supplier=${query.supplierId}`,
      certainty: "KNOWN",
    };
  }
}

/**
 * Manual adapter: the operator reading rides in the command input. Without
 * one the effect is UNKNOWN (fail-closed) — the command must refuse rather
 * than persist a fabricated balance.
 */
export class ManualSupplierBalanceAdapter implements SupplierBalancePort {
  readonly name = "manual";

  async readBalance(query: SupplierBalanceQuery, operator?: OperatorSuppliedReading): Promise<SupplierBalanceReading> {
    const balanceMinor = operator?.balanceMinor?.trim() ?? "";
    const currency = (operator?.currency ?? "").trim().toUpperCase();
    const evidenceRef = operator?.evidenceRef?.trim() ?? "";
    if (!/^\d+$/.test(balanceMinor) || !CURRENCY_RE.test(currency) || evidenceRef === "") {
      return {
        balanceMinor: "0",
        currency: "XXX",
        observedAt: new Date(),
        evidenceRef: `manual:missing-reading:supplier=${query.supplierId}`,
        certainty: "UNKNOWN",
      };
    }
    return {
      balanceMinor: BigInt(balanceMinor).toString(),
      currency,
      observedAt: new Date(),
      evidenceRef,
      certainty: "KNOWN",
    };
  }
}

export function supplierBalanceAdapterFromEnv(): "echo" | "manual" {
  return process.env["SUPPLIER_BALANCE_ADAPTER"] === "echo" ? "echo" : "manual";
}

export function resolveSupplierBalancePort(name: "echo" | "manual"): SupplierBalancePort {
  return name === "echo" ? new EchoSupplierBalanceAdapter() : new ManualSupplierBalanceAdapter();
}
