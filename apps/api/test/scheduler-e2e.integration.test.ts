import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { applyMigrations, createDb, withTenantTransaction, type Database } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";
import { registerObservabilityHook } from "../src/observability-hook.js";
import { CommandBus } from "../src/commands/command-bus.js";
import { OutboxDrainer } from "../src/outbox/outbox-drainer.js";
import { LocalTransport } from "../src/outbox/transport.js";
import { SchedulerService } from "../src/scheduler/scheduler.service.js";

/**
 * EXEC-SCHEDULER-E2E-20261020 (test-only, banco descartável vazio).
 *
 * Prova via HTTP + tick, sob a identidade efetiva `iptv_app` (NOBYPASSRLS),
 * que:
 * - o tick do scheduler converge fila seeded (trial expirado → ENDED +
 *   recover→drain→reconcile da fila durable → HUMAN_REQUIRED no seam
 *   default, sem efeito externo, sem re-send) e isola a perna de outbox
 *   (fail-closed sob `iptv_app` sem matar o resto do tick);
 * - os drains admin de provider-dispatch funcionam via HTTP autenticado como
 *   plataforma (403 para não-admin, 200 + transições assertadas para
 *   platform-admin);
 * - o drain admin de outbox via HTTP é fail-closed sob `iptv_app` (500: a
 *   API least-privilege não tem DML em `platform.outbox_messages`; publicar
 *   é do worker lane 050/051) e a mesma fila converge no lane legado
 *   declarado (modo 051 = LEGACY, drain owner).
 *
 * Não toca scheduler prod, nem 051/interlock, nem RLS/policies, nem pool
 * prod. Porta externa: nenhuma (o seam default `manual` estaciona
 * HUMAN_REQUIRED antes de qualquer send — prova sem live provider).
 * Segredo temporário do role cluster-global `iptv_app`: hex aleatório por
 * run, reset para NULL no teardown — mesmo padrão dos rehearsals RLS irmãos.
 * P8: worker exercido via 051-legado declarado (o DB fresco semeia
 * `outbox_runtime_control` em LEGACY) — sem API_SCHEDULER_ENABLED em prod.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const PERMISSIONS = [
  "crm.person.read",
  "crm.lead.write",
  "trial.read",
  "trial.write",
  "provider.operation.read",
  "provider.operation.write",
  "commerce.order.write",
  "billing.read",
  "billing.charge.write",
  "subscription.read",
  "subscription.write",
  "agent.review.request",
  "agent.review.decide",
];

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(-12)}@example.com`;
}

function withAppIdentity(base: string, password: string): string {
  const url = new URL(base);
  url.username = "iptv_app";
  url.password = password;
  return url.toString();
}

describe.skipIf(!hasDb)("Scheduler + admin drains E2E sob iptv_app (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });
  let appDb: Kysely<Database>;
  let appUrl = "";

  let token = "";
  let tenantId = "";
  let userId = "";
  let bus: CommandBus;
  let ownerDrainer: OutboxDrainer;
  let scheduler: SchedulerService;

  const suffix = newId().replace(/-/g, "").slice(-12);
  let providerId = "";

  const savedEnv: Record<string, string | undefined> = {
    APP_DATABASE_URL: process.env["APP_DATABASE_URL"],
    DATABASE_URL: process.env["DATABASE_URL"],
    BETTER_AUTH_SECRET: process.env["BETTER_AUTH_SECRET"],
    API_SCHEDULER_ENABLED: process.env["API_SCHEDULER_ENABLED"],
    PROVIDER_OPS_ADAPTER: process.env["PROVIDER_OPS_ADAPTER"],
    PROVIDER_DISPATCH_MODE: process.env["PROVIDER_DISPATCH_MODE"],
    ASAAS_ECHO_CREATE: process.env["ASAAS_ECHO_CREATE"],
    ASAAS_ECHO_RECONCILE: process.env["ASAAS_ECHO_RECONCILE"],
    LEGACY_OUTBOX_DRAIN_ENABLED: process.env["LEGACY_OUTBOX_DRAIN_ENABLED"],
  };

  function restoreEnv(): void {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  function actor(): CommandActor {
    return {
      userId,
      isPlatformAdmin: false,
      tenantId,
      roleKeys: ["tenant_owner"],
      permissions: PERMISSIONS,
      actorType: "human",
    };
  }

  function injectRaw(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    revision?: string | null;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
      if (opts.revision !== null) {
        headers["x-tenant-context-revision"] = opts.revision ?? "0";
      }
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

  async function setPlatformAdmin(value: boolean): Promise<void> {
    await db.updateTable("control.users").set({ is_platform_admin: value }).where("id", "=", userId).execute();
  }

  /** ACTIVE trial cuja expiração é forçada para o passado (SQL time travel). */
  async function seedExpiredTrial(): Promise<string> {
    const person = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Scheduler E2E Person",
    });
    if (!person.ok) {
      throw new Error(`person.register failed: ${JSON.stringify(person)}`);
    }
    const requested = await bus.execute<{ id: string | null }>(actor(), "trial.request", {
      personId: person.data.id,
      durationMinutes: 60,
    });
    if (!requested.ok || requested.data.id === null) {
      throw new Error(`trial.request failed: ${JSON.stringify(requested)}`);
    }
    const trialId = requested.data.id;
    const provisioned = await bus.execute<{ status: string }>(actor(), "trial.begin_provisioning", {
      trialId,
      adapter: "echo",
    });
    if (!provisioned.ok || provisioned.data.status !== "ACTIVE") {
      throw new Error(`begin_provisioning failed: ${JSON.stringify(provisioned)}`);
    }
    await db
      .updateTable("trial.trials")
      .set({ activated_at: new Date(Date.now() - 2 * 3_600_000), expires_at: new Date(Date.now() - 3_600_000) })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", trialId)
      .execute();
    return trialId;
  }

  async function ensureProvider(): Promise<void> {
    const existing = await db
      .selectFrom("provider.providers")
      .select(["id"])
      .where("provider_key", "=", "cinevision")
      .executeTakeFirst();
    if (existing !== undefined) {
      providerId = existing.id;
      return;
    }
    const created = await db
      .insertInto("provider.providers")
      .values({
        id: newId(),
        provider_key: "cinevision",
        name: "CINEVISION",
        provider_type: "FULFILLMENT",
        status: "ACTIVE",
        created_at: new Date(),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    providerId = created.id;
  }

  /**
   * Linha durable `trial.provision` secret-required plantada à mão (setup via
   * owner, sem passar pelo request handler): elegível ao `dispatch_claim`
   * (`REQUESTED` + `adapter_version = secret-required-v1`), com lease
   * expirado pré-send quando `crashed=true` (candidata ao `recoverOnce`).
   * O seam default (`manual`, sem conta descartável designada) estaciona
   * HUMAN_REQUIRED antes de qualquer send — prova sem live provider.
   */
  async function seedProviderOp(crashed: boolean): Promise<{ opId: string; trialId: string }> {
    const person = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: `Scheduler E2E Op ${crashed ? "crashed" : "queued"}`,
    });
    if (!person.ok) {
      throw new Error(`person.register failed: ${JSON.stringify(person)}`);
    }
    const requested = await bus.execute<{ id: string | null }>(actor(), "trial.request", {
      personId: person.data.id,
      durationMinutes: 60,
    });
    if (!requested.ok || requested.data.id === null) {
      throw new Error(`trial.request failed: ${JSON.stringify(requested)}`);
    }
    const trialId = requested.data.id;
    // Reuso respeita a invariante "um binding vivo por (tenant, provider, env)":
    // `trial.request` já plantou o placeholder SANDBOX via ensureTrialProviderAccount.
    const live = await db
      .selectFrom("provider.provider_accounts")
      .select(["id"])
      .where("tenant_id", "=", tenantId)
      .where("provider_id", "=", providerId)
      .where("environment", "=", "SANDBOX")
      .where("connection_status", "<>", "DISABLED")
      .orderBy("created_at", "asc")
      .executeTakeFirst();
    const accountId = live?.id ?? newId();
    if (live === undefined) {
      await db
        .insertInto("provider.provider_accounts")
        .values({
          id: accountId,
          tenant_id: tenantId,
          provider_id: providerId,
          name: `Scheduler E2E account ${suffix}`,
          status: "ACTIVE",
          secret_ref: `infisical://scheduler-e2e/${suffix}`,
          environment: "SANDBOX",
          connection_status: "NOT_CONFIGURED",
          version: 1,
          settings_json: { synthetic: true },
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
    }
    const opId = newId();
    await db
      .insertInto("provider.provider_operations")
      .values({
        id: opId,
        tenant_id: tenantId,
        provider_account_id: accountId,
        action: "trial.provision",
        entity_type: "trial",
        entity_id: trialId,
        status: crashed ? "QUEUED" : "REQUESTED",
        idempotency_key: `trial-provision:${trialId}`,
        execution_channel: null,
        adapter_version: "secret-required-v1",
        requested_payload_json: { duration_minutes: 60 },
        result_summary_json: null,
        requested_at: new Date(),
        started_at: null,
        completed_at: null,
        correlation_id: newId(),
        effect_certainty: "UNKNOWN",
        claimed_by: crashed ? "crashed-worker" : null,
        claimed_at: crashed ? new Date() : null,
        lease_expires_at: crashed ? new Date(Date.now() - 60_000) : null,
        dispatch_started_at: null,
      })
      .execute();
    return { opId, trialId };
  }

  async function getOpStatus(opId: string): Promise<string> {
    const row = await db
      .selectFrom("provider.provider_operations")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", opId)
      .executeTakeFirstOrThrow();
    return row.status;
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    await db
      .updateTable("platform.capabilities")
      .set({ availability: "AVAILABLE", certification_status: "CERTIFIED" })
      .where("key", "=", "provider.cinevision")
      .execute();
    await ensureProvider();
    // Identidade efetiva `iptv_app` (sem SET ROLE: o pool autentica como o
    // role de verdade). Senha temporária hex por run, reset no teardown.
    const appPassword = `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
    if (!/^[0-9a-f]{32,}$/.test(appPassword)) {
      throw new Error("unsafe generated app password");
    }
    await sql.raw(`ALTER ROLE iptv_app WITH LOGIN PASSWORD '${appPassword}'`).execute(db);
    appUrl = withAppIdentity(connectionString as string, appPassword);
    appDb = createDb({ connectionString: appUrl });

    process.env["DATABASE_URL"] = connectionString as string;
    process.env["APP_DATABASE_URL"] = appUrl;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    delete process.env["API_SCHEDULER_ENABLED"];
    delete process.env["PROVIDER_OPS_ADAPTER"];
    delete process.env["PROVIDER_DISPATCH_MODE"];
    delete process.env["ASAAS_ECHO_CREATE"];
    delete process.env["ASAAS_ECHO_RECONCILE"];
    delete process.env["LEGACY_OUTBOX_DRAIN_ENABLED"];

    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    registerObservabilityHook(app);
    await app.init();
    bus = app.get(CommandBus);
    ownerDrainer = new OutboxDrainer(db, new LocalTransport());
    scheduler = app.get(SchedulerService);

    const register = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("sched-e2e"), password: "correct-horse-8", tenantName: "Scheduler E2E Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;
  }, 180_000);

  afterAll(async () => {
    let resetError: unknown = null;
    try {
      if (hasDb && ownerDrainer !== undefined) {
        const drainBudgetUntil = Date.now() + 6000;
        for (;;) {
          if (Date.now() >= drainBudgetUntil) break;
          const drained = await ownerDrainer.drain(50).catch(() => undefined);
          if (drained === undefined || drained.claimed === 0) break;
        }
      }
      await app?.close().catch(() => undefined);
      await appDb?.destroy().catch(() => undefined);
      // Reset da senha cluster-global `iptv_app` com prazo: falha de
      // restauração é erro explícito do teardown (nunca suprimida), para um
      // vazamento de credencial nunca ser reportado como run verde.
      if (hasDb) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            sql.raw("ALTER ROLE iptv_app WITH PASSWORD NULL").execute(db),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("teardown: iptv_app password reset timed out after 15000ms")),
                15000,
              );
              timer.unref?.();
            }),
          ]);
        } catch (err) {
          resetError = err;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      await db.destroy().catch(() => undefined);
    } finally {
      restoreEnv();
    }
    if (resetError) {
      throw resetError;
    }
  }, 60_000);

  it("executa sob iptv_app (NOBYPASSRLS) e falha fechado sem contexto", async () => {
    const who = await sql<{ u: string; su: string }>`
      SELECT current_user AS u, current_setting('is_superuser') AS su
    `.execute(appDb);
    expect(who.rows[0]?.u).toBe("iptv_app");
    expect(who.rows[0]?.su).toBe("off");
    const bypass = await sql<{ rolbypassrls: boolean }>`
      SELECT rolbypassrls FROM pg_roles WHERE rolname = 'iptv_app'
    `.execute(db);
    expect(bypass.rows[0]?.rolbypassrls).toBe(false);

    const person = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Scheduler E2E RLS Probe",
    });
    if (!person.ok) {
      throw new Error(`person.register failed: ${JSON.stringify(person)}`);
    }
    // Sem contexto → fail-closed (0 rows), mesmo com linhas do tenant.
    expect(await appDb.selectFrom("identity.persons").select(["id"]).execute()).toHaveLength(0);
    // Contexto correto → enxerga as próprias linhas.
    const seen = await withTenantTransaction(appDb, tenantId, (trx) =>
      trx.selectFrom("identity.persons").select(["id"]).execute(),
    );
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });

  it("tick converge fila seeded (trial ENDED + recover→drain→reconcile → HUMAN_REQUIRED)", async () => {
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    try {
      const trialId = await seedExpiredTrial();
      const { opId, trialId: opTrialId } = await seedProviderOp(true);
      expect(await getOpStatus(opId)).toBe("QUEUED");

      const result = await scheduler.tick();
      // Sob `iptv_app` o lane legado de outbox é fail-closed por desenho (a
      // API least-privilege não tem DML em `platform.outbox_messages`; a
      // publicação pertence ao worker lane 050/051). O tick registra o erro
      // isolado e CONVERGE todo o resto — failure isolation contratual.
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("outbox.drain");
      expect(result.tenants).toBeGreaterThanOrEqual(1);
      // Pernas durable do tick executaram (recover→drain→reconcile, nessa ordem).
      expect(result.commands["provider.dispatch_recovery"]?.ok).toBeGreaterThanOrEqual(1);
      expect(result.commands["provider.dispatch_due"]?.ok).toBeGreaterThanOrEqual(1);
      expect(result.commands["provider.dispatch_reconcile"]?.ok).toBeGreaterThanOrEqual(1);

      const trial = await db
        .selectFrom("trial.trials")
        .select(["lifecycle_status"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", trialId)
        .executeTakeFirstOrThrow();
      expect(trial.lifecycle_status).toBe("ENDED");

      // Fila durable convergiu no seam default: recover liberou o lease
      // expirado pré-send e o drain estacionou HUMAN_REQUIRED antes de
      // qualquer send (sem conta descartável designada / sem port
      // secret-requiring). Terminal conforme o seam, nunca re-enviado.
      expect(await getOpStatus(opId)).toBe("HUMAN_REQUIRED");
      const bindings = await db
        .selectFrom("provider.provider_bindings")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("entity_type", "=", "trial")
        .where("entity_id", "=", opTrialId)
        .execute();
      expect(bindings).toHaveLength(0);

      // A fila de outbox do tenant EXISTE (eventos emitidos) mas o lane da
      // API não a publica — a convergência dela é provada no teste do drain
      // admin (lane legado declarado via owner).
      const leftoverForTenant = () =>
        db
          .selectFrom("platform.outbox_messages")
          .select(["id"])
          .where("tenant_id", "=", tenantId)
          .where("state", "in", ["PENDING", "FAILED"])
          .where("next_attempt_at", "<=", new Date())
          .execute();
      expect((await leftoverForTenant()).length).toBeGreaterThanOrEqual(1);

      // Segundo tick idempotente: o mesmo erro isolado, fila segue terminal.
      const second = await scheduler.tick();
      expect(second.errors).toHaveLength(1);
      expect(second.errors[0]).toContain("outbox.drain");
      expect(await getOpStatus(opId)).toBe("HUMAN_REQUIRED");
    } finally {
      delete process.env["PROVIDER_DISPATCH_MODE"];
    }
  }, 180_000);

  it("drains admin de provider-dispatch via HTTP autenticado como plataforma", async () => {
    for (const route of ["recover", "drain", "reconcile"]) {
      const forbidden = await injectRaw({
        method: "POST",
        url: `/v1/admin/provider-dispatch/${route}`,
        token,
        payload: { limit: 10 },
      });
      expect(forbidden.statusCode).toBe(403);
    }

    await setPlatformAdmin(true);
    try {
      const { opId, trialId } = await seedProviderOp(false);
      expect(await getOpStatus(opId)).toBe("REQUESTED");

      const recovered = await injectRaw({
        method: "POST",
        url: "/v1/admin/provider-dispatch/recover",
        token,
        payload: { limit: 100 },
      });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json<{ released: number }>().released).toBe(0);

      const drained = await injectRaw({
        method: "POST",
        url: "/v1/admin/provider-dispatch/drain",
        token,
        payload: { limit: 10 },
      });
      expect(drained.statusCode).toBe(200);
      const drainBody = drained.json<{ claimed: number; humanRequired: number; operationIds: string[] }>();
      expect(drainBody.claimed).toBe(1);
      expect(drainBody.operationIds).toContain(opId);
      expect(drainBody.humanRequired).toBe(1);
      expect(await getOpStatus(opId)).toBe("HUMAN_REQUIRED");

      const reconciled = await injectRaw({
        method: "POST",
        url: "/v1/admin/provider-dispatch/reconcile",
        token,
        payload: { limit: 100 },
      });
      expect(reconciled.statusCode).toBe(200);

      // Fila convergiu: drains seguintes reclamam zero (idempotente).
      const redrained = await injectRaw({
        method: "POST",
        url: "/v1/admin/provider-dispatch/drain",
        token,
        payload: { limit: 10 },
      });
      expect(redrained.statusCode).toBe(200);
      expect(redrained.json<{ claimed: number }>().claimed).toBe(0);
      expect(await getOpStatus(opId)).toBe("HUMAN_REQUIRED");

      const bindings = await db
        .selectFrom("provider.provider_bindings")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("entity_type", "=", "trial")
        .where("entity_id", "=", trialId)
        .execute();
      expect(bindings).toHaveLength(0);
    } finally {
      await setPlatformAdmin(false);
    }
  }, 180_000);

  it("drain admin de outbox: HTTP fail-closed sob iptv_app + convergência no lane legado declarado", async () => {
    const forbidden = await injectRaw({ method: "POST", url: "/v1/admin/outbox/drain", token, payload: { limit: 10 } });
    expect(forbidden.statusCode).toBe(403);
    const forbiddenState = await injectRaw({ method: "GET", url: "/v1/admin/outbox/drain-state", token });
    expect(forbiddenState.statusCode).toBe(403);

    await setPlatformAdmin(true);
    try {
      // Snapshot pré-drain (owner): prova ausência de mutação no fail-closed.
      const outboxSnapshot = () =>
        db
          .selectFrom("platform.outbox_messages")
          .select(["id", "state", "attempt_count"])
          .where("tenant_id", "=", tenantId)
          .orderBy("id", "asc")
          .execute();
      const beforeRows = await outboxSnapshot();
      expect(beforeRows.length).toBeGreaterThanOrEqual(1);
      const apiTransport = app.get("TRANSPORT") as LocalTransport;
      const beforeTransport = apiTransport.count();
      // Sob `iptv_app` a publicação é fail-closed (sem DML em
      // `platform.outbox_messages` por desenho — lane do worker 050/051):
      // o endpoint autentica e autoriza (platform-admin passa), mas a
      // publicação recusa sem vazar detalhe interno além do 500.
      const denied = await injectRaw({
        method: "POST",
        url: "/v1/admin/outbox/drain",
        token,
        payload: { limit: 50 },
      });
      expect(denied.statusCode).toBe(500);
      // Causa na identidade efetiva da API: sem privilégio de tabela para
      // `iptv_app` (42501), não um erro genérico.
      const probe = await appDb
        .selectFrom("platform.outbox_messages")
        .select(["id"])
        .limit(1)
        .execute()
        .then(() => null as unknown)
        .catch((err: unknown) => err as { code?: string; message?: string });
      expect(probe).not.toBeNull();
      expect((probe as { code?: string } | null)?.code).toBe("42501");
      expect(String((probe as { message?: string } | null)?.message ?? "")).toContain("permission denied");
      // Ausência de publicação/mutação: transporte da API intacto e linhas
      // do tenant idênticas antes/depois.
      expect(apiTransport.count()).toBe(beforeTransport);
      expect(await outboxSnapshot()).toEqual(beforeRows);

      // Leitura de estado funciona no mesmo contexto/identidade.
      const state = await injectRaw({ method: "GET", url: "/v1/admin/outbox/drain-state", token });
      expect(state.statusCode).toBe(200);
      expect(state.json<{ enabled: boolean }>().enabled).toBe(true);

      // P8 "legado declarado": o modo de runtime 051 segue LEGACY no DB
      // fresco, e o lane legado (owner) publica a fila do tenant até
      // convergência — sem tocar 051/interlock, RLS ou scheduler prod.
      const mode = await sql<{ mode: string }>`SELECT platform.outbox_runtime_mode() AS mode`.execute(db);
      expect(mode.rows[0]?.mode).toBe("LEGACY");
      const dueBefore = await db
        .selectFrom("platform.outbox_messages")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("state", "in", ["PENDING", "FAILED"])
        .where("next_attempt_at", "<=", new Date())
        .execute();
      expect(dueBefore.length).toBeGreaterThanOrEqual(1);
      const dueBeforeIds = new Set(dueBefore.map((row) => row.id));
      let published = 0;
      let failed = 0;
      let claimedTotal = 0;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const drained = await ownerDrainer.drain(50);
        expect(drained.failed).toBe(0);
        published += drained.published;
        failed += drained.failed;
        claimedTotal += drained.claimed;
        if (drained.claimed === 0) break;
      }
      expect(claimedTotal).toBeGreaterThanOrEqual(1);
      expect(published).toBeGreaterThanOrEqual(dueBefore.length);
      expect(failed).toBe(0);
      // Todas as linhas semeadas convergiram para PUBLISHED (nada parcial).
      const afterSeeded = await db
        .selectFrom("platform.outbox_messages")
        .select(["id", "state"])
        .where("tenant_id", "=", tenantId)
        .where("id", "in", [...dueBeforeIds])
        .execute();
      expect(afterSeeded.length).toBe(dueBefore.length);
      for (const row of afterSeeded) {
        expect(row.state).toBe("PUBLISHED");
      }
      // Sem resíduo terminal: nenhuma linha do tenant em estado transitório
      // (PENDING vencido ou não, PUBLISHING ou FAILED com backoff futuro).
      const residue = await db
        .selectFrom("platform.outbox_messages")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("state", "in", ["PENDING", "PUBLISHING", "FAILED"])
        .execute();
      expect(residue).toHaveLength(0);
    } finally {
      await setPlatformAdmin(false);
    }
  }, 180_000);
});
