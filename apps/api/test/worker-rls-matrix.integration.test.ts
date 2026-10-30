import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { createDb, applyMigrations, withTenantTransaction, type Database } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import { KyselyCommandDb } from "../src/commands/kysely-command-db.js";
import { registerCrmCommands } from "../src/crm/crm.commands.js";
import { registerPolicyCommands } from "../src/policy/policy.commands.js";
import { registerTrialCommands } from "../src/trial/trial.commands.js";
import { registerProviderCommands } from "../src/provider/provider.commands.js";
import { ProviderDispatcherService } from "../src/provider/provider-dispatcher.service.js";
import type {
  AdapterResult,
  ProviderOperationRequest,
  ProviderOpsPort,
  ProviderReadbackPort,
} from "../src/provider/provider-port.js";
import { StubTrialReadback } from "../src/trial/trial-readback.js";
import { FakeTrialReadback } from "./fakes/trial-readback-fake.js";

/**
 * EXEC-WORKER-RLS-MATRIX-20261020 (FIX-WORKER-RLS-REVIEW-20261020, test-only, sandbox descartável).
 *
 * Matriz em DB descartável vazio (TEST_DATABASE_URL):
 * - M1 crash/timeout: drain → recover → reconcile sem re-send
 *   (VERIFYING + business key EXATA `trial-provision:{trialId}` antes/depois
 *   do kill e no `browser.calls[].idempotencyKey`);
 * - M2 RLS sob a conexão efetiva `iptv_app` (052/055/056) + drains
 *   scheduler/admin: contexto correto lê, ausente fail-closed (0 rows),
 *   outro-tenant isolado — sem WHERE que substitua o RLS;
 * - M2-parity PgBouncer: opt-in explícito via `TEST_POOLED_DATABASE_URL`
 *   (ausência = teste skipped reportado ao runner); quando configurado, a
 *   mesma matriz nas duas conexões, falhando em erro/divergência;
 * - M3 fake TrialReadback conclusivo vs Stub (SUCCEEDED + HUMAN_REQUIRED).
 *
 * Não toca dispatcher prod, migrations, RLS policies ou pool prod.
 * Porta externa: só FakeBrowserPort em memória (zero live provider).
 * A senha temporária do role cluster-global `iptv_app` é por run com reset
 * para NULL no teardown (mesmo padrão dos rehearsals RLS irmãos): sem pooled,
 * hex aleatória gerada no teste; com pooled, a senha P embutida em
 * `TEST_POOLED_DATABASE_URL` (mesmo segredo do userlist.txt do pooler) —
 * sem segredo commitado.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

// Opt-in explícito do pooler (ex.: `docker compose --profile pooling up -d
// pgbouncer` + `TEST_POOLED_DATABASE_URL=postgresql://iptv_app:...@localhost:6432/iptv`).
// Ausência = parity test skipped e REPORTADO ao runner via `it.runIf` —
// nunca "skipped aceito" dentro de um `expect` verde (falso-verde).
const pooledConnectionString = process.env["TEST_POOLED_DATABASE_URL"];
const hasPooled = typeof pooledConnectionString === "string" && pooledConnectionString.length > 0;

const VALID_REF = "infisical://dispatch-worker-matrix/BROWSER_WORKER_KEY";
const TEST_TRIAL_CAPABILITY_KEY = "provider.cinevision-itest-worker-matrix-trial";

const CONFIGURED_SECRETS_PORT = {
  name: "infisical-test",
  async getSecret(): Promise<string> {
    throw new Error("must never be called by the dispatch path");
  },
};

class FakeBrowserPort implements ProviderOpsPort {
  readonly name = "browser";
  readonly requiresSecretRef = true;
  readonly calls: ProviderOperationRequest[] = [];
  mode: "success" | "hang" | "throw" = "success";

  async requestOperation(input: ProviderOperationRequest): Promise<AdapterResult> {
    this.calls.push(input);
    if (this.mode === "hang") {
      return new Promise<AdapterResult>(() => undefined);
    }
    if (this.mode === "throw") {
      throw new Error("fake port post-effect boom");
    }
    return { outcome: "SUCCEEDED", detail: "browser: ok", externalRef: `op-${input.entityId.slice(0, 8)}` };
  }
}

class ConclusiveGenericReadback implements ProviderReadbackPort {
  constructor(private readonly applied: boolean) {}
  async verify(): Promise<{ effectApplied: boolean; evidence: string; conclusive: boolean }> {
    return { effectApplied: this.applied, evidence: "itest:conclusive-generic", conclusive: true };
  }
}

function dumped(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function withAppIdentity(base: string, password: string): string {
  const url = new URL(base);
  url.username = "iptv_app";
  // FIX-POOLER-PW-20261020 (1): o setter `URL.password` do WHATWG preserva
  // `%` literal (sem re-encode), mas o driver `pg` decodifica uma vez ao
  // parsear. Atribuir a senha decodificada direto quebra a perna direta
  // quando ela contém `%` (ex.: P=`a%252Fb` → decodificada `a%2Fb` →
  // preservada `a%2Fb` → driver lê `a/b` ≠ `a%2Fb`, SCRAM falha).
  // Pré-codificar garante round-trip para `%` literal e sequências %HH.
  url.password = encodeURIComponent(password);
  return url.toString();
}

// Paridade pooled (FIX-POOLER-PW-20261020): quando TEST_POOLED_DATABASE_URL
// está presente, a senha P dela é HONRADA como senha do role `iptv_app`
// (pooler→servidor faz SCRAM com o mesmo segredo da conexão direta).
// Gerar uma senha aleatória R aqui e ignorar P quebra o login pooler→servidor
// antes da matriz. Sem pooled, mantém o comportamento atual (R aleatório).
// Percent-encoding malformado em P REJEITA com erro genérico (sem URL/senha
// na mensagem) — nunca retorna `raw`: senha errada mutaria o role no setup e
// só falharia depois, no login do pooler. O getter `URL.password` devolve a
// forma codificada; decodificar uma vez recupera o segredo real.
function pooledAppPassword(): string | null {
  if (!hasPooled) return null;
  let raw: string;
  try {
    raw = new URL(pooledConnectionString as string).password;
  } catch {
    throw new Error("TEST_POOLED_DATABASE_URL inválida: password ilegível");
  }
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Error("TEST_POOLED_DATABASE_URL com percent-encoding inválido no password");
  }
}

function escapeRolePassword(value: string): string {
  return value.replace(/'/g, "''");
}

function businessKey(trialId: string): string {
  return `trial-provision:${trialId}`;
}

describe.skipIf(!hasDb)("EXEC-WORKER-RLS-MATRIX crash/timeout + A/B + readback (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });
  let appDb: Kysely<Database>;
  let appRolePasswordSet = false;
  const commandDb = new KyselyCommandDb(db);
  const bus = new CommandBus(commandDb);
  const browser = new FakeBrowserPort();
  const dispatcher = new ProviderDispatcherService(db, commandDb, undefined, TEST_TRIAL_CAPABILITY_KEY);

  const suffix = newId().replace(/-/g, "").slice(-12);
  let tenantId = "";
  let accountId = "";

  function actor(): CommandActor {
    return {
      userId: newId(),
      isPlatformAdmin: true,
      tenantId,
      roleKeys: [],
      permissions: [],
      actorType: "human",
    };
  }

  function overrides(extra: Record<string, unknown> = {}) {
    return {
      opsPort: browser as ProviderOpsPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY,
      ...extra,
    };
  }

  async function requestDurable(key: string): Promise<{ opId: string; trialId: string; idempotencyKey: string }> {
    const idempotencyKey = `matrix-${key}-${suffix}`;
    const person = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: `Matrix ${key}`,
    });
    if (!person.ok) throw new Error(`person.register failed: ${dumped(person)}`);
    const trial = await bus.execute<{ id: string | null }>(actor(), "trial.request", {
      personId: person.data.id,
      durationMinutes: 60,
    });
    if (!trial.ok || trial.data.id === null) throw new Error(`trial.request failed: ${dumped(trial)}`);
    const result = await bus.execute<{ id: string; status: string; effectCertainty: string }>(
      actor(),
      "provider.request_operation",
      {
        action: "trial.provision",
        entityType: "trial",
        entityId: trial.data.id,
        idempotencyKey,
        payload: { duration_minutes: 60 },
      },
    );
    if (!result.ok) throw new Error(`request failed: ${dumped(result)}`);
    return { opId: result.data.id, trialId: trial.data.id, idempotencyKey };
  }

  async function getOp(id: string) {
    return db
      .selectFrom("provider.provider_operations")
      .select(["id", "status", "effect_certainty", "idempotency_key", "claimed_by", "lease_expires_at", "dispatch_started_at"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }

  async function plant(id: string, patch: Record<string, unknown>): Promise<void> {
    await db
      .updateTable("provider.provider_operations")
      .set(patch as never)
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .execute();
  }

  beforeAll(async () => {
    // FIX-POOLER-PW-20261020 (2): valida P ANTES de qualquer mutação do setup
    // (migrations, fixtures, ALTER ROLE). Percent-encoding malformado rejeita
    // aqui com erro genérico — sem URL/senha na mensagem.
    const honoredPooledPassword = pooledAppPassword();
    if (hasPooled && !honoredPooledPassword) {
      throw new Error("TEST_POOLED_DATABASE_URL sem password: parity exige senha P embutida");
    }
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    await db
      .updateTable("platform.capabilities")
      .set({ availability: "AVAILABLE", certification_status: "CERTIFIED" })
      .where("key", "=", "provider.cinevision")
      .execute();
    await db
      .insertInto("platform.capabilities")
      .values({
        id: newId(),
        key: TEST_TRIAL_CAPABILITY_KEY,
        owner_context: "provider",
        availability: "AVAILABLE",
        certification_status: "CERTIFIED",
        risk_level: "HIGH",
        mvp_phase: "W0",
        manual_equivalent: "manual",
        policy_family: "provider-integration",
        degradation: "Isolated test gate (worker-rls-matrix); mirrors provider.cinevision.trial",
        permissions: [],
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({ availability: "AVAILABLE", certification_status: "CERTIFIED", updated_at: new Date() }),
      )
      .execute();
    process.env["PROVIDER_DISPATCH_MODE"] = "durable";
    registerCrmCommands(bus);
    registerPolicyCommands(bus);
    registerTrialCommands(bus, {
      opsPort: browser as ProviderOpsPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY,
    });
    registerProviderCommands(bus, {
      opsPort: browser as ProviderOpsPort,
      secretsPort: CONFIGURED_SECRETS_PORT,
      loadSecretRef: async () => VALID_REF,
      trialCapabilityKey: TEST_TRIAL_CAPABILITY_KEY,
    });
    tenantId = newId();
    await db
      .insertInto("control.tenants")
      .values({
        id: tenantId,
        slug: `matrix-${suffix}`,
        name: "Worker Matrix",
        status: "ACTIVE",
        default_currency: "BRL",
        timezone: "America/Sao_Paulo",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    let provider = await db
      .selectFrom("provider.providers")
      .select(["id"])
      .where("provider_key", "=", "cinevision")
      .executeTakeFirst();
    if (provider === undefined) {
      provider = await db
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
    }
    const account = await db
      .insertInto("provider.provider_accounts")
      .values({
        id: newId(),
        tenant_id: tenantId,
        provider_id: provider.id,
        name: "Matrix account",
        status: "ACTIVE",
        secret_ref: VALID_REF,
        environment: "SANDBOX",
        connection_status: "NOT_CONFIGURED",
        version: 1,
        settings_json: { synthetic: true },
        created_at: new Date(),
        updated_at: new Date(),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    accountId = account.id;
    process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"] = accountId;
    // Conexão efetiva `iptv_app` (M2/parity): senha temporária por run,
    // reset para NULL no teardown — padrão dos rehearsals RLS irmãos.
    // Com pooled configurado, HONRA a senha P de TEST_POOLED_DATABASE_URL
    // (mesmo segredo no userlist.txt do pooler e no role); sem pooled,
    // gera R aleatório como antes. Ausência de password em P falha cedo.
    // Sem SET ROLE: o pool autentica como `iptv_app` de verdade.
    const generatedPassword = `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
    if (!/^[0-9a-f]{32,}$/.test(generatedPassword)) {
      throw new Error("unsafe generated app password");
    }
    let appPassword = generatedPassword;
    if (honoredPooledPassword !== null) {
      appPassword = honoredPooledPassword;
    }
    await sql.raw(`ALTER ROLE iptv_app WITH LOGIN PASSWORD '${escapeRolePassword(appPassword)}'`).execute(db);
    // REREVIEW-POOLER-PERCENT (MEDIUM): reset do teardown só ocorre se este
    // ALTER ROLE concluiu — rejeição precoce de P malformado não toca o role.
    appRolePasswordSet = true;
    appDb = createDb({ connectionString: withAppIdentity(connectionString as string, appPassword) });
  }, 120_000);

  afterAll(async () => {
    delete process.env["PROVIDER_DISPATCH_MODE"];
    delete process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"];
    await appDb?.destroy().catch(() => undefined);
    if (appRolePasswordSet) {
      await sql.raw("ALTER ROLE iptv_app WITH PASSWORD NULL").execute(db).catch(() => undefined);
    }
    await db.destroy().catch(() => undefined);
  });

  afterEach(() => {
    browser.mode = "success";
    process.env["PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID"] = accountId;
  });

  it("M1 crash/timeout matrix: kill mid-send never re-sends; VERIFYING + idempotencyKey estável", async () => {
    const satisfied = new FakeTrialReadback("satisfied");

    // M1a: pre-send crash → recover libera REQUESTED → drain executa exatamente 1 send.
    {
      const before = browser.calls.length;
      const { opId, trialId } = await requestDurable("m1a-presend");
      const expected = businessKey(trialId);
      const keyBefore = (await getOp(opId)).idempotency_key;
      // Business-key EXATA (nunca a chave por tentativa): o invariante é
      // igualdade ao `trial-provision:{trialId}`, estável através do kill.
      expect(keyBefore).toBe(expected);
      await plant(opId, {
        status: "QUEUED",
        claimed_by: "crashed-worker",
        claimed_at: new Date(),
        lease_expires_at: sql`now() - make_interval(secs => 60)`,
        dispatch_started_at: null,
      });
      const recovered = await dispatcher.recoverOnce(10);
      expect(recovered.operationIds).toContain(opId);
      expect((await getOp(opId)).status).toBe("REQUESTED");
      const drained = await dispatcher.drainOnce(10, overrides({ trialReadbackPort: satisfied }));
      expect(drained.operationIds).toContain(opId);
      expect(browser.calls.length).toBe(before + 1);
      const sent = browser.calls.slice(before);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.entityId).toBe(trialId);
      expect(sent[0]?.idempotencyKey).toBe(expected);
      const terminal = await getOp(opId);
      expect(terminal.status).toBe("SUCCEEDED");
      // Business-key EXATA após o kill (nunca a chave por tentativa):
      // estabilidade E igualdade ao `trial-provision:{trialId}`.
      expect(terminal.idempotency_key).toBe(expected);
    }

    // M1b: post-send crash (kill após frontier) → VERIFYING, drain não reclama, sem 2º send.
    {
      const before = browser.calls.length;
      const { opId, trialId } = await requestDurable("m1b-postsend");
      const expected = businessKey(trialId);
      const keyBefore = (await getOp(opId)).idempotency_key;
      expect(keyBefore).toBe(expected);
      await plant(opId, {
        status: "RUNNING",
        claimed_by: "crashed-worker",
        claimed_at: new Date(),
        lease_expires_at: sql`now() - make_interval(secs => 60)`,
        dispatch_started_at: new Date(),
      });
      const recovered = await dispatcher.recoverOnce(10);
      expect(recovered.operationIds).toContain(opId);
      const parked = await getOp(opId);
      expect(parked.status).toBe("VERIFYING");
      expect(parked.effect_certainty).toBe("UNKNOWN");
      expect(parked.claimed_by).toBeNull();
      expect(parked.idempotency_key).toBe(expected);
      expect((await dispatcher.drainOnce(10, overrides({ trialReadbackPort: satisfied }))).claimed).toBe(0);
      expect(browser.calls.length).toBe(before);
      // Reconcile inconclusivo converge HUMAN_REQUIRED sem re-send (Stub genérico fail-closed).
      const reconciled = await dispatcher.reconcileOnce(100, overrides({ trialReadbackPort: satisfied }));
      expect(reconciled.operationIds).toContain(opId);
      expect(browser.calls.length).toBe(before);
      expect((await getOp(opId)).status).toBe("HUMAN_REQUIRED");
    }

    // M1c: timeout do port (hang) → VERIFYING com exatamente 1 send, nunca FAILED.
    {
      browser.mode = "hang";
      const before = browser.calls.length;
      try {
        const { opId, trialId } = await requestDurable("m1c-timeout");
        const expected = businessKey(trialId);
        const drained = await dispatcher.drainOnce(10, { ...overrides({ trialReadbackPort: satisfied }), timeoutMs: 20 });
        expect(drained.verifying).toBe(1);
        const parked = await getOp(opId);
        expect(parked.status).toBe("VERIFYING");
        expect(parked.effect_certainty).toBe("UNKNOWN");
        expect(parked.dispatch_started_at).not.toBeNull();
        expect(parked.idempotency_key).toBe(expected);
        const sent = browser.calls.slice(before);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.entityId).toBe(trialId);
        expect(sent[0]?.idempotencyKey).toBe(expected);
      } finally {
        browser.mode = "success";
      }
    }

    // M1d: timeout do readback (hang) → VERIFYING com exatamente 1 send, nunca re-send.
    {
      const hangingReadback = { readTrialCustomer: () => new Promise<never>(() => undefined) };
      const before = browser.calls.length;
      const { opId, trialId } = await requestDurable("m1d-readback");
      const expected = businessKey(trialId);
      const drained = await dispatcher.drainOnce(10, {
        ...overrides({ trialReadbackPort: hangingReadback }),
        trialReadbackTimeoutMs: 20,
      });
      expect(drained.verifying).toBe(1);
      expect((await getOp(opId)).idempotency_key).toBe(expected);
      const sent = browser.calls.slice(before);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.entityId).toBe(trialId);
      expect(sent[0]?.idempotencyKey).toBe(expected);
    }
  });

  it("M2 RLS sob iptv_app efetivo (052/055/056) + drains scheduler/admin", async () => {
    // Identidade efetiva do pool: SEMPRE iptv_app, nunca owner, sem bypass.
    const who = await sql<{ u: string; su: string; is_superuser: string }>`
      SELECT current_user AS u, session_user AS su, current_setting('is_superuser') AS is_superuser
    `.execute(appDb);
    expect(who.rows[0]?.u).toBe("iptv_app");
    expect(who.rows[0]?.su).toBe("iptv_app");
    expect(who.rows[0]?.is_superuser).toBe("off");

    // Segundo tenant (isolamento cruzado real, via owner setup-only).
    const tenantB = newId();
    await db
      .insertInto("control.tenants")
      .values({
        id: tenantB,
        slug: `matrix-b-${suffix}`,
        name: "Worker Matrix B",
        status: "ACTIVE",
        default_currency: "BRL",
        timezone: "America/Sao_Paulo",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const channelBId = newId();
    await db
      .insertInto("billing.tenant_channels")
      .values({
        id: channelBId,
        tenant_id: tenantB,
        channel: "ASAAS",
        tenant_key: `matrix-052-b-${suffix}`,
        webhook_secret_hash: null,
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    // 052: billing/finance enroladas — SEM filtro WHERE que substitua o RLS:
    // o isolamento vem só de `app.tenant_id` + policy.
    const channelId = newId();
    await db
      .insertInto("billing.tenant_channels")
      .values({
        id: channelId,
        tenant_id: tenantId,
        channel: "ASAAS",
        tenant_key: `matrix-052-${suffix}`,
        webhook_secret_hash: null,
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    // Sem contexto → fail-closed (0 rows, RLS puro).
    expect(await appDb.selectFrom("billing.tenant_channels").select(["id"]).execute()).toHaveLength(0);
    // Contexto correto → enxerga as próprias linhas, nunca as do outro tenant.
    const seenA = await withTenantTransaction(appDb, tenantId, (trx) =>
      trx.selectFrom("billing.tenant_channels").select(["id"]).execute(),
    );
    expect(seenA.map((r) => r.id)).toContain(channelId);
    expect(seenA.map((r) => r.id)).not.toContain(channelBId);
    // Outro-tenant → isolado (vê só as dele, nunca as do tenant A).
    const seenB = await withTenantTransaction(appDb, tenantB, (trx) =>
      trx.selectFrom("billing.tenant_channels").select(["id"]).execute(),
    );
    expect(seenB.map((r) => r.id)).toContain(channelBId);
    expect(seenB.map((r) => r.id)).not.toContain(channelId);

    // 055: trial + provider accounts — mesma regra de contexto, RLS puro.
    expect(await appDb.selectFrom("provider.provider_accounts").select(["id"]).execute()).toHaveLength(0);
    const accountsA = await withTenantTransaction(appDb, tenantId, (trx) =>
      trx.selectFrom("provider.provider_accounts").select(["id"]).execute(),
    );
    expect(accountsA.map((r) => r.id)).toContain(accountId);
    const accountsB = await withTenantTransaction(appDb, tenantB, (trx) =>
      trx.selectFrom("provider.provider_accounts").select(["id"]).execute(),
    );
    expect(accountsB.map((r) => r.id)).not.toContain(accountId);
    expect(accountsB).toHaveLength(0);

    // 056: definers cross-tenant do dispatcher respondem vazios (não explodem)
    // na via direta `iptv_app` — o dispatcher abre o contexto por operação
    // (`withTenantTransaction`), então sem fila visível nada é reclamado.
    const appCommandDb = new KyselyCommandDb(appDb);
    const appDispatcher = new ProviderDispatcherService(appDb, appCommandDb, undefined, TEST_TRIAL_CAPABILITY_KEY);
    expect((await appDispatcher.drainOnce(5, overrides())).claimed).toBe(0);
    expect((await appDispatcher.recoverOnce(5)).released).toBe(0);
    expect((await appDispatcher.reconcileOnce(5, overrides())).checked).toBeGreaterThanOrEqual(0);

    // Scheduler order (recover→drain→reconcile) vs admin order (drain/recover/reconcile
    // individuais): ambos convergem sem 2º efeito sobre fila vazia.
    const schedulerTick = await (async () => {
      const r = await dispatcher.recoverOnce(10);
      const d = await dispatcher.drainOnce(10, overrides({ trialReadbackPort: new FakeTrialReadback("satisfied") }));
      const c = await dispatcher.reconcileOnce(10, overrides({ trialReadbackPort: new FakeTrialReadback("satisfied") }));
      return { r, d, c };
    })();
    expect(schedulerTick.d.claimed).toBe(0);
    expect(schedulerTick.r.released).toBe(0);
    // Admin drains individuais usam os mesmos métodos (paridade de caminho).
    expect((await dispatcher.drainOnce(5, overrides())).claimed).toBe(0);

    // 056-positivo sob `iptv_app` direto: fila elegível processa com
    // transições + efeitos (prova positiva — não só igualdade de vazios).
    {
      const satisfied = new FakeTrialReadback("satisfied");
      // A: drain direto reclama e termina SUCCEEDED com 1 send + binding.
      {
        const before = browser.calls.length;
        const { opId, trialId } = await requestDurable("m2-app-drain");
        const expected = businessKey(trialId);
        const drained = await appDispatcher.drainOnce(10, overrides({ trialReadbackPort: satisfied }));
        expect(drained.operationIds).toContain(opId);
        expect(drained.succeeded).toBe(1);
        expect(browser.calls.length).toBe(before + 1);
        expect(browser.calls[before]?.entityId).toBe(trialId);
        expect(browser.calls[before]?.idempotencyKey).toBe(expected);
        expect((await getOp(opId)).status).toBe("SUCCEEDED");
        const bindings = await db
          .selectFrom("provider.provider_bindings")
          .select(["id"])
          .where("tenant_id", "=", tenantId)
          .where("entity_type", "=", "trial")
          .where("entity_id", "=", trialId)
          .execute();
        expect(bindings).toHaveLength(1);
      }
      // B: recover pré-send libera + drain executa com 1 send.
      {
        const { opId, trialId } = await requestDurable("m2-app-recover");
        const expected = businessKey(trialId);
        await plant(opId, {
          status: "QUEUED",
          claimed_by: "crashed-worker",
          claimed_at: new Date(),
          lease_expires_at: sql`now() - make_interval(secs => 60)`,
          dispatch_started_at: null,
        });
        const recovered = await appDispatcher.recoverOnce(10);
        expect(recovered.operationIds).toContain(opId);
        expect((await getOp(opId)).status).toBe("REQUESTED");
        const before = browser.calls.length;
        const drained = await appDispatcher.drainOnce(10, overrides({ trialReadbackPort: satisfied }));
        expect(drained.operationIds).toContain(opId);
        expect((await getOp(opId)).status).toBe("SUCCEEDED");
        expect(browser.calls.length).toBe(before + 1);
        expect(browser.calls[before]?.idempotencyKey).toBe(expected);
      }
      // C: timeout do port sob app → VERIFYING com 1 send; reconcile
      // conclusivo converge SUCCEEDED sem re-send.
      {
        browser.mode = "hang";
        const before = browser.calls.length;
        try {
          const { opId, trialId } = await requestDurable("m2-app-verify");
          const expected = businessKey(trialId);
          const drained = await appDispatcher.drainOnce(10, {
            ...overrides({ trialReadbackPort: satisfied }),
            timeoutMs: 20,
          });
          expect(drained.operationIds).toContain(opId);
          expect(drained.verifying).toBe(1);
          expect((await getOp(opId)).status).toBe("VERIFYING");
          const sent = browser.calls.slice(before);
          expect(sent).toHaveLength(1);
          expect(sent[0]?.idempotencyKey).toBe(expected);
          const reconciled = await appDispatcher.reconcileOnce(
            100,
            overrides({ trialReadbackPort: satisfied, readbackPort: new ConclusiveGenericReadback(true) }),
          );
          expect(reconciled.operationIds).toContain(opId);
          expect((await getOp(opId)).status).toBe("SUCCEEDED");
          expect(browser.calls.length).toBe(before + 1);
        } finally {
          browser.mode = "success";
        }
      }
    }
  });

  // Paridade PgBouncer (finding HIGH falso-verde): opt-in explícito via
  // `TEST_POOLED_DATABASE_URL`. Ausência = SKIPPED reportado ao runner
  // (nunca `expect` verde sobre erro engolido). Quando configurado, roda a
  // MESMA matriz nas duas conexões e falha em erro OU divergência.
  it.runIf(hasPooled)("M2 parity PgBouncer: mesma matriz via pooler (requires TEST_POOLED_DATABASE_URL)", async () => {
    const pooledDb = createDb({ connectionString: pooledConnectionString as string, maxConnections: 1 });
    try {
      // Identidade do pooler amarrada à identidade certificada (sem bypass).
      const pooledWho = await sql<{ u: string; is_superuser: string }>`
        SELECT current_user AS u, current_setting('is_superuser') AS is_superuser
      `.execute(pooledDb);
      expect(pooledWho.rows[0]?.is_superuser).toBe("off");
      const directWho = await sql<{ u: string }>`SELECT current_user AS u`.execute(appDb);
      expect(pooledWho.rows[0]?.u).toBe(directWho.rows[0]?.u);

      // Mesma matriz de leitura (052/055) nas duas conexões, sem WHERE
      // que substitua o RLS — divergência falha.
      async function readMatrix(target: Kysely<Database>) {
        const noContextChannels = await target.selectFrom("billing.tenant_channels").select(["id"]).execute();
        const noContextAccounts = await target.selectFrom("provider.provider_accounts").select(["id"]).execute();
        const ownChannels = await withTenantTransaction(target, tenantId, (trx) =>
          trx.selectFrom("billing.tenant_channels").select(["id"]).execute(),
        );
        const ownAccounts = await withTenantTransaction(target, tenantId, (trx) =>
          trx.selectFrom("provider.provider_accounts").select(["id"]).execute(),
        );
        return {
          noContextChannels: noContextChannels.map((r) => r.id).sort(),
          noContextAccounts: noContextAccounts.map((r) => r.id).sort(),
          ownChannels: ownChannels.map((r) => r.id).sort(),
          ownAccounts: ownAccounts.map((r) => r.id).sort(),
        };
      }
      const directMatrix = await readMatrix(appDb);
      expect(directMatrix.noContextChannels).toHaveLength(0);
      expect(directMatrix.noContextAccounts).toHaveLength(0);
      expect(directMatrix.ownAccounts).toContain(accountId);
      const pooledMatrix = await readMatrix(pooledDb);
      // Qualquer erro acima já falha; divergência de linhas falha aqui.
      expect(pooledMatrix).toEqual(directMatrix);

      // Mesmos drains nas duas vias (056): sem fila visível, zeros iguais —
      // sem try/catch que converta erro em "skipped".
      async function drainShapes(
        target: Kysely<Database>,
      ): Promise<{ claimed: number; released: number; checked: number }> {
        const disp = new ProviderDispatcherService(
          target,
          new KyselyCommandDb(target),
          undefined,
          TEST_TRIAL_CAPABILITY_KEY,
        );
        const drained = await disp.drainOnce(5, overrides());
        const recovered = await disp.recoverOnce(5);
        const reconciled = await disp.reconcileOnce(5, overrides());
        return { claimed: drained.claimed, released: recovered.released, checked: reconciled.checked };
      }
      const directDrains = await drainShapes(appDb);
      expect(directDrains.claimed).toBe(0);
      expect(directDrains.released).toBe(0);
      const pooledDrains = await drainShapes(pooledDb);
      expect(pooledDrains).toEqual(directDrains);

      // 056-positivo via pooler como `iptv_app`: transições + efeitos,
      // não só zeros iguais — mesma exigência da via direta.
      {
        const pooledDisp = new ProviderDispatcherService(
          pooledDb,
          new KyselyCommandDb(pooledDb),
          undefined,
          TEST_TRIAL_CAPABILITY_KEY,
        );
        const satisfied = new FakeTrialReadback("satisfied");
        // A: drain via pooler reclama e termina SUCCEEDED com 1 send.
        {
          const before = browser.calls.length;
          const { opId, trialId } = await requestDurable("m2-pooled-drain");
          const expected = businessKey(trialId);
          const drained = await pooledDisp.drainOnce(10, overrides({ trialReadbackPort: satisfied }));
          expect(drained.operationIds).toContain(opId);
          expect(drained.succeeded).toBe(1);
          expect(browser.calls.length).toBe(before + 1);
          expect(browser.calls[before]?.entityId).toBe(trialId);
          expect(browser.calls[before]?.idempotencyKey).toBe(expected);
          expect((await getOp(opId)).status).toBe("SUCCEEDED");
        }
        // B: recover pré-send via pooler libera + drain executa.
        {
          const { opId, trialId } = await requestDurable("m2-pooled-recover");
          const expected = businessKey(trialId);
          await plant(opId, {
            status: "QUEUED",
            claimed_by: "crashed-worker",
            claimed_at: new Date(),
            lease_expires_at: sql`now() - make_interval(secs => 60)`,
            dispatch_started_at: null,
          });
          const recovered = await pooledDisp.recoverOnce(10);
          expect(recovered.operationIds).toContain(opId);
          expect((await getOp(opId)).status).toBe("REQUESTED");
          const before = browser.calls.length;
          const drained = await pooledDisp.drainOnce(10, overrides({ trialReadbackPort: satisfied }));
          expect(drained.operationIds).toContain(opId);
          expect((await getOp(opId)).status).toBe("SUCCEEDED");
          expect(browser.calls.length).toBe(before + 1);
          expect(browser.calls[before]?.idempotencyKey).toBe(expected);
        }
        // C: timeout via pooler → VERIFYING com 1 send; reconcile
        // conclusivo converge SUCCEEDED sem re-send.
        {
          browser.mode = "hang";
          const before = browser.calls.length;
          try {
            const { opId, trialId } = await requestDurable("m2-pooled-verify");
            const expected = businessKey(trialId);
            const drained = await pooledDisp.drainOnce(10, {
              ...overrides({ trialReadbackPort: satisfied }),
              timeoutMs: 20,
            });
            expect(drained.operationIds).toContain(opId);
            expect(drained.verifying).toBe(1);
            expect((await getOp(opId)).status).toBe("VERIFYING");
            const sent = browser.calls.slice(before);
            expect(sent).toHaveLength(1);
            expect(sent[0]?.idempotencyKey).toBe(expected);
            const reconciled = await pooledDisp.reconcileOnce(
              100,
              overrides({ trialReadbackPort: satisfied, readbackPort: new ConclusiveGenericReadback(true) }),
            );
            expect(reconciled.operationIds).toContain(opId);
            expect((await getOp(opId)).status).toBe("SUCCEEDED");
            expect(browser.calls.length).toBe(before + 1);
          } finally {
            browser.mode = "success";
          }
        }
      }
    } finally {
      await pooledDb.destroy().catch(() => undefined);
    }
  });

  it("M3 fake conclusivo vs Stub: SUCCEEDED prova + HUMAN_REQUIRED onde Stub dava INCONCLUSIVE", async () => {
    // Stub fail-closed: SUCCEEDED do port vira VERIFYING (INCONCLUSIVE nunca termina).
    {
      const stub = new StubTrialReadback();
      const before = browser.calls.length;
      const { opId } = await requestDurable("m3-stub");
      const drained = await dispatcher.drainOnce(10, overrides({ trialReadbackPort: stub }));
      expect(drained.operationIds).toContain(opId);
      expect(drained.verifying).toBe(1);
      expect(browser.calls.length).toBe(before + 1);
      expect((await getOp(opId)).status).toBe("VERIFYING");
    }

    // Fake conclusivo satisfeito + generic APPLIED → SUCCEEDED com binding (sem live).
    {
      const readback = new FakeTrialReadback("satisfied");
      const before = browser.calls.length;
      const { opId, trialId } = await requestDurable("m3-fake-happy");
      const drained = await dispatcher.drainOnce(10, overrides({ trialReadbackPort: readback }));
      expect(drained.succeeded).toBe(1);
      expect(browser.calls.length).toBe(before + 1);
      expect((await getOp(opId)).status).toBe("SUCCEEDED");
      const bindings = await db
        .selectFrom("provider.provider_bindings")
        .select(["id"])
        .where("tenant_id", "=", tenantId)
        .where("entity_type", "=", "trial")
        .where("entity_id", "=", trialId)
        .execute();
      expect(bindings).toHaveLength(1);
    }

    // Fake conclusivo violado (not-trial) → HUMAN_REQUIRED/POSTCONDITION_MISMATCH, nunca ACTIVE.
    {
      const readback = new FakeTrialReadback("not-trial");
      const before = browser.calls.length;
      const { opId, trialId } = await requestDurable("m3-fake-mismatch");
      const drained = await dispatcher.drainOnce(10, overrides({ trialReadbackPort: readback }));
      expect(drained.humanRequired).toBeGreaterThanOrEqual(1);
      expect(browser.calls.length).toBe(before + 1);
      const row = await db
        .selectFrom("provider.provider_operations")
        .select(["status", "result_summary_json"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", opId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("HUMAN_REQUIRED");
      expect(dumped(row.result_summary_json)).toContain("POSTCONDITION_MISMATCH");
      const trial = await db
        .selectFrom("trial.trials")
        .select(["lifecycle_status"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", trialId)
        .executeTakeFirstOrThrow();
      expect(trial.lifecycle_status).not.toBe("ACTIVE");
    }

    // Fake inconclusivo no reconcile → HUMAN_REQUIRED direto, sem 2º send (prova sem live).
    {
      const readback = new FakeTrialReadback("inconclusive");
      const before = browser.calls.length;
      const { opId } = await requestDurable("m3-fake-verifying");
      expect((await dispatcher.drainOnce(10, overrides({ trialReadbackPort: readback }))).verifying).toBe(1);
      const reconciled = await dispatcher.reconcileOnce(
        100,
        overrides({ trialReadbackPort: readback, readbackPort: new ConclusiveGenericReadback(true) }),
      );
      expect(reconciled.operationIds).toContain(opId);
      expect(browser.calls.length).toBe(before + 1);
      expect((await getOp(opId)).status).toBe("HUMAN_REQUIRED");
    }
  });
});
