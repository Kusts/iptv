import { HttpException } from "@nestjs/common";
import { z } from "zod";
import { newId, now } from "@iptv/domain";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";
import {
  resolveSecretsPort,
  resolveSecretsWriterPort,
  SecretsError,
  type SecretsPort,
  type SecretsWriterPort,
} from "@iptv/secrets";

/**
 * S1C2 Central de Integrações — write/test/disable (SPEC S1 §4–§5).
 *
 * `integration.configure` / `integration.test` / `integration.disable` sob
 * `integration.manage` (configure/disable) e `integration.test` (test), com
 * idempotência via `CommandBus` (header `Idempotency-Key`, escopo = nome do
 * comando) e auditoria automática (`integration.configure|test|disable` sobre
 * `provider_account`, sem valores de segredo).
 *
 * Segredos server-side SEMPRE: o corpo aceita o VALOR uma vez; o writer
 * persiste no Infisical sob o namespace backend-owned
 * `infisical://<env>/integrations/<tenantId>/<provider>/<KEY>` (derivado de
 * contexto validado via `buildIntegrationSecretRef`, nunca do cliente) e a
 * linha guarda só `secret_ref`. NENHUMA resposta contém segredo.
 *
 * Ordem de escrita (configure): `putSecret` no vault PRIMEIRO, SÓ então
 * insert/update da linha. Falha do vault → 503 fail-closed, linha intocada;
 * falha do DB após o put → COMPENSAÇÃO (`deleteSecret` best-effort) + 503.
 * Rotação = configure com novo segredo + `expectedVersion` atual (sem
 * endpoint `rotate` dedicado em S1; `rotateSecret` orquestrado com canary
 * continua disponível no `@iptv/secrets` para S2+).
 *
 * Probe Asaas (test): SOMENTE contra a allowlist fixa por environment
 * (`ASAAS_HOSTS`), NUNCA URL do cliente (o schema `strict()` rejeita
 * `baseUrl` e afins com 400). `GET /v3/webhooks?limit=1` com header
 * `access_token`, fallback `GET /v3/customers?limit=1`; timeout bounded
 * 8000ms via `AbortSignal.timeout`. Sucesso → `CONNECTED_READ_ONLY`;
 * falha → `TESTING` + `last_error_code` sanitizado
 * (`INVALID_CREDENTIALS` / `PROVIDER_UNAVAILABLE` / `TIMEOUT` — nunca corpo,
 * valor ou header).
 *
 * CINEVISION (test): SEM browser (S4 faz live) — só verifica resolução do
 * vault (presença, nunca o valor) + coerência do binding → mantém `TESTING`
 * com `last_checked_at`. `CONNECTED_READ_ONLY` cinevision SÓ em S4.
 *
 * WhatsApp: 501 `CAPABILITY_UNCERTIFIED` ("disponível em S3") no controller,
 * antes do bus — sem criar linha, sem tocar no vault.
 */

// ---------------------------------------------------------------------------
// Fixed probe surface (never client-supplied).
// ---------------------------------------------------------------------------

/** Allowlist fixa de hosts Asaas por environment (pesquisa S2-RESEARCH-ASAAS). */
export const ASAAS_HOSTS = {
  SANDBOX: "https://api-sandbox.asaas.com/v3",
  PRODUCTION: "https://api.asaas.com/v3",
} as const;

/** Budget bounded do probe Asaas (mesmo default do adapter Infisical). */
export const ASAAS_PROBE_TIMEOUT_MS = 8000;

/** Test seam: fakes injetados pela suite de integração (produção resolve live). */
interface IntegrationTestDoubles {
  secretsWriter?: SecretsWriterPort;
  secretsReader?: SecretsPort;
  asaasFetch?: typeof fetch;
}

let testDoubles: IntegrationTestDoubles | null = null;

/** Test-only: instala fakes de vault/probe (chamado no beforeAll da suite). */
export function __setIntegrationTestDoubles(doubles: IntegrationTestDoubles): void {
  testDoubles = doubles;
}

