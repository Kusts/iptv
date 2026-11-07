#!/usr/bin/env node
/**
 * One-time migration: Infisical secret refs -> encrypted PostgreSQL rows.
 *
 * Reads the live tenant bindings, resolves the CURRENT value from the
 * operator's Infisical instance (read-only), encrypts it with the API's
 * `SECRETS_ENCRYPTION_KEY` (AES-256-GCM, same framing/AAD as
 * `packages/secrets`) and upserts `platform.secret_values` by the EXACT
 * `provider.provider_accounts.secret_ref` value. Existing bindings keep
 * working without rewriting the domain rows.
 *
 * Safety:
 * - DRY RUN by default. Pass `--apply` to write.
 * - Never prints secret values, ciphertext or tokens; only counts/refs are
 *   summarized as counts.
 * - Idempotent by default: an existing row is left untouched (a credential
 *   rotated after cutover must not be reverted). Pass `--overwrite` to force
 *   the legacy value over an existing row.
 * - Reads are best-effort per derived key: a missing derived key
 *   (`CINEVISION_PASS`, `ASAAS_WEBHOOK_TOKEN`) is skipped and reported.
 * - The script does NOT delete the Infisical project, volumes or backups.
 *
 * Required env:
 *   DATABASE_URL (OWNER connection; `iptv_app` is refused because RLS would
 *   hide rows and the migration would silently report nothing)
 *   SECRETS_ENCRYPTION_KEY (base64, 32 bytes)
 *   INFISICAL_SITE_URL, INFISICAL_PROJECT_ID, INFISICAL_CLIENT_ID,
 *   INFISICAL_CLIENT_SECRET (legacy read identity)
 *
 * Run:
 *   node packages/database/scripts/migrate-secrets-to-postgres.mjs
 *   node packages/database/scripts/migrate-secrets-to-postgres.mjs --apply
 *   node packages/database/scripts/migrate-secrets-to-postgres.mjs --apply --overwrite
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Client } from "pg";

const APPLY = process.argv.includes("--apply");
const OVERWRITE = process.argv.includes("--overwrite");
const KEY_ENV = "SECRETS_ENCRYPTION_KEY";
const CIPHER_VERSION = "v1";
const KEY_BYTES = 32;

function fail(message) {
  console.error(`migrate-secrets: ${message}`);
  process.exit(2);
}

function empty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function loadKey() {
  const raw = empty(process.env[KEY_ENV]);
  if (raw === undefined) fail(`${KEY_ENV} is required`);
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== KEY_BYTES) fail(`${KEY_ENV} must decode to exactly ${KEY_BYTES} bytes`);
  // Same canonical check as packages/secrets: a key the API would reject must
  // not be silently accepted by the migration.
  const normalized = raw.replace(/=+$/, "");
  const canonicalUrl = decoded.toString("base64url");
  const canonicalStd = decoded.toString("base64").replace(/=+$/, "");
  if (normalized !== canonicalUrl && normalized !== canonicalStd) {
    fail(`${KEY_ENV} is not canonical base64`);
  }
  return decoded;
}

function aad(tenantId, ref) {
  return `${tenantId}\n${ref}`;
}

function encrypt(plaintext, key, tenantId, ref) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad(tenantId, ref), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CIPHER_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** Read-back verification: prove the stored row decrypts with the same key/AAD. */
function decrypt(payload, key, tenantId, ref) {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) throw new Error("bad ciphertext frame");
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAAD(Buffer.from(aad(tenantId, ref), "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

const REF_SCHEMES = ["pgsecret://", "infisical://"];

function parseRef(ref) {
  const scheme = REF_SCHEMES.find((candidate) => ref.startsWith(candidate));
  if (scheme === undefined) throw new Error("not a secret ref");
  const rest = ref.slice(scheme.length);
  const segments = rest.split("/");
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) {
    throw new Error("malformed secret ref");
  }
  return {
    environment: segments[0],
    key: segments[segments.length - 1],
    secretPath: segments.length === 3 ? `/${segments[1]}` : `/${segments.slice(1, -1).join("/")}`,
  };
}

function integrationSegments(ref) {
  const parsed = parseRef(ref);
  const segments = parsed.secretPath.replace(/^\//, "").split("/");
  if (segments.length !== 3 || segments[0] !== "integrations") {
    throw new Error("ref outside the integrations namespace");
  }
  return { environment: parsed.environment, tenantId: segments[1], provider: segments[2], key: parsed.key };
}

function buildRef(binding, key) {
  const prefix = binding.refScheme;
  return `${prefix}${binding.environment}/integrations/${binding.tenantId}/${binding.provider}/${key}`;
}

async function infisicalLogin(base) {
  const res = await fetch(`${base.siteUrl}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: base.clientId, clientSecret: base.clientSecret }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`infisical login failed (status ${res.status})`);
  const body = await res.json();
  if (typeof body?.accessToken !== "string" || body.accessToken.length === 0) {
    throw new Error("infisical login response without access token");
  }
  return body.accessToken;
}

async function infisicalRead(base, token, ref) {
  const parsed = parseRef(ref);
  const url =
    `${base.siteUrl}/api/v3/secrets/raw/${encodeURIComponent(parsed.key)}` +
    `?workspaceId=${encodeURIComponent(base.projectId)}` +
    `&environment=${encodeURIComponent(parsed.environment.toLowerCase())}` +
    `&secretPath=${encodeURIComponent(parsed.secretPath)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`infisical read failed (status ${res.status})`);
  const body = await res.json();
  const value = body?.secret?.secretValue;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function refSchemeOf(ref) {
  return ref.startsWith("infisical://") ? "infisical://" : "pgsecret://";
}

async function main() {
  const key = loadKey();
  const databaseUrl = empty(process.env.DATABASE_URL);
  if (databaseUrl === undefined) fail("DATABASE_URL (owner) is required");
  const infisical = {
    siteUrl: empty(process.env.INFISICAL_SITE_URL)?.replace(/\/+$/, ""),
    projectId: empty(process.env.INFISICAL_PROJECT_ID),
    clientId: empty(process.env.INFISICAL_CLIENT_ID),
    clientSecret: empty(process.env.INFISICAL_CLIENT_SECRET),
  };
  if (Object.values(infisical).some((value) => value === undefined)) {
    fail("INFISICAL_SITE_URL/PROJECT_ID/CLIENT_ID/CLIENT_SECRET are required to read legacy values");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Refuse the RLS-restricted app role: it would see zero rows and the
    // migration would falsely report "nothing to migrate".
    const identity = await client.query("select current_user as role");
    const role = String(identity.rows[0]?.role ?? "");
    if (role === "iptv_app") {
      fail("DATABASE_URL must be the OWNER role, not iptv_app (RLS hides the rows)");
    }
    const { rows } = await client.query(
      `select tenant_id, secret_ref, environment
         from provider.provider_accounts
        where secret_ref like 'infisical://%'
          and connection_status <> 'DISABLED'`,
    );
    console.log(`migrate-secrets: ${rows.length} live Infisical binding(s)`);
    if (rows.length === 0) {
      console.log("migrate-secrets: nothing to migrate (dry run)" + (APPLY ? "" : "; pass --apply to write"));
      return;
    }

    const token = await infisicalLogin(infisical);
    let planned = 0;
    let migrated = 0;
    let existing = 0;
    let missing = 0;
    let failed = 0;

    for (const row of rows) {
      const tenantId = String(row.tenant_id);
      const ref = String(row.secret_ref);
      const binding = { ...integrationSegments(ref), refScheme: refSchemeOf(ref) };
      if (binding.tenantId !== tenantId) {
        failed += 1;
        console.log(`migrate-secrets: TENANT MISMATCH in ref for ${binding.provider}/${binding.environment}/${binding.key}`);
        continue;
      }
      const derived = [binding.key];
      if (binding.provider === "cinevision") derived.push("CINEVISION_PASS");
      if (binding.provider === "asaas") derived.push("ASAAS_WEBHOOK_TOKEN");

      for (const keyName of derived) {
        const targetRef = buildRef(binding, keyName);
        planned += 1;
        let value;
        try {
          value = await infisicalRead(infisical, token, targetRef);
        } catch {
          failed += 1;
          console.log(`migrate-secrets: READ FAILED for ${binding.provider}/${binding.environment}/${keyName}`);
          continue;
        }
        if (value === undefined) {
          missing += 1;
          console.log(`migrate-secrets: not present (skipped) ${binding.provider}/${binding.environment}/${keyName}`);
          continue;
        }
        if (!APPLY) {
          console.log(`migrate-secrets: would migrate ${binding.provider}/${binding.environment}/${keyName} (dry run)`);
          continue;
        }
        const ciphertext = encrypt(value, key, tenantId, targetRef);
        const write = await client.query(
          OVERWRITE
            ? `insert into platform.secret_values (tenant_id, secret_ref, ciphertext, created_at, updated_at)
               values ($1, $2, $3, now(), now())
               on conflict (tenant_id, secret_ref)
               do update set ciphertext = excluded.ciphertext, updated_at = now()`
            : `insert into platform.secret_values (tenant_id, secret_ref, ciphertext, created_at, updated_at)
               values ($1, $2, $3, now(), now())
               on conflict (tenant_id, secret_ref) do nothing`,
          [tenantId, targetRef, ciphertext],
        );
        if (write.rowCount === 0) {
          // A post-cutover rotation lives in PostgreSQL; never revert it
          // unless the operator explicitly asked with --overwrite.
          existing += 1;
          console.log(`migrate-secrets: already present (kept) ${binding.provider}/${binding.environment}/${keyName}`);
          continue;
        }
        // Read-back proof: if this throws, the key/AAD does not match what a
        // later API read would use — do not cut over.
        try {
          const check = await client.query(
            `select ciphertext from platform.secret_values where tenant_id = $1 and secret_ref = $2`,
            [tenantId, targetRef],
          );
          const stored = String(check.rows[0]?.ciphertext ?? "");
          if (stored === "" || decrypt(stored, key, tenantId, targetRef) !== value) {
            throw new Error("readback mismatch");
          }
        } catch {
          failed += 1;
          console.error(`migrate-secrets: READBACK FAILED for ${binding.provider}/${binding.environment}/${keyName}`);
          continue;
        }
        migrated += 1;
        console.log(`migrate-secrets: migrated ${binding.provider}/${binding.environment}/${keyName}`);
      }
    }

    console.log(
      `migrate-secrets: planned=${planned} migrated=${migrated} existing=${existing} missing=${missing} failed=${failed} apply=${APPLY} overwrite=${OVERWRITE}`,
    );
    if (APPLY && failed > 0) {
      console.error("migrate-secrets: failures occurred; do NOT cut over until every live credential is confirmed");
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`migrate-secrets: ${err instanceof Error ? err.message : "unknown failure"}`);
  process.exit(1);
});
