"use client";

import { useState } from "react";
import { Button } from "../../../components/ui/Button";
import { StatusPill } from "../../../components/ui/Badge";
import { Dialog } from "../../../components/ui/Dialog";
import { Field, Input, Select } from "../../../components/ui/Input";
import { useToast } from "../../../components/ui/Toast";
import { ApiError, api, userMessage } from "../../../lib/api";
import { formatDateTime } from "../../../lib/money";

/**
 * Card da conta CINEVISION (S4b, #88; importação assistida S4d): conectar
 * conta, validação read-only, capacidades/limites reais e importação
 * assistida com preview (S4c).
 *
 * Contratos verificados no backend (`origin/main`):
 *
 * - `POST /v1/integrations/cinevision/configure` aceita SOMENTE
 *   `{ environment: SANDBOX|PRODUCTION, expectedVersion?, secret: {
 *   username, password } }` — o schema `strict()` rejeita `baseUrl` e afins
 *   com 400. O endereço do painel é fixo no servidor (allowlist
 *   `CINEVISION_ALLOWED_ORIGIN` + ref do cofre no browser-worker): esta UI
 *   NUNCA envia URL — o dialog exibe a nota de endereço fixo e não renderiza
 *   nenhum campo de URL.
 * - `POST /v1/integrations/cinevision/test` devolve só metadados do vínculo
 *   (`connection_status`, `version`, `last_checked_at`, `last_error_code`).
 * - S4c importação assistida:
 *   `POST /v1/integrations/cinevision/import-preview` sob
 *   `integration.read` (corpo `{}`; classifica sem escrever CRM; devolve
 *   `{total,novos,duplicados,conflitos,previewHash,items[]}` com
 *   `items[] = {externalId, decision: novo|duplicado|conflito}`) e
 *   `POST /v1/integrations/cinevision/import-execute` sob
 *   `integration.manage` (corpo `{previewHash, confirmed: true}` +
 *   `Idempotency-Key` OBRIGATÓRIO; devolve
 *   `{total,criados,pulados,conflitos}`). Sem vínculo vivo → 404; hash
 *   divergente/tamper → 409 (re-rodar o preview).
 * - NÃO existe endpoint de leitura de servidores/clientes/saldo na API.
 *   Servidores/clientes/saldo seguem como seção de capacidade + fallback
 *   manual — nenhum número é inventado.
 *
 * Sem dado sensível no DOM: usuário/senha viajam só no corpo do configure e
 * nunca são renderizados; respostas sanitizadas nunca contêm valor de
 * credencial; o `previewHash` anti-tamper vive só em estado (nunca
 * renderizado). Gating: conectar/executar sob `integration.manage`,
 * validar sob `integration.test`, pré-visualizar sob `integration.read`
 * (o card só monta com `integration.read` no hub).
 */

interface CinevisionStatus {
  provider: string;
  environment: string;
  connection_status: string;
  capability_status: string;
  last_checked_at: string | null;
  last_error_code: string | null;
  configured: boolean;
}

interface CinevisionTestResult {
  connection_status: string;
  version: number;
  last_checked_at: string | null;
  last_error_code: string | null;
}

/** Decisão por item do preview S4c (espelho do backend, sem PII). */
type CinevisionImportDecision = "novo" | "duplicado" | "conflito";

interface CinevisionImportPreviewItem {
  externalId: string;
  decision: CinevisionImportDecision;
}

/** Resposta de `POST /v1/integrations/cinevision/import-preview`. */
interface CinevisionImportPreview {
  provider: "cinevision";
  version: string;
  total: number;
  novos: number;
  duplicados: number;
  conflitos: number;
  previewHash: string;
  items: CinevisionImportPreviewItem[];
}

/** Resposta de `POST /v1/integrations/cinevision/import-execute`. */
interface CinevisionImportSummary {
  provider: "cinevision";
  version: string;
  total: number;
  criados: number;
  pulados: number;
  conflitos: number;
  previewHash: string;
}

