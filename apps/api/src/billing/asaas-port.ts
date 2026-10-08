/**
 * Asaas billing port (Wave 5).
 *
 * Agent tools never call provider APIs directly: `charge.create`,
 * `charge.reconcile` and `refund.execute_approved` invoke semantic commands
 * that go through this port. The ONLY implementations shipped here are:
 * - `EchoAsaasAdapter` (default): deterministic synthetic outcomes for tests
 *   and local flows — no network, no credentials.
 * - `RealAsaasAdapter` (env-gated stub): used ONLY when `ASAAS_API_KEY` and
 *   `ASAAS_BASE_URL` are both set; `createPixCharge` posts the `/payments`
 *   minimum (`billingType/value/dueDate/externalReference` + `customer` only
 *   from an explicit `providerCustomerId` binding, never invented); transport
 *   timeouts/unknowns map to UNKNOWN_EFFECT (charge stays PROCESSING +
 *   reconcile task, NEVER an automatic create retry). There are no real Asaas
 *   calls in tests.
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
  /**
   * Proven Asaas customer id (`cus_...`) bound to the payer, or null when no
   * binding exists. The Asaas `/payments` API requires `customer`: when absent
   * the stub sends no customer and the provider rejects (4xx →
   * KNOWN_NOT_APPLIED, charge stays PENDING) — the stub never invents one.
   * B1 wires a disposable sandbox customer here; production wiring is a later
   * explicit step, never inferred.
   */
  providerCustomerId?: string | null;
  /**
   * `YYYY-MM-DD` due date for the charge (required by `/payments`). Defaults
   * to tomorrow (UTC) when omitted/blank; a malformed explicit value throws
   * before any I/O.
   */
  dueDate?: string;
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
  /** Internal `billing.payments` id (lineage only — NEVER used as a provider id). */
  paymentId: string;
  refundId: string;
  /**
   * Proven external Asaas charge id (from `charge_provider_bindings`), or
   * null when none exists. The real adapter NEVER calls the provider without
   * one: a local/synthetic reference maps to UNKNOWN, not to a refund
   * attempt against a payment the provider never issued.
   */
  providerChargeId: string | null;
  valueMinor: bigint;
  currency: string;
}

export interface RefundResult {
  effect: AsaasEffect;
  providerRefundId: string | null;
  detail: string;
}

export interface CustomerProvisionRequest {
  personId: string;
  /** Display name sent as the provider `name` (Asaas requires it). */
  name: string;
  /**
   * CPF/CNPJ digits (formatted or raw) carried in-transit ONLY — never
   * persisted (LGPD: no document column exists on `identity.persons` nor on
   * any billing binding table in this slice). Null/omitted means "no real
   * document available": sandbox/echo resolve the documented test constant,
   * production refuses with `DOCUMENT_REQUIRED` and NEVER invents one.
   */
  document?: string | null;
}

export interface CustomerProvisionResult {
  effect: AsaasEffect;
  providerCustomerId: string | null;
  detail: string;
}

export interface RefundStatusQuery {
  providerRefundId: string;
}

