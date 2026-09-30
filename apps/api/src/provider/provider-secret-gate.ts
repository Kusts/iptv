/**
 * PF-05 secret-ref gate (fail-closed, no secret values).
 *
 * - Echo/manual ports never require a secret: synthetic dev flows keep
 *   working with the `wave4://no-real-credential` placeholder and without
 *   any SecretsPort configured.
 * - Any future real adapter (a port with `requiresSecretRef === true`, or
 *   a port named `browser` as defense-in-depth) must pass this gate BEFORE
 *   the provider operation reaches REQUESTED and BEFORE any external port
 *   is called:
 *   1. load `provider.provider_accounts.secret_ref` tenant-scoped,
 *   2. reject missing / `wave4://…` placeholder / malformed refs via
 *      `parseSecretRef` (canonical grammar in `@iptv/secrets`),
 *   3. require a configured SecretsPort (anything but Noop).
 *
 * The gate NEVER calls `getSecret` and NEVER returns a secret value — on
 * success it returns the validated `secret_ref` STRING so the caller can
 * forward it (and only it) to the port frontier. Persisted
 * `requested_payload_json`, events, audit details and HTTP responses must
 * never carry the ref or a value; the future worker resolves credentials
 * via `providerAccountId` (+ the in-memory `secretRef` string when the
 * port field is necessary).
 *
 * All failure messages are generic on purpose: they never echo the ref,
 * key, path, environment or value.
 */
import { parseSecretRef } from "@iptv/secrets";
import type { CommandHandlerContext } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";
import { trialMemoryOf } from "../trial/trial-store.js";

export const SECRET_REF_PLACEHOLDER_PREFIX = "wave4://";

export interface SecretRequiringPort {
  readonly name: string;
  readonly requiresSecretRef?: boolean;
}

export interface ConfiguredSecretsPort {
  readonly name: string;
}

/**
 * True for future real adapters only. Echo/manual never set
 * `requiresSecretRef`; the case-insensitive `browser` name check is
 * defense-in-depth so a future port cannot slip past the gate by
 * forgetting the flag. No new public adapter alias is introduced here —
 * the zod inputs stay `echo | manual` until a real BROWSER is certified.
 */
export function isSecretRequiringPort(port: SecretRequiringPort | undefined): boolean {
  if (port === undefined) {
    return false;
  }
  if (port.requiresSecretRef === true) {
    return true;
  }
  return port.name.toLowerCase() === "browser";
}

/** A SecretsPort is "configured" when present and not the Noop default. */
export function isSecretsPortConfigured(port: ConfiguredSecretsPort | null | undefined): boolean {
  if (port === null || port === undefined) {
    return false;
  }
  const name = port.name.trim().toLowerCase();
  return name !== "" && name !== "noop";
}

export type SecretRefValidationReason = "missing" | "placeholder" | "malformed";

/**
 * Validate the FORMAT of a `secret_ref` string. Returns the original string
 * on success (never a value). Rejects:
 * - missing/blank,
 * - the Wave-4 `wave4://…` placeholder (never a live credential),
 * - anything `parseSecretRef` rejects.
 */
export function validateSecretRefFormat(
  ref: unknown,
): { ok: true; secretRef: string } | { ok: false; reason: SecretRefValidationReason } {
  if (typeof ref !== "string" || ref.trim().length === 0) {
    return { ok: false, reason: "missing" };
  }
  if (ref.startsWith(SECRET_REF_PLACEHOLDER_PREFIX)) {
    return { ok: false, reason: "placeholder" };
  }
  try {
    parseSecretRef(ref);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, secretRef: ref };
}

/**
 * Tenant-scoped `secret_ref` loader. Kysely path reads
 * `provider.provider_accounts.secret_ref`; memory path reads the unit-test
 * state (absent entry → null, never a throw). Returns null when the account
 * is missing in this tenant.
 */