/** Test-only: remove os fakes (chamado no afterAll da suite). */
export function __resetIntegrationTestDoubles(): void {
  testDoubles = null;
}

function resolveWriter(): SecretsWriterPort {
  if (testDoubles?.secretsWriter !== undefined) {
    return testDoubles.secretsWriter;
  }
  return resolveSecretsWriterPort();
}

function resolveReader(): SecretsPort {
  if (testDoubles?.secretsReader !== undefined) {
    return testDoubles.secretsReader;
  }
  if (testDoubles?.secretsWriter !== undefined) {
    return testDoubles.secretsWriter;
  }
  return resolveSecretsPort();
}

function resolveFetch(): typeof fetch {
  if (testDoubles?.asaasFetch !== undefined) {
    return testDoubles.asaasFetch;
  }
  return fetch;
}

// ---------------------------------------------------------------------------
// Inputs (Zod estrito: chaves desconhecidas como `baseUrl` → 400).
// ---------------------------------------------------------------------------

const providerSchema = z.enum(["asaas", "cinevision", "whatsapp"]);
const environmentSchema = z.enum(["SANDBOX", "PRODUCTION"]);

const secretValueSchema = z.object({
  apiKey: z.string().trim().min(1).max(512).optional(),
  username: z.string().trim().min(1).max(256).optional(),
  password: z.string().trim().min(1).max(512).optional(),
}).strict();

const whatsappRefused = (ctx: z.RefinementCtx, message: string): void => {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message });
};

export const configureIntegrationInput = z
  .object({
    provider: providerSchema,
    environment: environmentSchema,
    expectedVersion: z.number().int().min(1).optional(),
    secret: secretValueSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provider === "whatsapp") {
      whatsappRefused(ctx, "whatsapp integration is uncertified (disponível em S3)");
      return;
    }
    if (value.provider === "asaas" && value.secret.apiKey === undefined) {
      whatsappRefused(ctx, "asaas configure requires secret.apiKey");
      return;
    }
    if (
      value.provider === "cinevision" &&
      (value.secret.username === undefined || value.secret.password === undefined)
    ) {
      whatsappRefused(ctx, "cinevision configure requires secret.username and secret.password");
    }
  });
export type ConfigureIntegrationInput = z.infer<typeof configureIntegrationInput>;

export const testIntegrationInput = z
  .object({
    provider: providerSchema,
    environment: environmentSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provider === "whatsapp") {
      whatsappRefused(ctx, "whatsapp integration is uncertified (disponível em S3)");
    }
  });
export type TestIntegrationInput = z.infer<typeof testIntegrationInput>;

export const disableIntegrationInput = z
  .object({
    provider: providerSchema,
    environment: environmentSchema.optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provider === "whatsapp") {
      whatsappRefused(ctx, "whatsapp integration is uncertified (disponível em S3)");
    }
  });
export type DisableIntegrationInput = z.infer<typeof disableIntegrationInput>;

// ---------------------------------------------------------------------------
// Sanitized result (nunca secret_ref, valor ou settings).
// ---------------------------------------------------------------------------

export interface IntegrationBindingResult {
  id: string;
  provider: string;
  environment: string;
  connection_status: string;
  version: number;
  last_checked_at: string | null;
  last_error_code: string | null;
}

function sanitize(input: {
  id: string;
  provider: string;
  environment: string;
  connection_status: string;
  version: number | string | bigint;
  last_checked_at: Date | null;
  last_error_code: string | null;
}): IntegrationBindingResult {
  return {
    id: input.id,
    provider: input.provider,
    environment: input.environment,
    connection_status: input.connection_status,
    version: Number(input.version),
    last_checked_at: input.last_checked_at?.toISOString() ?? null,
    last_error_code: input.last_error_code,
  };
}

