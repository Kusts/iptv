import { HttpException } from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { newId, now } from "@iptv/domain";
import { parseIntegrationsPublicBaseUrl } from "@iptv/config";
import type { CommandResult } from "@iptv/domain";
import type { CommandBus, CommandHandlerContext } from "../commands/command-bus.js";
import { kyselyTrxOf } from "../crm/wave2-store.js";
import {
  ASAAS_WEBHOOK_LIMIT,
  AsaasWebhookError,
  RealAsaasAdapter,
} from "../billing/asaas-port.js";
import {
  resolveSecretsPort,
  resolveSecretsWriterPort,
  buildIntegrationSecretRef,
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
  /**
   * Override explícito da base pública (`null` simula ausente para o teste
   * de manual-mode; `undefined` = sem override, lê o env real).
   */
  webhookBaseUrl?: string | null;
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

/**
 * Base pública canônica (origem `scheme://host[:port]`). Override de teste
 * primeiro; depois `INTEGRATIONS_PUBLIC_BASE_URL` validada pela mesma regra
 * do `loadConfig` (NUNCA host do cliente).
 */
function resolvePublicBaseUrl(): string | null {
  if (testDoubles?.webhookBaseUrl !== undefined) {
    return testDoubles.webhookBaseUrl;
  }
  return parseIntegrationsPublicBaseUrl(process.env["INTEGRATIONS_PUBLIC_BASE_URL"]);
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
// webhook_ensure: input + resultado sanitizado (nunca o authToken).
// ---------------------------------------------------------------------------

export const webhookEnsureInput = z
  .object({
    provider: z.literal("asaas"),
    environment: environmentSchema,
    /**
     * Email operacional que recebe os avisos do Asaas sobre o webhook
     * (notification routing only). O controller preenche com o email da
     * sessão quando ausente; um valor explícito é validado aqui.
     */
    email: z.string().trim().email().max(320).optional(),
  })
  .strict();
export type WebhookEnsureInput = z.infer<typeof webhookEnsureInput>;

export interface WebhookEnsureResult {
  webhookUrl: string;
  providerWebhookId: string;
  hasAuthToken: true;
  status: "ACTIVE";
}

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

// ---------------------------------------------------------------------------
// webhook_ensure: provisiona o webhook Asaas do tenant (S2A, #86).
//
// Idempotente por natureza: PUT-or-POST pelo match da URL canônica
// (`<base>/v1/webhooks/asaas/:tenantKey`), então não há `expectedVersion` —
// a concorrência converge (mesma URL, mesmo authToken reutilizado do vault).
//
// Ordem de escrita SEGURA:
//  1. resolve o binding vivo + a API key no vault (falha → 503, nada marcado);
//  2. resolve a tenant_key (reusa a linha existente, senão deriva estável);
//  3. base pública ausente/inválida → 503 `WEBHOOK_BASE_URL_NOT_CONFIGURED`
//     com instrução de modo manual (path esperado + como validar);
//  4. `GET /v3/webhooks` (dedupe pela URL canônica; 10 existentes sem match
//     → 409 orientando update/delete manual);
//  5. authToken via `crypto` (64 chars base64url, sem espaços) SOMENTE sem um
//     token válido existente; `put` no vault ANTES de chamar o Asaas;
//  6. `POST` (novo) ou `PUT` (match) com o authToken;
//  7. upsert do `billing.tenant_channels` (`webhook_secret_hash=sha256`,
//     ACTIVE) — SOMENTE após o provider confirmar.
//
// Falha em 6 após 5 mantém o token no vault (NÃO deleta): o retry reutiliza
// o mesmo valor e converge (PUT com o mesmo authToken). Falha em 7 após 6
// também é recuperável pelo retry (dedupe encontra o webhook criado e faz
// PUT + upsert). A resposta NUNCA contém o token (`hasAuthToken: true`).
// ---------------------------------------------------------------------------

const ASAAS_WEBHOOK_CHANNEL = "ASAAS";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Token válido: 32–255 chars (regra oficial Asaas), sem whitespace. */
function isValidAuthToken(value: unknown): value is string {
  return (
    typeof value === "string" && value.length >= 32 && value.length <= 255 && !/\s/.test(value)
  );
}

/** Gera um authToken fresco: 48 bytes aleatórios em base64url (64 chars). */
function generateAuthToken(): string {
  return randomBytes(48).toString("base64url");
}

/**
 * Deriva a tenant_key estável `asaas-<tenantId-short>`: 12 hex do tenant id
 * (48 bits — colisão cross-tenant exige ~2^24 tenants; o insert ainda trata
 * `23505` estendendo a chave, sem nunca ler linhas de outro tenant sob RLS).
 */
function tenantKeyCandidates(tenantId: string): string[] {
  const hex = tenantId.replace(/-/g, "").toLowerCase();
  const lens = [12, 16, 20, 24, 32].filter((len) => len <= hex.length);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const len of lens) {
    const candidate = `asaas-${hex.slice(0, len)}`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out.length > 0 ? out : [`asaas-${hex}`];
}

function webhookManualMode(tenantKey: string): HttpException {
  return new HttpException(
    {
      code: "WEBHOOK_BASE_URL_NOT_CONFIGURED",
      message:
        "public webhook base URL is not configured (set INTEGRATIONS_PUBLIC_BASE_URL, e.g. https://app.exemplo.com, and retry). " +
        `Manual mode: register the webhook at the Asaas dashboard with url <base>/v1/webhooks/asaas/${tenantKey} ` +
        "(path /v1/webhooks/asaas/:tenantKey), events PAYMENT_RECEIVED/PAYMENT_OVERDUE/PAYMENT_REFUNDED, " +
        "sendType SEQUENTIALLY, apiVersion 3 and your own 32-255-char authToken (no spaces, not an API key); " +
        "then validate with a sandbox event and confirm the ingress answers 202 with the asaas-access-token header. " +
        "Re-run integration.webhook_ensure once the base URL is set to sync the channel hash.",
    },
    503,
  );
}

function webhookProviderErrorOf(err: unknown): HttpException | CommandResult<WebhookEnsureResult> {
  if (err instanceof AsaasWebhookError) {
    if (err.status === 401 || err.status === 403) {
      return {
        ok: false,
        code: "precondition_failed",
        message:
          "asaas rejected the vaulted API credential (INVALID_CREDENTIALS); rotate via integration.configure and retry",
      };
    }
    if (typeof err.status === "number" && err.status >= 400 && err.status < 500) {
      return {
        ok: false,
        code: "precondition_failed",
        message: `asaas refused the webhook save with status ${err.status} (check the binding credential/environment and retry)`,
      };
    }
    throw new HttpException(
      { code: "PROVIDER_UNAVAILABLE", message: "asaas webhook API unavailable; retry later" },
      503,
    );
  }
  throw err;
}

async function handleWebhookEnsure(
  ctx: CommandHandlerContext,
  input: WebhookEnsureInput,
): Promise<CommandResult<WebhookEnsureResult>> {
  const trx = requireTrx(ctx);

  // 1. Binding vivo do tenant (provider + environment exatos).
  const providerRow = await trx
    .selectFrom("provider.providers")
    .select(["id"])
    .where("provider_key", "=", "asaas")
    .executeTakeFirst();
  if (providerRow === undefined) {
    return { ok: false, code: "not_found", message: "no live asaas binding in this tenant" };
  }
  const binding = await trx
    .selectFrom("provider.provider_accounts")
    .select(["id", "environment", "secret_ref"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("provider_id", "=", providerRow.id)
    .where("environment", "=", input.environment)
    .where("connection_status", "<>", "DISABLED")
    .orderBy("updated_at", "desc")
    .forUpdate()
    .executeTakeFirst();
  if (binding === undefined) {
    return {
      ok: false,
      code: "not_found",
      message: `no live asaas binding for environment ${input.environment} in this tenant`,
    };
  }

  // 2. tenant_key: reusa a linha existente (qualquer status — URL estável
  //    entre disable/enable), senão deriva a primeira candidata.
  const existingChannel = await trx
    .selectFrom("billing.tenant_channels")
    .select(["id", "tenant_key"])
    .where("tenant_id", "=", ctx.tenantId)
    .where("channel", "=", ASAAS_WEBHOOK_CHANNEL)
    .orderBy("updated_at", "desc")
    .forUpdate()
    .executeTakeFirst();
  const tenantKey =
    existingChannel?.tenant_key ?? (tenantKeyCandidates(ctx.tenantId)[0] as string);

  // 3. Base pública fail-closed com instrução de modo manual.
  const base = resolvePublicBaseUrl();
  if (base === null) {
    throw webhookManualMode(tenantKey);
  }
  const webhookUrl = `${base}/v1/webhooks/asaas/${tenantKey}`;

  // 4. API key do vault (falha → 503, nada marcado, nenhum valor vaza).
  const reader = resolveReader();
  let apiKey: string;
  try {
    apiKey = await reader.getSecret(binding.secret_ref);
  } catch (err) {
    if (err instanceof SecretsError) {
      throw vaultUnavailable();
    }
    throw err;
  }

  const host =
    input.environment === "PRODUCTION" ? ASAAS_HOSTS.PRODUCTION : ASAAS_HOSTS.SANDBOX;
  const port = new RealAsaasAdapter(resolveFetch());

  // 5. Dedupe pela URL canônica (falha do provider mapeada sem corpo/valor).
  let remote: { id: string; url: string }[];
  try {
    remote = (await port.listWebhooks({ host, apiKey, fetchFn: resolveFetch() })).webhooks;
  } catch (err) {
    const mapped = webhookProviderErrorOf(err);
    if (mapped instanceof HttpException) {
      throw mapped;
    }
    return mapped;
  }
  const match = remote.find((webhook) => webhook.url === webhookUrl);
  if (match === undefined && remote.length >= ASAAS_WEBHOOK_LIMIT) {
    return {
      ok: false,
      code: "precondition_failed",
      message:
        `asaas account already holds ${remote.length} webhooks (limit ${ASAAS_WEBHOOK_LIMIT}) with none matching ${webhookUrl}; ` +
        "update or delete an unused webhook manually at the Asaas dashboard and retry",
    };
  }

  // 6. authToken: reusa o válido existente (retry converge), senão gera + put
  //    no vault ANTES de chamar o Asaas. Falha do put → 503, nada marcado.
  const writer = resolveWriter();
  const webhookRefTarget = {
    tenantId: ctx.tenantId,
    provider: "asaas" as const,
    environment: input.environment,
    key: "ASAAS_WEBHOOK_TOKEN",
  };
  let authToken: string | null = null;
  try {
    const current = await writer.getSecret(buildIntegrationSecretRef(webhookRefTarget));
    if (isValidAuthToken(current)) {
      authToken = current;
    }
  } catch (err) {
    if (!(err instanceof SecretsError) || err.code !== "NOT_FOUND") {
      if (err instanceof SecretsError) {
        throw vaultUnavailable();
      }
      throw err;
    }
  }
  if (authToken === null) {
    const fresh = generateAuthToken();
    try {
      await writer.putSecret({ ...webhookRefTarget, value: fresh, requestId: ctx.commandId });
    } catch (err) {
      if (err instanceof SecretsError) {
        throw vaultUnavailable();
      }
      throw err;
    }
    authToken = fresh;
  }

  // 7. POST (novo) ou PUT (match). Falha após o put mantém o token no vault
  //    (reutilizável no retry — NUNCA deletar aqui). O email operacional vem
  //    da sessão (o controller preenche); chamada direta sem email falha
  //    fechado em vez de inventar um endereço.
  const notificationEmail = input.email;
  if (notificationEmail === undefined) {
    return {
      ok: false,
      code: "precondition_failed",
      message: "notification email is required (resolved from the operator session)",
    };
  }
  let providerWebhookId: string;
  try {
    providerWebhookId =
      match === undefined
        ? (
            await port.createWebhook({
              host,
              apiKey,
              fetchFn: resolveFetch(),
              name: `iptv-asaas-${tenantKey}`,
              url: webhookUrl,
              email: notificationEmail,
              authToken,
            })
          ).id
        : (
            await port.updateWebhook({
              host,
              apiKey,
              fetchFn: resolveFetch(),
              providerWebhookId: match.id,
              name: `iptv-asaas-${tenantKey}`,
              url: webhookUrl,
              email: notificationEmail,
              authToken,
            })
          ).id;
  } catch (err) {
    const mapped = webhookProviderErrorOf(err);
    if (mapped instanceof HttpException) {
      throw mapped;
    }
    return mapped;
  }

  // 8. Upsert do canal SOMENTE após o provider confirmar (hash sha256 do
  //    token — o ingress verifica timing-safe contra ele). Falha do DB após
  //    o save → 503 com o token retido no vault (o retry faz PUT + upsert).
  const secretHash = sha256Hex(authToken);
  const at = now();
  try {
    if (existingChannel === undefined) {
      let inserted = false;
      const candidates = tenantKeyCandidates(ctx.tenantId);
      let lastError: unknown = null;
      for (const candidate of candidates) {
        try {
          await trx
            .insertInto("billing.tenant_channels")
            .values({
              id: newId(),
              tenant_id: ctx.tenantId,
              channel: ASAAS_WEBHOOK_CHANNEL,
              tenant_key: candidate,
              webhook_secret_hash: secretHash,
              status: "ACTIVE",
              created_at: at,
              updated_at: at,
            })
            .execute();
          inserted = true;
          break;
        } catch (err) {
          if ((err as { code?: unknown }).code === "23505") {
            lastError = err;
            continue;
          }
          throw err;
        }
      }
      if (!inserted) {
        throw lastError ?? vaultUnavailable();
      }
    } else {
      await trx
        .updateTable("billing.tenant_channels")
        .set({ webhook_secret_hash: secretHash, status: "ACTIVE", updated_at: at })
        .where("tenant_id", "=", ctx.tenantId)
        .where("id", "=", existingChannel.id)
        .execute();
    }
  } catch (err) {
    if (err instanceof HttpException) {
      throw err;
    }
    throw vaultUnavailable();
  }

  return {
    ok: true,
    data: { webhookUrl, providerWebhookId, hasAuthToken: true as const, status: "ACTIVE" as const },
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
  bus.register<WebhookEnsureInput, WebhookEnsureResult>({
    name: "integration.webhook_ensure",
    permission: "integration.manage",
    auditAction: "integration.webhook_ensure",
    auditResource: "tenant_channel",
    input: webhookEnsureInput,
    handler: handleWebhookEnsure,
  });
}
