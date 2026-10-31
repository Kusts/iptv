"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "../../../components/Shell";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { Badge } from "../../../components/ui/Badge";
import { ErrorState, LoadingSkeleton } from "../../../components/ui/States";
import { useToast } from "../../../components/ui/Toast";
import { ApiError, api } from "../../../lib/api";
import { useApi } from "../../../lib/useApi";
import { useOptionalHasPermission } from "../../../lib/auth";
import { formatDateTime } from "../../../lib/money";
import {
  deriveCatalogStep,
  deriveDiagnosticsStep,
  deriveIntegrationStep,
  deriveTestsStep,
  deriveWhatsappStep,
  isSkippable,
  SKIP_COPY,
  STEP_TITLES,
  type OnboardingStepId,
  type OnboardingStepState,
  type SanitizedIntegration,
} from "./steps";

const READ_PERMISSION = "integration.read";

/**
 * Assistente de configuração inicial (S5a, #89): wizard `/settings/onboarding`
 * com as 10 etapas do `docs/13-product-design/onboarding.md`.
 *
 * Contratos REAIS (somente leitura, sem segredo no DOM):
 * - `GET /v1/integrations` — etapas Asaas/WhatsApp/CINEVISION + testes + diagnóstico;
 * - `GET /v1/integrations/whatsapp/session` — estado verbatim da sessão;
 * - `GET /v1/catalog/plans` — etapa de catálogo (mesmo endpoint do diálogo
 *   "Novo pedido" em /orders; não há página dedicada de catálogo).
 *
 * Etapas sem endpoint (conta/equipe, preferências comerciais, autonomia):
 * modo "manual/guiado" com instrução explícita + confirmação local — NENHUM
 * POST inventado, nenhuma API mockada. Follow-ups S5 anotados no `S5_NOTES`.
 *
 * Configuração reutiliza os dialogs do hub (`/settings/integrations`):
 * este wizard NÃO duplica campos de credencial — só linka para o hub.
 * Go-live é marco local (confirmação explícita, sem POST, sem cobrança).
 */

const STEP_ORDER: OnboardingStepId[] = [
  "conta-equipe",
  "catalogo",
  "asaas",
  "whatsapp",
  "cinevision",
  "testes",
  "preferencias",
  "autonomia",
  "diagnostico",
  "golive",
];

/** Follow-ups S5: o que ficou manual por falta de endpoint (nunca mockado). */
const S5_NOTES: Partial<Record<OnboardingStepId, string>> = {
  "conta-equipe": "S5-follow-up: sem endpoint de listagem/convite de equipe no escopo — confirmação manual do operador.",
  "preferencias": "S5-follow-up: sem endpoint de preferências comerciais (janela de cobrança, tolerância, mensagens) — registrar manualmente; backend futuro.",
  "autonomia": "S5-follow-up: sem endpoint de níveis de autonomia por operação (AUTO/APROVAÇÃO/MANUAL) — operar no modo manual supervisionado; backend futuro.",
};

const SKIP_STORAGE_PREFIX = "onboarding:skip:";
const MANUAL_STORAGE_PREFIX = "onboarding:manual:";
const GOLIVE_STORAGE_KEY = "onboarding:golive";

function readFlag(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // armazenamento indisponível: o estado segue só em memória
  }
}

function toneForStep(state: OnboardingStepState): "success" | "warn" | "danger" | "neutral" | "info" {
  if (state === "concluida") return "success";
  if (state === "atencao") return "warn";
  if (state === "pulada") return "info";
  return "neutral";
}

const STATE_LABELS: Record<OnboardingStepState, string> = {
  "concluida": "Concluída",
  "pendente": "Pendente",
  "pulada": "Pulada",
  "atencao": "Atenção",
};

interface WhatsappSessionShape {
  sessionName: string;
  status: string;
  lastInbound: { occurredAt: string; preview: string } | null;
}

function parseSession(value: unknown): WhatsappSessionShape | null {
  if (value === null || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec["sessionName"] !== "string" || typeof rec["status"] !== "string") return null;
  const raw = rec["lastInbound"];
  let lastInbound: WhatsappSessionShape["lastInbound"] = null;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object") return null;
    const inbound = raw as Record<string, unknown>;
    if (typeof inbound["occurredAt"] !== "string" || typeof inbound["preview"] !== "string") return null;
    lastInbound = { occurredAt: inbound["occurredAt"], preview: inbound["preview"] };
  }
  return { sessionName: rec["sessionName"], status: rec["status"], lastInbound };
}

type SessionLoad = "loading" | "missing" | "error" | "ready";