export async function getProviderAccountSecretRef(
  ctx: CommandHandlerContext,
  providerAccountId: string,
): Promise<string | null> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const row = await trx
      .selectFrom("provider.provider_accounts")
      .select(["secret_ref"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", providerAccountId)
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    const ref = (row as { secret_ref: unknown }).secret_ref;
    return typeof ref === "string" ? ref : null;
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  const account = mem.providerAccounts.get(providerAccountId);
  if (account === undefined || account.tenantId !== ctx.tenantId) {
    return null;
  }
  const ref = (account as { secretRef?: unknown }).secretRef;
  return typeof ref === "string" ? ref : null;
}

export type BrowserGateFailureReason = SecretRefValidationReason | "secrets_port_unconfigured";

/**
 * Full fail-closed gate for secret-requiring (future BROWSER) operations.
 * Pure coordination: validates the ref format and verifies a SecretsPort is
 * configured. NEVER calls `getSecret`, NEVER resolves a value.
 */
export function assertBrowserSecretReady(input: {
  secretRef: unknown;
  secretsPort: ConfiguredSecretsPort | null | undefined;
}): { ok: true; secretRef: string } | { ok: false; reason: BrowserGateFailureReason; message: string } {
  const checked = validateSecretRefFormat(input.secretRef);
  if (!checked.ok) {
    if (checked.reason === "missing") {
      return {
        ok: false,
        reason: "missing",
        message: "browser operations require a configured provider secret (secret_ref is missing)",
      };
    }
    if (checked.reason === "placeholder") {
      return {
        ok: false,
        reason: "placeholder",
        message: "browser operations require a configured provider secret (placeholder ref cannot run browser work)",
      };
    }
    return {
      ok: false,
      reason: "malformed",
      message: "browser operations require a configured provider secret (secret_ref is malformed)",
    };
  }
  if (!isSecretsPortConfigured(input.secretsPort)) {
    return {
      ok: false,
      reason: "secrets_port_unconfigured",
      message: "browser operations require a configured secrets port",
    };
  }
  return { ok: true, secretRef: checked.secretRef };
}

/**
 * Keys that must never be persisted into `requested_payload_json` from a
 * caller-supplied payload. Defense-in-depth so a future caller cannot
 * smuggle a credential into the operation row even if the gate passed.
 * Kept for the echo/manual path; the secret-required path uses the
 * restrictive allowlist projection below (`validateSecretRequestShape`).
 */
const FORBIDDEN_PERSISTED_PAYLOAD_KEYS = new Set(["secret_ref", "secretref", "secret", "secretvalue"]);

export function stripSecretKeysFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_PERSISTED_PAYLOAD_KEYS.has(key.toLowerCase())) {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

/**
 * Secret-required frontier contract (PF-05 SEC-REVIEW fixes).
 *
 * Only the semantic operations the codebase actually implements may run
 * behind a secret-requiring port. No aliases are invented here:
 * - `trial.provision` (entity_type `trial`) — see `trial.begin_provisioning`.
 * - `subscription.provision` (entity_type `subscription`) — see fulfillment.
 */
export const SECRET_REQUIRED_ALLOWED_ACTIONS = ["trial.provision", "subscription.provision"] as const;
export type SecretRequiredAction = (typeof SECRET_REQUIRED_ALLOWED_ACTIONS)[number];

const SECRET_REQUIRED_ENTITY: Record<SecretRequiredAction, string> = {
  "trial.provision": "trial",
  "subscription.provision": "subscription",
};

/** Normalized suspicious key fragments (casing/separator-insensitive). */
const SUSPICIOUS_KEY_TOKENS = [
  "secret",
  "token",
  "credential",
  "password",
  "passwd",
  "apikey",
  "privatekey",
  "clientsecret",
  "infisical",
  "wave4",
  "bearer",
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSuspiciousKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (normalized.length === 0) {
    return true;
  }
  return SUSPICIOUS_KEY_TOKENS.some((token) => normalized.includes(token));
}

function containsRefValue(value: string): boolean {
  const lowered = value.toLowerCase();
  return lowered.includes("infisical://") || lowered.includes("wave4://");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deep scan for smuggled secret material. Rejects when ANY key at ANY depth
 * looks secret-like (casing/alias/separator-insensitive) or when ANY string
 * value carries a `infisical://` / `wave4://` ref. Generic message on
 * purpose — never echoes the offending key or value.
 */
function deepScanForSecrets(value: unknown, depth: number): boolean {
  if (depth > 10) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => deepScanForSecrets(entry, depth + 1));
  }
  if (isPlainRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (isSuspiciousKey(key)) {
        return true;
      }
      if (typeof entry === "string" && containsRefValue(entry)) {
        return true;
      }
      if (deepScanForSecrets(entry, depth + 1)) {
        return true;
      }
    }
    return false;
  }
  if (typeof value === "string") {
    return containsRefValue(value);
  }
  return false;
}

const SECRET_REQUEST_REJECTED_MESSAGE =
  "secret-required operations allow only certified actions with certified fields";

