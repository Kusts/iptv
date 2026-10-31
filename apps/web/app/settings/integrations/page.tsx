"use client";

import { useState } from "react";
import { Shell } from "../../../components/Shell";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { StatusPill } from "../../../components/ui/Badge";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../../components/ui/States";
import { Dialog } from "../../../components/ui/Dialog";
import { CopySnippet } from "../../../components/ui/CopySnippet";
import { Field, Input, Select } from "../../../components/ui/Input";
import { useToast } from "../../../components/ui/Toast";
import { WhatsAppSessionCard } from "./whatsapp-card";
import { CinevisionCard } from "./cinevision-card";
import { api, ApiError, userMessage } from "../../../lib/api";
import { useApi } from "../../../lib/useApi";
import { useOptionalHasPermission } from "../../../lib/auth";
import { formatDateTime } from "../../../lib/money";

const READ_PERMISSION = "integration.read";
const MANAGE_PERMISSION = "integration.manage";
const TEST_PERMISSION = "integration.test";

type ProviderKey = "asaas" | "whatsapp" | "cinevision";

const PROVIDER_ORDER: ProviderKey[] = ["asaas", "whatsapp", "cinevision"];

const PROVIDER_META: Record<ProviderKey, { title: string; description: string }> = {
  asaas: { title: "Asaas (Cobranças)", description: "Boletos, PIX e cobranças." },
  whatsapp: { title: "WhatsApp (Atendimento)", description: "Conversas e notificações." },
  cinevision: { title: "CINEVISION (Servidor/Ativação)", description: "Ativação e gestão de servidores." },
};

function isProviderKey(value: string): value is ProviderKey {
  return value === "asaas" || value === "whatsapp" || value === "cinevision";
}

// ---------------------------------------------------------------------------
// Tipos espelhados da API S1 (somente metadados sanitizados — a API nunca
// envia `secret_ref`, valores de segredo ou settings; a UI renderiza apenas
// estes campos conhecidos, nunca o corpo cru da resposta).
// ---------------------------------------------------------------------------

interface IntegrationStatus {
  provider: string;
  environment: string;
  connection_status: string;
  capability_status: string;
  last_checked_at: string | null;
  last_error_code: string | null;
  configured: boolean;
}

interface BindingResult {
  id: string;
  provider: string;
  environment: string;
  connection_status: string;
  version: number;
  last_checked_at: string | null;
  last_error_code: string | null;
}

const CONNECTION_LABELS: Record<string, string> = {
  NOT_CONFIGURED: "Não configurado",
  DRAFT: "Rascunho",
  TESTING: "Em teste",
  CONNECTED_READ_ONLY: "Conectado (somente leitura)",
  READY_FOR_PILOT: "Pronto para piloto",
  ACTIVE: "Ativo",
  DEGRADED: "Degradado",
  REAUTH_REQUIRED: "Reautorização necessária",
  DISABLED: "Desativado",
};

const CAPABILITY_LABELS: Record<string, string> = {
  AVAILABLE: "Disponível",
  DEGRADED: "Degradada",
  UNAVAILABLE: "Indisponível",
  UNCERTIFIED: "Não certificada",
  UNKNOWN: "Desconhecida",
};

/**
 * Instrução de resolução por código sanitizado (SPEC S1 §3–§4). Códigos
 * chegam sem detalhe interno; a UI orienta o próximo passo em pt-BR.
 */
const RESOLUTION_HINTS: Record<string, string> = {
  INVALID_CREDENTIALS:
    "Credenciais inválidas. Confira a chave de API (Asaas) ou o usuário e a senha (CINEVISION) e configure novamente.",
  PROVIDER_UNAVAILABLE: "Provedor indisponível. Aguarde alguns instantes e use Testar novamente.",
  TIMEOUT: "Tempo esgotado ao falar com o provedor. Tente Testar novamente.",
  REAUTH_REQUIRED: "Reautorização necessária. Reconfigure a integração com credenciais válidas.",
  CAPABILITY_UNCERTIFIED: "Recurso ainda não certificado para este tenant. O WhatsApp chega em S3.",
  CHALLENGE_DETECTED:
    "O painel exigiu verificação humana (challenge/CAPTCHA/2FA). Conclua o acesso manualmente no painel CINEVISION e repita o teste — sem bypass.",
};

function connectionLabel(status: string): string {
  return CONNECTION_LABELS[status] ?? status;
}

function capabilityLabel(status: string): string {
  return CAPABILITY_LABELS[status] ?? status;
}

