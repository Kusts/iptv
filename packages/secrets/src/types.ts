/** Shared secrets port types (no storage, crypto or transport code). */

export interface SecretsPort {
  readonly name: string;
  /** Resolve a `secret_ref` to its value. Rejects with `SecretsError`. */
  getSecret(ref: string): Promise<string>;
}

export interface ParsedSecretRef {
  /** Environment segment of the ref (SANDBOX/PRODUCTION/legacy slug). */
  environment: string;
  /** Namespace path (`/integrations/<tenant>/<provider>`). */
  secretPath: string;
  /** Secret key (last segment of the ref). */
  key: string;
}

/** A parsed ref proven to live inside the integration namespace. */
export interface IntegrationSecretBinding extends ParsedSecretRef {
  tenantId: string;
  provider: IntegrationProvider;
  /** True for rotation staging keys (`<KEY>__next`). */
  staged: boolean;
}

/** Providers allowed to hold tenant secrets. */
export type IntegrationProvider = "asaas" | "cinevision" | "whatsapp";

/** Backend-owned write target: tenant + provider + environment + key. */
export interface IntegrationSecretTarget {
  tenantId: string;
  provider: IntegrationProvider;
  environment: string;
  key: string;
}

/** Input for `putSecret`: backend-owned target + value + optional idempotency key. */
export interface PutSecretInput extends IntegrationSecretTarget {
  /** Secret value. Encrypted before storage; never logged or thrown. */
  value: string;
  /** Stable idempotency key for tracing/audit; never a secret. */
  requestId?: string;
}

/** Result of `putSecret`: the backend-owned ref plus whether it was created. */
export interface PutSecretResult {
  ref: string;
  created: boolean;
}

/**
 * Writer facet of the secrets port. Extends (rather than widens)
 * `SecretsPort` so existing read-only implementations keep compiling;
 * use `asSecretsWriter` to narrow.
 */
export interface SecretsWriterPort extends SecretsPort {
  putSecret(input: PutSecretInput): Promise<PutSecretResult>;
  deleteSecret(ref: string): Promise<void>;
}

/** Input for `rotateSecret`: live target + candidate value + read-only probe. */
export interface RotateSecretInput extends PutSecretInput {
  /**
   * Read-only canary validation against the STAGED ref. Must not mutate
   * anything; a rejection aborts the rotation with the live ref preserved.
   */
  probe: (stagedRef: string) => Promise<void>;
}

/** Result of `rotateSecret`: live ref (cut over) plus the staged ref used. */
export interface RotateSecretResult {
  ref: string;
  stagedRef: string;
}