/** 503 fail-closed do vault/DB (failures ambientais, nunca validação). */
function vaultUnavailable(): HttpException {
  return new HttpException(
    { code: "VAULT_UNAVAILABLE", message: "secret vault unavailable; binding untouched, retry later" },
    503,
  );
}

function requireTrx(ctx: CommandHandlerContext) {
  const trx = kyselyTrxOf(ctx);
  if (trx === null) {
    throw new Error("integration commands require a database transaction");
  }
  return trx;
}

const PROVIDER_TYPE_OF: Record<string, string> = {
  asaas: "BILLING",
  whatsapp: "MESSAGING",
  cinevision: "BROWSER",
};

async function ensureProviderId(
  trx: ReturnType<typeof requireTrx>,
  provider: string,
): Promise<string> {
  const found = await trx
    .selectFrom("provider.providers")
    .select(["id"])
    .where("provider_key", "=", provider)
    .executeTakeFirst();
  if (found !== undefined) {
    return found.id;
  }
  const inserted = await trx
    .insertInto("provider.providers")
    .values({
      id: newId(),
      provider_key: provider,
      name: provider,
      provider_type: PROVIDER_TYPE_OF[provider] ?? "INTEGRATION",
      status: "ACTIVE",
      created_at: now(),
    })
    .onConflict((oc) => oc.column("provider_key").doNothing())
    .returning(["id"])
    .executeTakeFirst();
  if (inserted !== undefined) {
    return inserted.id;
  }
  return (await trx
    .selectFrom("provider.providers")
    .select(["id"])
    .where("provider_key", "=", provider)
    .executeTakeFirstOrThrow()).id;
}

// ---------------------------------------------------------------------------
// configure: put no vault primeiro, SÓ então insert/update (DRAFT, version+1).
// ---------------------------------------------------------------------------

