/**
 * Asaas billing port (Wave 5).
 *
 * Agent tools never call provider APIs directly: `charge.create`,
 * `charge.reconcile` and `refund.execute_approved` invoke semantic commands
 * that go through this port. The ONLY implementations shipped here are:
 * - `EchoAsaasAdapter` (default): deterministic synthetic outcomes for tests
 *   and local flows — no network, no credentials.
 * - `RealAsaasAdapter` (env-gated stub): used ONLY when `ASAAS_API_KEY` and
 *   `ASAAS_BASE_URL` are both set; transport timeouts/unknowns map to
 *   UNKNOWN_EFFECT (charge stays PROCESSING + reconcile task, NEVER an
 *   automatic create retry). There are no real Asaas calls in tests.
 *
 * Selection: `ASAAS_ADAPTER=echo|real` (default `echo`).
 */

import { withSpan } from "@iptv/observability";

export type AsaasEffect = "KNOWN_APPLIED" | "KNOWN_NOT_APPLIED" | "UNKNOWN";

export interface PixChargeRequest {
  chargeId: string;
  valueMinor: bigint;
  currency: string;
  payer: { personId: string };
}

export interface PixChargeResult {
  effect: AsaasEffect;
  providerChargeId: string;
  qrCode: string | null;
  detail: string;
}

export interface ChargeStatusQuery {
  providerChargeId: string;
}

export type ProviderChargeStatus = "PAID" | "PENDING" | "FAILED" | "UNKNOWN";

export interface ChargeStatusResult {
  status: ProviderChargeStatus;
  valueMinor: bigint | null;
  currency: string | null;
  detail: string;
}

export interface RefundRequest {
  paymentId: string;
  refundId: string;
  valueMinor: bigint;
  currency: string;
}

export interface RefundResult {
  effect: AsaasEffect;
  providerRefundId: string | null;
  detail: string;
}

export interface RefundStatusQuery {
  providerRefundId: string;
}

export interface AsaasPort {
  readonly name: string;
  createPixCharge(input: PixChargeRequest): Promise<PixChargeResult>;
  getCharge(query: ChargeStatusQuery): Promise<ChargeStatusResult>;
  executeRefund(input: RefundRequest): Promise<RefundResult>;
  getRefund(query: RefundStatusQuery): Promise<RefundResult>;
}

function envMode(name: string, def: string): string {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return def;
  }
  return raw.trim().toLowerCase();
}

/** Deterministic synthetic adapter: no network, no credentials. */
export class EchoAsaasAdapter implements AsaasPort {
  readonly name = "echo";

  async createPixCharge(input: PixChargeRequest): Promise<PixChargeResult> {
    const mode = envMode("ASAAS_ECHO_CREATE", "ok");
    const providerChargeId = `echo-${input.chargeId}`;
    if (mode === "unknown") {
      // Provisional binding: the effect is uncertain, so the charge stays
      // PROCESSING and `charge.reconcile` resolves it later.
      return {
        effect: "UNKNOWN",
        providerChargeId,
        qrCode: null,
        detail: "echo: synthetic unknown create effect",
      };
    }
    if (mode === "failed") {
      return {
        effect: "KNOWN_NOT_APPLIED",
        providerChargeId,
        qrCode: null,
        detail: "echo: synthetic create failure",
      };
    }
    return {
      effect: "KNOWN_APPLIED",
      providerChargeId,
      qrCode: `echo-qr-${input.chargeId}`,
      detail: "echo: synthetic pix charge accepted",
    };
  }

  async getCharge(query: ChargeStatusQuery): Promise<ChargeStatusResult> {
    const mode = envMode("ASAAS_ECHO_RECONCILE", "unknown");
    if (mode === "paid") {
      return { status: "PAID", valueMinor: null, currency: null, detail: `echo: synthetic paid for ${query.providerChargeId}` };
    }
    if (mode === "failed") {
      return { status: "FAILED", valueMinor: null, currency: null, detail: `echo: synthetic failed for ${query.providerChargeId}` };
    }
    return { status: "UNKNOWN", valueMinor: null, currency: null, detail: `echo: still unknown for ${query.providerChargeId}` };
  }

  async executeRefund(input: RefundRequest): Promise<RefundResult> {
    const mode = envMode("ASAAS_ECHO_REFUND", "applied");
    const providerRefundId = `echo-refund-${input.refundId}`;
    if (mode === "unknown") {
      return { effect: "UNKNOWN", providerRefundId, detail: "echo: synthetic unknown refund effect" };
    }
    if (mode === "not_applied") {
      return { effect: "KNOWN_NOT_APPLIED", providerRefundId: null, detail: "echo: synthetic refund rejected" };
    }
    return { effect: "KNOWN_APPLIED", providerRefundId, detail: "echo: synthetic refund applied" };
  }

