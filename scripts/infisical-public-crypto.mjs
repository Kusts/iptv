#!/usr/bin/env node
// infisical-public-crypto.mjs — hybrid envelope encryption for Infisical R2 backups.
//
// Each archive gets a fresh random AES-256-GCM data key; RSA-OAEP-SHA256 wraps
// the data key under the recipient PUBLIC key. The backup host holds ONLY the
// public key: it can encrypt but never decrypt. The private key stays
// operator-local (artifacts/infisical-recovery/, gitignored) and is used
// solely for isolated restores. stdlib only (node:crypto, node:fs, node:stream).
//
// THE SYMMETRIC backup-crypto.mjs FORMAT IS NOT USED HERE: provisioning its
// AES key to the VPS would put decryption capability on the host. This helper
// is a separate format and never reads BACKUP_CRYPTO_KEY_FILE.
//
// Format: "IPUB1" (5) || wrappedLen u16be || wrappedKey || iv (12) || authTag (16) || ciphertext
// GCM verifies the auth tag on decrypt, so a tampered archive fails closed
// before any restore is attempted. Key material is never printed, even on error.
//
// Streaming: plaintext and ciphertext are piped in chunks (never read fully
// into RAM), so multi-hundred-MB dumps do not OOM the host. Encrypt stages to
// a temp file and publishes only after the GCM tag is patched in;
// decrypt stages plaintext to a temp file and publishes only after
// GCM authentication succeeds — a tampered archive never publishes plaintext.
// Temp names carry 16 random bytes (unpredictable in a writable directory)
// and are created with O_CREAT|O_EXCL (`wx`, 0600): a pre-planted symlink or
// file at the temp path makes staging fail closed instead of being followed
// or truncated. Final publish is atomic no-clobber via hard-link (`linkSync`
// fails with EEXIST when the destination already exists, closing the
// exists-check/rename race on both POSIX and Windows/NTFS); the temp link is
// unlinked right after. Temps are unlinked on failure and on SIGINT/SIGTERM.
//
// Usage:
//   node scripts/infisical-public-crypto.mjs keygen <private-pem-out> <public-pem-out>
//   node scripts/infisical-public-crypto.mjs fingerprint <public-pem>
//   node scripts/infisical-public-crypto.mjs encrypt <public-pem> <plain-in> <enc-out>
//   node scripts/infisical-public-crypto.mjs decrypt <enc-in> <plain-out>
//     # private key path via $INFISICAL_RECOVERY_PRIVATE_KEY_FILE (path, never the value)
import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  createHash,
  constants,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("IPUB1", "ascii");
const RSA_BITS = 2048;
const TAG_LEN = 16;
const IV_LEN = 12;

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function usage() {
  console.error(
    "usage: infisical-public-crypto.mjs keygen <private-pem-out> <public-pem-out>\n" +
      "       infisical-public-crypto.mjs fingerprint <public-pem>\n" +
      "       infisical-public-crypto.mjs encrypt <public-pem> <plain-in> <enc-out>\n" +
      "       infisical-public-crypto.mjs decrypt <enc-in> <plain-out>  # via $INFISICAL_RECOVERY_PRIVATE_KEY_FILE"
  );
  process.exit(2);
}

function readKeyFile(path, what) {
  if (typeof path !== "string" || path.length === 0) fail(`${what} path is not set`);
  try {
    return readFileSync(path, "utf8");
  } catch {
    fail(`cannot read ${what} file (check the path, never the key itself)`);
  }
}

function unlinkQuiet(p) {
  try {
    unlinkSync(p);
  } catch {
    // Already gone — nothing to do.
  }
}

function onSignalsCleanup(paths) {
  const handler = (sig) => {
    for (const p of paths) unlinkQuiet(p);
    // Re-raise with default disposition so the exit code reflects the signal.
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.kill(process.pid, sig);
  };
  process.once("SIGINT", () => handler("SIGINT"));
  process.once("SIGTERM", () => handler("SIGTERM"));
}

// Unpredictable staging path: pid alone is guessable by other local users
// with write access to the output directory; 16 random bytes close that.
function makeTempPath(dest) {
  return `${dest}.tmp.${process.pid}.${randomBytes(16).toString("hex")}`;
}