async function handleConfigure(
  ctx: CommandHandlerContext,
  input: ConfigureIntegrationInput,
): Promise<CommandResult<IntegrationBindingResult>> {
  const trx = requireTrx(ctx);
  const providerId = await ensureProviderId(trx, input.provider);

  const existing = await trx
    .selectFrom("provider.provider_accounts")
    .select(["id", "secret_ref", "connection_status", "version"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("provider_id", "=", providerId)
    .where("environment", "=", input.environment)
    .where("connection_status", "<>", "DISABLED")
    .orderBy("updated_at", "desc")
    .forUpdate()
    .executeTakeFirst();

  if (existing !== undefined) {
    if (input.expectedVersion === undefined) {
      return {
        ok: false,
        code: "precondition_failed",
        message: `live ${input.provider} binding exists (version ${Number(existing.version)}); expectedVersion is required`,
      };
    }
    if (input.expectedVersion !== Number(existing.version)) {
      return {
        ok: false,
        code: "precondition_failed",
        message: `version conflict: expected ${input.expectedVersion}, current is ${Number(existing.version)}`,
      };
    }
  }

  // Alvos backend-owned (chaves allowlisted por provider; refs derivadas de
  // contexto validado — nunca do corpo do cliente).
  const targets =
    input.provider === "asaas"
      ? [{ key: "ASAAS_API_KEY", value: input.secret.apiKey as string }]
      : [
          { key: "CINEVISION_USER", value: input.secret.username as string },
          { key: "CINEVISION_PASS", value: input.secret.password as string },
        ];

  const writer = resolveWriter();
  const refs: string[] = [];
  try {
    for (const target of targets) {
      const put = await writer.putSecret({
        tenantId: ctx.tenantId,
        provider: input.provider as "asaas" | "cinevision",
        environment: input.environment,
        key: target.key,
        value: target.value,
        requestId: ctx.commandId,
      });
      refs.push(put.ref);
    }
  } catch (err) {
    // Falha no vault: compensa puts parciais e falha fechado (503), sem
    // tocar na linha. Nenhum valor vaza (mensagem fixa, sem detalhe).
    for (const ref of refs) {
      await writer.deleteSecret(ref).catch(() => undefined);
    }
    if (err instanceof SecretsError) {
      throw vaultUnavailable();
    }
    throw err;
  }

  const primaryRef = refs[0] as string;
  const at = now();
  try {
    if (existing === undefined) {
      const id = newId();
      await trx
        .insertInto("provider.provider_accounts")
        .values({
          id,
          tenant_id: ctx.tenantId,
          provider_id: providerId,
          name: `${input.provider} ${input.environment}`,
          status: "ACTIVE",
          secret_ref: primaryRef,
          settings_json: {},
          last_recharge_at: null,
          created_at: at,
          updated_at: at,
          environment: input.environment,
          // Novo segredo nunca alega conectado: DRAFT até o probe (test).
          connection_status: "DRAFT",
          last_checked_at: null,
          last_error_code: null,
          version: 1,
        })
        .execute();
      return {
        ok: true,
        data: sanitize({
          id,
          provider: input.provider,
          environment: input.environment,
          connection_status: "DRAFT",
          version: 1,
          last_checked_at: null,
          last_error_code: null,
        }),
      };
    }
    // Update com CAS na versão lida: derrota corrida (409 honesto) em vez
    // de sobrescrever o vencedor em silêncio.
    const nextVersion = Number(existing.version) + 1;
    const updated = await trx
      .updateTable("provider.provider_accounts")
      .set({
        secret_ref: primaryRef,
        // Novo segredo invalida o probe anterior: volta a DRAFT.
        connection_status: "DRAFT",
        last_error_code: null,
        updated_at: at,
        version: nextVersion,
      })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", existing.id)
      .where("version", "=", Number(existing.version))
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) < 1) {
      // Perdeu a corrida: compensa o put órfão e devolve 409.
      for (const ref of refs) {
        await writer.deleteSecret(ref).catch(() => undefined);
      }
      return {
        ok: false,
        code: "precondition_failed",
        message: `version conflict: binding ${existing.id} changed concurrently; retry against current state`,
      };
    }
    return {
      ok: true,
      data: sanitize({
        id: existing.id,
        provider: input.provider,
        environment: input.environment,
        connection_status: "DRAFT",
        version: nextVersion,
        last_checked_at: null,
        last_error_code: null,
      }),
    };
  } catch {
    // Insert/update falhou após o put: compensa e falha fechado (503), sem
    // marcar conectado e sem deixar segredo órfão.
    for (const ref of refs) {
      await writer.deleteSecret(ref).catch(() => undefined);
    }
    throw vaultUnavailable();
  }
}

// ---------------------------------------------------------------------------
// Asaas read-only probe (allowlist fixa, timeout bounded, erro sanitizado).
// ---------------------------------------------------------------------------

type AsaasProbeOutcome =
  | { ok: true }
  | { ok: false; code: "INVALID_CREDENTIALS" | "PROVIDER_UNAVAILABLE" | "TIMEOUT" };

function probeErrorOfStatus(status: number): AsaasProbeOutcome {
  if (status === 401 || status === 403) {
    return { ok: false, code: "INVALID_CREDENTIALS" };
  }
  return { ok: false, code: "PROVIDER_UNAVAILABLE" };
}

async function probeAsaas(input: { host: string; authToken: string }): Promise<AsaasProbeOutcome> {
  const run = async (path: string): Promise<Response> =>
    resolveFetch()(`${input.host}${path}`, {
      method: "GET",
      headers: { access_token: input.authToken, Accept: "application/json" },
      signal: AbortSignal.timeout(ASAAS_PROBE_TIMEOUT_MS),
    });
  let res: Response;
  try {
    res = await run("/v3/webhooks?limit=1");
  } catch (err) {
    return {
      ok: false,
      code: err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "TIMEOUT" : "PROVIDER_UNAVAILABLE",
    };
  }
  if (res.ok) {
    return { ok: true };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: "INVALID_CREDENTIALS" };
  }
  // Fallback documentado (S2-RESEARCH-ASAAS): webhooks pode 404ar em contas
  // sem webhook; confirma identidade via leitura de customers.
  if (res.status === 404) {
    try {
      const fallback = await run("/v3/customers?limit=1");
      if (fallback.ok) {
        return { ok: true };
      }
      return probeErrorOfStatus(fallback.status);
    } catch (err) {
      return {
        ok: false,
        code: err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "TIMEOUT" : "PROVIDER_UNAVAILABLE",
      };
    }
  }
  return probeErrorOfStatus(res.status);
}