/**
 * PF-05 (MVP-PF05-SECRETREF-04): public echo/manual payload frontier.
 *
 * The public `provider.request_operation` route takes an arbitrary payload,
 * so the old shallow top-level strip was insufficient: nested secret-like
 * keys, casing/separator aliases and ref-like string values at ANY depth
 * must REJECT the request before any insert/event/port call — never merely
 * sanitize. Abusive shapes (deep nesting, key floods, oversized arrays or
 * JSON) are rejected as well.
 *
 * This validator is intentionally permissive about NON-secret content:
 * plain nested objects/arrays/strings/numbers pass so existing synthetic
 * flows (`duration_minutes`, `adult_content_enabled`, capability metadata)
 * keep working. Anything secret-like or abusive fails closed with a generic
 * message that never echoes the offending key or value.
 */
const PUBLIC_PAYLOAD_REJECTED_MESSAGE =
  "provider payload contains forbidden secret material or exceeds the safe shape";

const PUBLIC_PAYLOAD_MAX_DEPTH = 5;
const PUBLIC_PAYLOAD_MAX_KEYS = 100;
const PUBLIC_PAYLOAD_MAX_BYTES = 16384;
const PUBLIC_PAYLOAD_MAX_ARRAY_LENGTH = 100;

function measureShapeAbusive(value: unknown, depth: number, acc: { keys: number }): boolean {
  if (depth > PUBLIC_PAYLOAD_MAX_DEPTH) {
    return true;
  }
  if (Array.isArray(value)) {
    if (value.length > PUBLIC_PAYLOAD_MAX_ARRAY_LENGTH) {
      return true;
    }
    return value.some((entry) => measureShapeAbusive(entry, depth + 1, acc));
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value);
    acc.keys += keys.length;
    if (acc.keys > PUBLIC_PAYLOAD_MAX_KEYS) {
      return true;
    }
    return keys.some((key) => measureShapeAbusive(value[key], depth + 1, acc));
  }
  return false;
}

export function validatePublicRequestPayload(
  payload: Record<string, unknown>,
): { ok: true } | { ok: false; message: string } {
  if (deepScanForSecrets(payload, 0)) {
    return { ok: false, message: PUBLIC_PAYLOAD_REJECTED_MESSAGE };
  }
  if (measureShapeAbusive(payload, 0, { keys: 0 })) {
    return { ok: false, message: PUBLIC_PAYLOAD_REJECTED_MESSAGE };
  }
  try {
    if (JSON.stringify(payload).length > PUBLIC_PAYLOAD_MAX_BYTES) {
      return { ok: false, message: PUBLIC_PAYLOAD_REJECTED_MESSAGE };
    }
  } catch {
    return { ok: false, message: PUBLIC_PAYLOAD_REJECTED_MESSAGE };
  }
  return { ok: true };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Restrictive contract for the secret-required path.
 *
 * - `action` must be exactly `trial.provision` or `subscription.provision`
 *   (case-sensitive; no aliases), with the matching `entityType`.
 * - `payload` is projected by allowlist and rejected on ANY unknown key,
 *   ANY nested object/array, ANY suspicious key at any depth, or ANY
 *   ref-like string value. Allowed shapes mirror what the internal
 *   trial/fulfillment callers actually send:
 *   - `trial.provision`: `{ duration_minutes?: number, adult_content_enabled?: boolean }`
 *   - `subscription.provision`: `{ plan_id?: string, plan_key?: string }`
 */
export function validateSecretRequestShape(input: {
  action: string;
  entityType: string;
  payload: Record<string, unknown>;
}): { ok: true; projectedPayload: Record<string, unknown> } | { ok: false; message: string } {
  const action = input.action;
  if (action !== "trial.provision" && action !== "subscription.provision") {
    return { ok: false, message: SECRET_REQUEST_REJECTED_MESSAGE };
  }
  if (input.entityType !== SECRET_REQUIRED_ENTITY[action]) {
    return { ok: false, message: SECRET_REQUEST_REJECTED_MESSAGE };
  }
  if (!isPlainRecord(input.payload)) {
    return { ok: false, message: SECRET_REQUEST_REJECTED_MESSAGE };
  }
  if (deepScanForSecrets(input.payload, 0)) {
    return { ok: false, message: SECRET_REQUEST_REJECTED_MESSAGE };
  }
  const projected: Record<string, unknown> = {};
  if (action === "trial.provision") {
    for (const [key, value] of Object.entries(input.payload)) {
      if (key === "duration_minutes") {
        if (!isFiniteNumber(value) || !Number.isInteger(value) || value <= 0 || value > 24 * 60) {
          return { ok: false, message: SECRET_REQUEST_REJECTED_MESSAGE };
        }
        projected[key] = value;
      } else if (key === "adult_content_enabled") {
        if (typeof value !== "boolean") {
          return { ok: false, message: SECRET_REQUEST_REJECTED_MESSAGE };
        }
        projected[key] = value;
      } else {
        return { ok: false, message: SECRET_REQUEST_REJECTED_MESSAGE };
      }
    }
    return { ok: true, projectedPayload: projected };
  }
  for (const [key, value] of Object.entries(input.payload)) {
    if (key === "plan_id" || key === "plan_key") {
      if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
        return { ok: false, message: SECRET_REQUEST_REJECTED_MESSAGE };
      }
      projected[key] = value;
    } else {
      return { ok: false, message: SECRET_REQUEST_REJECTED_MESSAGE };
    }
  }
  return { ok: true, projectedPayload: projected };
}