// Atomic no-clobber publish compatible with POSIX and Windows/NTFS: link(2)
// fails with EEXIST when `dest` already exists, so a concurrent create
// between the fast-path existsSync check and publish cannot be overwritten.
// On success the temp link is removed, leaving `dest` (0600) as the single
// link. On failure the temp is removed and the existing dest is untouched.
function publishNoClobber(tmp, dest, refuseMsg) {
  try {
    linkSync(tmp, dest);
  } catch (e) {
    unlinkQuiet(tmp);
    if (e && e.code === "EEXIST") fail(refuseMsg);
    // Windows may surface an existing destination as EPERM/EACCES: classify
    // by presence so a real overwrite attempt still reports refusal, while a
    // genuinely unwritable directory reports publish failure. Either way the
    // temp is already removed and nothing is overwritten.
    if (e && (e.code === "EPERM" || e.code === "EACCES") && existsSync(dest)) {
      fail(refuseMsg);
    }
    fail("publish failed (partial output removed; check the destination directory)");
  }
  unlinkQuiet(tmp);
  try {
    chmodSync(dest, 0o600);
  } catch {
    // Windows ACLs: best-effort.
  }
}

const [mode, a, b, c] = process.argv.slice(2);

if (mode === "keygen") {
  if (!a || !b) usage();
  if (a === b) fail("refusing to overwrite existing key output (move it aside first)");
  // Fast path for the common mistake; the opens below are the atomic guard.
  if (existsSync(a) || existsSync(b)) {
    fail("refusing to overwrite existing key output (move it aside first)");
  }
  // Operator-local step: private key 0600 from the first byte; public key is
  // non-secret and is the ONLY key material that ever reaches the backup host.
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: RSA_BITS,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  // Exclusive creates (O_CREAT|O_EXCL): close the exists-check/create race —
  // a concurrent keygen targeting the same paths fails here instead of one
  // side silently truncating the other's output. Only files this run created
  // are ever removed on error; pre-existing files are left untouched.
  let privCreated = false;
  let pubCreated = false;
  try {
    let pfd;
    try {
      pfd = openSync(a, "wx", 0o600);
    } catch (e) {
      if (e && e.code === "EEXIST") {
        fail("refusing to overwrite existing key output (move it aside first)");
      }
      fail("keygen failed (check the private output path)");
    }
    privCreated = true;
    try {
      try {
        chmodSync(a, 0o600);
      } catch {
        // Windows ACLs: best-effort; the operator confines the file regardless.
      }
      writeSync(pfd, privateKey, null, "utf8");
    } finally {
      try {
        closeSync(pfd);
      } catch {
        // Best-effort.
      }
    }
    let qfd;
    try {
      qfd = openSync(b, "wx", 0o644);
    } catch (e) {
      // The private half is ours (created above with O_EXCL just now); the
      // public side already existed, so drop our half and fail closed.
      unlinkQuiet(a);
      privCreated = false;
      if (e && e.code === "EEXIST") {
        fail("refusing to overwrite existing key output (move it aside first)");
      }
      fail("keygen failed (check the public output path; private partial removed)");
    }
    pubCreated = true;
    try {
      writeSync(qfd, publicKey, null, "utf8");
    } finally {
      try {
        closeSync(qfd);
      } catch {
        // Best-effort.
      }
    }
  } catch {
    // writeSync failures only (fail() above exits before reaching here):
    // remove the half keypair this run created, never pre-existing files.
    if (pubCreated) {
      unlinkQuiet(b);
      unlinkQuiet(a);
    } else if (privCreated) {
      unlinkQuiet(a);
    }
    fail("keygen failed (partial output removed)");
  }
  const fingerprint = createHash("sha256").update(publicKey, "utf8").digest("hex");
  console.log(`KEYGEN OK (private 0600 operator-local, value never printed)`);
  console.log(`PUBLIC SHA256: ${fingerprint}`);
  process.exit(0);
}

if (mode === "fingerprint") {
  if (!a || b) usage();
  // Raw file bytes: identical to the keygen-time hash when the file is the
  // unmodified keygen output (PEM written verbatim). Operators record this
  // alongside the private key and compare with manifest recipient_pub_sha256.
  let raw;
  try {
    raw = readFileSync(a);
  } catch {
    fail("cannot read public-key file (check the path)");
  }
  console.log(createHash("sha256").update(raw).digest("hex"));
  process.exit(0);
}