/** Mapeia falha do vault (test) para código sanitizado, sem vazar detalhe. */
function vaultReadErrorOf(err: unknown): "INVALID_CREDENTIALS" | "PROVIDER_UNAVAILABLE" | "TIMEOUT" {
  if (err instanceof SecretsError) {
    if (err.code === "NOT_FOUND") {
      return "INVALID_CREDENTIALS";
    }
    if (err.code === "TRANSPORT") {
      return "TIMEOUT";
    }
    return "PROVIDER_UNAVAILABLE";
  }
  return "PROVIDER_UNAVAILABLE";
}

async function handleTest(
  ctx: CommandHandlerContext,
  input: TestIntegrationInput,
): Promise<CommandResult<IntegrationBindingResult>> {
  const trx = requireTrx(ctx);
  const providerRow = await trx
    .selectFrom("provider.providers")
    .select(["id"])
    .where("provider_key", "=", input.provider)
    .executeTakeFirst();
  if (providerRow === undefined) {
    return { ok: false, code: "not_found", message: `no live ${input.provider} binding in this tenant` };
  }
  let query = trx
    .selectFrom("provider.provider_accounts")
    .select(["id", "environment", "secret_ref", "connection_status", "version"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("provider_id", "=", providerRow.id)
    .where("connection_status", "<>", "DISABLED");
  if (input.environment !== undefined) {
    query = query.where("environment", "=", input.environment);
  }
  const binding = await query.orderBy("updated_at", "desc").forUpdate().executeTakeFirst();
  if (binding === undefined) {
    return { ok: false, code: "not_found", message: `no live ${input.provider} binding in this tenant` };
  }

  const reader = resolveReader();
  const at = now();

  // CINEVISION: sem browser em S1 — só resolução do vault (presença; o valor
  // nunca é retornado nem logado) + coerência do binding → mantém TESTING.
  // CONNECTED_READ_ONLY cinevision SÓ com certificação live (S4).
  if (input.provider === "cinevision") {
    let code: string | null = null;
    try {
      await reader.getSecret(binding.secret_ref);
    } catch (err) {
      code = vaultReadErrorOf(err);
    }
    await trx
      .updateTable("provider.provider_accounts")
      .set({ connection_status: "TESTING", last_checked_at: at, last_error_code: code, updated_at: at })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", binding.id)
      .execute();
    return {
      ok: true,
      data: sanitize({
        id: binding.id,
        provider: input.provider,
        environment: binding.environment,
        connection_status: "TESTING",
        version: binding.version,
        last_checked_at: at,
        last_error_code: code,
      }),
    };
  }

  // ASAAS: resolve o token no vault e sonda read-only na allowlist fixa.
  let authToken: string;
  try {
    authToken = await reader.getSecret(binding.secret_ref);
  } catch (err) {
    const code = vaultReadErrorOf(err);
    await trx
      .updateTable("provider.provider_accounts")
      .set({ connection_status: "TESTING", last_checked_at: at, last_error_code: code, updated_at: at })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", binding.id)
      .execute();
    return {
      ok: true,
      data: sanitize({
        id: binding.id,
        provider: input.provider,
        environment: binding.environment,
        connection_status: "TESTING",
        version: binding.version,
        last_checked_at: at,
        last_error_code: code,
      }),
    };
  }
  const host =
    binding.environment === "PRODUCTION" ? ASAAS_HOSTS.PRODUCTION : ASAAS_HOSTS.SANDBOX;
  const probe = await probeAsaas({ host, authToken });
  const status = probe.ok ? "CONNECTED_READ_ONLY" : "TESTING";
  const code = probe.ok ? null : probe.code;
  await trx
    .updateTable("provider.provider_accounts")
    .set({ connection_status: status, last_checked_at: at, last_error_code: code, updated_at: at })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", binding.id)
    .execute();
  return {
    ok: true,
    data: sanitize({
      id: binding.id,
      provider: input.provider,
      environment: binding.environment,
      connection_status: status,
      version: binding.version,
      last_checked_at: at,
      last_error_code: code,
    }),
  };
}

// ---------------------------------------------------------------------------
// disable: pausa novos efeitos, preserva histórico (linha mantida DISABLED).
// ---------------------------------------------------------------------------

async function handleDisable(
  ctx: CommandHandlerContext,
  input: DisableIntegrationInput,
): Promise<CommandResult<IntegrationBindingResult>> {
  const trx = requireTrx(ctx);
  const providerRow = await trx
    .selectFrom("provider.providers")
    .select(["id"])
    .where("provider_key", "=", input.provider)
    .executeTakeFirst();
  if (providerRow === undefined) {
    return { ok: false, code: "not_found", message: `no live ${input.provider} binding in this tenant` };
  }
  let query = trx
    .selectFrom("provider.provider_accounts")
    .select(["id", "environment", "connection_status", "version", "last_checked_at", "last_error_code"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("provider_id", "=", providerRow.id)
    .where("connection_status", "<>", "DISABLED");
  if (input.environment !== undefined) {
    query = query.where("environment", "=", input.environment);
  }
  const binding = await query.orderBy("updated_at", "desc").forUpdate().executeTakeFirst();
  if (binding === undefined) {
    return { ok: false, code: "not_found", message: `no live ${input.provider} binding in this tenant` };
  }
  if (input.expectedVersion === undefined) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `live ${input.provider} binding exists (version ${Number(binding.version)}); expectedVersion is required`,
    };
  }
  if (input.expectedVersion !== Number(binding.version)) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `version conflict: expected ${input.expectedVersion}, current is ${Number(binding.version)}`,
    };
  }
  const nextVersion = Number(binding.version) + 1;
  const updated = await trx
    .updateTable("provider.provider_accounts")
    .set({ connection_status: "DISABLED", updated_at: now(), version: nextVersion })
    .where("tenant_id", "=", ctx.tenantId)
    .where("id", "=", binding.id)
    .where("version", "=", Number(binding.version))
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows ?? 0) < 1) {
    return {
      ok: false,
      code: "precondition_failed",
      message: `version conflict: binding ${binding.id} changed concurrently; retry against current state`,
    };
  }
  return {
    ok: true,
    data: sanitize({
      id: binding.id,
      provider: input.provider,
      environment: binding.environment,
      connection_status: "DISABLED",
      version: nextVersion,
      last_checked_at: binding.last_checked_at,
      last_error_code: binding.last_error_code,
    }),
  };
}

export function registerIntegrationCommands(bus: CommandBus): void {
  bus.register<ConfigureIntegrationInput, IntegrationBindingResult>({
    name: "integration.configure",
    permission: "integration.manage",
    auditAction: "integration.configure",
    auditResource: "provider_account",
    input: configureIntegrationInput,
    handler: handleConfigure,
  });
  bus.register<TestIntegrationInput, IntegrationBindingResult>({
    name: "integration.test",
    permission: "integration.test",
    auditAction: "integration.test",
    auditResource: "provider_account",
    input: testIntegrationInput,
    handler: handleTest,
  });
  bus.register<DisableIntegrationInput, IntegrationBindingResult>({
    name: "integration.disable",
    permission: "integration.manage",
    auditAction: "integration.disable",
    auditResource: "provider_account",
    input: disableIntegrationInput,
    handler: handleDisable,
  });
}
