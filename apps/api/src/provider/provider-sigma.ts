/**
 * Sigma Reseller adapter (CINEVISION M2M).
 *
 * Minimal HTTP adapter reusing ProviderOpsPort/dispatcher/fulfillment.
 * Fixed base URL per official OpenAPI; Bearer token resolved per call via
 * injected resolver (Postgres encrypted secret CINEVISION_RESELLER_API_TOKEN
 * via deriveIntegrationSecretRef at the caller — never logged, persisted or
 * emitted). No new microservice/queue/DB/auth/vault/dispatcher.
 *
 * Writes confirm with GET before SUCCEEDED. Create requires matching id,
 * server_id, package_id and ACTIVE status; renew captures expires_at before
 * the POST and requires a strictly later expires_at afterwards. Timeout/5xx/429 -> UNKNOWN
 * (never FAILED, never auto-resend); 429 detail carries Retry-After seconds
 * without replaying the mutation. The SigmaReseller token never reaches
 * detail/externalRef. A confirm-GET failure after a created/renewed effect
 * returns UNKNOWN with externalRef set so reconciliation can re-read by id.
 * The readback resolves the same postconditions with GET only — never POST —
 * and stays inconclusive without complete evidence.
 *
 * Modes: live = SIGMA_MODE=live + configured SecretsPort -> SigmaHttpAdapter.
 * Anything else -> SigmaUnconfiguredAdapter (MANUAL, never a simulated
 * SUCCEEDED). Simulated outcomes (SigmaSimulatedAdapter) are injected
 * directly by tests only — never selected via env in production.
 */
import { deriveIntegrationSecretRef, isSecretsConfigured, type SecretsPort } from "@iptv/secrets";
import { withTenantTransaction, type Database } from "@iptv/database";
import type { Kysely, Transaction } from "kysely";
import { tryCreatePostgresSecretsAdapter } from "../integrations/postgres-secrets.js";
import type { AdapterResult, ProviderOperationRequest, ProviderOpsPort, ProviderReadbackPort, ReadbackQuery, ReadbackResult } from "./provider-port.js";

export const SIGMA_BASE_URL = "https://cinevision.panelbr.site/api/reseller-api/v1" as const;
export const SIGMA_RESELLER_TOKEN_KEY = "CINEVISION_RESELLER_API_TOKEN" as const;

type FetchLike = typeof fetch;
export type SigmaTokenResolver = (secretRef: string) => Promise<string>;

