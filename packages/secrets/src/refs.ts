/**
 * Secret-ref grammar and the backend-owned integration namespace.
 *
 * Runtime refs use `pgsecret://`:
 *
 *   pgsecret://<environment>/integrations/<tenantId>/<provider>/<KEY>
 *
 * Rows created before the PostgreSQL cutover carry the legacy
 * `infisical://` scheme; both are parsed so an existing
 * `provider.provider_accounts.secret_ref` keeps resolving by exact value
 * while new writes use the current scheme.
 *
 * Nothing here touches a value: refs name a scope, never a secret.
 */

import { SecretsError } from "./errors.js";
import type {
  IntegrationProvider,
  IntegrationSecretBinding,
  IntegrationSecretTarget,
  ParsedSecretRef,
} from "./types.js";

/** Current URI scheme for domain `secret_ref` values. */
export const SECRETS_REF_SCHEME = "pgsecret://";

/** Legacy scheme kept parse-compatible during the one-time data migration. */
export const LEGACY_SECRETS_REF_SCHEME = "infisical://";

/** The two ref schemes a binding may carry (current and migrated). */
export type IntegrationRefScheme =
  | typeof SECRETS_REF_SCHEME
  | typeof LEGACY_SECRETS_REF_SCHEME;

/** Root path segment of the controlled namespace. */
export const SECRET_NAMESPACE_ROOT = "integrations";

/**
 * Suffix for rotation staging keys (`<KEY>__next`). The ONLY
 * client-unreachable-by-convention key shape besides the per-provider
 * allowlist; `rotateSecret` stages the candidate under it, probes
 * read-only, then cuts over.
 */
export const SECRET_STAGED_SUFFIX = "__next";

/** Exact secret keys each provider may store (no free-form keys). */
const INTEGRATION_SECRET_KEYS: Record<IntegrationProvider, readonly string[]> = {
  asaas: ["ASAAS_API_KEY", "ASAAS_WEBHOOK_TOKEN"],
  cinevision: ["CINEVISION_USER", "CINEVISION_PASS"],
  whatsapp: ["WAHA_WEBHOOK_SECRET"],
};

const ENV_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function schemeOf(ref: string): { scheme: string; rest: string } | null {
  if (ref.startsWith(SECRETS_REF_SCHEME)) {
    return { scheme: SECRETS_REF_SCHEME, rest: ref.slice(SECRETS_REF_SCHEME.length) };
  }
  if (ref.startsWith(LEGACY_SECRETS_REF_SCHEME)) {
    return { scheme: LEGACY_SECRETS_REF_SCHEME, rest: ref.slice(LEGACY_SECRETS_REF_SCHEME.length) };
  }
  return null;
}

/**
 * Parse a ref into environment / path / key. Accepts the current
 * `pgsecret://` scheme and the legacy `infisical://` scheme. Throws
 * `SecretsError(MALFORMED_REF)` for anything else.
 */
export function parseSecretRef(ref: string): ParsedSecretRef {
  const parsedScheme = typeof ref === "string" ? schemeOf(ref) : null;
  if (parsedScheme === null) {
    throw new SecretsError(
      "MALFORMED_REF",
      `malformed secret ref (expected "${SECRETS_REF_SCHEME}<environment>/<key>")`,
    );
  }
  const segments = parsedScheme.rest.split("/");
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) {
    throw new SecretsError(
      "MALFORMED_REF",
      `malformed secret ref (expected "${SECRETS_REF_SCHEME}<environment>/<key>")`,
    );
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new SecretsError(
      "MALFORMED_REF",
      `malformed secret ref (path segments "." and ".." are not allowed)`,
    );
  }
  const environment = segments[0] as string;
  const key = segments[segments.length - 1] as string;
  if (!ENV_SEGMENT_RE.test(environment)) {
    throw new SecretsError(
      "MALFORMED_REF",
      `malformed secret ref environment ${JSON.stringify(environment)} (expected slug like "production")`,
    );
  }
  if (/[\s]/.test(key)) {
    throw new SecretsError("MALFORMED_REF", "malformed secret ref key (must not contain whitespace)");
  }
  const middle = segments.slice(1, -1);
  return { environment, secretPath: middle.length === 0 ? "/" : `/${middle.join("/")}`, key };
}