/**
 * PF-05 (MVP-PF05-SECRETREF-04): fixed outcome code persisted when a
 * secret-required port call throws AFTER its effect may have happened. The
 * operation parks in VERIFYING/UNKNOWN with this code — the reservation is
 * preserved, nothing is completed, and only explicit readback may resolve
 * it. Generic by design: never carries exception text or refs.
 */
export const PROVIDER_CALL_UNCERTAIN_CODE = "PROVIDER_CALL_UNCERTAIN";

/** UNAVAILABLE always wins over an injected secret-requiring port. */
export function isCapabilityUnavailable(capability: { availability: string } | null): boolean {
  return capability !== null && capability.availability === "UNAVAILABLE";
}

/**
 * Lookup-only trial provider account resolution for the secret-required
 * pre-gate: returns the existing account id or null. NEVER creates provider
 * or account rows (unlike `ensureTrialProviderAccount`).
 */
export async function findExistingTrialProviderAccountId(
  ctx: CommandHandlerContext,
): Promise<string | null> {
  const trx = kyselyTrxOf(ctx);
  if (trx !== null) {
    const provider = await trx
      .selectFrom("provider.providers")
      .select(["id"])
      .where("provider_key", "=", "cinevision")
      .executeTakeFirst();
    if (provider === undefined) {
      return null;
    }
    const existing = await trx
      .selectFrom("provider.provider_accounts")
      .select(["id"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("provider_id", "=", provider.id)
      .where("status", "=", "ACTIVE")
      .orderBy("created_at", "asc")
      .executeTakeFirst();
    return existing?.id ?? null;
  }
  const mem = trialMemoryOf(ctx);
  if (mem === null) {
    throw new Error("no Wave 4 store available");
  }
  const provider = [...mem.providers.values()].find((p) => p.providerKey === "cinevision");
  if (provider === undefined) {
    return null;
  }
  const existing = [...mem.providerAccounts.values()].find(
    (a) => a.tenantId === ctx.tenantId && a.providerId === provider.id,
  );
  return existing?.id ?? null;
}

const EXTERNAL_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:=-]{0,127}$/;

const SAFE_PORT_DETAIL: Record<string, string> = {
  SUCCEEDED: "secret-required operation completed",
  FAILED: "secret-required operation failed",
  UNKNOWN: "secret-required operation effect unknown",
  MANUAL: "secret-required operation requires operator",
};

export interface ProjectedSecretPortResult {
  outcome: string;
  safeDetail: string;
  safeExternalRef: string | null;
  externalRefInvalid: boolean;
}

/**
 * Safe projection of a secret-requiring port result. The raw `detail` is
 * ALWAYS replaced by a fixed generic string and `externalRef` is kept only
 * when it matches a restricted token format (1..128 chars, no URLs, no
 * whitespace, no secret-like fragments). Callers demote SUCCEEDED with an
 * invalid ref to UNKNOWN (ambiguous effect, reservation retained) and never
 * persist/emit/respond with raw text.
 */
export function projectSecretPortResult(input: {
  outcome: string;
  detail: string;
  externalRef: string | null;
}): ProjectedSecretPortResult {
  const safeDetail = SAFE_PORT_DETAIL[input.outcome] ?? "secret-required operation completed";
  const raw = input.externalRef;
  if (raw === null) {
    return { outcome: input.outcome, safeDetail, safeExternalRef: null, externalRefInvalid: false };
  }
  const invalid =
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > 128 ||
    !EXTERNAL_REF_RE.test(raw) ||
    raw.includes("://") ||
    /\s/.test(raw) ||
    isSuspiciousKey(raw) ||
    containsRefValue(raw);
  if (invalid) {
    return { outcome: input.outcome, safeDetail, safeExternalRef: null, externalRefInvalid: true };
  }
  return { outcome: input.outcome, safeDetail, safeExternalRef: raw, externalRefInvalid: false };
}
