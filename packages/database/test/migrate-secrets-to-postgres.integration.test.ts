import { randomBytes, randomUUID, createDecipheriv } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { applyMigrations } from "../src/migrate.js";

/**
 * SIMPLIFY-01: the one-time migration script must be safe to run in staging.
 *
 * Verified here against a real PostgreSQL and a fake Infisical HTTP endpoint:
 * - dry run writes nothing;
 * - legacy refs stay EXACT (primary + secondary credentials);
 * - an existing PostgreSQL value is never overwritten without --overwrite;
 * - read-back decryption is proven;
 * - a failure blocks promotion (non-zero exit);
 * - no secret value reaches stdout/stderr.
 *
 * The script never deletes anything from the vault (no delete call is made).
 */
const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "scripts", "migrate-secrets-to-postgres.mjs");
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const KEY = randomBytes(32);
const KEY_B64 = KEY.toString("base64");

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

const USER_VALUE = "simplify01-migration-cine-user";
const PASS_VALUE = "simplify01-migration-cine-pass";
const API_KEY_VALUE = "simplify01-migration-asaas-key";
const WEBHOOK_VALUE = "simplify01-migration-webhook-token-value";
const FAILING_VALUE = "simplify01-migration-failing-value";

/** `secretPath/key` -> value served by the fake Infisical. */
const vault = new Map<string, string>();
/** `secretPath/key` reads that fail with 500 (promotion must be blocked). */
const failingSecrets = new Set<string>();
/** Every request the script made to the fake Infisical (must be read-only). */
const requests: Array<{ method: string; path: string }> = [];

