import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDb,
  type Database,
} from "@iptv/database";
import { SecretsError } from "@iptv/secrets";
import { sql, type Kysely } from "kysely";
import { newId } from "@iptv/domain";
import { createPostgresSecretsAdapter } from "../src/integrations/postgres-secrets.js";

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const KEY = randomBytes(32).toString("base64");
const TARGET = {
  provider: "cinevision" as const,
  environment: "SANDBOX",
  key: "CINEVISION_USER",
  value: "browser-user-value",
};

describe.skipIf(!hasDb)("PostgreSQL secrets store (requires TEST_DATABASE_URL)", () => {
  const db: Kysely<Database> = createDb({ connectionString: connectionString as string });
  let tenantA = "";
  let tenantB = "";
  const previousKey = process.env["SECRETS_ENCRYPTION_KEY"];

  beforeAll(async () => {
    process.env["SECRETS_ENCRYPTION_KEY"] = KEY;
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    const rows = await db
      .insertInto("control.tenants")
      .values([
        {
          id: newId(),
          slug: `secret-a-${newId().slice(-8)}`,
          name: "Secret A",
          status: "ACTIVE",
          default_currency: "BRL",
          timezone: "America/Sao_Paulo",
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: newId(),
          slug: `secret-b-${newId().slice(-8)}`,
          name: "Secret B",
          status: "ACTIVE",
          default_currency: "BRL",
          timezone: "America/Sao_Paulo",
          created_at: new Date(),
          updated_at: new Date(),
        },
      ])
      .returning("id")
      .execute();
    tenantA = rows[0]?.id as string;
    tenantB = rows[1]?.id as string;
  });

  afterAll(async () => {
    if (tenantA !== "" && tenantB !== "") {
      await db.deleteFrom("platform.secret_values").where("tenant_id", "in", [tenantA, tenantB]).execute();
      await db.deleteFrom("control.tenants").where("id", "in", [tenantA, tenantB]).execute();
    }
    await db.destroy();
    if (previousKey === undefined) {
      delete process.env["SECRETS_ENCRYPTION_KEY"];
    } else {
      process.env["SECRETS_ENCRYPTION_KEY"] = previousKey;
    }
  });

  it("persists encrypted-only ciphertext and survives an adapter restart", async () => {
    const writer = createPostgresSecretsAdapter(db, tenantA);
    const put = await writer.putSecret({ tenantId: tenantA, ...TARGET });
    expect(put.ref.startsWith("pgsecret://")).toBe(true);
    expect(put.created).toBe(true);

    const raw = await db
      .selectFrom("platform.secret_values")
      .select(["secret_ref", "ciphertext"])
      .where("tenant_id", "=", tenantA)
      .where("secret_ref", "=", put.ref)
      .executeTakeFirstOrThrow();
    expect(raw.ciphertext).toMatch(/^v1\./);
    expect(raw.ciphertext).not.toContain(TARGET.value);
    expect(JSON.stringify(raw)).not.toContain(TARGET.value);

    // "API restart": a fresh adapter reads the same key from the environment.
    const restarted = createPostgresSecretsAdapter(db, tenantA);
    await expect(restarted.getSecret(put.ref)).resolves.toBe(TARGET.value);
  });

  it("does not let another tenant read the value", async () => {
    const a = createPostgresSecretsAdapter(db, tenantA);
    const ref = (
      await a.putSecret({ tenantId: tenantA, ...TARGET, value: "tenant-a-only" })
    ).ref;
    const b = createPostgresSecretsAdapter(db, tenantB);
    const err = await b.getSecret(ref).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretsError);
    expect((err as SecretsError).code).toBe("NOT_FOUND");
    expect(String(err)).not.toContain("tenant-a-only");
  });

  it("fails closed with a wrong key (no silent plaintext fallback)", async () => {
    const a = createPostgresSecretsAdapter(db, tenantA);
    const ref = (await a.putSecret({ tenantId: tenantA, ...TARGET, value: "key-check" })).ref;
    process.env["SECRETS_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
    try {
      const wrongKey = createPostgresSecretsAdapter(db, tenantA);
      await expect(wrongKey.getSecret(ref)).rejects.toMatchObject({ code: "SERVER" });
    } finally {
      process.env["SECRETS_ENCRYPTION_KEY"] = KEY;
    }
  });

  it("keeps RLS enabled and tenant-scoped on the new table", async () => {
    const state = await sql<{ relrowsecurity: boolean }>`
      select relrowsecurity from pg_class where oid = 'platform.secret_values'::regclass
    `.execute(db);
    expect(state.rows[0]?.relrowsecurity).toBe(true);
    const policies = await sql<{ policyname: string }>`
      select policyname from pg_policies
      where schemaname = 'platform' and tablename = 'secret_values'
    `.execute(db);
    expect(policies.rows.map((p) => p.policyname)).toContain("tenant_isolation");
  });

  it("RLS hides a tenant's rows from iptv_app under another tenant context", async () => {
    const a = createPostgresSecretsAdapter(db, tenantA);
    await a.putSecret({ tenantId: tenantA, ...TARGET, value: "rls-only-a" });

    const countFor = async (tenantId: string): Promise<string> =>
      db.transaction().execute(async (trx) => {
        await sql`set local role iptv_app`.execute(trx);
        await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
        const rows = await sql<{ count: string }>`
          select count(*)::text as count from platform.secret_values
        `.execute(trx);
        return rows.rows[0]?.count ?? "-1";
      });

    await expect(countFor(tenantA)).resolves.toBe("1");
    await expect(countFor(tenantB)).resolves.toBe("0");
  });
});
