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
import type { Transaction } from "kysely";
import type { Database } from "@iptv/database";
import { resolveSecretsPort, type SecretsPort } from "@iptv/secrets";

export type AsaasEffect = "KNOWN_APPLIED" | "KNOWN_NOT_APPLIED" | "UNKNOWN";

/** Provider `/payments` billing types supported by this slice (default `PIX`). */
export type AsaasBillingType = "PIX" | "BOLETO";

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
   * Provider `billingType` for `/payments` (default `PIX`). Validated
   * (PIX|BOLETO) before any I/O — a forged value throws instead of posting.
   */
  billingType?: AsaasBillingType;
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

export interface PixQrCodeResult {
  payload: string | null;
  encodedImage: string | null;
  expirationDate: string | null;
}

export interface AsaasPort {
  readonly name: string;
  createPixCharge(input: PixChargeRequest): Promise<PixChargeResult>;
  getPixQrCode?(providerChargeId: string): Promise<PixQrCodeResult>;
  createCustomer(input: CustomerProvisionRequest): Promise<CustomerProvisionResult>;
  getCharge(query: ChargeStatusQuery): Promise<ChargeStatusResult>;
  executeRefund(input: RefundRequest): Promise<RefundResult>;
  getRefund(query: RefundStatusQuery): Promise<RefundResult>;
  /**
   * Webhook provisioning (S2A, `integration.webhook_ensure`): OPTIONAL on the
   * port so existing unit fakes (billing/charge-only) keep compiling —
   * `EchoAsaasAdapter` and `RealAsaasAdapter` both implement it. Credentials
   * are explicit per call (the tenant's vault-resolved API key + the fixed
   * allowlist host), never the process `ASAAS_API_KEY` env. Outbound auth
   * uses the official `access_token` header (the `asaas-access-token` header
   * is the INBOUND direction: Asaas → our ingress, echoing our authToken).
   */
  listWebhooks?(input: AsaasWebhookAuth): Promise<AsaasWebhookListResult>;
  createWebhook?(input: AsaasWebhookSaveInput): Promise<AsaasWebhookSaveResult>;
  updateWebhook?(input: AsaasWebhookSaveInput & { providerWebhookId: string }): Promise<AsaasWebhookSaveResult>;
}

/**
 * Per-call provisioning credentials: the tenant's vault-resolved Asaas API
 * key plus the fixed allowlist host for its environment. `fetchFn` is an
 * injectable transport (global fetch in production, fake in tests). The API
 * key authenticates the call (`access_token` header); the webhook token
 * below travels in the save body — never the same value.
 */
export interface AsaasWebhookAuth {
  host: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

/** PIX-billing events this platform subscribes to (official Asaas names). */
export const ASAAS_WEBHOOK_EVENTS = ["PAYMENT_RECEIVED", "PAYMENT_OVERDUE", "PAYMENT_REFUNDED"] as const;

/** Official Asaas cap: at most 10 webhooks per account. */
export const ASAAS_WEBHOOK_LIMIT = 10;

/** Bounded transport budget for webhook provisioning (same as probes). */
export const ASAAS_WEBHOOK_TIMEOUT_MS = 8000;

export interface AsaasWebhookRecord {
  id: string;
  url: string;
}

export interface AsaasWebhookListResult {
  webhooks: AsaasWebhookRecord[];
}

/** `POST /v3/webhooks` body (official required fields + our authToken). */
export interface AsaasWebhookSaveInput extends AsaasWebhookAuth {
  name: string;
  url: string;
  /** Operational notification email (required by Asaas; notification routing only). */
  email: string;
  /** Webhook token (32–255 chars, no spaces, never an API key) for the body. */
  authToken: string;
}

export interface AsaasWebhookSaveResult {
  id: string;
}

/**
 * Webhook provisioning step. Preserved on every typed failure so callers can
 * distinguish a LIST problem (endpoint/contract) from a SAVE problem
 * (create endpoint vs. update target) without ever carrying the raw payload.
 */
export type AsaasWebhookStep = "list" | "create" | "update";

export type AsaasWebhookFailureCode =
  | "INVALID_CREDENTIALS"
  | "WEBHOOK_RESOURCE_NOT_FOUND"
  | "PROVIDER_REQUEST_REJECTED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_CONTRACT_MISMATCH"
  | "PROVIDER_UNAVAILABLE";

function webhookFailureCodeOf(
  status: number | "TRANSPORT" | "MALFORMED",
  step: AsaasWebhookStep,
): AsaasWebhookFailureCode {
  if (status === 401 || status === 403) return "INVALID_CREDENTIALS";
  if (status === 404) return step === "update" ? "WEBHOOK_RESOURCE_NOT_FOUND" : "PROVIDER_CONTRACT_MISMATCH";
  if (status === "MALFORMED") return "PROVIDER_CONTRACT_MISMATCH";
  if (status === "TRANSPORT" || (typeof status === "number" && status >= 500)) return "PROVIDER_UNAVAILABLE";
  if (status === 429) return "PROVIDER_RATE_LIMITED";
  return "PROVIDER_REQUEST_REJECTED";
}

/**
 * Typed provisioning failure. `status` is the provider HTTP status, or
 * `TRANSPORT` (timeout/network), or `MALFORMED` (2xx without a usable `id` —
 * effect unknown). `step` is the provisioning phase that failed. `detail`
 * carries the status only — never the response body, the authToken, any
 * header, an external id, or a URL.
 */
export class AsaasWebhookError extends Error {
  readonly status: number | "TRANSPORT" | "MALFORMED";
  readonly step: AsaasWebhookStep;
  readonly code: AsaasWebhookFailureCode;