let server: Server;
let siteUrl = "";
let providerCinevisionId = "";
let providerAsaasId = "";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runScript(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: join(here, "..", "..", ".."),
      env: {
        ...process.env,
        DATABASE_URL: connectionString as string,
        SECRETS_ENCRYPTION_KEY: KEY_B64,
        INFISICAL_SITE_URL: siteUrl,
        INFISICAL_PROJECT_ID: "test-project",
        INFISICAL_CLIENT_ID: "test-client",
        INFISICAL_CLIENT_SECRET: "test-client-secret",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function decryptFor(tenantId: string, ref: string, ciphertext: string): string {
  const parts = ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("bad ciphertext frame");
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivB64 as string, "base64url"));
  decipher.setAAD(Buffer.from(`${tenantId}\n${ref}`, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64 as string, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64 as string, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: connectionString as string });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function secretRows(): Promise<Array<{ tenant_id: string; secret_ref: string; ciphertext: string }>> {
  return withClient(async (client) => {
    const res = await client.query(
      `select tenant_id, secret_ref, ciphertext
         from platform.secret_values
        where tenant_id = any($1::uuid[])
        order by secret_ref`,
      [[TENANT_A, TENANT_B]],
    );
    return res.rows as Array<{ tenant_id: string; secret_ref: string; ciphertext: string }>;
  });
}

function legacyRef(tenantId: string, provider: string, key: string): string {
  return `infisical://SANDBOX/integrations/${tenantId}/${provider}/${key}`;
}

describe.skipIf(!hasDb)("migrate-secrets-to-postgres (requires TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });

    server = createServer((req, res) => {
      const url = new URL(String(req.url), "http://fake-infisical.test");
      requests.push({ method: String(req.method), path: url.pathname });
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && url.pathname === "/api/v1/auth/universal-auth/login") {
        json(200, { accessToken: "fake-access-token", expiresIn: 600 });
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/v3/secrets/raw/")) {
        const key = decodeURIComponent(url.pathname.slice("/api/v3/secrets/raw/".length));
        const secretPath = url.searchParams.get("secretPath") ?? "";
        if (failingSecrets.has(`${secretPath}/${key}`)) {
          json(500, { message: "fake upstream failure" });
          return;
        }
        const value = vault.get(`${secretPath}/${key}`);
        if (value === undefined) {
          json(404, { message: "not found" });
          return;
        }
        json(200, { secret: { secretKey: key, secretValue: value } });
        return;
      }
      json(404, { message: "unexpected fake route" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    siteUrl = `http://127.0.0.1:${port}`;

    await withClient(async (client) => {
      await client.query(
        `insert into control.tenants (id, slug, name, status, default_currency, timezone)
         values ($1, $2, 'Migration A', 'ACTIVE', 'BRL', 'America/Sao_Paulo')`,
        [TENANT_A, `migration-a-${TENANT_A.slice(0, 8)}`],
      );
      const providers = await client.query(
        `insert into provider.providers (provider_key, name, provider_type)
         values ('cinevision', 'Cinevision', 'BROWSER'),
                ('asaas', 'Asaas', 'BILLING')
         on conflict (provider_key) do update set name = excluded.name
         returning id, provider_key`,
      );
      for (const row of providers.rows as Array<{ id: string; provider_key: string }>) {
        if (row.provider_key === "cinevision") providerCinevisionId = row.id;
        if (row.provider_key === "asaas") providerAsaasId = row.id;
      }
      await client.query(
        `insert into provider.provider_accounts (tenant_id, provider_id, name, secret_ref, environment)
         values ($1, $2, 'cinevision SANDBOX', $3, 'SANDBOX'),
                ($1, $4, 'asaas SANDBOX', $5, 'SANDBOX')`,
        [
          TENANT_A,
          providerCinevisionId,
          legacyRef(TENANT_A, "cinevision", "CINEVISION_USER"),
          providerAsaasId,
          legacyRef(TENANT_A, "asaas", "ASAAS_API_KEY"),
        ],
      );
    });

    vault.set(`/integrations/${TENANT_A}/cinevision/CINEVISION_USER`, USER_VALUE);
    vault.set(`/integrations/${TENANT_A}/cinevision/CINEVISION_PASS`, PASS_VALUE);
    vault.set(`/integrations/${TENANT_A}/asaas/ASAAS_API_KEY`, API_KEY_VALUE);
    vault.set(`/integrations/${TENANT_A}/asaas/ASAAS_WEBHOOK_TOKEN`, WEBHOOK_VALUE);
  });

  afterAll(async () => {
    await withClient(async (client) => {
      await client.query(`delete from platform.secret_values where tenant_id = any($1::uuid[])`, [
        [TENANT_A, TENANT_B],
      ]);
      await client.query(`delete from provider.provider_accounts where tenant_id = any($1::uuid[])`, [
        [TENANT_A, TENANT_B],
      ]);
      await client.query(`delete from control.tenants where id = any($1::uuid[])`, [[TENANT_A, TENANT_B]]);
    }).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("dry run writes nothing, resolves secondary keys and never prints values", async () => {
    const before = await secretRows();
    expect(before).toEqual([]);

    const run = await runScript([]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      `would migrate cinevision/SANDBOX/CINEVISION_USER (dry run)`,
    );
    expect(run.stdout).toContain(
      `would migrate cinevision/SANDBOX/CINEVISION_PASS (dry run)`,
    );
    expect(run.stdout).toContain(`would migrate asaas/SANDBOX/ASAAS_API_KEY (dry run)`);
    expect(run.stdout).toContain(`would migrate asaas/SANDBOX/ASAAS_WEBHOOK_TOKEN (dry run)`);
    expect(await secretRows()).toEqual([]);
    for (const value of [USER_VALUE, PASS_VALUE, API_KEY_VALUE, WEBHOOK_VALUE]) {
      expect(`${run.stdout}${run.stderr}`).not.toContain(value);
    }
  });

  it("apply keeps the exact legacy refs (primary + secondary) and reads back the ciphertext", async () => {
    const run = await runScript(["--apply"]);
    expect(run.code).toBe(0);

    const rows = await secretRows();
    const byRef = new Map(rows.map((row) => [row.secret_ref, row]));
    const expected: Array<[string, string]> = [
      [legacyRef(TENANT_A, "cinevision", "CINEVISION_USER"), USER_VALUE],
      [legacyRef(TENANT_A, "cinevision", "CINEVISION_PASS"), PASS_VALUE],
      [legacyRef(TENANT_A, "asaas", "ASAAS_API_KEY"), API_KEY_VALUE],
      [legacyRef(TENANT_A, "asaas", "ASAAS_WEBHOOK_TOKEN"), WEBHOOK_VALUE],
    ];
    for (const [ref, value] of expected) {
      const row = byRef.get(ref);
      expect(row).toBeDefined();
      expect(row?.tenant_id).toBe(TENANT_A);
      expect(row?.ciphertext).toMatch(/^v1\./);
      expect(row?.ciphertext).not.toContain(value);
      expect(decryptFor(TENANT_A, ref, row?.ciphertext as string)).toBe(value);
    }
    expect(rows.some((row) => row.secret_ref.startsWith("pgsecret://"))).toBe(false);
    for (const value of [USER_VALUE, PASS_VALUE, API_KEY_VALUE, WEBHOOK_VALUE]) {
      expect(`${run.stdout}${run.stderr}`).not.toContain(value);
    }
    // The vault was only read (login + GET); the script never writes or
    // deletes anything in Infisical.
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.method).toBe(request.path === "/api/v1/auth/universal-auth/login" ? "POST" : "GET");
      if (request.method === "GET") {
        expect(request.path.startsWith("/api/v3/secrets/raw/")).toBe(true);
      }
    }
  });

  it("a second apply never overwrites an existing PostgreSQL value by default", async () => {
    const before = await secretRows();
    vault.set(`/integrations/${TENANT_A}/asaas/ASAAS_API_KEY`, "simplify01-rotated-after-cutover");

    const run = await runScript(["--apply"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("already present (kept) asaas/SANDBOX/ASAAS_API_KEY");

    const after = await secretRows();
    expect(after).toEqual(before);
    const apiKeyRef = legacyRef(TENANT_A, "asaas", "ASAAS_API_KEY");
    const row = after.find((candidate) => candidate.secret_ref === apiKeyRef);
    expect(decryptFor(TENANT_A, apiKeyRef, row?.ciphertext as string)).toBe(API_KEY_VALUE);
  });

  it("a read failure exits non-zero so the cutover is not promoted", async () => {
    // Tenant B is created only here: the failing credential must leave no
    // partial row, and tenant A's already-migrated rows must stay untouched.
    await withClient(async (client) => {
      await client.query(
        `insert into control.tenants (id, slug, name, status, default_currency, timezone)
         values ($1, $2, 'Migration B', 'ACTIVE', 'BRL', 'America/Sao_Paulo')`,
        [TENANT_B, `migration-b-${TENANT_B.slice(0, 8)}`],
      );
      await client.query(
        `insert into provider.provider_accounts (tenant_id, provider_id, name, secret_ref, environment)
         values ($1, $2, 'asaas SANDBOX', $3, 'SANDBOX')`,
        [TENANT_B, providerAsaasId, legacyRef(TENANT_B, "asaas", "ASAAS_API_KEY")],
      );
    });
    const beforeA = (await secretRows()).filter((row) => row.tenant_id === TENANT_A);
    vault.set(`/integrations/${TENANT_B}/asaas/ASAAS_API_KEY`, FAILING_VALUE);
    failingSecrets.add(`/integrations/${TENANT_B}/asaas/ASAAS_API_KEY`);

    const run = await runScript(["--apply"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("do NOT cut over");
    expect(run.stdout).toContain("READ FAILED for asaas/SANDBOX/ASAAS_API_KEY");
    expect(`${run.stdout}${run.stderr}`).not.toContain(FAILING_VALUE);

    const rows = await secretRows();
    expect(rows.some((row) => row.tenant_id === TENANT_B)).toBe(false);
    expect(rows.filter((row) => row.tenant_id === TENANT_A)).toEqual(beforeA);
  });
});
