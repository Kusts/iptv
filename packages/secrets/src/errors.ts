/**
 * Typed secrets failures shared by every adapter.
 *
 * `detail` NEVER contains a secret value, ciphertext or token. Error
 * messages may name the environment/key for NOT_FOUND, but never material.
 */

export type SecretsErrorCode =
  | "MALFORMED_REF"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "TRANSPORT"
  | "CONFIG"
  | "ROTATE_FAILED"
  | "SERVER";

export class SecretsError extends Error {
  readonly code: SecretsErrorCode;

  constructor(code: SecretsErrorCode, detail: string) {
    super(`secrets: ${detail}`);
    this.name = "SecretsError";
    this.code = code;
  }
}
