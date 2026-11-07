import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { applyMigrations, createDb } from "@iptv/database";
import { newId } from "@iptv/domain";
import { encryptSecret, secretAad } from "@iptv/secrets";
import { sql } from "kysely";
import { AppModule } from "../src/app.module.js";
import {
  __resetIntegrationTestDoubles,
  __setIntegrationTestDoubles,
} from "../src/integrations/integrations.commands.js";
import type {
  CinevisionProbeOutcome,
  CinevisionWorkerRunner,
} from "../src/integrations/cinevision-worker-probe.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";

/**
 * SIMPLIFY-01 legacy-binding compatibility (PR #123 correction).
 *
 * The one-time migration keeps `provider.provider_accounts.secret_ref`
 * untouched and stores ciphertext under that EXACT ref, including the
 * backend-owned secondary keys (`CINEVISION_PASS`, `ASAAS_WEBHOOK_TOKEN`).
 * A legacy `infisical://` binding therefore only resolves if derived refs
 * preserve the binding scheme; deriving `pgsecret://` always made CINEVISION
 * lose the password and made Asaas generate a second webhook token.
 *
 * This suite uses the REAL PostgreSQL secrets adapter (no vault double):
 * rows are seeded exactly the way `migrate-secrets-to-postgres.mjs` writes
 * them, then the real command handlers resolve + decrypt them.
 *
 * No external call happens: the CINEVISION probe and the Asaas HTTP client
 * are deterministic fakes, so no panel write and no real webhook is created.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const KEY_B64 = randomBytes(32).toString("base64");
const KEY = Buffer.from(KEY_B64, "base64");
const previousKey = process.env["SECRETS_ENCRYPTION_KEY"];

// Synthetic fixtures (never real credentials, never `sk-`).
const LEGACY_USER = "simplify01-legacy-cine-user";
const LEGACY_PASS = "simplify01-legacy-cine-pass";
const LEGACY_API_KEY = "simplify01-legacy-asaas-credential";
const LEGACY_WEBHOOK_TOKEN = "simplify01-legacy-webhook-token-0123456789abcdef0123456789abcdef";
const FRESH_API_KEY = "simplify01-fresh-asaas-credential";

const PUBLIC_BASE = "https://simplify01.example.com";

type Provider = "asaas" | "cinevision";

function legacyRef(environment: string, tenantId: string, provider: Provider, key: string): string {
  return `infisical://${environment}/integrations/${tenantId}/${provider}/${key}`;
}

function pgRef(environment: string, tenantId: string, provider: Provider, key: string): string {
  return `pgsecret://${environment}/integrations/${tenantId}/${provider}/${key}`;
}

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(0, 12)}@example.com`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

class FakeProbe implements CinevisionWorkerRunner {
  readonly calls: Array<{ hasUsername: boolean; hasPassword: boolean }> = [];
  async runProbe(input: {
    tenantId: string;
    providerAccountId: string;
    username: string;
    password: string;
  }): Promise<CinevisionProbeOutcome> {
    this.calls.push({
      hasUsername: input.username.length > 0,
      hasPassword: input.password.length > 0,
    });
    return { ok: true };
  }
}

interface FakeWebhook {
  id: string;
  url: string;
}

let remoteWebhooks: FakeWebhook[] = [];
let webhookSeq = 0;
const seenLists: Array<{ accessToken: string | null }> = [];
const seenSaves: Array<{ method: string; authToken: unknown; url: string }> = [];

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const headers = new Headers(init?.headers);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.includes("/v3/webhooks") && method === "GET") {
    seenLists.push({ accessToken: headers.get("access_token") });
    return jsonResponse({ data: remoteWebhooks, totalCount: remoteWebhooks.length });
  }
  if (url.includes("/v3/webhooks") && (method === "POST" || method === "PUT")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seenSaves.push({ method, authToken: body["authToken"], url: String(body["url"] ?? "") });
    if (method === "POST") {
      webhookSeq += 1;
      const created: FakeWebhook = { id: `wh_simplify01_${webhookSeq}`, url: String(body["url"] ?? "") };
      remoteWebhooks.push(created);
      return jsonResponse({
        id: created.id,
        name: body["name"],
        url: created.url,
        email: body["email"],
        enabled: true,
        interrupted: false,
        apiVersion: 3,
        hasAuthToken: true,
        sendType: "SEQUENTIALLY",
        events: body["events"],
      });
    }
    const id = decodeURIComponent(url.split("/").pop() ?? "");
    const found = remoteWebhooks.find((webhook) => webhook.id === id);
    return jsonResponse({
      id,
      name: body["name"],
      url: found?.url ?? body["url"],
      email: body["email"],
      enabled: true,
      interrupted: false,
      apiVersion: 3,
      hasAuthToken: true,
      sendType: "SEQUENTIALLY",
      events: body["events"],
    });
  }
  return new Response("unexpected fake route", { status: 500 });
}

describe.skipIf(!hasDb)("legacy secret refs stay resolvable (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  const probe = new FakeProbe();
  let app: NestFastifyApplication;

  let tokenA = "";
  let tenantA = "";
  let tokenB = "";
  let tenantB = "";
  let tokenC = "";
  let tenantC = "";
  let tokenD = "";
  let tenantD = "";

  function inject(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    revision?: string | null;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
    }
    if (opts.token !== undefined && opts.revision !== null) {
      headers["x-tenant-context-revision"] = opts.revision ?? "0";
    }
    const options: {
      method: "GET" | "POST";
      url: string;
      headers: Record<string, string>;
      payload?: Record<string, unknown>;
    } = { method: opts.method, url: opts.url, headers };
    if (opts.payload !== undefined) {
      options.payload = opts.payload;
    }
    return app.getHttpAdapter().getInstance().inject(options);
  }

  async function register(prefix: string): Promise<{ token: string; tenantId: string }> {
    const res = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email(prefix), password: "correct-horse-8", tenantName: `Simplify ${prefix}` },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ token: string; activeTenantId: string }>();
    return { token: body.token, tenantId: body.activeTenantId };
  }

  async function seedSecret(tenantId: string, ref: string, value: string): Promise<void> {
    await db
      .insertInto("platform.secret_values")
      .values({
        tenant_id: tenantId,
        secret_ref: ref,
        ciphertext: encryptSecret(value, KEY, secretAad(tenantId, ref)),
        created_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .execute();
  }

  async function dropSecret(tenantId: string, ref: string): Promise<void> {
    await db
      .deleteFrom("platform.secret_values")
      .where("tenant_id", "=", tenantId)
      .where("secret_ref", "=", ref)
      .execute();
  }

  async function secretRows(tenantId: string): Promise<Array<{ secret_ref: string; ciphertext: string }>> {
    return db
      .selectFrom("platform.secret_values")
      .select(["secret_ref", "ciphertext"])
      .where("tenant_id", "=", tenantId)
      .execute();
  }

  async function bindingOf(tenantId: string, provider: Provider) {
    return db
      .selectFrom("provider.provider_accounts")
      .innerJoin("provider.providers", "provider.providers.id", "provider.provider_accounts.provider_id")
      .select(["provider.provider_accounts.id", "provider.provider_accounts.secret_ref"])
      .where("provider.provider_accounts.tenant_id", "=", tenantId)
      .where("provider.providers.provider_key", "=", provider)
      .where("provider.provider_accounts.environment", "=", "SANDBOX")
      .where("provider.provider_accounts.connection_status", "<>", "DISABLED")
      .executeTakeFirstOrThrow();
  }

  async function setBindingRef(tenantId: string, provider: Provider, ref: string): Promise<void> {
    const binding = await bindingOf(tenantId, provider);
    await db
      .updateTable("provider.provider_accounts")
      .set({ secret_ref: ref })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", binding.id)
      .execute();
  }

  /**
   * Turn a freshly configured binding into the exact post-migration state:
   * the domain row keeps the legacy ref and both credentials live under it.
   * `refEnvironment` models a legacy ref whose environment spelling differs
   * from the `provider_accounts.environment` column (e.g. `sandbox`).
   */
  async function makeLegacy(input: {
    tenantId: string;
    provider: Provider;
    primaryKey: string;
    values: Record<string, string>;
    refEnvironment?: string;
  }): Promise<void> {
    const refEnvironment = input.refEnvironment ?? "SANDBOX";
    const primaryRef = pgRef("SANDBOX", input.tenantId, input.provider, input.primaryKey);
    const legacyPrimaryRef = legacyRef(
      refEnvironment,
      input.tenantId,
      input.provider,
      input.primaryKey,
    );
    for (const key of Object.keys(input.values)) {
      if (key !== input.primaryKey) {
        await dropSecret(input.tenantId, pgRef("SANDBOX", input.tenantId, input.provider, key));
      }
      const value = input.values[key] as string;
      await seedSecret(
        input.tenantId,
        legacyRef(refEnvironment, input.tenantId, input.provider, key),
        value,
      );
    }
    await dropSecret(input.tenantId, primaryRef);
    await setBindingRef(input.tenantId, input.provider, legacyPrimaryRef);
  }

  async function channelOf(tenantId: string) {
    return db
      .selectFrom("billing.tenant_channels")
      .select(["tenant_key", "webhook_secret_hash"])
      .where("tenant_id", "=", tenantId)
      .where("channel", "=", "ASAAS")
      .executeTakeFirst();
  }

  beforeAll(async () => {
    process.env["SECRETS_ENCRYPTION_KEY"] = KEY_B64;
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "simplify01-legacy-secret-0123456789";
    remoteWebhooks = [];
    webhookSeq = 0;
    __setIntegrationTestDoubles({
      cinevisionProbe: probe,
      asaasFetch: fakeFetch as typeof fetch,
      webhookBaseUrl: PUBLIC_BASE,
    });
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();

    const a = await register("legacy-a");
    tokenA = a.token;
    tenantA = a.tenantId;
    const b = await register("legacy-b");
    tokenB = b.token;
    tenantB = b.tenantId;
    const c = await register("legacy-c");
    tokenC = c.token;
    tenantC = c.tenantId;
    const d = await register("legacy-d");
    tokenD = d.token;
    tenantD = d.tenantId;
    expect(tenantB).not.toBe(tenantA);
    expect(tenantC).not.toBe(tenantA);
    expect(tenantD).not.toBe(tenantA);

    // Tenant A: real Control Center writes (pgsecret), then converted to the
    // exact state the one-time migration leaves behind (legacy refs).
    const cineConfigured = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/configure",
      token: tokenA,
      payload: { environment: "SANDBOX", secret: { username: LEGACY_USER, password: LEGACY_PASS } },
    });
    expect(cineConfigured.statusCode).toBe(201);
    await makeLegacy({
      tenantId: tenantA,
      provider: "cinevision",
      primaryKey: "CINEVISION_USER",
      values: { CINEVISION_USER: LEGACY_USER, CINEVISION_PASS: LEGACY_PASS },
    });

    const asaasConfigured = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenA,
      payload: { environment: "SANDBOX", secret: { apiKey: LEGACY_API_KEY } },
    });
    expect(asaasConfigured.statusCode).toBe(201);
    await makeLegacy({
      tenantId: tenantA,
      provider: "asaas",
      primaryKey: "ASAAS_API_KEY",
      values: { ASAAS_API_KEY: LEGACY_API_KEY },
      // Legacy refs can spell the environment differently from the DB column.
      refEnvironment: "sandbox",
    });
    // The migration copies the pre-existing webhook token under the same
    // legacy scheme, which is exactly what must be reused.
    await seedSecret(
      tenantA,
      legacyRef("sandbox", tenantA, "asaas", "ASAAS_WEBHOOK_TOKEN"),
      LEGACY_WEBHOOK_TOKEN,
    );

    // Tenant C: a brand-new configuration (must stay pgsecret).
    const freshConfigured = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenC,
      payload: { environment: "SANDBOX", secret: { apiKey: FRESH_API_KEY } },
    });
    expect(freshConfigured.statusCode).toBe(201);

    // Tenant D: legacy lowercase ref WITHOUT a migrated webhook token; the
    // first ensure must generate one and the retry must reuse it.
    const legacyD = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/configure",
      token: tokenD,
      payload: { environment: "SANDBOX", secret: { apiKey: LEGACY_API_KEY } },
    });
    expect(legacyD.statusCode).toBe(201);
    await makeLegacy({
      tenantId: tenantD,
      provider: "asaas",
      primaryKey: "ASAAS_API_KEY",
      values: { ASAAS_API_KEY: LEGACY_API_KEY },
      refEnvironment: "sandbox",
    });
  }, 120_000);

  afterAll(async () => {
    __resetIntegrationTestDoubles();
    await app?.close().catch(() => undefined);
    await (db as unknown as { destroy: () => Promise<void> }).destroy?.().catch(() => undefined);
    if (previousKey === undefined) {
      delete process.env["SECRETS_ENCRYPTION_KEY"];
    } else {
      process.env["SECRETS_ENCRYPTION_KEY"] = previousKey;
    }
  });

  it("Test A: legacy CINEVISION binding decrypts BOTH credentials and validates read-only", async () => {
    probe.calls.length = 0;
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/test",
      token: tokenA,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body["connection_status"]).toBe("CONNECTED_READ_ONLY");
    expect(body["last_error_code"]).toBeNull();
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]).toEqual({ hasUsername: true, hasPassword: true });

    // The legacy binding ref was not rewritten and both ciphertext rows live
    // under the legacy refs the migration wrote.
    const binding = await bindingOf(tenantA, "cinevision");
    const refs = (await secretRows(tenantA)).map((row) => row.secret_ref);
    expect(binding.secret_ref).toBe(legacyRef("SANDBOX", tenantA, "cinevision", "CINEVISION_USER"));
    expect(refs).toContain(legacyRef("SANDBOX", tenantA, "cinevision", "CINEVISION_PASS"));

    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain(LEGACY_USER);
    expect(dumped).not.toContain(LEGACY_PASS);
    expect(dumped).not.toMatch(/secret_ref|infisical|pgsecret/i);
  });

  it("Test B: legacy Asaas binding reuses the migrated webhook token (no second token)", async () => {
    seenSaves.length = 0;
    seenLists.length = 0;
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/webhook",
      token: tokenA,
      payload: { environment: "SANDBOX" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body["hasAuthToken"]).toBe(true);
    expect(body["status"]).toBe("ACTIVE");

    // The provider saw the tenant's migrated API key and the SAME authToken
    // that was migrated; no replacement token was generated.
    expect(seenLists.at(-1)?.accessToken).toBe(LEGACY_API_KEY);
    expect(seenSaves).toHaveLength(1);
    expect(seenSaves[0]?.method).toBe("POST");
    expect(seenSaves[0]?.authToken).toBe(LEGACY_WEBHOOK_TOKEN);

    const refs = (await secretRows(tenantA)).map((row) => row.secret_ref);
    expect((await bindingOf(tenantA, "asaas")).secret_ref).toBe(
      legacyRef("sandbox", tenantA, "asaas", "ASAAS_API_KEY"),
    );
    expect(refs).toContain(legacyRef("sandbox", tenantA, "asaas", "ASAAS_WEBHOOK_TOKEN"));
    expect(refs).not.toContain(pgRef("SANDBOX", tenantA, "asaas", "ASAAS_WEBHOOK_TOKEN"));
    expect((await channelOf(tenantA))?.webhook_secret_hash).toBe(sha256Hex(LEGACY_WEBHOOK_TOKEN));

    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain(LEGACY_WEBHOOK_TOKEN);
    expect(dumped).not.toContain(LEGACY_API_KEY);
  });

  it("Test B retry: the legacy token is reused again on the PUT path", async () => {
    seenSaves.length = 0;
    const res = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/webhook",
      token: tokenA,
      payload: { environment: "SANDBOX" },
    });
    expect(res.statusCode).toBe(201);
    expect(seenSaves).toHaveLength(1);
    expect(seenSaves[0]?.method).toBe("PUT");
    expect(seenSaves[0]?.authToken).toBe(LEGACY_WEBHOOK_TOKEN);
    const refs = (await secretRows(tenantA)).map((row) => row.secret_ref);
    expect(refs).not.toContain(pgRef("SANDBOX", tenantA, "asaas", "ASAAS_WEBHOOK_TOKEN"));
  });

  it("Test B2: a lowercase legacy binding generates ONE token and reuses it on retry", async () => {
    seenSaves.length = 0;
    const first = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/webhook",
      token: tokenD,
      payload: { environment: "SANDBOX" },
    });
    expect(first.statusCode).toBe(201);
    expect(seenSaves).toHaveLength(1);
    expect(seenSaves[0]?.method).toBe("POST");
    const firstToken = seenSaves[0]?.authToken;
    expect(typeof firstToken).toBe("string");
    expect((firstToken as string).length).toBeGreaterThanOrEqual(32);

    const refsAfterFirst = (await secretRows(tenantD)).map((row) => row.secret_ref);
    // The generated token lives beside the legacy principal ref, matching the
    // ref spelling exactly (read and write cannot diverge).
    expect(refsAfterFirst).toContain(
      legacyRef("sandbox", tenantD, "asaas", "ASAAS_WEBHOOK_TOKEN"),
    );
    expect(refsAfterFirst.some((ref) => ref.startsWith("pgsecret://"))).toBe(false);

    const retry = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/webhook",
      token: tokenD,
      payload: { environment: "SANDBOX" },
    });
    expect(retry.statusCode).toBe(201);
    expect(seenSaves).toHaveLength(2);
    expect(seenSaves[1]?.method).toBe("PUT");
    expect(seenSaves[1]?.authToken).toBe(firstToken);
    const refsAfterRetry = (await secretRows(tenantD)).map((row) => row.secret_ref);
    expect(refsAfterRetry).toEqual(refsAfterFirst);
    expect((await channelOf(tenantD))?.webhook_secret_hash).toBe(
      sha256Hex(firstToken as string),
    );
  });

  it("Test C: a new configuration stores pgsecret refs, encrypted, and stays readable", async () => {
    const binding = await bindingOf(tenantC, "asaas");
    const apiKeyRef = pgRef("SANDBOX", tenantC, "asaas", "ASAAS_API_KEY");
    expect(binding.secret_ref).toBe(apiKeyRef);

    const row = (await secretRows(tenantC)).find((candidate) => candidate.secret_ref === apiKeyRef);
    expect(row?.ciphertext).toMatch(/^v1\./);
    expect(row?.ciphertext).not.toContain(FRESH_API_KEY);
    expect(JSON.stringify(await secretRows(tenantC))).not.toContain(FRESH_API_KEY);

    seenLists.length = 0;
    const tested = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/test",
      token: tokenC,
      payload: { environment: "SANDBOX" },
    });
    expect(tested.statusCode).toBe(201);
    expect(tested.json<Record<string, unknown>>()["connection_status"]).toBe("CONNECTED_READ_ONLY");
    expect(seenLists.at(-1)?.accessToken).toBe(FRESH_API_KEY);
    expect(JSON.stringify(tested.json())).not.toContain(FRESH_API_KEY);

    const ensured = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/webhook",
      token: tokenC,
      payload: { environment: "SANDBOX" },
    });
    expect(ensured.statusCode).toBe(201);
    const refs = (await secretRows(tenantC)).map((candidate) => candidate.secret_ref);
    expect(refs).toContain(pgRef("SANDBOX", tenantC, "asaas", "ASAAS_WEBHOOK_TOKEN"));
    expect(refs.some((ref) => ref.startsWith("infisical://"))).toBe(false);
  });

  it("Test D: another tenant and another environment see no binding (isolation)", async () => {
    const cine = await inject({
      method: "POST",
      url: "/v1/integrations/cinevision/test",
      token: tokenB,
      payload: {},
    });
    expect(cine.statusCode).toBe(404);
    expect(cine.json<{ code: string }>().code).toBe("NOT_FOUND");

    const asaas = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/test",
      token: tokenB,
      payload: { environment: "SANDBOX" },
    });
    expect(asaas.statusCode).toBe(404);

    // Sandbox configuration is not reachable from the Production environment.
    const production = await inject({
      method: "POST",
      url: "/v1/integrations/asaas/test",
      token: tokenC,
      payload: { environment: "PRODUCTION" },
    });
    expect(production.statusCode).toBe(404);

    const dumped = JSON.stringify([cine.json(), asaas.json(), production.json()]);
    for (const secret of [LEGACY_USER, LEGACY_PASS, LEGACY_API_KEY, FRESH_API_KEY]) {
      expect(dumped).not.toContain(secret);
    }
    expect(await secretRows(tenantB)).toEqual([]);
  });
});
