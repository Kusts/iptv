#!/usr/bin/env node
// backup-crypto.mjs — encrypt/decrypt backup archives with AES-256-GCM.
//
// stdlib only (node:crypto). The key NEVER comes from argv/env values: it is
// read from a file ($BACKUP_CRYPTO_KEY_FILE) holding 64 hex chars (32 bytes)
// and is never printed, even on error. Output format:
//
//   "IPTV1" (5 bytes) || iv (12 bytes) || authTag (16 bytes) || ciphertext
//
// GCM decryption verifies the auth tag, so a truncated/tampered archive
// fails here — before any restore is attempted.
//
// Usage:
//   node scripts/backup-crypto.mjs encrypt <plain-in> <enc-out>
//   node scripts/backup-crypto.mjs decrypt <enc-in> <plain-out>
//   node scripts/backup-crypto.mjs keygen <key-file-out>   # 0600, operator step
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const MAGIC = Buffer.from("IPTV1", "ascii");

function loadKey() {
  const path = process.env["BACKUP_CRYPTO_KEY_FILE"];
  if (typeof path !== "string" || path.length === 0) {
    console.error("ERROR: BACKUP_CRYPTO_KEY_FILE is not set (key file path, never the key itself)");
    process.exit(2);
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    console.error("ERROR: cannot read key file (check BACKUP_CRYPTO_KEY_FILE)");
    process.exit(2);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    console.error("ERROR: key file must hold exactly 64 hex chars (32 bytes); got wrong shape");
    process.exit(2);
  }
  return Buffer.from(raw, "hex");
}

const [mode, input, output] = process.argv.slice(2);
if (mode === "keygen") {
  if (!input) {
    console.error("usage: backup-crypto.mjs keygen <key-file-out>");
    process.exit(2);
  }
} else if ((mode !== "encrypt" && mode !== "decrypt") || !input || !output) {
  console.error("usage: backup-crypto.mjs (encrypt|decrypt) <in> <out> | keygen <key-file-out>");
  process.exit(2);
}

if (mode === "keygen") {
  // umask-equivalent: the key file is created 0600 from the first byte.
  const keyFile = input;
  writeFileSync(keyFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    // Windows ACLs: best-effort; the operator confines the file regardless.
  }
  console.log(`KEYGEN OK (operator-confined file, value never printed)`);
  process.exit(0);
}

if (mode === "encrypt") {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = readFileSync(input);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(output, Buffer.concat([MAGIC, iv, tag, ciphertext]), { mode: 0o600 });
  console.log(`ENCRYPT OK: ${ciphertext.length} plain bytes -> ${MAGIC.length + 12 + 16 + ciphertext.length} enc bytes`);
} else {
  const key = loadKey();
  const blob = readFileSync(input);
  if (blob.length < MAGIC.length + 12 + 16 + 1 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    console.error("ERROR: not an IPTV1 encrypted archive (wrong magic or truncated)");
    process.exit(1);
  }
  const iv = blob.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = blob.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const ciphertext = blob.subarray(MAGIC.length + 28);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    writeFileSync(output, plain, { mode: 0o600 });
    console.log(`DECRYPT OK: ${ciphertext.length} enc bytes -> ${plain.length} plain bytes (auth tag verified)`);
  } catch {
    console.error("ERROR: authentication failed — archive is tampered, truncated, or the wrong key was used");
    process.exit(1);
  }
}