if (mode === "encrypt") {
  if (!a || !b || !c) usage();
  if (existsSync(c)) {
    fail("refusing to overwrite existing encrypted output (unique per-run names must not collide)");
  }
  const pubPem = readKeyFile(a, "recipient public key");
  let plainStat;
  try {
    plainStat = statSync(b);
  } catch {
    fail("cannot read plaintext input");
  }
  if (!plainStat.isFile()) fail("plaintext input is not a regular file");
  const dek = randomBytes(32);
  let wrapped;
  try {
    wrapped = publicEncrypt(
      { key: pubPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      dek
    );
  } catch {
    fail("public-key wrap failed (check the recipient public PEM)");
  }
  const iv = randomBytes(IV_LEN);
  const tagOffset = MAGIC.length + 2 + wrapped.length + IV_LEN;
  const header = Buffer.concat([
    MAGIC,
    (() => {
      const len = Buffer.allocUnsafe(2);
      len.writeUInt16BE(wrapped.length, 0);
      return len;
    })(),
    wrapped,
    iv,
    Buffer.alloc(TAG_LEN, 0), // patched with the real GCM tag after streaming
  ]);
  const tmp = makeTempPath(c);
  onSignalsCleanup([tmp]);
  // Exclusive staging (O_CREAT|O_EXCL, 0600): a pre-planted file or symlink
  // at the temp path fails here instead of being followed or truncated.
  let stageFd = null;
  try {
    stageFd = openSync(tmp, "wx", 0o600);
  } catch {
    fail("encryption staging failed (temp exists or directory unwritable; partial output removed)");
  }
  let staged = true;
  try {
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Windows ACLs: best-effort.
    }
    writeSync(stageFd, header);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    // fd-backed stream: no reopen between header write and ciphertext
    // append, so a swapped-in symlink at the temp path cannot be followed.
    // autoClose:false — this block owns stageFd and closes it explicitly.
    // NOTE: destroy() the stream only when the pipeline FAILED: on success
    // the fd must stay open for the tag patch below (destroy closes the fd
    // even with autoClose:false).
    const append = createWriteStream(tmp, { fd: stageFd, autoClose: false });
    let piped = false;
    try {
      await pipeline(createReadStream(b), cipher, append);
      piped = true;
    } finally {
      if (!piped) {
        try {
          append.destroy();
        } catch {
          // Best-effort; fd lifecycle is handled below.
        }
      }
    }
    const tag = cipher.getAuthTag();
    writeSync(stageFd, tag, 0, TAG_LEN, tagOffset);
    try {
      closeSync(stageFd);
    } catch {
      // Best-effort.
    }
    stageFd = null;
    staged = false;
    // Atomic no-clobber publish: link fails with EEXIST when `c` appeared
    // after the fast-path check above, so no concurrent run is overwritten.
    publishNoClobber(tmp, c, "refusing to overwrite existing encrypted output (unique per-run names must not collide)");
  } catch (err) {
    if (stageFd !== null) {
      try {
        closeSync(stageFd);
      } catch {
        // Best-effort.
      }
      stageFd = null;
    }
    if (staged) unlinkQuiet(tmp);
    if (err && (err.code === "ERR_OSSL_EVP_BAD_DECRYPT" || /auth/i.test(String((err && err.message) || "")))) {
      fail("encryption pipeline failed (input changed mid-read or crypto error)");
    }
    fail("encryption failed (see above; partial output removed)");
  }
  dek.fill(0);
  const encBytes = statSync(c).size;
  console.log(
    `ENCRYPT OK: ${plainStat.size} plain bytes -> ${encBytes} enc bytes (public-key envelope)`
  );
  process.exit(0);
}

