/**
 * Writer facet and the fail-closed default port.
 *
 * Reads stay on `SecretsPort`. Writes live on `SecretsWriterPort` (a
 * separate interface extending the read port so existing read-only fakes
 * keep compiling) plus `rotateSecret` as an orchestrated domain function
 * composed from put + a read-only probe + cutover + staged-key cleanup.
 */

import { SecretsError } from "./errors.js";
import {
  SECRET_STAGED_SUFFIX,
  buildIntegrationSecretRef,
} from "./refs.js";
import type {
  PutSecretInput,
  PutSecretResult,
  RotateSecretInput,
  RotateSecretResult,
  SecretsPort,
  SecretsWriterPort,
} from "./types.js";

/** Default: records nothing, fails loudly (never a fake secret). */
export class NoopSecretsPort implements SecretsWriterPort {
  readonly name = "noop";

  async getSecret(ref: string): Promise<string> {
    void ref;
    throw new SecretsError(
      "CONFIG",
      "secrets storage is not configured (use the PostgreSQL adapter with SECRETS_ENCRYPTION_KEY)",
    );
  }

  async putSecret(input: PutSecretInput): Promise<PutSecretResult> {
    void input;
    throw new SecretsError(
      "CONFIG",
      "secrets storage is not configured (use the PostgreSQL adapter with SECRETS_ENCRYPTION_KEY)",
    );
  }

  async deleteSecret(ref: string): Promise<void> {
    void ref;
    throw new SecretsError(
      "CONFIG",
      "secrets storage is not configured (use the PostgreSQL adapter with SECRETS_ENCRYPTION_KEY)",
    );
  }
}

/**
 * Narrow a `SecretsPort` to its writer facet. Returns `null` for
 * read-only implementations, so callers fail closed instead of assuming
 * write capability.
 */
export function asSecretsWriter(port: SecretsPort): SecretsWriterPort | null {
  const candidate = port as Partial<SecretsWriterPort>;
  if (typeof candidate.putSecret === "function" && typeof candidate.deleteSecret === "function") {
    return candidate as SecretsWriterPort;
  }
  return null;
}

/**
 * Orchestrated secret rotation:
 *
 * 1. `put` the candidate under `<KEY>__next` (same path/environment);
 * 2. run the read-only `probe` against the staged ref;
 * 3. `put` (cutover) the live key with the candidate value;
 * 4. best-effort `delete` of the staged key.
 *
 * Failure at any step is fail-closed: a probe rejection cleans the stage
 * and throws `SecretsError(ROTATE_FAILED)` with the live ref untouched.
 * The post-cutover stage cleanup is best-effort so a successful cutover is
 * never reported as failed.
 */
export async function rotateSecret(
  port: SecretsWriterPort,
  input: RotateSecretInput,
): Promise<RotateSecretResult> {
  const { probe, ...target } = input;
  if (typeof probe !== "function") {
    throw new SecretsError("MALFORMED_REF", "rotation requires a read-only probe callback");
  }
  if (typeof target.value !== "string" || target.value.length === 0) {
    throw new SecretsError("MALFORMED_REF", "secret value must be a non-empty string");
  }
  const ref = buildIntegrationSecretRef(target, input.refScheme);
  const stagedKey = `${target.key}${SECRET_STAGED_SUFFIX}`;
  const stagedRef = buildIntegrationSecretRef({ ...target, key: stagedKey }, input.refScheme);
  // 1. Stage the candidate.
  await port.putSecret({ ...target, key: stagedKey, value: target.value });
  // 2. Read-only canary.
  try {
    await probe(stagedRef);
  } catch {
    await port.deleteSecret(stagedRef).catch(() => undefined);
    throw new SecretsError(
      "ROTATE_FAILED",
      `rotation probe rejected the candidate in environment ${JSON.stringify(target.environment)} (live ref preserved)`,
    );
  }
  // 3. Cutover.
  await port.putSecret({ ...target, value: target.value });
  // 4. Best-effort stage cleanup.
  await port.deleteSecret(stagedRef).catch(() => undefined);
  return { ref, stagedRef };
}