const IMPORT_DECISION_LABELS: Record<CinevisionImportDecision, string> = {
  novo: "Novo",
  duplicado: "Duplicado",
  conflito: "Conflito",
};

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

function connectionLabel(status: string): string {
  return CONNECTION_LABELS[status] ?? status;
}

function capabilityLabel(status: string): string {
  return CAPABILITY_LABELS[status] ?? status;
}

/**
 * Instrução manual por código sanitizado do teste. Texto espelha o mapa
 * `CINEVISION_MANUAL_GUIDANCE` da S4a (probe `cinevision-worker-probe.ts`,
 * ainda em branch paralela): o teste devolve só o código e a UI orienta o
 * próximo passo em pt-BR. HUMAN_REQUIRED nunca é resolvido por bypass.
 */
const CINEVISION_MANUAL_GUIDANCE: Record<string, string> = {
  INVALID_CREDENTIALS:
    "Credencial rejeitada pelo painel CINEVISION. Confira o usuário e a senha no painel e reconfigure a conta (Conectar conta novamente); depois repita a validação.",
  CHALLENGE_DETECTED:
    "O painel exigiu verificação humana (challenge/CAPTCHA/2FA). Conclua o acesso manualmente no painel CINEVISION e repita a validação — sem bypass.",
  TIMEOUT:
    "A leitura excedeu o tempo limite. Tente validar de novo; se persistir, verifique se o painel CINEVISION está acessível.",
  PROVIDER_UNAVAILABLE:
    "Não foi possível concluir a leitura no provedor. Aguarde e tente de novo; se persistir, acione o operador da plataforma.",
};

function codeGuidance(code: string | null): string | null {
  if (code === null) return null;
  return CINEVISION_MANUAL_GUIDANCE[code] ?? "Verifique o status e use Validar acesso para diagnosticar.";
}