export default function OnboardingPage(): React.JSX.Element {
  const { push } = useToast();
  const hasPermission = useOptionalHasPermission();
  const canRead = hasPermission(READ_PERMISSION);

  const integrationsQuery = useApi<{ integrations: SanitizedIntegration[] }>(
    canRead ? "/v1/integrations" : null,
  );
  const plansQuery = useApi<{ plans: { id: string }[] }>("/v1/catalog/plans");

  const [sessionState, setSessionState] = useState<SessionLoad>("loading");
  const [session, setSession] = useState<WhatsappSessionShape | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionNonce, setSessionNonce] = useState(0);

  useEffect(() => {
    if (!canRead) {
      setSessionState("missing");
      setSession(null);
      return;
    }
    let cancelled = false;
    setSessionState("loading");
    setSessionError(null);
    api
      .get<unknown>("/v1/integrations/whatsapp/session")
      .then((value) => {
        if (cancelled) return;
        const parsed = parseSession(value);
        if (parsed === null) {
          setSession(null);
          setSessionError("Resposta inesperada ao ler a sessão WhatsApp.");
          setSessionState("error");
          return;
        }
        setSession(parsed);
        setSessionState("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          // Sem vínculo: 404 fail-closed vira "sem sessão", não erro.
          setSession(null);
          setSessionState("missing");
          return;
        }
        setSession(null);
        setSessionError(err instanceof ApiError ? err.message : "Algo deu errado. Tente novamente.");
        setSessionState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, sessionNonce]);

  const [skipped, setSkipped] = useState<Record<string, boolean>>(() => ({
    "asaas": readFlag(`${SKIP_STORAGE_PREFIX}asaas`),
    "whatsapp": readFlag(`${SKIP_STORAGE_PREFIX}whatsapp`),
    "cinevision": readFlag(`${SKIP_STORAGE_PREFIX}cinevision`),
  }));
  const [manualDone, setManualDone] = useState<Record<string, boolean>>(() => ({
    "conta-equipe": readFlag(`${MANUAL_STORAGE_PREFIX}conta-equipe`),
    "preferencias": readFlag(`${MANUAL_STORAGE_PREFIX}preferencias`),
    "autonomia": readFlag(`${MANUAL_STORAGE_PREFIX}autonomia`),
  }));
  const [goliveAt, setGoliveAt] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(GOLIVE_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [goliveConfirm, setGoliveConfirm] = useState(false);

  const toggleSkip = (step: OnboardingStepId): void => {
    const next = !(skipped[step] ?? false);
    setSkipped((prev) => ({ ...prev, [step]: next }));
    writeFlag(`${SKIP_STORAGE_PREFIX}${step}`, next);
    push(next ? `Etapa ${STEP_TITLES[step]} marcada como pulada (modo manual).` : `Pulo da etapa ${STEP_TITLES[step]} desfeito.`);
  };

  const toggleManual = (step: OnboardingStepId): void => {
    const next = !(manualDone[step] ?? false);
    setManualDone((prev) => ({ ...prev, [step]: next }));
    writeFlag(`${MANUAL_STORAGE_PREFIX}${step}`, next);
  };

  const markGolive = (): void => {
    const at = new Date().toISOString();
    setGoliveAt(at);
    try {
      window.localStorage.setItem(GOLIVE_STORAGE_KEY, at);
    } catch {
      // segue em memória
    }
    push("Go-live registrado como marco (sem cobrança, sem efeito colateral).");
  };

  const integrations = integrationsQuery.data?.integrations ?? [];
  const byProvider = new Map(integrations.map((i) => [i.provider, i]));
  const planCount = plansQuery.data?.plans.length ?? 0;

  const integrationsLoading = canRead && integrationsQuery.loading;
  const integrationsFailed = canRead && integrationsQuery.error !== null;

  const states: Record<OnboardingStepId, { state: OnboardingStepState; summary: string }> = {
    "conta-equipe": ((): { state: OnboardingStepState; summary: string } =>
      (manualDone["conta-equipe"] ?? false)
        ? { state: "concluida", summary: "Conta e equipe confirmadas manualmente pelo operador." }
        : { state: "pendente", summary: "Confirme a identidade do tenant e os acessos da equipe (guia manual abaixo)." })(),
    "catalogo": plansQuery.loading
      ? { state: "pendente", summary: "Carregando catálogo…" }
      : plansQuery.error !== null
        ? { state: "atencao", summary: `Não foi possível ler o catálogo: ${plansQuery.error}` }
        : deriveCatalogStep(planCount),
    "asaas": integrationsLoading
      ? { state: "pendente", summary: "Carregando integrações…" }
      : integrationsFailed
        ? { state: "atencao", summary: `Não foi possível ler as integrações: ${integrationsQuery.error ?? ""}` }
        : deriveIntegrationStep(byProvider.get("asaas"), skipped["asaas"] ?? false),
    "whatsapp": integrationsLoading || sessionState === "loading"
      ? { state: "pendente", summary: "Carregando WhatsApp…" }
      : integrationsFailed
        ? { state: "atencao", summary: `Não foi possível ler as integrações: ${integrationsQuery.error ?? ""}` }
        : sessionState === "error"
          ? { state: "atencao", summary: `Não foi possível ler a sessão WhatsApp: ${sessionError ?? ""}` }
          : deriveWhatsappStep(byProvider.get("whatsapp"), session?.status ?? null, skipped["whatsapp"] ?? false),
    "cinevision": integrationsLoading
      ? { state: "pendente", summary: "Carregando integrações…" }
      : integrationsFailed
        ? { state: "atencao", summary: `Não foi possível ler as integrações: ${integrationsQuery.error ?? ""}` }
        : deriveIntegrationStep(byProvider.get("cinevision"), skipped["cinevision"] ?? false),
    "testes": integrationsLoading
      ? { state: "pendente", summary: "Carregando…" }
      : integrationsFailed
        ? { state: "atencao", summary: `Sem leitura das integrações: ${integrationsQuery.error ?? ""}` }
        : deriveTestsStep(integrations),
    "preferencias": (manualDone["preferencias"] ?? false)
      ? { state: "concluida", summary: "Preferências comerciais registradas manualmente pelo operador." }
      : { state: "pendente", summary: "Defina janela de cobrança, tolerância e mensagens (guia manual abaixo)." },
    "autonomia": (manualDone["autonomia"] ?? false)
      ? { state: "concluida", summary: "Níveis de autonomia definidos manualmente (modo supervisionado)." }
      : { state: "pendente", summary: "Defina AUTO/APROVAÇÃO/MANUAL por operação (guia manual abaixo)." },
    "diagnostico": integrationsLoading
      ? { state: "pendente", summary: "Carregando saúde…" }
      : integrationsFailed
        ? { state: "atencao", summary: `Sem leitura das integrações: ${integrationsQuery.error ?? ""}` }
        : deriveDiagnosticsStep(integrations),
    "golive": goliveAt !== null
      ? { state: "concluida", summary: `Go-live registrado em ${formatDateTime(goliveAt)} (marco local — sem cobrança, sem efeito colateral).` }
      : { state: "pendente", summary: "Confirme explicitamente abaixo para registrar o go-live como marco." },
  };

  const doneCount = STEP_ORDER.filter((s) => states[s].state === "concluida").length;

  return (
    <Shell>
      <div className="cc-row cc-u-mb-4" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1>Onboarding — configuração inicial</h1>
          <p className="cc-muted">
            {doneCount} de {STEP_ORDER.length} etapas concluídas. Estados derivam de leituras reais da API; pular uma
            integração ativa o modo manual com o que fica indisponível.
          </p>
        </div>
        <Button variant="secondary" onClick={() => { integrationsQuery.reload(); plansQuery.reload(); setSessionNonce((n) => n + 1); }}>
          Recarregar
        </Button>
      </div>

      {!canRead ? (
        <Card title="Sem permissão">
          <p>Você não tem permissão para ver as integrações. As etapas de Asaas, WhatsApp, CINEVISION, testes e
          diagnóstico ficam indisponíveis — fale com um administrador.</p>
        </Card>
      ) : null}

      {integrationsFailed ? (
        <ErrorState message={integrationsQuery.error ?? "Falha ao ler integrações."} onRetry={() => integrationsQuery.reload()} />
      ) : null}

      {integrationsLoading && plansQuery.loading ? <LoadingSkeleton lines={6} /> : null}

      <ol style={{ listStyle: "none", padding: 0 }}>
        {STEP_ORDER.map((step, idx) => (
          <li key={step} className="cc-u-mt-2">
            <StepCard
              index={idx + 1}
              step={step}
              state={states[step].state}
              summary={states[step].summary}
              skipped={skipped[step] ?? false}
              manualChecked={manualDone[step] ?? false}
              note={S5_NOTES[step] ?? null}
              canRead={canRead}
              integrations={integrations}
              session={session}
              sessionState={sessionState}
              goliveAt={goliveAt}
              goliveConfirm={goliveConfirm}
              onGoliveConfirm={setGoliveConfirm}
              onGolive={markGolive}
              onToggleSkip={() => toggleSkip(step)}
              onToggleManual={() => toggleManual(step)}
            />
          </li>
        ))}
      </ol>
    </Shell>
  );
}

function StepCard(props: {
  index: number;
  step: OnboardingStepId;
  state: OnboardingStepState;
  summary: string;
  skipped: boolean;
  manualChecked: boolean;
  note: string | null;
  canRead: boolean;
  integrations: SanitizedIntegration[];
  session: WhatsappSessionShape | null;
  sessionState: SessionLoad;
  goliveAt: string | null;
  goliveConfirm: boolean;
  onGoliveConfirm: (value: boolean) => void;
  onGolive: () => void;
  onToggleSkip: () => void;
  onToggleManual: () => void;
}): React.JSX.Element {
  const { index, step, state, summary } = props;
  return (
    <Card title={`Etapa ${index} — ${STEP_TITLES[step]}`}>
      <div className="cc-row" style={{ alignItems: "center" }}>
        <Badge tone={toneForStep(state)}>{STATE_LABELS[state]}</Badge>
        {state === "pulada" ? <span className="cc-muted">explícita pelo operador</span> : null}
      </div>
      <p className="cc-u-mt-2">{summary}</p>
      {props.note !== null ? <p className="cc-muted">{props.note}</p> : null}

      {step === "conta-equipe" ? <AccountGuide checked={props.manualChecked} onToggle={props.onToggleManual} /> : null}
      {step === "catalogo" ? <CatalogGuide /> : null}
      {(step === "asaas" || step === "whatsapp" || step === "cinevision") && props.canRead ? (
        <IntegrationActions
          step={step}
          skipped={props.skipped}
          integration={props.integrations.find((i) => i.provider === (step === "cinevision" ? "cinevision" : step)) ?? undefined}
          onToggleSkip={props.onToggleSkip}
        />
      ) : null}
      {(step === "asaas" || step === "whatsapp" || step === "cinevision") && !props.canRead ? (
        <p className="cc-muted cc-u-mt-2">Sem permissão para ver esta integração.</p>
      ) : null}
      {step === "testes" ? <TestsGuide /> : null}
      {step === "preferencias" || step === "autonomia" ? (
        <ManualGuide step={step} checked={props.manualChecked} onToggle={props.onToggleManual} />
      ) : null}
      {step === "diagnostico" ? (
        <DiagnosticsTable integrations={props.integrations} session={props.session} sessionState={props.sessionState} canRead={props.canRead} />
      ) : null}
      {step === "golive" ? (
        <GoliveConfirm
          doneAt={props.goliveAt}
          confirmed={props.goliveConfirm}
          onConfirm={props.onGoliveConfirm}
          onGolive={props.onGolive}
        />
      ) : null}
    </Card>
  );
}

function AccountGuide({ checked, onToggle }: { checked: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <div className="cc-u-mt-2">
      <p className="cc-muted">
        Guia manual (sem endpoint de equipe no escopo): confira o tenant ativo no seletor do Control Center,
        convide operadores com o papel mínimo necessário e valide que cada um acessa com seu próprio login.
      </p>
      <label className="cc-row cc-u-mt-2" style={{ gap: "0.5rem", alignItems: "center" }}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        Confirmo que a conta e a equipe estão ok
      </label>
    </div>
  );
}

function CatalogGuide(): React.JSX.Element {
  return (
    <p className="cc-muted cc-u-mt-2">
      O catálogo é lido de <span className="cc-mono">GET /v1/catalog/plans</span> (mesmo endpoint do diálogo
      “Novo pedido” em <Link href="/orders">/orders</Link> — não há página dedicada de catálogo). Com ao menos
      um plano, esta etapa conclui.
    </p>
  );
}

function IntegrationActions({
  step,
  skipped,
  integration,
  onToggleSkip,
}: {
  step: OnboardingStepId;
  skipped: boolean;
  integration: SanitizedIntegration | undefined;
  onToggleSkip: () => void;
}): React.JSX.Element | null {
  if (!isSkippable(step)) return null;
  const copy = SKIP_COPY[step];
  return (
    <div className="cc-u-mt-2">
      <div className="cc-row">
        <Link href="/settings/integrations">Configurar em /settings/integrations</Link>
        <Button variant="secondary" onClick={onToggleSkip}>
          {skipped ? "Desfazer pulo" : "Pular etapa"}
        </Button>
      </div>
      {integration !== undefined && integration.last_checked_at !== null ? (
        <p className="cc-muted cc-u-mt-2">Última verificação: {formatDateTime(integration.last_checked_at)}</p>
      ) : null}
      {skipped && copy !== undefined ? (
        <p className="cc-muted cc-u-mt-2">
          {copy.manual} {copy.unavailable}
        </p>
      ) : null}
    </div>
  );
}

function TestsGuide(): React.JSX.Element {
  return (
    <p className="cc-muted cc-u-mt-2">
      Conectar e testar é somente leitura: use <strong>Testar</strong> / <strong>Validar acesso</strong> em{" "}
      <Link href="/settings/integrations">/settings/integrations</Link> (ambiente Sandbox quando disponível).
      Nenhuma cobrança, mensagem ou ativação é criada a partir dos testes.
    </p>
  );
}

function ManualGuide({
  step,
  checked,
  onToggle,
}: {
  step: OnboardingStepId;
  checked: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <div className="cc-u-mt-2">
      {step === "preferencias" ? (
        <p className="cc-muted">
          Guia manual: defina janela de cobrança, tolerância a atraso, textos de notificação e canal de suporte —
          anote fora da plataforma até existir endpoint de preferências.
        </p>
      ) : (
        <p className="cc-muted">
          Guia manual: opere no modo supervisionado (toda ação relevante com revisão humana) até existirem
          níveis de autonomia por operação (AUTO/APROVAÇÃO/MANUAL).
        </p>
      )}
      <label className="cc-row cc-u-mt-2" style={{ gap: "0.5rem", alignItems: "center" }}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        Confirmo que registrei manualmente
      </label>
    </div>
  );
}

/**
 * Saúde/diagnóstico: último teste, última verificação, último evento e
 * problemas com instrução — tudo derivado do que a API expõe
 * (`last_checked_at`, `last_error_code`, `capability_status`,
 * `lastInbound` do WhatsApp). NENHUM evento inventado.
 */
function DiagnosticsTable({
  integrations,
  session,
  sessionState,
  canRead,
}: {
  integrations: SanitizedIntegration[];
  session: WhatsappSessionShape | null;
  sessionState: SessionLoad;
  canRead: boolean;
}): React.JSX.Element {
  if (!canRead) return <p className="cc-muted cc-u-mt-2">Sem permissão para ler o diagnóstico.</p>;
  if (integrations.length === 0) {
    return <p className="cc-muted cc-u-mt-2">Sem vínculos para diagnosticar ainda.</p>;
  }
  return (
    <div className="cc-u-mt-2">
      <ul>
        {integrations.map((i) => (
          <li key={i.provider}>
            <strong>{STEP_TITLES[i.provider as OnboardingStepId] ?? i.provider}</strong>
            {" — último teste: "}
            {i.last_checked_at === null ? "nunca" : formatDateTime(i.last_checked_at)}
            {"; última verificação: "}
            {i.last_checked_at === null ? "nunca" : formatDateTime(i.last_checked_at)}
            {"; último evento: "}
            {i.provider === "whatsapp"
              ? session?.lastInbound !== null && session?.lastInbound !== undefined
                ? `mensagem recebida (${session?.lastInbound.preview})`
                : sessionState === "ready"
                  ? "nenhuma mensagem recebida ainda"
                  : "sessão não vinculada"
              : "a API não expõe eventos desta integração"}
            {"; capacidade: "}
            <strong>{i.capability_status}</strong>
            {i.last_error_code !== null ? (
              <span>
                {" — problema: "}
                <strong>{i.last_error_code}</strong>
                {" — corrija em /settings/integrations e use Testar para revalidar."}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function GoliveConfirm({
  doneAt,
  confirmed,
  onConfirm,
  onGolive,
}: {
  doneAt: string | null;
  confirmed: boolean;
  onConfirm: (value: boolean) => void;
  onGolive: () => void;
}): React.JSX.Element {
  if (doneAt !== null) {
    return <p className="cc-u-mt-2">Go-live registrado. Para reabrir, desmarque nas etapas e registre de novo.</p>;
  }
  return (
    <div className="cc-u-mt-2">
      <p className="cc-muted">
        O go-live é um <strong>marco</strong>: registrar não cria cobrança, não envia mensagem e não ativa
        provedor — só marca a data de conclusão do onboarding neste navegador.
      </p>
      <label className="cc-row cc-u-mt-2" style={{ gap: "0.5rem", alignItems: "center" }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} />
        Confirmo que o tenant está pronto para operar (marco, sem efeito colateral)
      </label>
      <div className="cc-row cc-u-mt-2">
        <Button disabled={!confirmed} onClick={onGolive}>
          Registrar go-live
        </Button>
      </div>
    </div>
  );
}