function resolutionHint(code: string | null): string | null {
  if (code === null) return null;
  return RESOLUTION_HINTS[code] ?? "Verifique o status e use Testar para diagnosticar.";
}

function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fallback abaixo
  }
  return `hub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Hosts Asaas fixos por environment — espelho de leitura do allowlist
 * backend (`ASAAS_HOSTS` em `integrations.commands.ts`, pesquisa
 * S2-RESEARCH-ASAAS). A UI exibe; NUNCA envia URL e o schema `strict()`
 * do backend rejeita `baseUrl` e afins com 400.
 */
const ASAAS_HOSTS_DISPLAY = {
  SANDBOX: "https://api-sandbox.asaas.com/v3",
  PRODUCTION: "https://api.asaas.com/v3",
} as const;

type AsaasEnvironment = keyof typeof ASAAS_HOSTS_DISPLAY;

/** Eventos que o webhook Asaas do tenant deve assinar (nomes oficiais). */
const ASAAS_WEBHOOK_EVENTS_DISPLAY = "PAYMENT_RECEIVED, PAYMENT_OVERDUE, PAYMENT_REFUNDED";

function conflictOrGeneric(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) {
    return "Conflito de concorrência — os dados mudaram. Recarregue e tente de novo.";
  }
  return userMessage(err);
}

export default function IntegrationsHubPage(): React.JSX.Element {
  const hasPermission = useOptionalHasPermission();
  const canRead = hasPermission(READ_PERMISSION);
  const canManage = hasPermission(MANAGE_PERMISSION);
  const canTest = hasPermission(TEST_PERMISSION);
  // Sem `integration.read` a UI não busca nada: estado sanitizado, sem segredo.
  const { data, error, loading, reload } = useApi<{ integrations: IntegrationStatus[] }>(
    canRead ? "/v1/integrations" : null,
  );
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  // Versões otimistas por provider: aprendidas das respostas de escrita
  // (configure/test/disable devolvem `version`; o GET de status não carrega
  // versão) e preservadas entre reloads da lista — a S1C2 exige
  // `expectedVersion` no configure/disable com binding vivo.
  const [versions, setVersions] = useState<Record<string, number>>({});
  const learnVersion = (provider: string, version: number): void => {
    setVersions((prev) => (prev[provider] === version ? prev : { ...prev, [provider]: version }));
  };

  return (
    <Shell>
      <div className="cc-row cc-u-mb-4" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1>Integrações</h1>
          <p className="cc-muted">Conecte Asaas, WhatsApp e CINEVISION sem sair do Control Center.</p>
        </div>
        {canRead ? (
          <Button variant="secondary" onClick={reload}>
            Recarregar
          </Button>
        ) : null}
      </div>

      {!canRead ? (
        <Card title="Sem permissão">
          <p>Você não tem permissão para ver as integrações. Fale com um administrador.</p>
        </Card>
      ) : null}

      {canRead && loading ? <LoadingSkeleton lines={6} /> : null}

      {canRead && error !== null ? (
        <div>
          <ErrorState message={offline ? "Você está offline. Verifique sua conexão e tente de novo." : error} onRetry={reload} />
          {offline ? null : (
            <p className="cc-muted cc-u-mt-2">
              Sem conexão com a API? Confira sua internet — ações de escrita exigem rede.
            </p>
          )}
        </div>
      ) : null}

      {canRead && !loading && error === null && data !== null && data.integrations.length === 0 ? (
        <EmptyState
          title="Nenhuma integração encontrada"
          hint="Asaas, WhatsApp e CINEVISION aparecem aqui quando disponíveis para o tenant."
        />
      ) : null}

      {canRead && !loading && error === null && data !== null && data.integrations.length > 0 ? (
        <div className="cc-grid-2">
          {orderedStatuses(data.integrations).map((status) => (
            <IntegrationCard
              key={status.provider}
              status={status}
              canManage={canManage}
              canTest={canTest}
              knownVersion={versions[status.provider] ?? null}
              onVersion={(version) => learnVersion(status.provider, version)}
              onChanged={reload}
            />
          ))}
        </div>
      ) : null}

      {canRead && !loading && error === null && data !== null && data.integrations.length > 0 ? (
        <Card title="Como resolver" className="cc-u-mt-4">
          <ul>
            <li>
              <strong>Credenciais inválidas:</strong> {RESOLUTION_HINTS.INVALID_CREDENTIALS}
            </li>
            <li>
              <strong>Provedor indisponível:</strong> {RESOLUTION_HINTS.PROVIDER_UNAVAILABLE}
            </li>
            <li>
              <strong>Tempo esgotado:</strong> {RESOLUTION_HINTS.TIMEOUT}
            </li>
            <li>
              <strong>Reautorização necessária:</strong> {RESOLUTION_HINTS.REAUTH_REQUIRED}
            </li>
          </ul>
        </Card>
      ) : null}
    </Shell>
  );
}

/** Ordem canônica dos cards (Asaas, WhatsApp, CINEVISION), independente da API. */
function orderedStatuses(list: IntegrationStatus[]): IntegrationStatus[] {
  const byProvider = new Map(list.map((item) => [item.provider, item]));
  const out: IntegrationStatus[] = [];
  for (const provider of PROVIDER_ORDER) {
    const found = byProvider.get(provider);
    if (found !== undefined) out.push(found);
  }
  for (const item of list) {
    if (!isProviderKey(item.provider)) out.push(item);
  }
  return out;
}

function IntegrationCard({
  status,
  canManage,
  canTest,
  knownVersion,
  onVersion,
  onChanged,
}: {
  status: IntegrationStatus;
  canManage: boolean;
  canTest: boolean;
  knownVersion: number | null;
  onVersion: (version: number) => void;
  onChanged: () => void;
}): React.JSX.Element {
  const { push } = useToast();
  const meta = isProviderKey(status.provider)
    ? PROVIDER_META[status.provider]
    : { title: status.provider, description: "" };
  const isWhatsApp = status.provider === "whatsapp";
  const isCinevision = status.provider === "cinevision";
  const isLive = status.configured && status.connection_status !== "DISABLED";
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [configureOpen, setConfigureOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const isAsaas = status.provider === "asaas";

  const runTest = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await api.post<BindingResult>(
        `/v1/integrations/${status.provider}/test`,
        {},
        { idempotencyKey: newIdempotencyKey() },
      );
      onVersion(res.version);
      push(`Teste concluído (${meta.title}): ${connectionLabel(res.connection_status)}.`);
      onChanged();
    } catch (err) {
      const msg = conflictOrGeneric(err);
      setActionError(msg);
      push(msg);
    } finally {
      setBusy(false);
    }
  };

  const hint = resolutionHint(status.last_error_code);

  return (
    <Card title={meta.title}>
      <p className="cc-muted">{meta.description}</p>
      <div className="cc-row cc-u-mt-2">
        <StatusPill status={status.connection_status} />
        <span className="cc-muted">{connectionLabel(status.connection_status)}</span>
      </div>
      <ul className="cc-u-mt-2">
        <li>
          Ambiente: <strong>{status.environment}</strong>
        </li>
        <li>
          Capacidade: <strong>{capabilityLabel(status.capability_status)}</strong>{" "}
          <StatusPill status={status.capability_status} />
        </li>
        <li>Última verificação: {status.last_checked_at === null ? "nunca" : formatDateTime(status.last_checked_at)}</li>
        {status.last_error_code !== null ? (
          <li>
            Último erro: <strong>{status.last_error_code}</strong>
            {hint !== null ? <p className="cc-muted">{hint}</p> : null}
          </li>
        ) : null}
        <li>{status.configured ? "Configurado neste tenant." : "Não configurado neste tenant."}</li>
      </ul>

      {isWhatsApp ? <WhatsAppSessionCard canManage={canManage} /> : null}

      {isCinevision ? (
        <CinevisionCard
          status={status}
          canManage={canManage}
          canTest={canTest}
          knownVersion={knownVersion}
          onVersion={onVersion}
          onChanged={onChanged}
        />
      ) : null}

      {!isWhatsApp && !isCinevision && (canManage || canTest) ? (
        <div className="cc-row cc-u-mt-2">
          {canManage && isAsaas ? (
            <Button variant="secondary" disabled={busy} onClick={() => setWizardOpen(true)}>
              Assistente de conexão
            </Button>
          ) : null}
          {canManage && !isLive ? (
            <Button disabled={busy} onClick={() => setConfigureOpen(true)}>
              Conectar
            </Button>
          ) : null}
          {canManage && isLive ? (
            <Button variant="secondary" disabled={busy} onClick={() => setConfigureOpen(true)}>
              Reconfigurar
            </Button>
          ) : null}
          {canTest && isLive ? (
            <Button variant="secondary" disabled={busy} onClick={() => void runTest()}>
              {busy ? "Testando…" : "Testar"}
            </Button>
          ) : null}
          {canManage && isLive ? (
            <Button variant="danger" disabled={busy} onClick={() => setDisableOpen(true)}>
              Desconectar
            </Button>
          ) : null}
        </div>
      ) : null}
      {!isWhatsApp && !isCinevision && !canManage && !canTest ? (
        <p className="cc-muted cc-u-mt-2">Somente leitura para o seu perfil.</p>
      ) : null}

      {actionError !== null ? <p className="cc-field-error cc-u-mt-2">{actionError}</p> : null}

      {!isWhatsApp && !isCinevision && canManage ? (
        <ConfigureDialog
          status={status}
          knownVersion={knownVersion}
          open={configureOpen}
          onClose={() => setConfigureOpen(false)}
          onVersion={onVersion}
          onChanged={onChanged}
        />
      ) : null}
      {!isWhatsApp && canManage ? (
        <DisableDialog
          status={status}
          knownVersion={knownVersion}
          open={disableOpen}
          onClose={() => setDisableOpen(false)}
          onVersion={onVersion}
          onChanged={onChanged}
        />
      ) : null}
      {isAsaas && canManage ? (
        <AsaasWizardDialog
          status={status}
          knownVersion={knownVersion}
          canTest={canTest}
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
          onVersion={onVersion}
          onChanged={onChanged}
        />
      ) : null}
    </Card>
  );
}

function ConfigureDialog({
  status,
  knownVersion,
  open,
  onClose,
  onVersion,
  onChanged,
}: {
  status: IntegrationStatus;
  knownVersion: number | null;
  open: boolean;
  onClose: () => void;
  onVersion: (version: number) => void;
  onChanged: () => void;
}): React.JSX.Element | null {
  const { push } = useToast();
  const provider = status.provider;
  const isLive = status.configured && status.connection_status !== "DISABLED";
  const [environment, setEnvironment] = useState(status.environment);
  const [apiKey, setApiKey] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const submit = async (): Promise<void> => {
    const key = apiKey.trim();
    const user = username.trim();
    const pass = password.trim();
    if (provider === "asaas") {
      if (key.length === 0) {
        setFieldError("Informe a chave de API.");
        return;
      }
      if (key.length > 512) {
        setFieldError("A chave de API deve ter no máximo 512 caracteres.");
        return;
      }
    } else {
      if (user.length === 0) {
        setFieldError("Informe o usuário.");
        return;
      }
      if (user.length > 256) {
        setFieldError("O usuário deve ter no máximo 256 caracteres.");
        return;
      }
      if (pass.length === 0) {
        setFieldError("Informe a senha.");
        return;
      }
      if (pass.length > 512) {
        setFieldError("A senha deve ter no máximo 512 caracteres.");
        return;
      }
    }
    setFieldError(null);
    setSaveError(null);
    setBusy(true);
    try {
      // Binding vivo exige `expectedVersion` (S1C2, 409 em mismatch). A
      // versão vem das respostas de escrita; quando desconhecida, o hub
      // sonda via Testar (read-only) antes de escrever.
      let expected = knownVersion;
      if (isLive && expected === null) {
        try {
          const probed = await api.post<BindingResult>(
            `/v1/integrations/${provider}/test`,
            {},
            { idempotencyKey: newIdempotencyKey() },
          );
          expected = probed.version;
          onVersion(probed.version);
        } catch {
          expected = null;
        }
      }
      const body: Record<string, unknown> = { environment };
      if (isLive && expected !== null) body.expectedVersion = expected;
      body.secret = provider === "asaas" ? { apiKey: key } : { username: user, password: pass };
      const res = await api.post<BindingResult>(
        `/v1/integrations/${provider}/configure`,
        body,
        { idempotencyKey: newIdempotencyKey() },
      );
      onVersion(res.version);
      push(isLive ? "Integração reconfigurada (DRAFT). Use Testar para validar." : "Integração conectada (DRAFT). Use Testar para validar.");
      onClose();
      onChanged();
    } catch (err) {
      const msg = conflictOrGeneric(err);
      setSaveError(msg);
      push(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={isLive ? "Reconfigurar integração" : "Conectar integração"} open={open} onClose={onClose}>
      <div className="cc-form">
        <p className="cc-muted">
          {provider === "asaas" ? "Asaas (Cobranças)" : "CINEVISION (Servidor/Ativação)"} — o segredo vai
          direto ao cofre do servidor e nunca volta para o navegador.
        </p>
        <Field label="Ambiente">
          <Select value={environment} onChange={(e) => setEnvironment(e.target.value)} disabled={busy}>
            <option value="SANDBOX">Sandbox (SANDBOX)</option>
            <option value="PRODUCTION">Produção (PRODUCTION)</option>
          </Select>
        </Field>
        {provider === "asaas" ? (
          <Field label="Chave de API" error={fieldError}>
            <Input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setFieldError(null);
              }}
              disabled={busy}
              placeholder="Cole a chave de API do Asaas"
            />
          </Field>
        ) : (
          <>
            <Field label="Usuário" error={fieldError}>
              <Input
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setFieldError(null);
                }}
                disabled={busy}
                placeholder="Usuário CINEVISION"
              />
            </Field>
            <Field label="Senha">
              <Input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setFieldError(null);
                }}
                disabled={busy}
                placeholder="Senha CINEVISION"
              />
            </Field>
          </>
        )}
        {fieldError !== null && provider !== "asaas" && username.trim().length > 0 ? (
          <p className="cc-field-error">{fieldError}</p>
        ) : null}
        {saveError !== null ? <p className="cc-field-error">{saveError}</p> : null}
        <div className="cc-row cc-u-mt-4">
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? "Salvando…" : "Salvar"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

interface WebhookEnsureResult {
  webhookUrl: string;
  providerWebhookId: string;
  hasAuthToken: boolean;
  status: string;
}

type WizardStep = 1 | 2 | 3 | 4;

/**
 * Assistente guiado de conexão Asaas (S2B, #86): ambiente → credencial →
 * webhook → teste em sandbox. Reutiliza os contratos S1/S2A
 * (`integration.configure|test` + `integration.webhook_ensure`); NENHUMA
 * cobrança é criada a partir daqui — a etapa 4 executa somente a sonda
 * read-only (`integration.test`) em SANDBOX, após confirmação explícita.
 * Não existe endpoint backend de "cobrança de teste" em `origin/main`, e
 * `charge.create` exigiria pedido + `billing.charge.write` (fora do gating
 * deste hub): criar cobrança de teste segue no fluxo de pedidos/billing,
 * não neste assistente. Sem segredo no DOM: a resposta do webhook nunca
 * contém o authToken (`hasAuthToken: true` apenas).
 */
function AsaasWizardDialog({
  status,
  knownVersion,
  canTest,
  open,
  onClose,
  onVersion,
  onChanged,
}: {
  status: IntegrationStatus;
  knownVersion: number | null;
  canTest: boolean;
  open: boolean;
  onClose: () => void;
  onVersion: (version: number) => void;
  onChanged: () => void;
}): React.JSX.Element | null {
  const { push } = useToast();
  const isLive = status.configured && status.connection_status !== "DISABLED";
  const [step, setStep] = useState<WizardStep>(1);
  const [environment, setEnvironment] = useState<AsaasEnvironment>("SANDBOX");
  const [prodConfirm, setProdConfirm] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [credSaved, setCredSaved] = useState(false);
  const [credBusy, setCredBusy] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [webhookResult, setWebhookResult] = useState<WebhookEnsureResult | null>(null);
  const [webhookMode, setWebhookMode] = useState<"idle" | "manual" | "limit" | "error">("idle");
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [manualAck, setManualAck] = useState(false);
  const [testConfirm, setTestConfirm] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testDone, setTestDone] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  if (!open) return null;

  const host = ASAAS_HOSTS_DISPLAY[environment];

  const saveCredential = async (): Promise<void> => {
    const key = apiKey.trim();
    if (key.length === 0) {
      setCredError("Informe a chave de API.");
      return;
    }
    if (key.length > 512) {
      setCredError("A chave de API deve ter no máximo 512 caracteres.");
      return;
    }
    setCredError(null);
    setCredBusy(true);
    try {
      let expected = knownVersion;
      if (isLive && expected === null) {
        try {
          const probed = await api.post<BindingResult>(
            "/v1/integrations/asaas/test",
            {},
            { idempotencyKey: newIdempotencyKey() },
          );
          expected = probed.version;
          onVersion(probed.version);
        } catch {
          expected = null;
        }
      }
      const body: Record<string, unknown> = { environment };
      if (isLive && expected !== null) body.expectedVersion = expected;
      body.secret = { apiKey: key };
      const res = await api.post<BindingResult>("/v1/integrations/asaas/configure", body, {
        idempotencyKey: newIdempotencyKey(),
      });
      onVersion(res.version);
      setCredSaved(true);
      push("Credencial Asaas salva (DRAFT). Avance para o webhook.");
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_CREDENTIALS") {
        const hint = RESOLUTION_HINTS.INVALID_CREDENTIALS ?? userMessage(err);
        setCredError(hint);
        push(hint);
      } else {
        const msg = conflictOrGeneric(err);
        setCredError(msg);
        push(msg);
      }
    } finally {
      setCredBusy(false);
    }
  };

  const runWebhook = async (): Promise<void> => {
    setWebhookError(null);
    setWebhookBusy(true);
    try {
      const res = await api.post<WebhookEnsureResult>(
        "/v1/integrations/asaas/webhook",
        { provider: "asaas", environment },
        { idempotencyKey: newIdempotencyKey() },
      );
      setWebhookResult(res);
      setWebhookMode("idle");
      push("Webhook Asaas configurado.");
      // Sem reload aqui: `onChanged` desmontaria o card (skeleton) e fecharia
      // o assistente no remount. O refresh da lista acontece no "Concluir".
    } catch (err) {
      // 503 manual-mode e 409 de limite vêm com códigos sanitizados; o
      // token nunca viaja na resposta (só `hasAuthToken: true`).
      if (err instanceof ApiError && err.code === "WEBHOOK_BASE_URL_NOT_CONFIGURED") {
        setWebhookMode("manual");
      } else if (err instanceof ApiError && err.status === 409) {
        setWebhookMode("limit");
      } else {
        setWebhookMode("error");
        const msg = conflictOrGeneric(err);
        setWebhookError(msg);
        push(msg);
      }
    } finally {
      setWebhookBusy(false);
    }
  };

  const runSandboxTest = async (): Promise<void> => {
    setTestError(null);
    setTestBusy(true);
    try {
      const res = await api.post<BindingResult>(
        "/v1/integrations/asaas/test",
        {},
        { idempotencyKey: newIdempotencyKey() },
      );
      onVersion(res.version);
      setTestDone(`Teste concluído: ${connectionLabel(res.connection_status)}.`);
      push("Teste em sandbox concluído.");
      // Sem reload aqui (ver `runWebhook`): o refresh acontece no "Concluir".
    } catch (err) {
      const msg = conflictOrGeneric(err);
      setTestError(msg);
      push(msg);
    } finally {
      setTestBusy(false);
    }
  };

  const finish = (): void => {
    onClose();
    onChanged();
  };

  return (
    <Dialog title="Assistente Asaas" open={open} onClose={onClose}>
      <div className="cc-form">
        {step === 1 ? (
          <div>
            <p>
              <strong>Etapa 1 de 4 — Ambiente</strong>
            </p>
            <p className="cc-muted">
              O ambiente é explícito e o host é fixo por ambiente (sem campo de URL editável).
            </p>
            <div className="cc-field">
              <span>Ambiente</span>
              <label className="cc-row" style={{ gap: "0.5rem", alignItems: "center" }} htmlFor="asaas-wizard-env-sandbox">
                <input
                  type="radio"
                  id="asaas-wizard-env-sandbox"
                  name="asaas-wizard-env"
                  checked={environment === "SANDBOX"}
                  onChange={() => setEnvironment("SANDBOX")}
                />
                Sandbox (testes, sem dinheiro real)
              </label>
              <label className="cc-row cc-u-mt-2" style={{ gap: "0.5rem", alignItems: "center" }} htmlFor="asaas-wizard-env-production">
                <input
                  type="radio"
                  id="asaas-wizard-env-production"
                  name="asaas-wizard-env"
                  checked={environment === "PRODUCTION"}
                  onChange={() => setEnvironment("PRODUCTION")}
                />
                Produção (dinheiro real)
              </label>
            </div>
            <p className="cc-muted">
              Host fixo: <strong>{host}</strong>
            </p>
            {environment === "PRODUCTION" ? (
              <div className="cc-field">
                <span>Confirmação de impacto</span>
                <label className="cc-row" style={{ gap: "0.5rem", alignItems: "center" }} htmlFor="asaas-wizard-prod-confirm">
                  <input
                    type="checkbox"
                    id="asaas-wizard-prod-confirm"
                    checked={prodConfirm}
                    onChange={(e) => setProdConfirm(e.target.checked)}
                  />
                  Entendo que produção movimenta dinheiro real e afeta cobranças do tenant.
                </label>
              </div>
            ) : null}
            <div className="cc-row cc-u-mt-4">
              <Button
                disabled={environment === "PRODUCTION" && !prodConfirm}
                onClick={() => setStep(2)}
              >
                Avançar para credencial
              </Button>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div>
            <p>
              <strong>Etapa 2 de 4 — Credencial</strong>
            </p>
            <p className="cc-muted">
              A chave vai direto ao cofre do servidor e nunca volta para o navegador.
            </p>
            <Field label="Chave de API">
              <Input
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setCredError(null);
                  setCredSaved(false);
                }}
                disabled={credBusy}
                placeholder="Cole a chave de API do Asaas"
              />
            </Field>
            {credError !== null ? <p className="cc-field-error">{credError}</p> : null}
            {credSaved ? <p>Credencial salva. Avance para configurar o webhook.</p> : null}
            <div className="cc-row cc-u-mt-4">
              <Button variant="secondary" disabled={credBusy} onClick={() => setStep(1)}>
                Voltar
              </Button>
              <Button disabled={credBusy} onClick={() => void saveCredential()}>
                {credBusy ? "Salvando…" : "Salvar credencial"}
              </Button>
              {isLive ? (
                <Button variant="secondary" disabled={credBusy} onClick={() => setStep(3)}>
                  Pular para webhook
                </Button>
              ) : null}
              {credSaved ? (
                <Button disabled={credBusy} onClick={() => setStep(3)}>
                  Avançar para webhook
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div>
            <p>
              <strong>Etapa 3 de 4 — Webhook</strong>
            </p>
            <p className="cc-muted">
              O assistente cria ou atualiza o webhook na conta Asaas (eventos{" "}
              {ASAAS_WEBHOOK_EVENTS_DISPLAY}) sem exibir o token.
            </p>
            <div className="cc-row cc-u-mt-2">
              <Button disabled={webhookBusy} onClick={() => void runWebhook()}>
                {webhookBusy ? "Configurando…" : "Configurar webhook automaticamente"}
              </Button>
            </div>
            {webhookResult !== null ? (
              <div className="cc-u-mt-2">
                <p>
                  Webhook ativo: <CopySnippet text={webhookResult.webhookUrl} label="URL do webhook" />
                </p>
                <p className="cc-muted">
                  ID no provedor: <strong>{webhookResult.providerWebhookId}</strong> — status{" "}
                  <strong>{webhookResult.status}</strong>.
                </p>
              </div>
            ) : null}
            {webhookMode === "manual" ? (
              <div className="cc-u-mt-2">
                <p>
                  <strong>Modo manual:</strong> a base pública ainda não está configurada no
                  servidor. Registre o webhook no painel do Asaas com a URL canônica no formato{" "}
                  <strong>&lt;base-publica&gt;/v1/webhooks/asaas/:tenantKey</strong> (troque a base
                  e a chave do tenant), eventos{" "}
                  <strong>{ASAAS_WEBHOOK_EVENTS_DISPLAY}</strong>, envio sequencial e um
                  authToken próprio de 32 a 255 caracteres (sem espaços, nunca a chave de API).
                  Depois valide com um evento de sandbox e confirme que o ingresso responde 202
                  com o cabeçalho <strong>asaas-access-token</strong>.
                </p>
                <div className="cc-field">
                  <span>Confirmação manual</span>
                  <label className="cc-row" style={{ gap: "0.5rem", alignItems: "center" }} htmlFor="asaas-wizard-manual-ack">
                    <input
                      type="checkbox"
                      id="asaas-wizard-manual-ack"
                      checked={manualAck}
                      onChange={(e) => setManualAck(e.target.checked)}
                    />
                    Registrei manualmente e validei o 202
                  </label>
                </div>
              </div>
            ) : null}
            {webhookMode === "limit" ? (
              <p className="cc-u-mt-2">
                A conta Asaas atingiu o limite de 10 webhooks sem nenhum igual ao canônico deste
                tenant. No painel do Asaas, atualize ou exclua um webhook não utilizado e tente de
                novo — o assistente nunca apaga webhooks de outra origem sozinho.
              </p>
            ) : null}
            {webhookMode === "error" && webhookError !== null ? (
              <p className="cc-field-error cc-u-mt-2">{webhookError}</p>
            ) : null}
            <div className="cc-row cc-u-mt-4">
              <Button variant="secondary" disabled={webhookBusy} onClick={() => setStep(2)}>
                Voltar para credencial
              </Button>
              <Button variant="secondary" disabled={webhookBusy} onClick={() => setStep(4)}>
                Pular para teste sandbox
              </Button>
              {webhookResult !== null || manualAck ? (
                <Button disabled={webhookBusy} onClick={() => setStep(4)}>
                  Avançar para teste sandbox
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === 4 ? (
          <div>
            <p>
              <strong>Etapa 4 de 4 — Teste em sandbox</strong>
            </p>
            {environment !== "SANDBOX" ? (
              <p className="cc-muted">
                Teste automático indisponível em produção: nenhuma sonda é executada a partir
                deste assistente em ambiente PRODUCTION. Conclua o assistente e acompanhe o
                status no card.
              </p>
            ) : !canTest ? (
              <p className="cc-muted">
                Seu perfil não tem a permissão <strong>integration.test</strong> — peça a um
                administrador para executar a sonda de sandbox.
              </p>
            ) : (
              <div>
                <p className="cc-muted">
                  Executa somente a sonda read-only (<strong>sem criar cobrança</strong>): nada é
                  criado automaticamente ao abrir esta etapa.
                </p>
                <div className="cc-field">
                  <span>Confirmação explícita</span>
                  <label className="cc-row" style={{ gap: "0.5rem", alignItems: "center" }} htmlFor="asaas-wizard-test-confirm">
                    <input
                      type="checkbox"
                      id="asaas-wizard-test-confirm"
                      checked={testConfirm}
                      onChange={(e) => {
                        setTestConfirm(e.target.checked);
                        setTestError(null);
                      }}
                      disabled={testBusy}
                    />
                    Confirmo que quero executar o teste em sandbox
                  </label>
                </div>
                <div className="cc-row cc-u-mt-2">
                  <Button
                    disabled={testBusy || !testConfirm}
                    onClick={() => void runSandboxTest()}
                  >
                    {testBusy ? "Testando…" : "Testar conexão em sandbox"}
                  </Button>
                </div>
                {testDone !== null ? <p className="cc-u-mt-2">{testDone}</p> : null}
                {testError !== null ? <p className="cc-field-error cc-u-mt-2">{testError}</p> : null}
              </div>
            )}
            <div className="cc-row cc-u-mt-4">
              <Button variant="secondary" onClick={() => setStep(3)}>
                Voltar para webhook
              </Button>
              <Button onClick={finish}>Concluir</Button>
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function DisableDialog({
  status,
  knownVersion,
  open,
  onClose,
  onVersion,
  onChanged,
}: {
  status: IntegrationStatus;
  knownVersion: number | null;
  open: boolean;
  onClose: () => void;
  onVersion: (version: number) => void;
  onChanged: () => void;
}): React.JSX.Element | null {
  const { push } = useToast();
  const [confirmed, setConfirmed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  const meta = isProviderKey(status.provider) ? PROVIDER_META[status.provider].title : status.provider;

  const submit = async (): Promise<void> => {
    if (!confirmed) {
      setSaveError("Confirme que deseja desconectar para continuar.");
      return;
    }
    setSaveError(null);
    setBusy(true);
    try {
      let expected = knownVersion;
      if (expected === null) {
        try {
          const probed = await api.post<BindingResult>(
            `/v1/integrations/${status.provider}/test`,
            {},
            { idempotencyKey: newIdempotencyKey() },
          );
          expected = probed.version;
          onVersion(probed.version);
        } catch {
          expected = null;
        }
      }
      const body: Record<string, unknown> = {};
      if (expected !== null) body.expectedVersion = expected;
      const res = await api.post<BindingResult>(
        `/v1/integrations/${status.provider}/disable`,
        body,
        { idempotencyKey: newIdempotencyKey() },
      );
      // Sem binding vivo a versão aprendida expirou: limpa para a reconexão
      // criar uma linha nova sem `expectedVersion` obsoleto.
      onVersion(res.version);
      push("Integração desativada. Histórico preservado — novos efeitos estão pausados.");
      onClose();
      onChanged();
    } catch (err) {
      const msg = conflictOrGeneric(err);
      setSaveError(msg);
      push(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Desconectar integração" open={open} onClose={onClose}>
      <div className="cc-form">
        <p>
          Desconectar <strong>{meta}</strong>? Novos efeitos são pausados, mas o histórico (faturas,
          eventos e evidências) é preservado.
        </p>
        <Field label="Confirmação">
          <label className="cc-row" style={{ gap: "0.5rem", alignItems: "center" }}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => {
                setConfirmed(e.target.checked);
                setSaveError(null);
              }}
              disabled={busy}
            />
            Confirmo que desejo desconectar
          </label>
        </Field>
        {saveError !== null ? <p className="cc-field-error">{saveError}</p> : null}
        <div className="cc-row cc-u-mt-4">
          <Button variant="danger" disabled={busy || !confirmed} onClick={() => void submit()}>
            {busy ? "Desconectando…" : "Desconectar"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
