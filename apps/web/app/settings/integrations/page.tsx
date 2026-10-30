"use client";

import { useState } from "react";
import { Shell } from "../../../components/Shell";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { StatusPill } from "../../../components/ui/Badge";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../../components/ui/States";
import { Dialog } from "../../../components/ui/Dialog";
import { Field, Input, Select } from "../../../components/ui/Input";
import { useToast } from "../../../components/ui/Toast";
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
  const isLive = status.configured && status.connection_status !== "DISABLED";
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [configureOpen, setConfigureOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

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

      {isWhatsApp ? (
        <p className="cc-muted cc-u-mt-2">
          Disponível em S3 — o pareamento WhatsApp chega na próxima etapa e não pede segredo aqui.
        </p>
      ) : null}

      {!isWhatsApp && (canManage || canTest) ? (
        <div className="cc-row cc-u-mt-2">
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
      {!isWhatsApp && !canManage && !canTest ? (
        <p className="cc-muted cc-u-mt-2">Somente leitura para o seu perfil.</p>
      ) : null}

      {actionError !== null ? <p className="cc-field-error cc-u-mt-2">{actionError}</p> : null}

      {!isWhatsApp && canManage ? (
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
