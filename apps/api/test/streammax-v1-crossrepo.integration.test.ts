import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { applyMigrations, createDb } from "@iptv/database";
import { newId } from "@iptv/domain";
import { sql } from "kysely";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter } from "../src/request-id.js";

const execFile = promisify(execFileCallback);
const cliPath = process.env["OPENMAUSBOT_CLI_PATH"] ?? "D:/projetos/OpenMausBot/bots/streammax/cli/streammax.mjs";
const connectionString = process.env["TEST_DATABASE_URL"];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "db", "migrations");
const tenantId = randomUUID();
const pepper = "crossrepo-synthetic-pepper-value-32";
const token = `crossrepo-${randomUUID()}-${randomUUID()}`;
const tokenHash = createHash("sha256").update(`${pepper}:${token}`).digest("hex");

describe.skipIf(!connectionString || !existsSync(cliPath))("StreamMax API × OpenMausBot CLI (cross-repo integration)", () => {
  const db = createDb({ connectionString: connectionString as string });
  const envKeys = ["DATABASE_URL", "BETTER_AUTH_SECRET", "BOT_SERVICE_TOKEN_PEPPER", "STREAMMAX_BOT_API_ENABLED", "STREAMMAX_BOT_ENABLED"] as const;
  const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let app: NestFastifyApplication;
  let baseUrl = "";
  let port = 0;

  async function runCli(args: string[], serviceToken = token, apiUrl = baseUrl) {
    try {
      const result = await execFile("node", [cliPath, ...args], {
        env: { ...process.env, STREAMMAX_API_BASE_URL: apiUrl, STREAMMAX_BOT_SERVICE_TOKEN: serviceToken },
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const result = error as { code?: number | string; stdout?: string; stderr?: string };
      return { code: typeof result.code === "number" ? result.code : 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "synthetic-crossrepo-auth-secret-0123456789";
    process.env["BOT_SERVICE_TOKEN_PEPPER"] = pepper;
    process.env["STREAMMAX_BOT_API_ENABLED"] = "true";
    process.env["STREAMMAX_BOT_ENABLED"] = "false";
    await sql`insert into control.tenants (id, slug, name, status) values
      (${tenantId}::uuid, ${`crossrepo-${randomUUID()}`}, 'Cross-repo synthetic test', 'ACTIVE')`.execute(db);
    await sql`insert into platform.bot_service_credentials
      (tenant_id, label, token_hash, token_prefix, scopes, expires_at)
      values (${tenantId}::uuid, 'crossrepo integration', ${tokenHash}, ${token.substring(0, 8)},
      ARRAY['bot.streammax.execute'], now() + interval '1 day')`.execute(db);

    const tail = randomUUID().replace(/-/g, "");
    const productId = newId();
    const planId = newId();
    await sql`insert into catalog.products
      (id, tenant_id, product_key, name, product_type, status, metadata_json, created_at, updated_at)
      values (${productId}::uuid, ${tenantId}::uuid, ${`crossrepo-${tail}`}, 'Cross-repo plan',
      'SERVICE', 'ACTIVE', '{}'::jsonb, now(), now())`.execute(db);
    await sql`insert into catalog.plans
      (id, tenant_id, product_id, plan_key, name, billing_interval_unit, billing_interval_count, status, metadata_json, created_at, updated_at)
      values (${planId}::uuid, ${tenantId}::uuid, ${productId}::uuid, ${`crossrepo-plan-${tail}`},
      'Cross-repo integration plan', 'MONTH', 1, 'ACTIVE', '{}'::jsonb, now(), now())`.execute(db);
    await sql`insert into catalog.prices
      (id, tenant_id, sellable_type, sellable_id, amount_minor, currency, starts_at, ends_at, segment_key, status, metadata_json, created_at)
      values (${newId()}::uuid, ${tenantId}::uuid, 'PLAN', ${planId}::uuid, '12345',
      'BRL', now() - interval '1 minute', null, null, 'ACTIVE', '{}'::jsonb, now())`.execute(db);

    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    if (!address || typeof address === "string") throw new Error("Could not determine ephemeral API port");
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
    for (const key of envKeys) {
      const value = oldEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("real CLI lists active API plans and preserves amountMinor as a string", async () => {
    const result = await runCli(["list-plans"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Cross-repo integration plan");
    expect(result.stdout).toMatch(/"amountMinor":\s*"12345"/);
  });

  it("real CLI resolves and idempotently reuses a lead identity", async () => {
    const waId = `5511${randomUUID().replace(/-/g, "")}`;
    const messageId = `crossrepo-${randomUUID()}`;
    const idempotencyKey = `crossrepo-${randomUUID()}`;
    const args = ["resolve-lead", "--waId", waId, "--name", "Cross-repo lead", "--messageId", messageId, "--idempotencyKey", idempotencyKey];
    const first = await runCli(args);
    const second = await runCli(args);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const one = JSON.parse(first.stdout) as { personId: string; leadId: string };
    const two = JSON.parse(second.stdout) as { personId: string; leadId: string };
    expect(one.personId).toBeTruthy();
    expect(one.leadId).toBeTruthy();
    expect(two.personId).toBe(one.personId);
    expect(two.leadId).toBe(one.leadId);
    const identities = await db.selectFrom("identity.identities").select("id")
      .where("tenant_id", "=", tenantId).where("normalized_value", "=", waId.replace(/\D/g, "")).execute();
    expect(identities).toHaveLength(1);
  });

  it("real CLI composes a safe reply without sending an outbound message", async () => {
    const lead = await runCli(["resolve-lead", "--waId", `5512${randomUUID().replace(/-/g, "")}`]);
    expect(lead.code).toBe(0);
    const { personId } = JSON.parse(lead.stdout) as { personId: string };
    const conversation = await db.selectFrom("communication.conversations").select("id")
      .where("tenant_id", "=", tenantId).where("person_id", "=", personId).executeTakeFirstOrThrow();
    const before = await db.selectFrom("communication.messages").select("id")
      .where("tenant_id", "=", tenantId).where("direction", "=", "OUTBOUND").execute();
    const reply = await runCli(["reply", "--conversationId", conversation.id, "--inboundText", "Quais são as opções?", "--waId", "5512999999999"]);
    expect(reply.code, `reply stderr: ${reply.stderr}; stdout: ${reply.stdout}`).toBe(0);
    const body = JSON.parse(reply.stdout) as { handled: boolean; sent: boolean; text: string };
    expect(body).toMatchObject({ handled: true, sent: false });
    expect(body.text).toContain("Cross-repo integration plan");
    expect(body.text).not.toMatch(/\b(pagamento confirmado|pagamento recebido|serviço ativo|ativado|renovado|prazo garantido)\b/i);
    const after = await db.selectFrom("communication.messages").select("id")
      .where("tenant_id", "=", tenantId).where("direction", "=", "OUTBOUND").execute();
    expect(after).toHaveLength(before.length);
  });

  it("real CLI fails closed for an invalid token", async () => {
    const result = await runCli(["list-plans"], "invalid-synthetic-token");
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("real CLI fails closed when the API port is closed", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not reserve a port for unavailable API case");
    const closedPort = address.port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const result = await runCli(["list-plans"], token, `http://127.0.0.1:${closedPort}`);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("API remains the sole sender when bot sending is disabled", async () => {
    expect(process.env["STREAMMAX_BOT_ENABLED"]).toBe("false");
    const count = await db.selectFrom("communication.messages").select("id")
      .where("tenant_id", "=", tenantId).where("direction", "=", "OUTBOUND").execute();
    expect(count).toHaveLength(0);
  });
});