function validateIntegrationTarget(target: IntegrationSecretTarget): { secretPath: string } {
  if (
    typeof target.provider !== "string" ||
    !Object.hasOwn(INTEGRATION_SECRET_KEYS, target.provider)
  ) {
    throw new SecretsError(
      "MALFORMED_REF",
      "unknown integration provider (expected one of: asaas, cinevision, whatsapp)",
    );
  }
  if (typeof target.environment !== "string" || !ENV_SEGMENT_RE.test(target.environment)) {
    throw new SecretsError(
      "MALFORMED_REF",
      `malformed integration environment ${JSON.stringify(target.environment)} (expected slug like "sandbox")`,
    );
  }
  if (typeof target.tenantId !== "string" || !TENANT_ID_RE.test(target.tenantId)) {
    throw new SecretsError(
      "MALFORMED_REF",
      "malformed tenant id (expected 1-64 chars: letters, digits, '-' or '_')",
    );
  }
  const provider = target.provider as IntegrationProvider;
  const allowed = INTEGRATION_SECRET_KEYS[provider];
  const staged = target.key.endsWith(SECRET_STAGED_SUFFIX);
  const base = staged ? target.key.slice(0, -SECRET_STAGED_SUFFIX.length) : target.key;
  if (!allowed.includes(base)) {
    throw new SecretsError(
      "MALFORMED_REF",
      `secret key ${JSON.stringify(target.key)} is not allowed for provider ${JSON.stringify(provider)}`,
    );
  }
  return { secretPath: `/${SECRET_NAMESPACE_ROOT}/${target.tenantId}/${provider}` };
}

/**
 * Build the backend-owned ref for an integration secret:
 * `pgsecret://<environment>/integrations/<tenantId>/<provider>/<KEY>`.
 * `scheme` is selectable for the two binding schemes only: a legacy
 * `infisical://` binding keeps writing its secondary keys beside the
 * principal credential during the cutover. Throws
 * `SecretsError(MALFORMED_REF)` for anything outside the controlled
 * namespace — before any storage call.
 */
export function buildIntegrationSecretRef(
  target: IntegrationSecretTarget,
  scheme: IntegrationRefScheme = SECRETS_REF_SCHEME,
): string {
  if (scheme !== SECRETS_REF_SCHEME && scheme !== LEGACY_SECRETS_REF_SCHEME) {
    throw new SecretsError("MALFORMED_REF", "unknown secret ref scheme");
  }
  const { secretPath } = validateIntegrationTarget(target);
  return `${scheme}${target.environment}${secretPath}/${target.key}`;
}

/** Scheme of a ref, or `null` when it is not a supported secret ref. */
export function secretRefSchemeOf(ref: string): IntegrationRefScheme | null {
  return typeof ref === "string" ? (schemeOf(ref)?.scheme as IntegrationRefScheme | undefined) ?? null : null;
}

/**
 * Derive the backend-owned ref of a sibling key from the PRINCIPAL binding
 * ref (`provider.provider_accounts.secret_ref`), preserving that ref's
 * scheme, environment and namespace segments.
 *
 * A binding migrated from Infisical keeps `infisical://` while new
 * configurations use `pgsecret://`; secondary keys (`CINEVISION_PASS`,
 * `ASAAS_WEBHOOK_TOKEN`) must live under the SAME scheme as the principal
 * credential, otherwise the exact-ref lookup misses the migrated row.
 *
 * Scope (tenant, provider, environment) always comes from the principal ref,
 * never from the caller, so derivation cannot cross tenants, providers or
 * environments. The derived key must still be allowlisted for the principal
 * provider; anything else throws `SecretsError(MALFORMED_REF)`.
 */
export function deriveIntegrationSecretRef(bindingRef: string, key: string): string {
  const binding = parseIntegrationSecretRef(bindingRef);
  validateIntegrationTarget({
    tenantId: binding.tenantId,
    provider: binding.provider,
    environment: binding.environment,
    key,
  });
  // The key is always the last segment of a validated ref; swapping it keeps
  // the scheme and the exact prefix the migration wrote.
  return `${bindingRef.slice(0, bindingRef.lastIndexOf("/") + 1)}${key}`;
}

/**
 * Parse a ref and prove it lives inside the integration namespace:
 * exactly `/integrations/<tenantId>/<provider>` with a valid tenant id, a
 * known provider and an allowlisted (or staged) key. Anything else throws
 * `SecretsError(MALFORMED_REF)` — before any storage call.
 */
export function parseIntegrationSecretRef(ref: string): IntegrationSecretBinding {
  const parsed = parseSecretRef(ref);
  const segments = parsed.secretPath === "/" ? [] : parsed.secretPath.slice(1).split("/");
  if (
    segments.length !== 3 ||
    segments[0] !== SECRET_NAMESPACE_ROOT ||
    typeof segments[1] !== "string" ||
    typeof segments[2] !== "string"
  ) {
    throw new SecretsError(
      "MALFORMED_REF",
      `secret ref is outside the integrations namespace (expected ${SECRETS_REF_SCHEME}<env>/${SECRET_NAMESPACE_ROOT}/<tenantId>/<provider>/<KEY>)`,
    );
  }
  const candidate: IntegrationSecretTarget = {
    tenantId: segments[1],
    provider: segments[2] as IntegrationProvider,
    environment: parsed.environment,
    key: parsed.key,
  };
  // Reuses the allowlist (including the `__next` staging convention).
  validateIntegrationTarget(candidate);
  return {
    ...parsed,
    tenantId: segments[1],
    provider: segments[2] as IntegrationProvider,
    staged: parsed.key.endsWith(SECRET_STAGED_SUFFIX),
  };
}
