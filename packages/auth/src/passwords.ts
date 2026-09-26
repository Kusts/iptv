import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SALT_BYTES = 16;
const KEY_LEN = 64;
// scrypt parameters (sensitivity is server-side; values are standard interactive).
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function scryptKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, derived) => {
      if (err !== null) {
        reject(err);
        return;
      }
      resolve(derived as Buffer);
    });
  });
}

const ENCODED_RE = /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/;

/** Password policy: minimum length only (no business policy beyond safety). */
export function assertPasswordPolicy(password: string): void {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
}

/**
 * Hash a password with scrypt (random salt per password).
 * Only the encoded `scrypt$...` string is stored; plaintext never persists.
 */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const derived = await scryptKey(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString("hex")}`;
}

/** Verify a password against a stored scrypt hash (constant-time compare). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!ENCODED_RE.test(stored)) {
    return false;
  }
  const parts = stored.split("$");
  const salt = parts[4] as string;
  const expected = Buffer.from(parts[5] as string, "hex");
  let derived: Buffer;
  try {
    derived = await scryptKey(password, salt);
  } catch {
    return false;
  }
  if (derived.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}