function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fallback abaixo
  }
  return `cinevision-hub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function conflictOrGeneric(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) {
    return "Conflito de concorrência — os dados mudaram. Recarregue e tente de novo.";
  }
  return userMessage(err);
}

export function CinevisionCard({
  status,
  canManage,
  canTest,
  knownVersion,
  onVersion,
  onChanged,
}: {
  status: CinevisionStatus;
  canManage: boolean;
  canTest: boolean;
  knownVersion: number | null;
  onVersion: (version: number) => void;
  onChanged: () => void;
}): React.JSX.Element {
  const { push } = useToast();
  const isLive = status.configured && status.connection_status !== "DISABLED";
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [configureOpen, setConfigureOpen] = useState(false);
  const [lastResult, setLastResult] = useState<CinevisionTestResult | null>(null);
  const hint = codeGuidance(status.last_error_code);

  const runValidation = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await api.post<CinevisionTestResult>(
        "/v1/integrations/cinevision/test",
        {},
        { idempotencyKey: newIdempotencyKey() },
      );
      onVersion(res.version);
      setLastResult(res);
      if (res.connection_status === "CONNECTED_READ_ONLY") {
        push("Validação concluída: conta CINEVISION conectada (somente leitura).");
      } else {
        push(`Validação concluída: ${connectionLabel(res.connection_status)}.`);
      }
      onChanged();
    } catch (err) {
      const msg = conflictOrGeneric(err);
      setActionError(msg);
      push(msg);
    } finally {
      setBusy(false);
    }
  };

  const resultHint = lastResult !== null ? codeGuidance(lastResult.last_error_code) : null;

  return (
    <div className="cc-u-mt-2">
      <h4 className="cc-u-mt-2">Conta CINEVISION</h4>
      <ul className="cc-u-mt-2">
        <li>
          Vínculo: <strong>{status.configured ? "configurado neste tenant" : "não configurado neste tenant"}</strong>
        </li>
        <li>
          Ambiente do vínculo: <strong>{status.environment}</strong>
        </li>
        <li>
          Capacidade: <strong>{capabilityLabel(status.capability_status)}</strong>{" "}
          <StatusPill status={status.capability_status} />
        </li>
        {lastResult === null ? (
          <li>
            Validação:{" "}
            {status.last_checked_at === null
              ? "nunca executada — use Validar acesso."
              : `última em ${formatDateTime(status.last_checked_at)}`}
          </li>
        ) : (
          <li>
            Validação: <strong>{connectionLabel(lastResult.connection_status)}</strong>{" "}
            <StatusPill status={lastResult.connection_status} />
            {lastResult.last_checked_at !== null ? ` em ${formatDateTime(lastResult.last_checked_at)}` : ""}
            {lastResult.last_error_code !== null ? (
              <span>
                {" "}
                — <strong>{lastResult.last_error_code}</strong>
              </span>
            ) : null}
          </li>
        )}
        {lastResult !== null && resultHint !== null ? <li className="cc-muted">{resultHint}</li> : null}
        {lastResult === null && hint !== null ? <li className="cc-muted">{hint}</li> : null}
        <li className="cc-muted">
          A validação é somente leitura — nenhum write é executado a partir daqui. Desafios do painel
          (challenge/CAPTCHA/2FA) exigem acesso humano manual, sem bypass.
        </li>
      </ul>

      <h4 className="cc-u-mt-2">Servidores, clientes e saldo</h4>
      <p className="cc-muted">
        A API ainda não expõe endpoint de leitura de servidores, clientes ou saldo: o status e a validação
        devolvem só metadados do vínculo (configurado, estado, última verificação). Confira os detalhes no
        painel CINEVISION. Leitura detalhada: pendente S4c — nenhum número é exibido aqui para não inventar
        dado.
      </p>

      <h4 className="cc-u-mt-2">Importação</h4>
      <CinevisionImportSection status={status} canManage={canManage} />

      <h4 className="cc-u-mt-2">Ativação manual</h4>
      <p className="cc-muted">
        Sem conta válida não há ativação pelo hub: abra o painel CINEVISION, conclua o acesso (inclusive
        verificações humanas) e volte para Conectar conta + Validar acesso.
      </p>

      {canManage || canTest ? (
        <div className="cc-row cc-u-mt-2">
          {canManage && !isLive ? (
            <Button disabled={busy} onClick={() => setConfigureOpen(true)}>
              Conectar conta
            </Button>
          ) : null}
          {canManage && isLive ? (
            <Button variant="secondary" disabled={busy} onClick={() => setConfigureOpen(true)}>
              Reconfigurar conta
            </Button>
          ) : null}
          {canTest && isLive ? (
            <Button variant="secondary" disabled={busy} onClick={() => void runValidation()}>
              {busy ? "Validando…" : "Validar acesso"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {!canManage && !canTest ? (
        <p className="cc-muted cc-u-mt-2">Somente leitura para o seu perfil.</p>
      ) : null}

      {actionError !== null ? <p className="cc-field-error cc-u-mt-2">{actionError}</p> : null}

      {canManage ? (
        <CinevisionConfigureDialog
          status={status}
          knownVersion={knownVersion}
          open={configureOpen}
          onClose={() => setConfigureOpen(false)}
          onVersion={onVersion}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  );
}

function previewErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return (
      "Sem vínculo CINEVISION ativo neste tenant — use Conectar conta primeiro e repita a pré-visualização."
    );
  }
  return userMessage(err);
}

function executeErrorMessage(err: unknown): string {
  if (err instanceof ApiError && (err.status === 409 || err.status === 412)) {
    return (
      "Os dados mudaram desde a pré-visualização — execute a pré-visualização de novo e confirme o " +
      "resultado atual."
    );
  }
  if (err instanceof ApiError && err.status === 404) {
    return (
      "Sem vínculo CINEVISION ativo neste tenant — use Conectar conta primeiro e repita a pré-visualização."
    );
  }
  return userMessage(err);
}

/**
 * Importação assistida S4c/S4d: pré-visualização (`integration.read`, sem
 * escrita) + execução confirmada (`integration.manage`, idempotente).
 * O `previewHash` anti-tamper vive só em estado — nunca renderizado.
 */
function CinevisionImportSection({
  status,
  canManage,
}: {
  status: CinevisionStatus;
  canManage: boolean;
}): React.JSX.Element {
  const { push } = useToast();
  const isLive = status.configured && status.connection_status !== "DISABLED";
  const [preview, setPreview] = useState<CinevisionImportPreview | null>(null);
  const [summary, setSummary] = useState<CinevisionImportSummary | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [executeBusy, setExecuteBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const runPreview = async (): Promise<void> => {
    setPreviewBusy(true);
    setImportError(null);
    try {
      const res = await api.post<CinevisionImportPreview>(
        "/v1/integrations/cinevision/import-preview",
        {},
        { idempotencyKey: newIdempotencyKey() },
      );
      setPreview(res);
      setSummary(null);
      setConfirmed(false);
      push(
        `Pré-visualização pronta: ${res.total} itens ` +
          `(${res.novos} novos, ${res.duplicados} duplicados, ${res.conflitos} conflitos).`,
      );
    } catch (err) {
      const msg = previewErrorMessage(err);
      setImportError(msg);
      push(msg);
    } finally {
      setPreviewBusy(false);
    }
  };

  const runExecute = async (): Promise<void> => {
    if (preview === null) return;
    if (!confirmed) {
      const msg = "Confirme explicitamente a importação para continuar.";
      setImportError(msg);
      push(msg);
      return;
    }
    setExecuteBusy(true);
    setImportError(null);
    try {
      const res = await api.post<CinevisionImportSummary>(
        "/v1/integrations/cinevision/import-execute",
        { previewHash: preview.previewHash, confirmed: true },
        { idempotencyKey: newIdempotencyKey() },
      );
      setSummary(res);
      setConfirmed(false);
      push(`Importação concluída: ${res.criados} criados, ${res.pulados} pulados, ${res.conflitos} conflitos.`);
    } catch (err) {
      const msg = executeErrorMessage(err);
      setImportError(msg);
      push(msg);
    } finally {
      setExecuteBusy(false);
    }
  };

  if (!isLive) {
    return (
      <p className="cc-muted">
        Sem conta conectada não há importação: use Conectar conta primeiro — a pré-visualização exige um
        vínculo ativo. Nenhuma importação automática é executada a partir daqui sem confirmação explícita.
      </p>
    );
  }

  return (
    <div>
      <p className="cc-muted">
        Importação assistida e supervisionada: a pré-visualização classifica cada cliente externo como novo,
        duplicado ou conflito sem escrever nada; a execução só acontece após confirmação explícita.
      </p>
      <div className="cc-row cc-u-mt-2">
        <Button variant="secondary" disabled={previewBusy || executeBusy} onClick={() => void runPreview()}>
          {previewBusy ? "Pré-visualizando…" : preview !== null ? "Atualizar pré-visualização" : "Pré-visualizar importação"}
        </Button>
      </div>
      {preview !== null ? (
        <div className="cc-u-mt-2">
          <p>
            Pré-visualização: <strong>{preview.total} itens</strong> — {preview.novos} novos,{" "}
            {preview.duplicados} duplicados, {preview.conflitos} conflitos.
          </p>
          <table className="cc-table">
            <thead>
              <tr>
                <th scope="col">ID externo</th>
                <th scope="col">Decisão</th>
              </tr>
            </thead>
            <tbody>
              {preview.items.map((item) => (
                <tr key={item.externalId}>
                  <td>{item.externalId}</td>
                  <td>{IMPORT_DECISION_LABELS[item.decision] ?? item.decision}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {canManage ? (
            <div className="cc-u-mt-2">
              <label className="cc-row" style={{ gap: "0.5rem", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => {
                    setConfirmed(e.target.checked);
                    setImportError(null);
                  }}
                  disabled={executeBusy}
                />
                Confirmo a importação dos {preview.novos} novos clientes desta pré-visualização
              </label>
              <div className="cc-row cc-u-mt-2">
                <Button disabled={executeBusy || !confirmed} onClick={() => void runExecute()}>
                  {executeBusy ? "Importando…" : "Confirmar importação"}
                </Button>
              </div>
            </div>
          ) : (
            <p className="cc-muted cc-u-mt-2">
              Seu perfil não tem permissão para confirmar a importação (exige integration.manage) — peça a um
              administrador para executar após revisar a pré-visualização.
            </p>
          )}
        </div>
      ) : null}
      {summary !== null ? (
        <p className="cc-u-mt-2">
          Importação concluída: <strong>{summary.criados} criados</strong>, {summary.pulados} pulados,{" "}
          {summary.conflitos} conflitos (total {summary.total}).
        </p>
      ) : null}
      {importError !== null ? <p className="cc-field-error cc-u-mt-2">{importError}</p> : null}
    </div>
  );
}

function CinevisionConfigureDialog({
  status,
  knownVersion,
  open,
  onClose,
  onVersion,
  onChanged,
}: {
  status: CinevisionStatus;
  knownVersion: number | null;
  open: boolean;
  onClose: () => void;
  onVersion: (version: number) => void;
  onChanged: () => void;
}): React.JSX.Element | null {
  const { push } = useToast();
  const isLive = status.configured && status.connection_status !== "DISABLED";
  const [environment, setEnvironment] = useState(status.environment);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const submit = async (): Promise<void> => {
    const user = username.trim();
    const pass = password.trim();
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
    setFieldError(null);
    setSaveError(null);
    setBusy(true);
    try {
      // Binding vivo exige `expectedVersion` (409 em mismatch). A versão vem
      // das respostas de escrita; quando desconhecida, o hub sonda via
      // Validar acesso (read-only) antes de escrever.
      let expected = knownVersion;
      if (isLive && expected === null) {
        try {
          const probed = await api.post<CinevisionTestResult>(
            "/v1/integrations/cinevision/test",
            {},
            { idempotencyKey: newIdempotencyKey() },
          );
          expected = probed.version;
          onVersion(probed.version);
        } catch {
          expected = null;
        }
      }
      // Sem URL no corpo: o backend `strict()` rejeita `baseUrl` com 400 e o
      // painel é fixo no servidor — só ambiente + credencial viajam.
      const body: Record<string, unknown> = { environment };
      if (isLive && expected !== null) body.expectedVersion = expected;
      body.secret = { username: user, password: pass };
      const res = await api.post<CinevisionTestResult>("/v1/integrations/cinevision/configure", body, {
        idempotencyKey: newIdempotencyKey(),
      });
      onVersion(res.version);
      push(
        isLive
          ? "Conta CINEVISION reconfigurada (Rascunho). Use Validar acesso para validar."
          : "Integração conectada (Rascunho). Use Validar acesso para validar.",
      );
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
    <Dialog title={isLive ? "Reconfigurar conta CINEVISION" : "Conectar conta CINEVISION"} open={open} onClose={onClose}>
      <div className="cc-form">
        <p className="cc-muted">
          O endereço do painel é fixo no servidor (allowlist server-side) — esta tela nunca envia URL. A
          credencial vai direto ao cofre do servidor e nunca volta para o navegador.
        </p>
        <Field label="Ambiente">
          <Select value={environment} onChange={(e) => setEnvironment(e.target.value)} disabled={busy}>
            <option value="SANDBOX">Sandbox (SANDBOX)</option>
            <option value="PRODUCTION">Produção (PRODUCTION)</option>
          </Select>
        </Field>
        <p className="cc-muted">O ambiente identifica o vínculo neste tenant (exigido pela API).</p>
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