  async getRefund(query: RefundStatusQuery): Promise<RefundResult> {
    const mode = envMode("ASAAS_ECHO_REFUND_RECONCILE", "applied");
    if (mode === "not_applied") {
      return { effect: "KNOWN_NOT_APPLIED", providerRefundId: null, detail: `echo: refund never applied ${query.providerRefundId}` };
    }
    if (mode === "unknown") {
      return { effect: "UNKNOWN", providerRefundId: query.providerRefundId, detail: `echo: refund still unknown ${query.providerRefundId}` };
    }
    return { effect: "KNOWN_APPLIED", providerRefundId: query.providerRefundId, detail: `echo: refund confirmed ${query.providerRefundId}` };
  }
}

/**
 * Env-gated real adapter stub. Requires BOTH `ASAAS_API_KEY` and
 * `ASAAS_BASE_URL`; without them it reports misconfiguration (the command
 * maps that to a failed attempt with the charge staying PENDING/PROCESSING —
 * never a blind retry). Timeouts and transport errors map to UNKNOWN.
 */
export class RealAsaasAdapter implements AsaasPort {
  readonly name = "real";

  private config(): { apiKey: string; baseUrl: string } | null {
    const apiKey = process.env["ASAAS_API_KEY"];
    const baseUrl = process.env["ASAAS_BASE_URL"];
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      return null;
    }
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      return null;
    }
    return { apiKey, baseUrl };
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; json: unknown }> {
    const cfg = this.config();
    if (cfg === null) {
      throw new Error("asaas is not configured (ASAAS_API_KEY/ASAAS_BASE_URL)");
    }
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", access_token: cfg.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json };
  }

  async createPixCharge(input: PixChargeRequest): Promise<PixChargeResult> {
    // Asaas PIX: value is decimal major units; format from minor units
    // without float arithmetic (BRL has 2 fraction digits).
    const major = `${input.valueMinor / 100n}.${(input.valueMinor % 100n).toString().padStart(2, "0")}`;
    let response: { ok: boolean; status: number; json: unknown };
    try {
      response = await this.postJson("/payments", {
        billingType: "PIX",
        value: major,
        externalReference: input.chargeId,
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return {
        effect: "UNKNOWN",
        providerChargeId: `unknown-${input.chargeId}`,
        qrCode: null,
        detail: timeout ? "asaas: create timed out, effect unknown" : "asaas: create transport error, effect unknown",
      };
    }
    if (!response.ok) {
      return {
        effect: "KNOWN_NOT_APPLIED",
        providerChargeId: `rejected-${input.chargeId}`,
        qrCode: null,
        detail: `asaas: create rejected with status ${response.status}`,
      };
    }
    const json = response.json as { id?: unknown; pixQrCode?: unknown } | null;
    const providerChargeId = typeof json?.id === "string" ? json.id : `asaas-${input.chargeId}`;
    return {
      effect: "KNOWN_APPLIED",
      providerChargeId,
      qrCode: typeof json?.pixQrCode === "string" ? json.pixQrCode : null,
      detail: "asaas: pix charge accepted",
    };
  }

  async getCharge(query: ChargeStatusQuery): Promise<ChargeStatusResult> {
    return { status: "UNKNOWN", valueMinor: null, currency: null, detail: `asaas stub: no readback for ${query.providerChargeId}` };
  }

  async executeRefund(input: RefundRequest): Promise<RefundResult> {
    void input;
    return { effect: "UNKNOWN", providerRefundId: null, detail: "asaas stub: refund effect unknown, reconcile required" };
  }

  async getRefund(query: RefundStatusQuery): Promise<RefundResult> {
    return { effect: "UNKNOWN", providerRefundId: query.providerRefundId, detail: "asaas stub: refund reconcile pending" };
  }
}

export function asaasAdapterNameFromEnv(): "echo" | "real" {
  return process.env["ASAAS_ADAPTER"] === "real" ? "real" : "echo";
}

export function resolveAsaasPort(name: "echo" | "real"): AsaasPort {
  const inner: AsaasPort = name === "real" ? new RealAsaasAdapter() : new EchoAsaasAdapter();
  return tracedAsaasPort(inner);
}

/**
 * W1-12 span decorator for Asaas calls. Attributes are adapter name +
 * operation only — amounts, ids and payloads are NEVER telemetry.
 */
export function tracedAsaasPort(inner: AsaasPort): AsaasPort {
  return {
    name: inner.name,
    createPixCharge: (input) =>
      withSpan("asaas.create_pix_charge", { adapter: inner.name, operation: "create_pix_charge" }, () =>
        inner.createPixCharge(input),
      ),
    getCharge: (query) =>
      withSpan("asaas.get_charge", { adapter: inner.name, operation: "get_charge" }, () => inner.getCharge(query)),
    executeRefund: (input) =>
      withSpan("asaas.execute_refund", { adapter: inner.name, operation: "execute_refund" }, () =>
        inner.executeRefund(input),
      ),
    getRefund: (query) =>
      withSpan("asaas.get_refund", { adapter: inner.name, operation: "get_refund" }, () => inner.getRefund(query)),
  };
}