if (mode === "decrypt") {
  if (!a || !b || c) usage();
  if (existsSync(b)) {
    fail("refusing to overwrite existing plaintext output (move it aside first)");
  }
  const privPath = process.env["INFISICAL_RECOVERY_PRIVATE_KEY_FILE"];
  const privPem = readKeyFile(privPath, "INFISICAL_RECOVERY_PRIVATE_KEY_FILE");
  let fd;
  try {
    fd = openSync(a, "r");
  } catch {
    fail("cannot read encrypted input");
  }
  let wrappedLen;
  try {
    const magic = Buffer.alloc(MAGIC.length);
    if (readSync(fd, magic, 0, MAGIC.length, 0) !== MAGIC.length || !magic.equals(MAGIC)) {
      fail("not an IPUB1 encrypted archive (wrong magic or truncated)");
    }
    const lenBuf = Buffer.alloc(2);
    if (readSync(fd, lenBuf, 0, 2, MAGIC.length) !== 2) {
      fail("IPUB1 archive truncated (header exceeds file)");
    }
    wrappedLen = lenBuf.readUInt16BE(0);
    const headLen = MAGIC.length + 2 + wrappedLen + IV_LEN + TAG_LEN;
    const st = statSync(a);
    if (!st.isFile() || st.size < headLen + 1) {
      fail("IPUB1 archive truncated (header exceeds file)");
    }
    const head = Buffer.alloc(headLen);
    if (readSync(fd, head, 0, headLen, 0) !== headLen) {
      fail("IPUB1 archive truncated (header exceeds file)");
    }
    closeSync(fd);
    fd = null;
    const wrapped = head.subarray(MAGIC.length + 2, MAGIC.length + 2 + wrappedLen);
    const iv = head.subarray(MAGIC.length + 2 + wrappedLen, MAGIC.length + 2 + wrappedLen + IV_LEN);
    const tag = head.subarray(MAGIC.length + 2 + wrappedLen + IV_LEN, headLen);
    let dek;
    try {
      dek = privateDecrypt(
        { key: privPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        wrapped
      );
    } catch {
      fail("key unwrap failed — wrong private key or tampered envelope");
    }
    // Plaintext is staged to a temp file and published ONLY after GCM
    // authentication succeeds (pipeline resolves post-final). A tampered
    // archive throws here and the temp is unlinked — no plaintext published.
    // Staging is exclusive (O_CREAT|O_EXCL, 0600, random name) and the final
    // publish is atomic no-clobber via link, mirroring encrypt.
    const tmp = makeTempPath(b);
    onSignalsCleanup([tmp]);
    let stageFd = null;
    try {
      stageFd = openSync(tmp, "wx", 0o600);
    } catch {
      fail("decrypt staging failed (temp exists or directory unwritable; partial output removed)");
    }
    let staged = true;
    try {
      try {
        chmodSync(tmp, 0o600);
      } catch {
        // Windows ACLs: best-effort.
      }
      const decipher = createDecipheriv("aes-256-gcm", dek, iv);
      decipher.setAuthTag(tag);
      // fd-backed stream: no reopen window where a swapped-in symlink at
      // the temp path could be followed. autoClose:false — owned here.
      // NOTE: destroy() only on pipeline failure (destroy closes the fd even
      // with autoClose:false; on success the fd must stay open for publish).
      const out = createWriteStream(tmp, { fd: stageFd, autoClose: false });
      let piped = false;
      try {
        await pipeline(
          createReadStream(a, { start: headLen }),
          decipher,
          out
        );
        piped = true;
      } finally {
        if (!piped) {
          try {
            out.destroy();
          } catch {
            // Best-effort; fd lifecycle is handled below.
          }
        }
      }
      try {
        closeSync(stageFd);
      } catch {
        // Best-effort.
      }
      stageFd = null;
      staged = false;
      publishNoClobber(tmp, b, "refusing to overwrite existing plaintext output (move it aside first)");
    } catch {
      if (stageFd !== null) {
        try {
          closeSync(stageFd);
        } catch {
          // Best-effort.
        }
        stageFd = null;
      }
      if (staged) unlinkQuiet(tmp);
      fail("authentication failed — archive is tampered, truncated, or the wrong key was used");
    } finally {
      dek.fill(0);
    }
    const plainBytes = statSync(b).size;
    console.log(`DECRYPT OK: plain bytes ${plainBytes} (auth tag verified)`);
  } finally {
    if (fd !== null && fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort.
      }
    }
  }
  process.exit(0);
}

usage();
