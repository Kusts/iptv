import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, applyMigrations } from "@iptv/database";
import { sql } from "kysely";
import { createHash } from "node:crypto";
import { BotServiceGuard } from "../src/bot/bot-service.guard.js";

const connectionString = process.env["TEST_DATABASE_URL"];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "db", "migrations");
const tenantId = "72000000-0000-4000-8000-000000000001";
const validToken = "1".repeat(64);
const expiredToken = "2".repeat(64);
const revokedToken = "3".repeat(64);
const pepper = "test-only-pepper";
const hashOf = (token: string) => createHash("sha256").update(`${pepper}:${token}`).digest("hex");

describe.skipIf(!connectionString)("BotServiceGuard integration", () => {
  const db = createDb({ connectionString: connectionString as string });
  const config = { STREAMMAX_BOT_API_ENABLED: "true", BOT_SERVICE_TOKEN_PEPPER: pepper } as never;
  function ctx(token: string) {
    const req = { headers: { authorization: `Bearer ${token}` } } as { headers: { authorization: string }; botService?: unknown };
    const context = { switchToHttp: () => ({ getRequest: () => req }) };
    return { ctx: context as never, req };
  }
  async function seed(hash: string, expiry: string) {
    await sql`insert into platform.bot_service_credentials
      (tenant_id, label, token_hash, token_prefix, scopes, created_at, expires_at)
      values (${tenantId}::uuid, 'guard-test', ${hash}, ${hash.slice(0, 8)},
       ARRAY['bot.streammax.execute'], '1990-01-01T00:00:00Z'::timestamptz,
       ${expiry}::timestamptz)
      on conflict (token_hash) do nothing`.execute(db);
  }
  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir });
    await sql`insert into control.tenants (id, slug, name, status) values
      (${tenantId}::uuid, 'bot-guard-test', 'Bot guard test', 'ACTIVE')
      on conflict (id) do update set status='ACTIVE'`.execute(db);
    await seed(hashOf(validToken), "2099-01-01");
    await seed(hashOf(expiredToken), "2000-01-01");
    await seed(hashOf(revokedToken), "2099-01-01");
    await sql`update platform.bot_service_credentials set revoked_at=now() where token_hash=${hashOf(revokedToken)}`.execute(db);
  });
  afterAll(async () => db.destroy());
  it("resolves a valid token and populates the request from the DB", async () => {
    const c = ctx(validToken);
    expect(await new BotServiceGuard(db, config).canActivate(c.ctx)).toBe(true);
    expect(c.req.botService).toMatchObject({ tenantId, scopes: ["bot.streammax.execute"] });
  });
  it.each([expiredToken, revokedToken, "4".repeat(64)])("rejects invalid/revoked/expired tokens", async (token) => {
    await expect(new BotServiceGuard(db, config).canActivate(ctx(token).ctx)).rejects.toMatchObject({ status: 401 });
  });
});