/** Resolver that derives the reseller-token ref from the principal binding ref. */
export function defaultSigmaTokenResolver(secretsPort: SecretsPort): SigmaTokenResolver {
  return async (secretRef: string) => {
    const tokenRef = deriveIntegrationSecretRef(secretRef, SIGMA_RESELLER_TOKEN_KEY);
    return secretsPort.getSecret(tokenRef);
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function idOf(value: unknown): string | null {
  const root = record(value);
  const item = record(root["data"] ?? root);
  const id = item["id"] ?? item["customer_id"] ?? root["id"] ?? root["customer_id"];
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

export interface SigmaCustomer {
  id: string | null;
  server_id: string | null;
  package_id: string | null;
  status: string | null;
  expires_at: string | null;
  username: string | null;
}

function stringField(item: Record<string, unknown>, key: string): string | null {
  const value = item[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

export function getCustomerParsed(body: unknown): SigmaCustomer {
  const root = record(body);
  const item = record(root["data"] ?? root);
  return {
    id: idOf(item), server_id: stringField(item, "server_id"), package_id: stringField(item, "package_id"),
    status: stringField(item, "status"), expires_at: stringField(item, "expires_at"), username: stringField(item, "username"),
  };
}

function validDate(value: string | null): number | null {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function errorFromBody(body: unknown): string | null {
  const err = record(body)["error"];
  return typeof err === "string" ? err : null;
}

function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  const secs = raw === null ? NaN : Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? Math.floor(secs) : null;
}

export class SigmaHttpAdapter implements ProviderOpsPort {
  readonly name = "sigma";
  readonly requiresSecretRef = true;
  private readonly fetcher: FetchLike;

  constructor(
    private readonly resolveToken: SigmaTokenResolver,
    fetcher: FetchLike = fetch,
  ) {
    this.fetcher = fetcher;
  }

  private async request(path: string, token: string, init: RequestInit = {}): Promise<Response> {
    return this.fetcher(`${SIGMA_BASE_URL}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(20_000),
    });
  }

  async getMe(token: string): Promise<unknown> {
    const res = await this.request("/me", token);
    return res.json() as Promise<unknown>;
  }
  async listPackages(token: string): Promise<unknown> {
    const res = await this.request("/packages", token);
    return res.json() as Promise<unknown>;
  }
  async listServers(token: string): Promise<unknown> {
    const res = await this.request("/servers", token);
    return res.json() as Promise<unknown>;
  }
  async listCustomers(token: string, query = ""): Promise<unknown> {
    const res = await this.request(`/customers${query}`, token);
    return res.json() as Promise<unknown>;
  }
  async getCustomer(token: string, customerId: string): Promise<unknown> {
    const res = await this.request(`/customers/${encodeURIComponent(customerId)}`, token);
    return res.json() as Promise<unknown>;
  }
  async findByUsername(token: string, username: string): Promise<unknown> {
    const res = await this.request(`/customers/by-username/${encodeURIComponent(username)}`, token);
    return res.json() as Promise<unknown>;
  }

  async requestOperation(input: ProviderOperationRequest): Promise<AdapterResult> {
    if (!input.secretRef) return { outcome: "MANUAL", detail: "sigma: credential unavailable", externalRef: null };
    let token: string;
    try {
      token = await this.resolveToken(input.secretRef);
    } catch {
      return { outcome: "MANUAL", detail: "sigma: credential unavailable", externalRef: null };
    }
    let customerId: string | null = null;
    let expiresBefore: string | null = null;
    try {
      customerId =
        typeof input.payload["sigma_customer_id"] === "string" && (input.payload["sigma_customer_id"] as string).trim().length > 0
          ? (input.payload["sigma_customer_id"] as string)
          : null;
      const isRenew =
        input.action === "subscription.renew" ||
        (input.action === "subscription.provision" && customerId !== null);
      const isCreate = input.action === "subscription.provision" && customerId === null;
      if (!isCreate && !isRenew) {
        return { outcome: "MANUAL", detail: "sigma: unsupported operation", externalRef: null };
      }
      // Strict create guard: never guess server/package from internal ids.
      if (isCreate) {
        const sid = input.payload["server_id"];
        const pid = input.payload["package_id"];
        if (typeof sid !== "string" || sid.trim().length === 0 || typeof pid !== "string" || pid.trim().length === 0) {
          return { outcome: "FAILED", detail: "sigma: server_id and package_id are required", externalRef: null };
        }
      }
      let response: Response;
      // OpenAPI: POST /customers/{id}/renew declares no requestBody.
      if (isRenew && customerId !== null) {
        const before = await this.request(`/customers/${encodeURIComponent(customerId)}`, token);
        if (!before.ok) return { outcome: "UNKNOWN", detail: "sigma: pre-renew readback inconclusive", externalRef: customerId };
        const previous = getCustomerParsed(await before.json());
        if (previous.id !== customerId || previous.expires_at === null) return { outcome: "UNKNOWN", detail: "sigma: pre-renew state inconclusive", externalRef: customerId };
        expiresBefore = previous.expires_at;
        response = await this.request(`/customers/${encodeURIComponent(customerId)}/renew`, token, { method: "POST" });
      } else if (isRenew && customerId === null) {
        return { outcome: "MANUAL", detail: "sigma: renewal requires sigma_customer_id", externalRef: null };
      } else {
        const body: Record<string, unknown> = {
          server_id: input.payload["server_id"],
          package_id: input.payload["package_id"],
        };
        // Username: reuse payload if present; deterministic fallback keeps
        // 409→by-username reconciliation reachable even when callers omit it.
        const username = input.payload["username"];
        if (typeof username === "string" && username.trim().length > 0) {
          body["username"] = username.trim();
        } else {
          // Full entityId: the UUIDv7 prefix alone (slice 0,8) collides for
          // subscriptions created in the same timestamp window (see AGENTS.md).
          body["username"] = `sm-${input.entityId}`;
        }
        for (const key of ["name", "email", "telegram", "whatsapp", "note", "connections"]) {
          if (input.payload[key] !== undefined) body[key] = input.payload[key];
        }
        response = await this.request("/customers", token, { method: "POST", body: JSON.stringify(body) });
      }
      if (response.status === 429) {
        const retryAfter = retryAfterSeconds(response);
        return {
          outcome: "UNKNOWN",
          detail: `sigma: throttled; verify before retry${retryAfter !== null ? ` (retry-after ${retryAfter}s)` : ""}`,
          externalRef: isRenew && customerId !== null ? customerId : null,
          ...(isRenew && expiresBefore !== null ? { expiresBefore } : {}),
        };
      }
      if (response.status === 401) return { outcome: "MANUAL", detail: "sigma: unauthorized; token must be rotated", externalRef: null };
      if (response.status === 402) {
        const err = errorFromBody(await response.json().catch(() => null));
        return { outcome: "MANUAL", detail: `sigma: integration credits required${err ? ` (${err})` : ""}`, externalRef: null };
      }
      if (response.status === 403) {
        const err = errorFromBody(await response.json().catch(() => null));
        return { outcome: "MANUAL", detail: `sigma: permission required${err ? ` (${err})` : ""}`, externalRef: null };
      }
      if (response.status === 409) {
        // Conflict path requires a username; verify ownership shape before
        // binding to avoid attaching a foreign customer.
        const username =
          typeof input.payload["username"] === "string" && (input.payload["username"] as string).trim().length > 0
            ? (input.payload["username"] as string).trim()
            : typeof input.payload["server_id"] === "undefined"
              ? null
              : `sm-${input.entityId}`;
        if (username === null || username.length < 3) {
          return { outcome: "MANUAL", detail: "sigma: conflict requires operator", externalRef: null };
        }
        const lookup = await this.request(`/customers/by-username/${encodeURIComponent(username)}`, token);
        if (!lookup.ok) return { outcome: "MANUAL", detail: "sigma: conflict could not be verified", externalRef: null };
        const foundBody = record(await lookup.json());
        const found = idOf(foundBody);
        if (found === null) return { outcome: "MANUAL", detail: "sigma: conflict requires operator", externalRef: null };
        const foundCustomer = record(record(foundBody)["data"] ?? foundBody);
        // Bind only when server/package match exactly (missing = MANUAL).
        const wantServer = typeof input.payload["server_id"] === "string" ? (input.payload["server_id"] as string) : null;
        const wantPackage = typeof input.payload["package_id"] === "string" ? (input.payload["package_id"] as string) : null;
        const gotServer = typeof foundCustomer["server_id"] === "string" ? (foundCustomer["server_id"] as string) : null;
        const gotPackage = typeof foundCustomer["package_id"] === "string" ? (foundCustomer["package_id"] as string) : null;
        const shapeMatch =
          (wantServer === null || wantServer === gotServer) &&
          (wantPackage === null || wantPackage === gotPackage) &&
          (wantServer === null || gotServer !== null) &&
          (wantPackage === null || gotPackage !== null);
        if (!shapeMatch) {
          return { outcome: "MANUAL", detail: "sigma: conflicting customer belongs to another plan", externalRef: null };
        }
        return { outcome: "SUCCEEDED", detail: "sigma: existing customer verified", externalRef: found };
      }
      if (response.status === 422) return { outcome: "FAILED", detail: "sigma: validation failed", externalRef: null };
      if (response.status === 404) return { outcome: "FAILED", detail: "sigma: customer not found", externalRef: null };
      if (response.status >= 500) return { outcome: "UNKNOWN", detail: "sigma: response uncertain; verify before retry", externalRef: isRenew && customerId !== null ? customerId : null, ...(isRenew && expiresBefore !== null ? { expiresBefore } : {}) };
      if (!response.ok) return { outcome: "FAILED", detail: "sigma: request rejected", externalRef: null };
      const result = record(await response.json());
      const returnedId = idOf(result["data"] ?? result);
      const id = customerId ?? returnedId;
      if (id === null) return { outcome: "UNKNOWN", detail: "sigma: customer id unavailable for verification", externalRef: null };
      const verify = await this.request(`/customers/${encodeURIComponent(id)}`, token);
      if (!verify.ok) {
        // Keep the returned id on the uncertain result so reconciliation can
        // re-read it by id instead of creating a duplicate client.
        return { outcome: "UNKNOWN", detail: "sigma: readback inconclusive; verify by id", externalRef: id };
      }
      const customer = getCustomerParsed(await verify.json());
      const expectedServer = typeof input.payload["server_id"] === "string" ? input.payload["server_id"] : null;
      const expectedPackage = typeof input.payload["package_id"] === "string" ? input.payload["package_id"] : null;
      const valid = customer.id === id && (!isCreate || (customer.status === "ACTIVE" && customer.server_id === expectedServer && customer.package_id === expectedPackage));
      if (!valid) return { outcome: "UNKNOWN", detail: "sigma: customer postcondition not proven", externalRef: id, ...(expiresBefore !== null ? { expiresBefore } : {}) };
      if (isRenew && (validDate(expiresBefore) === null || validDate(customer.expires_at) === null || validDate(customer.expires_at)! <= validDate(expiresBefore)!)) {
        return { outcome: "UNKNOWN", detail: "sigma: renewal postcondition not proven", externalRef: id, expiresBefore };
      }
      return { outcome: "SUCCEEDED", detail: "sigma: customer verified", externalRef: id, ...(expiresBefore !== null ? { expiresBefore } : {}) };
    } catch {
      return { outcome: "UNKNOWN", detail: "sigma: response uncertain; verify before retry", externalRef: customerId, ...(expiresBefore !== null ? { expiresBefore } : {}) };
    }
  }
}

/** Readback for uncertain ops: GET only, never re-executes. */
export class SigmaReadback implements ProviderReadbackPort {
  constructor(
    private readonly _resolveToken: SigmaTokenResolver,
    private readonly _fetcher: FetchLike = fetch,
  ) {}
  async verify(query: ReadbackQuery): Promise<ReadbackResult> {
    if (!query.secretRef) return { effectApplied: false, evidence: `sigma:INCONCLUSIVE:${query.operationId}`, conclusive: false };
    try {
      const token = await this._resolveToken(query.secretRef);
      const payload = query.payload ?? {};
      const fallbackUsername = `sm-${query.entityId ?? query.operationId}`;
      const externalId = query.externalRef ?? (typeof payload["username"] === "string" ? payload["username"] : null) ?? fallbackUsername;
      const path = query.externalRef !== null ? `/customers/${encodeURIComponent(externalId)}` : `/customers/by-username/${encodeURIComponent(externalId)}`;
      const response = await this._fetcher(`${SIGMA_BASE_URL}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return { effectApplied: false, evidence: `sigma:INCONCLUSIVE:${query.operationId}`, conclusive: false };
      const customer = getCustomerParsed(await response.json());
      const hasServer = typeof payload["server_id"] === "string";
      const hasPackage = typeof payload["package_id"] === "string";
      if (customer.id === null) return { effectApplied: false, evidence: `sigma:INCONCLUSIVE:${query.operationId}`, conclusive: false };
      if ((hasServer || hasPackage) && (customer.server_id !== payload["server_id"] || customer.package_id !== payload["package_id"])) {
        return { effectApplied: false, evidence: `sigma:INCONCLUSIVE:${query.operationId}`, conclusive: false };
      }
      if (query.action === "subscription.provision" && query.externalRef === null && customer.status !== "ACTIVE") {
        return { effectApplied: false, evidence: `sigma:INCONCLUSIVE:${query.operationId}`, conclusive: false };
      }
      // Fulfillment persists a renew as `subscription.provision` +
      // `sigma_customer_id`, so renew proof (strictly later expires_at)
      // applies to both the explicit renew action and that shape. Without
      // a valid expiresBefore the GET only proves existence — never an
      // extension — and stays inconclusive (converges HUMAN_REQUIRED).
      const isRenewShape =
        query.action === "subscription.renew" ||
        (typeof payload["sigma_customer_id"] === "string" && (payload["sigma_customer_id"] as string).trim().length > 0);
      if (isRenewShape || query.expiresBefore !== null) {
        const before = validDate(query.expiresBefore ?? null), after = validDate(customer.expires_at);
        if (before === null || after === null || after <= before) return { effectApplied: false, evidence: `sigma:INCONCLUSIVE:${query.operationId}`, conclusive: false };
      }
      return { effectApplied: true, evidence: `sigma:APPLIED:${query.operationId}`, conclusive: true, externalRef: customer.id };
    } catch {
      return { effectApplied: false, evidence: `sigma:INCONCLUSIVE:${query.operationId}`, conclusive: false };
    }
  }
}

export type SigmaSimulatedBehavior = "success" | "exists" | "credits" | "permission" | "unavailable" | "timeout" | "auth";

/**
 * Offline sigma stub: deterministic outcomes without network or token.
 * Real 9-scenario ledger/idempotency/readback coverage lives in
 * CinevisionSimulatedWritePort (reuse, not a second mock system).
 */
export class SigmaSimulatedAdapter implements ProviderOpsPort {
  readonly name = "sigma";
  readonly requiresSecretRef = true;
  constructor(private behavior: SigmaSimulatedBehavior = "success") {}
  setBehavior(value: SigmaSimulatedBehavior): void {
    this.behavior = value;
  }
  async requestOperation(input: ProviderOperationRequest): Promise<AdapterResult> {
    if (this.behavior === "credits") return { outcome: "FAILED", detail: "sigma simulated: insufficient credits", externalRef: null };
    if (this.behavior === "permission" || this.behavior === "auth") {
      return { outcome: "MANUAL", detail: "sigma simulated: permission required", externalRef: null };
    }
    if (this.behavior === "unavailable" || this.behavior === "timeout") {
      return { outcome: "UNKNOWN", detail: "sigma simulated: verify before retry", externalRef: null };
    }
    return {
      outcome: "SUCCEEDED",
      detail: "sigma simulated: customer verified",
      externalRef: this.behavior === "exists" ? "sigma-existing" : `sigma-${input.entityId}`,
    };
  }
}

/**
 * Unconfigured sigma port: fail-closed without live credentials.
 * Preferred over any simulated SUCCEEDED so production can never activate
 * a subscription without a real Sigma call. Simulated behavior is available
 * to tests by direct injection only.
 */
export class SigmaUnconfiguredAdapter implements ProviderOpsPort {
  readonly name = "sigma";
  readonly requiresSecretRef = true;
  async requestOperation(): Promise<AdapterResult> {
    return { outcome: "MANUAL", detail: "sigma: not configured (live requires SIGMA_MODE=live + token)", externalRef: null };
  }
}

export function resolveSigmaPortFromEnv(secretsPort?: SecretsPort | null, fetchFn?: FetchLike): ProviderOpsPort {
  const live = process.env["SIGMA_MODE"] === "live";
  if (!live || secretsPort == null || secretsPort.name.toLowerCase() === "noop") {
    return new SigmaUnconfiguredAdapter();
  }
  return new SigmaHttpAdapter(defaultSigmaTokenResolver(secretsPort), fetchFn ?? (globalThis.fetch as FetchLike));
}

/**
 * Tenant-scoped factory: resolves the Sigma token through the shared
 * Postgres-encrypted vault, isolated by tenant. No new vault, no token
 * storage outside the existing mechanism.
 */
export function createTenantSigmaPorts(): {
  secretsPort: (tenantId: string, executor?: Kysely<Database> | Transaction<Database>) => SecretsPort | null;
  readback: (tenantId: string, executor?: Kysely<Database> | Transaction<Database>, fetchFn?: FetchLike) => ProviderReadbackPort | null;
} {
  return {
    secretsPort: (tenantId, executor) => {
      if (!isSecretsConfigured()) {
        return null;
      }
      if (executor !== undefined) {
        return tryCreatePostgresSecretsAdapter(executor, tenantId);
      }
      return null;
    },
    readback: (tenantId, executor, fetchFn) => {
      const port = createTenantScopedSecretsPort(executor, tenantId);
      if (port === null) return null;
      return new SigmaReadback(defaultSigmaTokenResolver(port), fetchFn ?? (globalThis.fetch as FetchLike));
    },
  };
}

function createTenantScopedSecretsPort(
  executor: Kysely<Database> | Transaction<Database> | undefined,
  tenantId: string,
): SecretsPort | null {
  if (!isSecretsConfigured() || executor === undefined) {
    return null;
  }
  return tryCreatePostgresSecretsAdapter(executor, tenantId);
}

/** Resolves the Sigma ops port for one tenant through the shared encrypted vault. No token storage outside the existing mechanism. */
export function resolveTenantSigmaPortFromEnv(input: {
  tenantId: string;
  db?: Kysely<Database> | null;
  trx?: Transaction<Database> | null;
  overrideSecretsPort?: SecretsPort | null;
  fetchFn?: FetchLike;
}): ProviderOpsPort {
  const secretsPort = input.overrideSecretsPort ?? (
    input.trx != null
      ? createTenantScopedSecretsPort(input.trx, input.tenantId)
      : input.db != null
        ? createDbBackedSecretPort(input.db, input.tenantId)
        : null
  );
  return resolveSigmaPortFromEnv(secretsPort, input.fetchFn);
}

function createDbBackedSecretPort(db: Kysely<Database>, tenantId: string): SecretsPort | null {
  if (!isSecretsConfigured()) {
    return null;
  }
  return {
    name: "postgres",
    getSecret: async (ref: string) => {
      const port = createTenantScopedSecretsPort(db, tenantId);
      if (port === null) throw new Error("sigma secret store unavailable");
      // The store itself enforces tenant isolation; wrapping in the tenant
      // transaction also satisfies the RLS `tenant_isolation` policy on
      // `platform.secret_values` for the `iptv_app` connection.
      return withTenantTransaction(db, tenantId, async (trx) => {
        const tenantPort = tryCreatePostgresSecretsAdapter(trx, tenantId);
        if (tenantPort === null) throw new Error("sigma secret store unavailable");
        return tenantPort.getSecret(ref);
      });
    },
  };
}

/** Resolves the Sigma readback for one tenant through the shared encrypted vault; live only with SIGMA_MODE=live + configured vault, else the fail-closed stub. */
export function resolveTenantSigmaReadbackFromEnv(input: {
  tenantId: string;
  db?: Kysely<Database> | null;
  trx?: Transaction<Database> | null;
  overrideSecretsPort?: SecretsPort | null;
  fetchFn?: FetchLike;
}): ProviderReadbackPort {
  const live = process.env["SIGMA_MODE"] === "live";
  const secretsPort = input.overrideSecretsPort ?? (
    input.trx != null
      ? createTenantScopedSecretsPort(input.trx, input.tenantId)
      : input.db != null
        ? createDbBackedSecretPort(input.db, input.tenantId)
        : null
  );
  if (!live || secretsPort == null || secretsPort.name.toLowerCase() === "noop") {
    return {
      verify: async (query: ReadbackQuery) => ({
        effectApplied: false,
        evidence: `sigma:INCONCLUSIVE:${query.operationId}`,
        conclusive: false,
      }),
    };
  }
  return new SigmaReadback(defaultSigmaTokenResolver(secretsPort), input.fetchFn ?? (globalThis.fetch as FetchLike));
}
