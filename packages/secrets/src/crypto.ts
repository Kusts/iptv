/**
 * AES-256-GCM secret encryption (node:crypto only, ADR-0014 replacement).
 *
 * The runtime credential vault is PostgreSQL: one row per
 * `(tenant, secret_ref)` holding ONLY ciphertext. The single 256-bit key
 * lives in the API process environment (`SECRETS_ENCRYPTION_KEY`), never in
 * the database, the repository or logs.
 *
 * Ciphertext format: `v1.<iv>.<authTag>.<ciphertext>`, each binary part
 * encoded with base64url (no padding). The AAD binds the ciphertext to its
 * tenant and ref, so a row copied to another tenant/ref (or a swapped row)
 * fails authentication instead of decrypting.
 *
 * SECURITY: plaintext, key material and decrypted values are never logged,
 * thrown in error messages or attached to telemetry. Errors are fixed
 * strings with no payload detail.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SecretsError } from "./errors.js";

/** Environment variable holding the base64 256-bit key. */
export const SECRETS_KEY_ENV = "SECRETS_ENCRYPTION_KEY";

/** Ciphertext version prefix. Unknown versions fail closed. */
export const SECRET_CIPHER_VERSION = "v1";

/** AES-256 key length in bytes. */
export const SECRET_KEY_BYTES = 32;

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const CIPHER_VERSION_RE = /^v\d+$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Decode and validate the 256-bit key. Accepts base64 or base64url with
 * optional padding. Throws `SecretsError(CONFIG)` for anything else; the
 * message never echoes the configured value.
 */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  const value = (raw ?? "").trim();
  if (value.length === 0) {
    throw new SecretsError(
      "CONFIG",
      `secrets encryption key is not configured (set ${SECRETS_KEY_ENV} to a base64 32-byte key)`,
    );
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    throw new SecretsError("CONFIG", `${SECRETS_KEY_ENV} is not valid base64`);
  }
  if (decoded.length !== SECRET_KEY_BYTES) {
    throw new SecretsError(
      "CONFIG",
      `${SECRETS_KEY_ENV} must decode to exactly ${SECRET_KEY_BYTES} bytes (got ${decoded.length})`,
    );
  }
  // Reject lossy/ambiguous encodings: re-encoding must reproduce the same
  // payload characters (ignoring padding). This refuses values that Node's
  // lenient base64 decoder would silently truncate or reinterpret.
  const normalized = value.replace(/=+$/, "");
  const canonical = decoded.toString("base64url");
  const canonicalStd = decoded.toString("base64").replace(/=+$/, "");
  if (normalized !== canonical && normalized !== canonicalStd) {
    throw new SecretsError("CONFIG", `${SECRETS_KEY_ENV} is not canonical base64`);
  }
  return decoded;
}

/** Load and validate the key from the environment. Throws `SecretsError(CONFIG)`. */
export function loadEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  return parseEncryptionKey(env[SECRETS_KEY_ENV]);
}

/** True when a usable key is configured. Used by the browser secret gate. */
export function isSecretsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    parseEncryptionKey(env[SECRETS_KEY_ENV]);
    return true;
  } catch {
    return false;
  }
}

/** Bind ciphertext to its tenant + ref (never a secret value). */
export function secretAad(tenantId: string, ref: string): string {
  return `${tenantId}\n${ref}`;
}

/** Encrypt a non-empty plaintext. Returns the compact `v1.*` payload. */
export function encryptSecret(plaintext: string, key: Buffer, aad: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new SecretsError("MALFORMED_REF", "secret value must be a non-empty string");
  }
  if (!Buffer.isBuffer(key) || key.length !== SECRET_KEY_BYTES) {
    throw new SecretsError("CONFIG", `encryption key must be ${SECRET_KEY_BYTES} bytes`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SECRET_CIPHER_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a `v1.*` payload. Any malformed structure, unknown version or
 * authentication failure throws `SecretsError(SERVER)` with a fixed message
 * (never the ref, ciphertext or plaintext).
 */
export function decryptSecret(payload: string, key: Buffer, aad: string): string {
  if (typeof payload !== "string") {
    throw new SecretsError("SERVER", "stored secret ciphertext is malformed");
  }
  if (!Buffer.isBuffer(key) || key.length !== SECRET_KEY_BYTES) {
    throw new SecretsError("CONFIG", `encryption key must be ${SECRET_KEY_BYTES} bytes`);
  }
  const parts = payload.split(".");
  if (parts.length !== 4) {
    throw new SecretsError("SERVER", "stored secret ciphertext is malformed");
  }
  const [version, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  if (!CIPHER_VERSION_RE.test(version) || version !== SECRET_CIPHER_VERSION) {
    throw new SecretsError("SERVER", "stored secret ciphertext uses an unsupported version");
  }
  if (
    !BASE64URL_RE.test(ivB64) ||
    !BASE64URL_RE.test(tagB64) ||
    !BASE64URL_RE.test(dataB64)
  ) {
    throw new SecretsError("SERVER", "stored secret ciphertext is malformed");
  }
  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(ivB64, "base64url");
    tag = Buffer.from(tagB64, "base64url");
    ciphertext = Buffer.from(dataB64, "base64url");
  } catch {
    throw new SecretsError("SERVER", "stored secret ciphertext is malformed");
  }
  if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES || ciphertext.length === 0) {
    throw new SecretsError("SERVER", "stored secret ciphertext is malformed");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretsError(
      "SERVER",
      "secret decryption failed (wrong key, wrong tenant/ref binding or tampered ciphertext)",
    );
  }
}
