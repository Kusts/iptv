import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  SECRETS_KEY_ENV,
  SecretsError,
  decryptSecret,
  encryptSecret,
  isSecretsConfigured,
  loadEncryptionKey,
  parseEncryptionKey,
  secretAad,
} from "../src/index.js";

const KEY = randomBytes(32);
const KEY_B64 = KEY.toString("base64");
const AAD = secretAad("11111111-1111-4111-8111-111111111111", "pgsecret://sandbox/integrations/t/asaas/ASAAS_API_KEY");

function codeOf(err: unknown): string | null {
  return err instanceof SecretsError ? err.code : null;
}

describe("parseEncryptionKey", () => {
  it("accepts a canonical base64 32-byte key", () => {
    expect(parseEncryptionKey(KEY_B64).equals(KEY)).toBe(true);
    expect(parseEncryptionKey(KEY.toString("base64url")).equals(KEY)).toBe(true);
  });

  it("rejects missing, malformed, wrong-length and non-canonical values", () => {
    for (const raw of [undefined, "", "   ", "not-base64!!!"]) {
      const err = (() => {
        try {
          parseEncryptionKey(raw);
          return null;
        } catch (e: unknown) {
          return e;
        }
      })();
      expect(codeOf(err)).toBe("CONFIG");
    }
    const short = randomBytes(16).toString("base64");
    expect(codeOf((() => { try { parseEncryptionKey(short); return null; } catch (e: unknown) { return e; } })())).toBe("CONFIG");
    // A 32-byte key plus trailing bytes must not be silently truncated.
    const long = randomBytes(40).toString("base64");
    expect(codeOf((() => { try { parseEncryptionKey(long); return null; } catch (e: unknown) { return e; } })())).toBe("CONFIG");
  });

  it("never echoes key material in the error", () => {
    try {
      parseEncryptionKey("short");
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain("short");
    }
  });

  it("loads from the documented env var and reports configured state", () => {
    expect(loadEncryptionKey({ [SECRETS_KEY_ENV]: KEY_B64 }).equals(KEY)).toBe(true);
    expect(isSecretsConfigured({ [SECRETS_KEY_ENV]: KEY_B64 })).toBe(true);
    expect(isSecretsConfigured({})).toBe(false);
    expect(isSecretsConfigured({ [SECRETS_KEY_ENV]: "bad" })).toBe(false);
  });
});

describe("AES-256-GCM payloads", () => {
  it("round-trips a plaintext with a versioned payload", () => {
    const payload = encryptSecret("s3cr3t-value", KEY, AAD);
    expect(payload.startsWith("v1.")).toBe(true);
    expect(payload.split(".")).toHaveLength(4);
    expect(payload).not.toContain("s3cr3t-value");
    expect(decryptSecret(payload, KEY, AAD)).toBe("s3cr3t-value");
  });

  it("uses a fresh IV per encryption", () => {
    const a = encryptSecret("same-value", KEY, AAD);
    const b = encryptSecret("same-value", KEY, AAD);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY, AAD)).toBe("same-value");
    expect(decryptSecret(b, KEY, AAD)).toBe("same-value");
  });

  it("fails closed when the AAD (tenant/ref binding) differs", () => {
    const payload = encryptSecret("value", KEY, AAD);
    expect(codeOf((() => { try { decryptSecret(payload, KEY, AAD + "x"); return null; } catch (e: unknown) { return e; } })())).toBe("SERVER");
  });

  it("fails closed when the ciphertext is tampered", () => {
    const payload = encryptSecret("value", KEY, AAD);
    const parts = payload.split(".");
    const data = parts[3] as string;
    // Flip the FIRST payload character: the final base64 char may carry only
    // padding bits, which Node's decoder ignores (flaky non-tamper).
    const flipped = data.startsWith("A") ? `B${data.slice(1)}` : `A${data.slice(1)}`;
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${flipped}`;
    expect(codeOf((() => { try { decryptSecret(tampered, KEY, AAD); return null; } catch (e: unknown) { return e; } })())).toBe("SERVER");
  });

  it("rejects malformed payloads and unknown versions", () => {
    for (const payload of ["", "v1", "v1.a.b", "v1.a.b.c.d", "v2.a.b.c", "v1.!!.b.c"]) {
      expect(codeOf((() => { try { decryptSecret(payload, KEY, AAD); return null; } catch (e: unknown) { return e; } })())).toBe("SERVER");
    }
  });

  it("rejects an empty plaintext and a wrong key length", () => {
    expect(codeOf((() => { try { encryptSecret("", KEY, AAD); return null; } catch (e: unknown) { return e; } })())).toBe("MALFORMED_REF");
    expect(codeOf((() => { try { encryptSecret("v", randomBytes(16), AAD); return null; } catch (e: unknown) { return e; } })())).toBe("CONFIG");
  });
});