  constructor(status: number | "TRANSPORT" | "MALFORMED", detail: string, step: AsaasWebhookStep) {
    super(`asaas webhook: ${detail}`);
    this.name = "AsaasWebhookError";
    this.status = status;
    this.step = step;
    this.code = webhookFailureCodeOf(status, step);
  }
}

/**
 * Official `POST /v3/webhooks` (+ `PUT`) body. `enabled: true` keeps the
 * queue flowing; `interrupted: false` never pauses delivery on provision;
 * `apiVersion: 3` pins the payload shape our ingress parses;
 * `sendType: "SEQUENTIALLY"` preserves event order. The authToken travels in
 * this body (required) and is NEVER logged, thrown, or telemetered.
 */
export function asaasWebhookSaveBody(input: { name: string; url: string; email: string; authToken: string }): Record<string, unknown> {
  return {
    name: input.name,
    url: input.url,
    email: input.email,
    enabled: true,
    interrupted: false,
    apiVersion: 3,
    authToken: input.authToken,
    sendType: "SEQUENTIALLY",
    events: [...ASAAS_WEBHOOK_EVENTS],
  };
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

/**
 * Resolve the provider `billingType`, defaulting to `PIX`. An explicit value
 * must be PIX|BOLETO (case-insensitive, trimmed) — anything else throws
 * before any I/O so a forged billing type can never reach the provider.
 */
export function resolveBillingType(explicit: unknown): AsaasBillingType {
  if (explicit === undefined || explicit === null) {
    return "PIX";
  }
  if (typeof explicit !== "string" || explicit.trim().length === 0) {
    return "PIX";
  }
  const normalized = explicit.trim().toUpperCase();
  if (normalized === "PIX" || normalized === "BOLETO") {
    return normalized;
  }
  throw new Error(`asaas: billingType must be PIX or BOLETO (got ${JSON.stringify(explicit)})`);
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

  async getPixQrCode(providerChargeId: string): Promise<PixQrCodeResult> {
    if (!isEchoProviderReference(providerChargeId)) {
      return {
        payload: null,
        encodedImage: null,
        expirationDate: null,
      };
    }
    // Extract charge id from echo-<chargeId>
    const chargeId = providerChargeId.startsWith(ECHO_PROVIDER_PREFIX)
      ? providerChargeId.slice(ECHO_PROVIDER_PREFIX.length)
      : providerChargeId;
    return {
      payload: `echo-qr-${chargeId}`,
      encodedImage: null,
      expirationDate: null,
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

  /**
   * Synthetic webhook surface (S2A): no network, no credentials. The echo
   * namespace owns nothing at the provider, so listing is always empty and
   * saves mint `echo-wh-` ids that no other adapter will ever resolve.
   * `integration.webhook_ensure` never routes here (provisioning is
   * inherently a real-provider write against per-tenant credentials); these
   * exist for local-shape flows only.
   */
  async listWebhooks(): Promise<AsaasWebhookListResult> {
    return { webhooks: [] };
  }

  async createWebhook(): Promise<AsaasWebhookSaveResult> {
    echoWebhookSeq += 1;
    return { id: `echo-wh-${echoWebhookSeq}` };
  }

  async updateWebhook(input: AsaasWebhookSaveInput & { providerWebhookId: string }): Promise<AsaasWebhookSaveResult> {
    return { id: input.providerWebhookId };
  }
}

let echoWebhookSeq = 0;

/**
 * Env-gated real adapter. Requires BOTH `ASAAS_API_KEY` and
 * `ASAAS_BASE_URL`; without them it reports misconfiguration (the command
 * maps that to a failed attempt with the charge staying PENDING/PROCESSING —
 * never a blind retry). Timeouts and transport errors map to UNKNOWN.
 *
 * Tenant cutover (S2C, #86): the same class ALSO accepts injected
 * per-tenant credentials (`RealAsaasOptions`). Injected values take
 * precedence over the process env; without either source the adapter keeps
 * the legacy env behavior untouched (single-tenant staging compat).
 */
export interface RealAsaasOptions {
  /** Per-tenant vault-resolved API key (never logged, never thrown). */
  apiKey?: string;
  /** Per-tenant allowlist host for its environment (never client-supplied). */
  baseUrl?: string;
  /** Injectable transport (global fetch in production, fake in tests). */
  fetchFn?: typeof fetch;
}

export class RealAsaasAdapter implements AsaasPort {
  readonly name = "real";

  private readonly injectedApiKey: string | undefined;
  private readonly injectedBaseUrl: string | undefined;
  private readonly fetchImpl: typeof fetch;

  /**
   * Injectable transport (global fetch in production, fake in tests via
   * `integration.webhook_ensure`'s test doubles). Existing charge/refund
   * helpers keep the global fetch path untouched.
   *
   * Back-compat: `new RealAsaasAdapter()` and
   * `new RealAsaasAdapter(fetchImpl)` keep working — a bare function argument
   * is treated as the transport, exactly as before.
   */
  constructor(optionsOrFetch?: RealAsaasOptions | typeof fetch, legacyFetch?: typeof fetch) {
    if (typeof optionsOrFetch === "function") {
      this.injectedApiKey = undefined;
      this.injectedBaseUrl = undefined;
      this.fetchImpl = (legacyFetch ?? optionsOrFetch) as typeof fetch;
      return;
    }
    const options = optionsOrFetch ?? {};
    const apiKey = typeof options.apiKey === "string" && options.apiKey.length > 0 ? options.apiKey : undefined;
    const baseUrl = typeof options.baseUrl === "string" && options.baseUrl.length > 0 ? options.baseUrl : undefined;
    this.injectedApiKey = apiKey;
    this.injectedBaseUrl = baseUrl;
    this.fetchImpl = options.fetchFn ?? legacyFetch ?? fetch;
  }

  private config(): { apiKey: string; baseUrl: string } | null {
    if (this.injectedApiKey !== undefined || this.injectedBaseUrl !== undefined) {
      if (this.injectedApiKey === undefined || this.injectedBaseUrl === undefined) {
        return null;
      }
      return { apiKey: this.injectedApiKey, baseUrl: this.injectedBaseUrl };
    }
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
    const res = await this.fetchImpl(`${cfg.baseUrl}${path}`, {
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
    const res = await this.fetchImpl(`${cfg.baseUrl}${path}`, {
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
    // Asaas charge: value is decimal major units; format from minor units
    // without float arithmetic (BRL has 2 fraction digits — enforced above,
    // so the /100n formatting below is exact for every accepted input).
    requireBrlCurrency(input.currency, "pix charge");
    const billingType = resolveBillingType(input.billingType);
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
      billingType,
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
    // Some Asaas responses may include pixQrCode in creation; prefer fetching
    // via the dedicated endpoint per official flow to be robust.
    let qrCode: string | null = typeof json?.pixQrCode === "string" ? json.pixQrCode : null;
    try {
      const qr = await this.getPixQrCode(providerId);
      if (qr.payload && qr.payload.trim().length > 0) {
        qrCode = qr.payload;
      }
    } catch {
      // If retrieval fails, keep what we have from creation response if any
    }
    return {
      effect: "KNOWN_APPLIED",
      providerChargeId: providerId,
      qrCode,
      detail: `asaas: ${billingType.toLowerCase()} charge accepted`,
    };
  }

  async getPixQrCode(providerChargeId: string): Promise<PixQrCodeResult> {
    if (isSyntheticProviderReference(providerChargeId)) {
      return {
        payload: null,
        encodedImage: null,
        expirationDate: null,
      };
    }
    let response: { ok: boolean; status: number; json: unknown };
    try {
      response = await this.getJson(`/payments/${encodeURIComponent(providerChargeId)}/pixQrCode`);
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        return {
          payload: null,
          encodedImage: null,
          expirationDate: null,
        };
      }
      return {
        payload: null,
        encodedImage: null,
        expirationDate: null,
      };
    }
    if (!response.ok) {
      return {
        payload: null,
        encodedImage: null,
        expirationDate: null,
      };
    }
    const record = asRecordOrNull(response.json);
    const payload = typeof record?.["payload"] === "string" && record["payload"].trim().length > 0 ? record["payload"].trim() : null;
    const encodedImage = typeof record?.["encodedImage"] === "string" && record["encodedImage"].trim().length > 0 ? record["encodedImage"].trim() : null;
    const expirationDate = typeof record?.["expirationDate"] === "string" && record["expirationDate"].trim().length > 0 ? record["expirationDate"].trim() : null;
    return {
      payload,
      encodedImage,
      expirationDate,
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

  /**
   * Webhook provisioning HTTP (S2A). Uses the EXPLICIT per-tenant API key
   * (vault-resolved, `access_token` header) — never the process env key —
   * and the injected `fetchFn` (fake in tests).
   * SECURITY: the API key and the webhook token travel in headers/body
   * (required) but are NEVER logged, thrown inside messages, or attached to
   * telemetry; errors carry the status only.
   */
  private webhookHeaders(apiKey: string): Record<string, string> {
    return { "Content-Type": "application/json", access_token: apiKey };
  }

  private async webhookReadJson(
    url: string,
    apiKey: string,
    fetchImpl?: typeof fetch,
  ): Promise<{ ok: boolean; status: number; json: unknown }> {
    let res: Response;
    try {
      res = await (fetchImpl ?? this.fetchImpl)(url, {
        method: "GET",
        headers: this.webhookHeaders(apiKey),
        signal: AbortSignal.timeout(ASAAS_WEBHOOK_TIMEOUT_MS),
      });
    } catch {
      throw new AsaasWebhookError("TRANSPORT", "webhook list transport error (retry later)", "list");
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) {
      throw new AsaasWebhookError(res.status, `webhook list rejected with status ${res.status}`, "list");
    }
    return { ok: res.ok, status: res.status, json };
  }

  private async webhookWriteJson(
    url: string,
    method: "POST" | "PUT",
    apiKey: string,
    body: Record<string, unknown>,
    fetchImpl?: typeof fetch,
  ): Promise<{ ok: boolean; status: number; json: unknown }> {
    const step: AsaasWebhookStep = method === "PUT" ? "update" : "create";
    let res: Response;
    try {
      res = await (fetchImpl ?? this.fetchImpl)(url, {
        method,
        headers: this.webhookHeaders(apiKey),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ASAAS_WEBHOOK_TIMEOUT_MS),
      });
    } catch {
      throw new AsaasWebhookError("TRANSPORT", "webhook save transport error (retry later)", step);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) {
      throw new AsaasWebhookError(res.status, `webhook save rejected with status ${res.status}`, step);
    }
    return { ok: res.ok, status: res.status, json };
  }

  async listWebhooks(input: AsaasWebhookAuth): Promise<AsaasWebhookListResult> {
    const { json } = await this.webhookReadJson(
      `${input.host}/webhooks?limit=100`,
      input.apiKey,
      input.fetchFn,
    );
    const items = Array.isArray(json) ? json : asRecordOrNull(json)?.["data"];
    if (!Array.isArray(items)) {
      throw new AsaasWebhookError("MALFORMED", "webhook list response without a data array", "list");
    }
    const webhooks: AsaasWebhookRecord[] = [];
    for (const item of items) {
      const record = asRecordOrNull(item);
      const id = typeof record?.["id"] === "string" ? (record["id"] as string).trim() : "";
      const hookUrl = typeof record?.["url"] === "string" ? (record["url"] as string).trim() : "";
      if (id.length > 0 && hookUrl.length > 0) {
        webhooks.push({ id, url: hookUrl });
      }
    }
    return { webhooks };
  }

  async createWebhook(input: AsaasWebhookSaveInput): Promise<AsaasWebhookSaveResult> {
    const { json } = await this.webhookWriteJson(
      `${input.host}/webhooks`,
      "POST",
      input.apiKey,
      asaasWebhookSaveBody(input),
      input.fetchFn,
    );
    return { id: webhookSaveIdOf(json, "create") };
  }

  async updateWebhook(
    input: AsaasWebhookSaveInput & { providerWebhookId: string },
  ): Promise<AsaasWebhookSaveResult> {
    const { json } = await this.webhookWriteJson(
      `${input.host}/webhooks/${encodeURIComponent(input.providerWebhookId)}`,
      "PUT",
      input.apiKey,
      asaasWebhookSaveBody(input),
      input.fetchFn,
    );
    return { id: webhookSaveIdOf(json, "update") };
  }
}

/** Extract the provider webhook `id` from a save response (2xx without one = unknown effect). */
function webhookSaveIdOf(json: unknown, step: AsaasWebhookStep): string {
  const record = asRecordOrNull(json);
  const id = typeof record?.["id"] === "string" ? (record["id"] as string).trim() : "";
  if (id.length === 0) {
    throw new AsaasWebhookError("MALFORMED", "webhook save response without provider id", step);
  }
  return id;
}

export function asaasAdapterNameFromEnv(): "echo" | "real" {
  return process.env["ASAAS_ADAPTER"] === "real" ? "real" : "echo";
}

export function resolveAsaasPort(name: "echo" | "real"): AsaasPort {
  const inner: AsaasPort = name === "real" ? new RealAsaasAdapter() : new EchoAsaasAdapter();
  return tracedAsaasPort(inner);
}

// ---------------------------------------------------------------------------
// Tenant-scoped runtime (S2C, #86).
//
// `resolveAsaasPortForTenant` replaces the process-global
// `ASAAS_API_KEY`/`ASAAS_BASE_URL` with the tenant's own vaulted credential:
//
//  1. look up `provider.providers` for `provider_key = 'asaas'` (missing → legacy);
//  2. look up the tenant's NEWEST non-DISABLED `provider.provider_accounts`
//     row for that provider + its environment, restricted to
//     `connection_status = 'CONNECTED_READ_ONLY'` (probe-passed only).
//     DRAFT / TESTING / REAUTH_REQUIRED / DEGRADED / NOT_CONFIGURED rows are
//     NOT eligible — they fall back to the legacy env adapter (compat), never
//     to a half-provisioned key. DISABLED rows are never eligible.
//  3. `getSecret(secret_ref)` from the vault (injected in tests, live via
//     `resolveSecretsPort()` in production); vault down / secret missing with
//     a live binding present throws fail-closed — NEVER a silent echo
//     fallback (echo happens ONLY when the legacy path was already echo).
//  4. base URL comes from the fixed per-environment allowlist below — never
//     from the client, the DB row, or the secret.
//
// Resolution matrix:
//
// | binding (non-DISABLED) | vault            | result                              |
// |------------------------|------------------|-------------------------------------|
// | none                   | n/a              | legacy env adapter (compat)         |
// | CONNECTED_READ_ONLY    | key resolves     | tenant RealAsaasAdapter (dedicated) |
// | CONNECTED_READ_ONLY    | down/missing     | throw fail-closed (no echo)         |
// | DRAFT/TESTING/other    | n/a              | legacy env adapter (compat)         |
// | DISABLED               | n/a              | legacy env adapter (compat)         |
// | unknown environment    | n/a              | throw fail-closed (no silent host)  |
//
// SECURITY: the vault value travels only into the adapter's `access_token`
// header (required). It is NEVER logged, thrown inside messages, or attached
// to telemetry — errors name the environment only, never the ref/key/value.
// ---------------------------------------------------------------------------

/**
 * Fixed Asaas hosts per environment. MIRROR of
 * `apps/api/src/integrations/integrations.commands.ts` (`ASAAS_HOSTS`) —
 * kept local so `billing/` never imports the integrations write context
 * (and vice-versa: that file owns the write path). The two copies MUST stay
 * identical; the contracts gate (`test_contracts.py`) pins the values.
 */
export const ASAAS_TENANT_HOSTS = {
  SANDBOX: "https://api-sandbox.asaas.com/v3",
  PRODUCTION: "https://api.asaas.com/v3",
} as const;

/** Only probe-passed bindings own a usable tenant credential. */
const TENANT_ELIGIBLE_CONNECTION_STATUS = "CONNECTED_READ_ONLY" as const;

export interface TenantAsaasResolution {
  port: AsaasPort;
  /** `tenant` = dedicated vaulted key; `legacy` = env compat path. */
  source: "tenant" | "legacy";
  /** Environment of the winning binding (`null` on the legacy path). */
  environment: string | null;
}

export interface ResolveTenantAsaasOptions {
  secretsPort?: SecretsPort;
  fetchFn?: typeof fetch;
}

function tenantHostFor(environment: string): string {
  if (environment === "SANDBOX") {
    return ASAAS_TENANT_HOSTS.SANDBOX;
  }
  if (environment === "PRODUCTION") {
    return ASAAS_TENANT_HOSTS.PRODUCTION;
  }
  throw new Error(
    `asaas tenant binding has unknown environment ${JSON.stringify(environment)} (expected SANDBOX or PRODUCTION); refusing to guess a host`,
  );
}

/**
 * Resolve the Asaas port for one tenant. Prefers the tenant's vaulted key;
 * falls back to the legacy env adapter ONLY when no eligible binding exists.
 * Throws fail-closed when a live binding exists but its credential/host
 * cannot be resolved (vault down, secret missing, unknown environment).
 */
export async function resolveAsaasPortForTenant(
  trx: Transaction<Database>,
  tenantId: string,
  options: ResolveTenantAsaasOptions = {},
): Promise<AsaasPort> {
  return (await resolveTenantAsaas(trx, tenantId, options)).port;
}

export async function resolveTenantAsaas(
  trx: Transaction<Database>,
  tenantId: string,
  options: ResolveTenantAsaasOptions = {},
): Promise<TenantAsaasResolution> {
  const providerRow = await trx
    .selectFrom("provider.providers")
    .select(["id"])
    .where("provider_key", "=", "asaas")
    .executeTakeFirst();
  if (providerRow === undefined) {
    return { port: resolveAsaasPort(asaasAdapterNameFromEnv()), source: "legacy", environment: null };
  }
  const binding = await trx
    .selectFrom("provider.provider_accounts")
    .select(["secret_ref", "environment", "connection_status"])
    .where("tenant_id", "=", tenantId)
    .where("provider_id", "=", providerRow.id)
    .where("connection_status", "=", TENANT_ELIGIBLE_CONNECTION_STATUS)
    .orderBy("updated_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (binding === undefined) {
    return { port: resolveAsaasPort(asaasAdapterNameFromEnv()), source: "legacy", environment: null };
  }
  const environment = String(binding.environment);
  const host = tenantHostFor(environment);
  const secrets = options.secretsPort ?? resolveSecretsPort();
  // Fail-closed: a live binding with an unreadable credential must NEVER
  // degrade into a silent echo/global-key fallback. The vault error is
  // sanitized by the secrets port (never the value); wrap without the ref.
  let apiKey: string;
  try {
    apiKey = await secrets.getSecret(binding.secret_ref);
  } catch {
    throw new Error(
      `asaas tenant credential unavailable in environment ${JSON.stringify(environment)} (binding present, vault read failed; retry later)`,
    );
  }
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error(
      `asaas tenant credential unavailable in environment ${JSON.stringify(environment)} (vault returned an empty value; retry later)`,
    );
  }
  const inner = new RealAsaasAdapter({ apiKey, baseUrl: host, fetchFn: options.fetchFn });
  return { port: tracedAsaasPort(inner), source: "tenant", environment };
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
    getPixQrCode: inner.getPixQrCode
      ? (providerChargeId) =>
          withSpan("asaas.get_pix_qrcode", { adapter: inner.name, operation: "get_pix_qrcode" }, () =>
            inner.getPixQrCode!(providerChargeId),
          )
      : undefined,
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
    listWebhooks: inner.listWebhooks
      ? (input) =>
          withSpan("asaas.list_webhooks", { adapter: inner.name, operation: "list_webhooks" }, () =>
            inner.listWebhooks!(input),
          )
      : undefined,
    createWebhook: inner.createWebhook
      ? (input) =>
          withSpan("asaas.create_webhook", { adapter: inner.name, operation: "create_webhook" }, () =>
            inner.createWebhook!(input),
          )
      : undefined,
    updateWebhook: inner.updateWebhook
      ? (input) =>
          withSpan("asaas.update_webhook", { adapter: inner.name, operation: "update_webhook" }, () =>
            inner.updateWebhook!(input),
          )
      : undefined,
  };
}
