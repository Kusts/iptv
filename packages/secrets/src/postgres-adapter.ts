/**
 * PostgreSQL-backed secrets adapter (AES-256-GCM, no Infisical).
 *
 * `SecretRowStore` is the storage boundary: the API supplies a Kysely
 * implementation bound to the request's tenant transaction (so the secret
 * write and the provider binding commit atomically), while unit tests use
 * an in-memory store. The adapter itself owns ref validation, tenant
 * isolation and ciphertext framing.
 *
 * SECURITY:
 * - Every ref is proven to live inside
 *   `pgsecret://<environment>/integrations/<tenantId>/<provider>/<KEY>`
 *   (legacy `infisical://` refs are still parsed for migration compatibility).
 * - A ref whose embedded tenant differs from the adapter's tenant is
 *   treated as NOT_FOUND; cross-tenant reads never reveal existence.
 * - The ciphertext is bound to `(tenantId, ref)` via AAD.
 * - Values never appear in errors, logs or telemetry.
 */

import { SecretsError } from "./errors.js";
import { decryptSecret, encryptSecret, secretAad } from "./crypto.js";
import { buildIntegrationSecretRef, parseIntegrationSecretRef } from "./refs.js";
import type { PutSecretInput, PutSecretResult, SecretsWriterPort } from "./types.js";

/** Minimal storage contract; one row per `(tenant, ref)`. */
export interface SecretRowStore {
  get(tenantId: string, ref: string): Promise<{ ciphertext: string } | undefined>;
  /** Upsert; returns true when a new row was created. */
  upsert(row: { tenantId: string; ref: string; ciphertext: string }): Promise<boolean>;
  /** Delete; returns true when a row was removed. */
  remove(tenantId: string, ref: string): Promise<boolean>;
}

export interface PostgresSecretsOptions {
  store: SecretRowStore;
  tenantId: string;
  /** 32-byte AES key (see `loadEncryptionKey`). */
  key: Buffer;
}

export class PostgresSecretsAdapter implements SecretsWriterPort {
  readonly name = "postgres";

  private readonly store: SecretRowStore;
  private readonly tenantId: string;
  private readonly key: Buffer;

  constructor(options: PostgresSecretsOptions) {
    if (options.key.length !== 32) {
      throw new SecretsError("CONFIG", "encryption key must be 32 bytes");
    }
    this.store = options.store;
    this.tenantId = options.tenantId;
    this.key = options.key;
  }

  async getSecret(ref: string): Promise<string> {
    // Throws MALFORMED_REF for out-of-namespace refs before any store call.
    const binding = parseIntegrationSecretRef(ref);
    if (binding.tenantId !== this.tenantId) {
      throw new SecretsError("NOT_FOUND", "secret is not available in this tenant");
    }
    const row = await this.store.get(this.tenantId, ref);
    if (row === undefined) {
      throw new SecretsError(
        "NOT_FOUND",
        `secret ${JSON.stringify(binding.key)} not found in environment ${JSON.stringify(binding.environment)}`,
      );
    }
    return decryptSecret(row.ciphertext, this.key, secretAad(this.tenantId, ref));
  }

  async putSecret(input: PutSecretInput): Promise<PutSecretResult> {
    if (typeof input.value !== "string" || input.value.length === 0) {
      throw new SecretsError("MALFORMED_REF", "secret value must be a non-empty string");
    }
    if (
      input.requestId !== undefined &&
      (typeof input.requestId !== "string" || input.requestId.length === 0)
    ) {
      throw new SecretsError("MALFORMED_REF", "request id must be a non-empty string when provided");
    }
    // Backend-derived ref only; throws before any write for out-of-namespace
    // targets (unknown provider/key, bad tenant id or environment).
    const ref = buildIntegrationSecretRef(input);
    const binding = parseIntegrationSecretRef(ref);
    if (binding.tenantId !== this.tenantId) {
      throw new SecretsError("MALFORMED_REF", "secret target is outside this tenant");
    }
    const ciphertext = encryptSecret(input.value, this.key, secretAad(this.tenantId, ref));
    const created = await this.store.upsert({ tenantId: this.tenantId, ref, ciphertext });
    return { ref, created };
  }

  async deleteSecret(ref: string): Promise<void> {
    const binding = parseIntegrationSecretRef(ref);
    if (binding.tenantId !== this.tenantId) {
      throw new SecretsError("MALFORMED_REF", "secret target is outside this tenant");
    }
    const removed = await this.store.remove(this.tenantId, ref);
    if (!removed) {
      throw new SecretsError(
        "NOT_FOUND",
        `secret ${JSON.stringify(binding.key)} not found in environment ${JSON.stringify(binding.environment)}`,
      );
    }
  }
}