export interface AsaasPort {
  readonly name: string;
  createPixCharge(input: PixChargeRequest): Promise<PixChargeResult>;
  createCustomer(input: CustomerProvisionRequest): Promise<CustomerProvisionResult>;
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

function normalizeToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * The Asaas provider boundary is BRL-only (PIX cobranças and refunds settle
 * in reais). Reject anything else with a clear error instead of formatting
 * foreign currencies with the wrong fraction digits.
 */
function requireBrlCurrency(currency: string, operation: string): void {
  if (currency.trim().toUpperCase() !== "BRL") {
    throw new Error(`asaas: ${operation} supports only BRL (got ${JSON.stringify(currency)})`);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYNTHETIC_PREFIXES = ["unknown-", "rejected-", "asaas-", "echo-"];

/** Namespace owned by the echo adapter (`echo-<charge>` / `echo-refund-<refund>`). */
export const ECHO_PROVIDER_PREFIX = "echo-";

/**
 * True when a provider reference was minted by the echo adapter. The echo
 * namespace is a subset of the synthetic namespace: every `echo-` ref is
 * synthetic (never a proven external Asaas id), but not every synthetic ref
 * is echo-owned (`unknown-` / `rejected-` / `asaas-` / UUIDs are not).
 * Reconcile safety is decided by this namespace — never by `port.name`
 * alone — so a config swap (real refs reconciled under echo, or vice-versa)
 * can never confirm/resolve foreign work.
 */
export function isEchoProviderReference(id: string | null | undefined): boolean {
  if (typeof id !== "string") {
    return false;
  }
  const value = id.trim();
  if (value.length === 0) {
    return false;
  }
  return value.toLowerCase().startsWith(ECHO_PROVIDER_PREFIX);
}

/**
 * True when a provider reference is NOT a proven external Asaas id and must
 * never be used as one: local UUIDs, blanks, and synthetic `unknown-` /
 * `rejected-` / `asaas-` / `echo-` references minted locally when a create
 * effect was uncertain or rejected. A 404 (or any readback) against such a
 * reference proves nothing about the provider — it only proves we asked
 * about an id the provider never issued.
 */
export function isSyntheticProviderReference(id: string | null | undefined): boolean {
  if (typeof id !== "string") {
    return true;
  }
  const value = id.trim();
  if (value.length === 0) {
    return true;
  }
  if (UUID_RE.test(value)) {
    return true;
  }
  const lower = value.toLowerCase();
  return SYNTHETIC_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Resolve the charge id a refund may legally target at the provider.
 * Returns the proven external id, or null when there is none (no binding,
 * blank, synthetic/local, or a foreign namespace for the configured
 * adapter). Each adapter owns exactly one namespace:
 * - `echo` executes ONLY `echo-` bindings (synthetic-local by design; the
 *   echo transport ignores the value but never touches foreign work);
 * - `real` executes ONLY proven external ids (every synthetic/local ref —
 *   including `echo-`, which is a subset of synthetic — maps to null).
 * Namespace safety therefore holds even before any command-level fast-path.
 */
export function provenExternalChargeId(
  adapterName: string,
  bindingExternalId: string | null | undefined,
): string | null {
  if (typeof bindingExternalId !== "string" || bindingExternalId.trim().length === 0) {
    return null;
  }
  const id = bindingExternalId.trim();
  if (adapterName === "echo") {
    return isEchoProviderReference(id) ? id : null;
  }
  return isSyntheticProviderReference(id) ? null : id;
}

function mapPaymentStatusToCharge(raw: string): ProviderChargeStatus {
  if (raw === "RECEIVED" || raw === "CONFIRMED" || raw === "RECEIVED_IN_CASH" || raw === "REFUNDED") {
    return "PAID";
  }
  if (
    raw === "CANCELLED" ||
    raw === "CANCELED" ||
    raw === "DELETED" ||
    raw === "FAILED" ||
    raw === "REFUSED" ||
    raw === "DENIED"
  ) {
    return "FAILED";
  }
  if (raw === "") {
    return "UNKNOWN";
  }
  return "PENDING";
}

function mapPaymentStatusToRefund(raw: string): AsaasEffect {
  if (raw === "REFUNDED") {
    return "KNOWN_APPLIED";
  }
  if (
    raw === "RECEIVED" ||
    raw === "CONFIRMED" ||
    raw === "RECEIVED_IN_CASH" ||
    raw === "OVERDUE" ||
    raw === "PENDING"
  ) {
    return "KNOWN_NOT_APPLIED";
  }
  return "UNKNOWN";
}

const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Sandbox-only test CPF (Asaas homologação accepts it; see the sandbox
 * docs). Used ONLY when the configured base URL is a sandbox one AND no
 * real document was supplied. NEVER sent to a non-sandbox base: production
 * without a real document fails closed with `DOCUMENT_REQUIRED` instead.
 */
export const SANDBOX_TEST_DOCUMENT_CPF = "11144477735";

/** True when the Asaas base URL points at the sandbox environment. */
export function isSandboxBaseUrl(baseUrl: string): boolean {
  return baseUrl.toLowerCase().includes("sandbox");
}

/**
 * Resolve the CPF/CNPJ digits a customer provision may send to the provider.
 * Sandbox resolves a missing document to the documented test constant;
 * production (any non-sandbox base) throws `DOCUMENT_REQUIRED` when no real
 * document is available and validates CPF (11) / CNPJ (14) digit length —
 * it NEVER invents a document.
 */
export function resolveProvisionDocument(
  document: string | null | undefined,
  baseUrl: string,
): string {
  const digits = typeof document === "string" ? document.replace(/\D/g, "") : "";
  if (isSandboxBaseUrl(baseUrl)) {
    return digits.length > 0 ? digits : SANDBOX_TEST_DOCUMENT_CPF;
  }
  if (digits.length === 0) {
    throw new Error(
      "asaas: DOCUMENT_REQUIRED — production customer provisioning needs a real CPF/CNPJ document (never invented; sandbox accepts the documented test constant)",
    );
  }
  if (digits.length !== 11 && digits.length !== 14) {
    throw new Error(
      `asaas: document must be CPF (11 digits) or CNPJ (14 digits), got ${digits.length} digits`,
    );
  }
  return digits;
}

/** Tomorrow (UTC) as `YYYY-MM-DD` — the default `/payments` due date. */
function defaultDueDate(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function resolveDueDate(explicit: string | undefined): string {
  if (explicit === undefined || explicit.trim().length === 0) {
    return defaultDueDate();
  }
  const value = explicit.trim();
  if (!DUE_DATE_RE.test(value)) {
    throw new Error(`asaas: dueDate must be YYYY-MM-DD (got ${JSON.stringify(explicit)})`);
  }
  return value;
}

function minorFromDecimal(value: unknown): bigint | null {
  const text =
    typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) {
    return null;
  }
  const units = BigInt(match[1] ?? "0");
  const cents = BigInt((match[2] ?? "").padEnd(2, "0"));
  return units * 100n + cents;
}

function currencyFromJson(record: Record<string, unknown> | null, hasValue: boolean): string | null {
  const raw = record?.["currency"];
  if (typeof raw === "string" && /^[A-Za-z]{3}$/.test(raw.trim())) {
    return raw.trim().toUpperCase();
  }
  return hasValue ? "BRL" : null;
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** Deterministic synthetic adapter: no network, no credentials. */
export class EchoAsaasAdapter implements AsaasPort {
  readonly name = "echo";

  async createCustomer(input: CustomerProvisionRequest): Promise<CustomerProvisionResult> {
    // Synthetic-local by design: the id is namespaced `echo-cus-` (never a
    // real provider id) and any in-transit document is ignored — echo never
    // touches the provider, so no document is ever needed nor sent.
    return {
      effect: "KNOWN_APPLIED",
      providerCustomerId: `echo-cus-${input.personId}`,
      detail: "echo: synthetic customer accepted",
    };
  }

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
    // Chokepoint (MVP-ASAAS-05): the echo namespace is `echo-` ONLY. A real
    // (or otherwise foreign) reference under echo must never resolve with a
    // synthetic outcome — refuse as UNKNOWN before consulting any mode/env,
    // with zero I/O. Callers retain PROCESSING + exception.
    if (!isEchoProviderReference(query.providerChargeId)) {
      return {
        status: "UNKNOWN",
        valueMinor: null,
        currency: null,
        detail: `echo: foreign reference ${query.providerChargeId}; confirmation refused (reservation held)`,
      };
    }
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
    // Chokepoint (MVP-ASAAS-05): echo executes ONLY `echo-` charge bindings.
    // A foreign (real) or missing binding must never yield KNOWN_APPLIED —
    // refuse as UNKNOWN with a null refund id (so no resolvable synthetic id
    // is persisted) before consulting any mode/env, with zero I/O. Callers
    // retain the reservation (RECONCILING + exception). KNOWN_NOT_APPLIED is
    // deliberately NOT used here: it would release the reservation as FAILED
    // on unproven data.
    const target = typeof input.providerChargeId === "string" ? input.providerChargeId.trim() : "";
    if (!isEchoProviderReference(target)) {
      return {
        effect: "UNKNOWN",
        providerRefundId: null,
        detail: "echo: foreign or missing charge reference; refund refused (reservation held, provider never called)",
      };
    }
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
    // Chokepoint (MVP-ASAAS-05): echo resolves ONLY `echo-` refund refs. A
    // foreign (real) reference must never resolve with a synthetic outcome —
    // refuse as UNKNOWN before consulting any mode/env, with zero I/O.
    // Callers retain RECONCILING + exception.
    if (!isEchoProviderReference(query.providerRefundId)) {
      return {
        effect: "UNKNOWN",
        providerRefundId: query.providerRefundId,
        detail: `echo: foreign refund reference ${query.providerRefundId}; resolution refused (reservation held)`,
      };
    }
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
 * Env-gated real adapter. Requires BOTH `ASAAS_API_KEY` and
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

  private async getJson(path: string): Promise<{ ok: boolean; status: number; json: unknown }> {
    const cfg = this.config();
    if (cfg === null) {
      throw new Error("asaas is not configured (ASAAS_API_KEY/ASAAS_BASE_URL)");
    }
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method: "GET",
      headers: { "Content-Type": "application/json", access_token: cfg.apiKey },
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

  async createCustomer(input: CustomerProvisionRequest): Promise<CustomerProvisionResult> {
    const cfg = this.config();
    if (cfg === null) {
      throw new Error("asaas is not configured (ASAAS_API_KEY/ASAAS_BASE_URL)");
    }
    // Sandbox-guarded document: sandbox resolves a missing document to the
    // documented test constant; production throws DOCUMENT_REQUIRED (never
    // invents) — the command maps that to an explicit precondition failure
    // with zero provider I/O.
    const document = resolveProvisionDocument(input.document, cfg.baseUrl);
    const name = input.name.trim().length > 0 ? input.name.trim() : `customer-${input.personId}`;
    let response: { ok: boolean; status: number; json: unknown };
    try {
      response = await this.postJson("/customers", { name, cpfCnpj: document });
    } catch {
      return {
        effect: "UNKNOWN",
        providerCustomerId: null,
        detail: "asaas: customer create transport error, effect unknown (no binding persisted)",
      };
    }
    if (!response.ok) {
      // 4xx = provider refused (no customer created); 5xx = uncertain.
      if (response.status >= 500) {
        return {
          effect: "UNKNOWN",
          providerCustomerId: null,
          detail: `asaas: customer create status ${response.status}, effect unknown (no binding persisted)`,
        };
      }
      return {
        effect: "KNOWN_NOT_APPLIED",
        providerCustomerId: null,
        detail: `asaas: customer create rejected with status ${response.status}`,
      };
    }
    const record = asRecordOrNull(response.json);
    const providerId =
      typeof record?.["id"] === "string" && (record["id"] as string).trim().length > 0
        ? (record["id"] as string).trim()
        : null;
    if (providerId === null) {
      return {
        effect: "UNKNOWN",
        providerCustomerId: null,
        detail: "asaas: customer create response without provider id, effect unknown (no binding persisted)",
      };
    }
    return { effect: "KNOWN_APPLIED", providerCustomerId: providerId, detail: "asaas: customer accepted" };
  }

  async createPixCharge(input: PixChargeRequest): Promise<PixChargeResult> {
    // Asaas PIX: value is decimal major units; format from minor units
    // without float arithmetic (BRL has 2 fraction digits — enforced above,
    // so the /100n formatting below is exact for every accepted input).
    requireBrlCurrency(input.currency, "pix charge");
    const major = `${input.valueMinor / 100n}.${(input.valueMinor % 100n).toString().padStart(2, "0")}`;
    // Customer binding (P3): `/payments` requires `customer` + `dueDate`.
    // The stub sends the proven binding when one exists and nothing otherwise
    // — without a customer the provider rejects (4xx → KNOWN_NOT_APPLIED),
    // which is the honest signal that B1 (disposable sandbox customer) is
    // still pending. No sandbox/production value is ever hardcoded here.
    const customerId =
      typeof input.providerCustomerId === "string" && input.providerCustomerId.trim().length > 0
        ? input.providerCustomerId.trim()
        : null;
    const body: Record<string, unknown> = {
      billingType: "PIX",
      value: major,
      dueDate: resolveDueDate(input.dueDate),
      externalReference: input.chargeId,
    };
    if (customerId !== null) {
      body["customer"] = customerId;
    }
    let response: { ok: boolean; status: number; json: unknown };
    try {
      response = await this.postJson("/payments", body);
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
    // A 2xx without a provider id proves nothing: the charge stays uncertain
    // (UNKNOWN + synthetic reference) instead of looking applied.
    const providerId = typeof json?.id === "string" && json.id.trim().length > 0 ? json.id.trim() : null;
    if (providerId === null) {
      return {
        effect: "UNKNOWN",
        providerChargeId: `unknown-${input.chargeId}`,
        qrCode: null,
        detail: "asaas: create response without provider id, effect unknown",
      };
    }
    return {
      effect: "KNOWN_APPLIED",
      providerChargeId: providerId,
      qrCode: typeof json?.pixQrCode === "string" ? json.pixQrCode : null,
      detail: "asaas: pix charge accepted",
    };
  }

  async getCharge(query: ChargeStatusQuery): Promise<ChargeStatusResult> {
    const cfg = this.config();
    if (cfg === null) {
      throw new Error("asaas is not configured (ASAAS_API_KEY/ASAAS_BASE_URL)");
    }
    // A 404 against a synthetic/local reference would only prove we asked
    // about an id the provider never issued — never that creation failed.
    if (isSyntheticProviderReference(query.providerChargeId)) {
      return {
        status: "UNKNOWN",
        valueMinor: null,
        currency: null,
        detail: "asaas: charge reference is synthetic/local; creation effect still unknown",
      };
    }
    let response: { ok: boolean; status: number; json: unknown };
    try {
      response = await this.getJson(`/payments/${encodeURIComponent(query.providerChargeId)}`);
    } catch (err) {
      return {
        status: "UNKNOWN",
        valueMinor: null,
        currency: null,
        detail: isTimeout(err)
          ? "asaas: charge readback timed out, effect unknown"
          : "asaas: charge readback transport error, effect unknown",
      };
    }
    if (!response.ok) {
      if (response.status === 404) {
        return {
          status: "FAILED",
          valueMinor: null,
          currency: null,
          detail: "asaas: charge not found at provider",
        };
      }
      return {
        status: "UNKNOWN",
        valueMinor: null,
        currency: null,
        detail: `asaas: charge readback status ${response.status}`,
      };
    }
    const record = asRecordOrNull(response.json);
    const raw = normalizeToken(record?.["status"]);
    const valueMinor = minorFromDecimal(record?.["value"]);
    return {
      status: mapPaymentStatusToCharge(raw),
      valueMinor,
      currency: currencyFromJson(record, valueMinor !== null),
      detail: `asaas: charge status ${raw === "" ? "unknown" : raw}`,
    };
  }

  async executeRefund(input: RefundRequest): Promise<RefundResult> {
    if (this.config() === null) {
      throw new Error("asaas is not configured (ASAAS_API_KEY/ASAAS_BASE_URL)");
    }
    requireBrlCurrency(input.currency, "refund");
    // CRITICAL: never refund by internal/local id. Without a proven external
    // charge id the effect is uncertain — report UNKNOWN and make NO call.
    const target =
      typeof input.providerChargeId === "string" ? input.providerChargeId.trim() : "";
    if (isSyntheticProviderReference(target)) {
      return {
        effect: "UNKNOWN",
        providerRefundId: null,
        detail: "asaas: no proven external charge id for refund; effect unknown (provider never called)",
      };
    }
    const major = `${input.valueMinor / 100n}.${(input.valueMinor % 100n).toString().padStart(2, "0")}`;
    let response: { ok: boolean; status: number; json: unknown };
    try {
      response = await this.postJson(`/payments/${encodeURIComponent(target)}/refund`, {
        value: major,
      });
    } catch (err) {
      return {
        effect: "UNKNOWN",
        providerRefundId: null,
        detail: isTimeout(err)
          ? "asaas: refund timed out, effect unknown"
          : "asaas: refund transport error, effect unknown",
      };
    }
    if (!response.ok) {
      if (response.status >= 500) {
        return {
          effect: "UNKNOWN",
          providerRefundId: null,
          detail: `asaas: refund status ${response.status}, effect unknown`,
        };
      }
      return {
        effect: "KNOWN_NOT_APPLIED",
        providerRefundId: null,
        detail: `asaas: refund rejected with status ${response.status}`,
      };
    }
    // A 2xx only counts as applied with BOTH a provider id and a proven
    // applied status. Malformed bodies (null, missing id) and non-terminal
    // statuses (pending/requested/empty) stay UNKNOWN — never finalize a
    // refund or post a ledger reversal on unproven data.
    const record = asRecordOrNull(response.json);
    const raw = normalizeToken(record?.["status"]);
    const providerRefundId =
      typeof record?.["id"] === "string" && (record["id"] as string).trim().length > 0
        ? (record["id"] as string).trim()
        : null;
    if (raw === "REFUNDED") {
      if (providerRefundId === null) {
        return {
          effect: "UNKNOWN",
          providerRefundId: null,
          detail: "asaas: refund reports applied status without a provider id; effect unknown",
        };
      }
      return { effect: "KNOWN_APPLIED", providerRefundId, detail: "asaas: refund applied" };
    }
    if (raw === "REFUSED" || raw === "DENIED" || raw === "FAILED" || raw === "CANCELLED" || raw === "CANCELED") {
      return {
        effect: "KNOWN_NOT_APPLIED",
        providerRefundId: null,
        detail: `asaas: refund not applied (${raw})`,
      };
    }
    return {
      effect: "UNKNOWN",
      providerRefundId,
      detail: `asaas: refund status ${raw === "" ? "unknown" : raw}; effect unknown`,
    };
  }

  async getRefund(query: RefundStatusQuery): Promise<RefundResult> {
    const cfg = this.config();
    if (cfg === null) {
      throw new Error("asaas is not configured (ASAAS_API_KEY/ASAAS_BASE_URL)");
    }
    // A 404 against a synthetic/local reference (including the internal
    // refund UUID used when execute ended UNKNOWN) can never prove the
    // provider did not execute — hold the reservation as UNKNOWN.
    if (isSyntheticProviderReference(query.providerRefundId)) {
      return {
        effect: "UNKNOWN",
        providerRefundId: query.providerRefundId,
        detail: "asaas: refund reference is synthetic/local; execution still unknown",
      };
    }
    let response: { ok: boolean; status: number; json: unknown };
    try {
      response = await this.getJson(`/payments/${encodeURIComponent(query.providerRefundId)}`);
    } catch (err) {
      return {
        effect: "UNKNOWN",
        providerRefundId: query.providerRefundId,
        detail: isTimeout(err)
          ? "asaas: refund readback timed out, effect unknown"
          : "asaas: refund readback transport error, effect unknown",
      };
    }
    if (!response.ok) {
      if (response.status === 404) {
        return {
          effect: "KNOWN_NOT_APPLIED",
          providerRefundId: null,
          detail: "asaas: refund not found at provider",
        };
      }
      return {
        effect: "UNKNOWN",
        providerRefundId: query.providerRefundId,
        detail: `asaas: refund readback status ${response.status}`,
      };
    }
    const record = asRecordOrNull(response.json);
    const raw = normalizeToken(record?.["status"]);
    const providerRefundId =
      typeof record?.["id"] === "string" && (record["id"] as string).length > 0
        ? (record["id"] as string)
        : query.providerRefundId;
    const effect = mapPaymentStatusToRefund(raw);
    if (effect === "KNOWN_APPLIED") {
      return { effect, providerRefundId, detail: "asaas: refund confirmed" };
    }
    if (effect === "KNOWN_NOT_APPLIED") {
      return {
        effect,
        providerRefundId: null,
        detail: `asaas: refund not applied (${raw === "" ? "unknown" : raw})`,
      };
    }
    return {
      effect,
      providerRefundId,
      detail: `asaas: refund status ${raw === "" ? "unknown" : raw}`,
    };
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
    createCustomer: (input) =>
      withSpan("asaas.create_customer", { adapter: inner.name, operation: "create_customer" }, () =>
        inner.createCustomer(input),
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
