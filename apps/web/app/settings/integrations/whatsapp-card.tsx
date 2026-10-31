"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { StatusPill } from "../../../components/ui/Badge";
import { Dialog } from "../../../components/ui/Dialog";
import { Field, Input, Textarea } from "../../../components/ui/Input";
import { useToast } from "../../../components/ui/Toast";
import {
  API_BASE,
  ApiError,
  api,
  getTenantContextRevision,
  getToken,
  messageForStatus,
  TENANT_CONTEXT_REVISION_HEADER,
  userMessage,
} from "../../../lib/api";

const SESSION_PATH = "/v1/integrations/whatsapp/session";
const RECONNECT_PATH = "/v1/integrations/whatsapp/reconnect";
const DISCONNECT_PATH = "/v1/integrations/whatsapp/disconnect";
const TEST_MESSAGE_PATH = "/v1/integrations/whatsapp/test-message";
const QR_PATH = "/v1/integrations/whatsapp/qr";

/**
 * Polling limitado do pareamento: a cada ~5s até WORKING ou timeout de 2 min,
 * depois para com instrução (o QR expira em segundos; o backend responde
 * 404/503 quando expirado). Só roda com o dialog de QR aberto.
 */
const POLL_INTERVAL_MS = 5000;
const QR_TIMEOUT_MS = 120_000;

/** E.164-like: `+` + DDI + número (8 a 15 dígitos após o `+`). */
const E164_RE = /^\+[1-9]\d{7,14}$/;
const MAX_TEST_TEXT = 500;

interface WhatsappLastInbound {
  occurredAt: string;
  preview: string;
}

interface WhatsappSessionState {
  sessionName: string;
  status: string;
  lastInbound: WhatsappLastInbound | null;
}

/**
 * Rótulos pt-BR dos estados verbatim do provedor (contrato S3a: o estado real
 * é exposto como recebido — restriction/timelock NUNCA vira "desconectado").
 * Desconhecido cai no verbatim (fail-closed de apresentação).
 */
const SESSION_LABELS: Record<string, string> = {
  STOPPED: "Parada",
  STARTING: "Iniciando",
  SCAN_QR_CODE: "Aguardando leitura do QR",
  WORKING: "Conectada",
  FAILED: "Falha",
  REAUTH_REQUIRED: "Reautorização necessária",
  CAPPED: "Limitada pelo provedor",
};

function sessionLabel(status: string): string {
  return SESSION_LABELS[status.toUpperCase()] ?? status;
}

/** Estados em que o QR ainda faz sentido (ver seção QR do controller S3a). */
function isQrAble(status: string): boolean {
  const s = status.toUpperCase();
  return s === "SCAN_QR_CODE" || s === "STARTING";
}

/**
 * Valida a forma da resposta de sessão (JSON da rede nunca é confiável por
 * construção — o contrato S3a devolve `{ sessionName, status }` e o S3c
 * acrescenta `lastInbound` opcional `{ occurredAt, preview } | null`;
 * qualquer outra forma vira erro sanitizado em vez de crash no render).
 */
function parseSessionState(value: unknown): WhatsappSessionState | null {
  if (value === null || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec["sessionName"] !== "string" || typeof rec["status"] !== "string") return null;
  const rawInbound = rec["lastInbound"];
  let lastInbound: WhatsappLastInbound | null = null;
  if (rawInbound !== undefined && rawInbound !== null) {
    if (typeof rawInbound !== "object") return null;
    const inbound = rawInbound as Record<string, unknown>;
    if (typeof inbound["occurredAt"] !== "string" || typeof inbound["preview"] !== "string") return null;
    lastInbound = { occurredAt: inbound["occurredAt"], preview: inbound["preview"] };
  }
  return { sessionName: rec["sessionName"], status: rec["status"], lastInbound };
}

const UNEXPECTED_SESSION = "Resposta inesperada ao ler a sessão WhatsApp.";

function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fallback abaixo
  }
  return `waha-hub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function conflictOrGeneric(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) {
    return "Conflito de concorrência — os dados mudaram. Recarregue e tente de novo.";
  }
  return userMessage(err);
}

function describeSessionError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 503 && err.code === "WAHA_NOT_CONFIGURED") {
      return "WAHA não configurado na plataforma. Procure o operador (variáveis WAHA_* server-side).";
    }
    if (err.status === 429) {
      return "Provedor limitou as requisições (CAPPED). Aguarde e atualize o estado.";
    }
    if (err.status === 404 && err.code === "SESSION_NOT_FOUND_AT_PROVIDER") {
      return "A sessão sumiu no provedor. Use Conectar para reprovisionar.";
    }
    return userMessage(err);
  }
  return userMessage(err);
}

function qrErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return "QR indisponível para este estado (já pareada, parada ou expirada). Atualize o estado e tente de novo.";
    }
    if (err.status === 429) {
      return "Provedor limitou as requisições (CAPPED). Aguarde e atualize o QR.";
    }
    return userMessage(err);
  }
  return userMessage(err);
}

/** Formata o `occurredAt` do último inbound sem nunca quebrar o render. */
function formatInboundAt(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  try {
    return new Date(time).toLocaleString("pt-BR");
  } catch {
    return iso;
  }
}

/**
 * Erro do envio de teste mapeado para instrução (contrato S3c:
 * 404 `NO_SESSION`, 409 `SESSION_NOT_READY`, 429 backstop, 400 validação).
 */
function testMessageErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404 && err.code === "NO_SESSION") {
      return "Nenhuma sessão WhatsApp vinculada a este tenant. Conecte para parear antes de testar.";
    }
    if (err.status === 409 && err.code === "SESSION_NOT_READY") {
      return "A sessão não está Conectada. Aguarde o estado Conectada e tente de novo.";
    }
    if (err.status === 429) {
      return "Muitas tentativas de envio. Aguarde alguns minutos e tente de novo.";
    }
    return userMessage(err);
  }
  return userMessage(err);
}

/**
 * Busca o QR como bytes (image/png, `no-store` no servidor) e materializa um
 * objectURL efêmero — NUNCA persiste em storage; o dono revoga ao fechar,
 * ao parear ou no unmount.
 */
async function fetchQrObjectUrl(): Promise<string> {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("QR indisponível neste ambiente (sem suporte a object URL).");
  }
  const token = getToken();
  const headers: Record<string, string> = { Accept: "image/png" };
  if (token !== null) {
    headers["authorization"] = `Bearer ${token}`;
  }
  const revision = getTenantContextRevision();
  if (token !== null && revision !== null) {
    headers[TENANT_CONTEXT_REVISION_HEADER] = revision;
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${QR_PATH}`, { headers });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Não foi possível alcançar a API. Verifique sua conexão.");
  }
  if (!res.ok) {
    let code = "REQUEST_FAILED";
    try {
      const payload = (await res.json()) as { code?: unknown };
      if (typeof payload.code === "string" && payload.code.length > 0) code = payload.code;
    } catch {
      // corpo não-JSON: mantém o código genérico
    }
    throw new ApiError(res.status, code, messageForStatus(res.status, code));
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * Card da sessão WhatsApp (S3b/S3c, #87): conecta via QR, exibe o estado verbatim
 * do provedor, reconecta/desconecta, mostra o último inbound e oferece a
 * mensagem de teste. Leituras sob `integration.read` (card só monta com
 * `canRead` no hub); escritas sob `integration.manage`. Sem segredo no DOM: o
 * QR é imagem pública de pareamento e vive só como objectURL revogável.
 */
export function WhatsAppSessionCard({ canManage }: { canManage: boolean }): React.JSX.Element {
  const { push } = useToast();
  const [session, setSession] = useState<WhatsappSessionState | null>(null);
  const [probed, setProbed] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const closeQr = useCallback((): void => {
    setQrOpen(false);
  }, []);

  const loadSession = useCallback(async (): Promise<void> => {
    try {
      const parsed = parseSessionState(await api.get<unknown>(SESSION_PATH));
      if (parsed === null) {
        setSession(null);
        setSessionError(UNEXPECTED_SESSION);
        return;
      }
      setSession(parsed);
      setSessionError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404 && err.code === "NO_SESSION") {
        setSession(null);
        setSessionError(null);
      } else {
        setSessionError(describeSessionError(err));
      }
    } finally {
      setProbed(true);
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const handleQrStatus = useCallback((next: WhatsappSessionState): void => {
    setSession(next);
  }, []);

  const connect = async (): Promise<void> => {
    setBusy(true);
    setSessionError(null);
    try {
      const res = await api.post<unknown>(SESSION_PATH, {}, { idempotencyKey: newIdempotencyKey() });
      const parsed = parseSessionState(res);
      if (parsed === null) {
        setSessionError(UNEXPECTED_SESSION);
        push(UNEXPECTED_SESSION);
        return;
      }
      setSession(parsed);
      if (parsed.status.toUpperCase() === "WORKING") {
        push(`WhatsApp conectado (${sessionLabel(parsed.status)}).`);
        return;
      }
      setQrOpen(true);
    } catch (err) {
      const msg = conflictOrGeneric(err);
      setSessionError(msg);
      push(msg);
    } finally {
      setBusy(false);
    }
  };

  const reconnect = async (): Promise<void> => {
    setBusy(true);
    setSessionError(null);
    try {
      const res = await api.post<unknown>(RECONNECT_PATH, {}, { idempotencyKey: newIdempotencyKey() });
      const parsed = parseSessionState(res);
      if (parsed === null) {
        setSessionError(UNEXPECTED_SESSION);
        push(UNEXPECTED_SESSION);
        return;
      }
      setSession(parsed);
      push(`Sessão WhatsApp reconectada (${sessionLabel(parsed.status)}).`);
    } catch (err) {
      const msg = conflictOrGeneric(err);
      setSessionError(msg);
      push(msg);
    } finally {
      setBusy(false);
    }
  };

  const isWorking = session !== null && session.status.toUpperCase() === "WORKING";

  return (
    <div className="cc-u-mt-2">
      {!probed ? <p className="cc-muted">Carregando sessão WhatsApp…</p> : null}
      {probed && sessionError !== null ? <p className="cc-field-error">{sessionError}</p> : null}
      {probed && session === null && sessionError === null ? (
        <p className="cc-muted">Nenhuma sessão WhatsApp vinculada a este tenant. Conecte para parear.</p>
      ) : null}
      {probed && session !== null ? (
        <ul className="cc-u-mt-2">
          <li>
            Sessão: <strong>{session.sessionName}</strong>
          </li>
          <li>
            Estado: <strong>{sessionLabel(session.status)}</strong> <StatusPill status={session.status} />
          </li>
          {session.status.toUpperCase() === "CAPPED" ? (
            <li className="cc-muted">
              Restrição do provedor exibida como recebida — não significa “desconectado”. Aguarde e atualize o
              estado.
            </li>
          ) : null}
          {/*
            S3c: o `GET .../session` expõe `lastInbound` (`{ occurredAt, preview } |
            null`, 1 query sem join). Preview curto do próprio tenant, nunca
            inventado — ausente vira linha muted, nunca campo vazio.
          */}
          {session.lastInbound !== null ? (
            <li>
              Última mensagem recebida: <strong>{session.lastInbound.preview}</strong>{" "}
              <span className="cc-muted">({formatInboundAt(session.lastInbound.occurredAt)})</span>
            </li>
          ) : (
            <li className="cc-muted">Nenhuma mensagem recebida ainda nesta linha.</li>
          )}
        </ul>
      ) : null}

      {probed ? (
        <div className="cc-row cc-u-mt-2">
          {session === null && canManage ? (
            <Button disabled={busy} onClick={() => void connect()}>
              {busy ? "Conectando…" : "Conectar WhatsApp"}
            </Button>
          ) : null}
          {session !== null ? (
            <Button variant="secondary" disabled={busy} onClick={() => void loadSession()}>
              Atualizar estado
            </Button>
          ) : null}
          {session !== null && canManage && !isWorking && isQrAble(session.status) ? (
            <Button variant="secondary" disabled={busy} onClick={() => setQrOpen(true)}>
              Ver QR
            </Button>
          ) : null}
          {session !== null && canManage ? (
            <Button variant="secondary" disabled={busy} onClick={() => void reconnect()}>
              {busy ? "Reconectando…" : "Reconectar"}
            </Button>
          ) : null}
          {session !== null && canManage ? (
            <Button variant="danger" disabled={busy} onClick={() => setDisconnectOpen(true)}>
              Desconectar
            </Button>
          ) : null}
          {session !== null && canManage ? (
            <Button variant="secondary" disabled={busy || !isWorking} onClick={() => setTestOpen(true)}>
              Enviar mensagem de teste
            </Button>
          ) : null}
        </div>
      ) : null}
      {probed && session !== null && canManage && !isWorking ? (
        <p className="cc-muted cc-u-mt-2">A mensagem de teste exige sessão Conectada.</p>
      ) : null}
      {probed && !canManage ? (
        <p className="cc-muted cc-u-mt-2">Somente leitura para o seu perfil.</p>
      ) : null}

      <WhatsAppQrDialog open={qrOpen} onClose={closeQr} onStatus={handleQrStatus} />
      <WhatsAppDisconnectDialog
        sessionName={session?.sessionName ?? null}
        open={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        onDisconnected={(next) => {
          setSession(next);
          setDisconnectOpen(false);
        }}
      />
      <WhatsAppTestDialog open={testOpen} onClose={() => setTestOpen(false)} />
    </div>
  );
}

function WhatsAppQrDialog({
  open,
  onClose,
  onStatus,
}: {
  open: boolean;
  onClose: () => void;
  onStatus: (next: WhatsappSessionState) => void;
}): React.JSX.Element | null {
  const { push } = useToast();
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrNote, setQrNote] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const deadlineRef = useRef(0);
  const qrUrlRef = useRef<string | null>(null);
  const pushRef = useRef(push);
  pushRef.current = push;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const revokeQr = useCallback((): void => {
    if (qrUrlRef.current !== null) {
      try {
        URL.revokeObjectURL(qrUrlRef.current);
      } catch {
        // ambiente sem revoke: o GC da aba cobre
      }
      qrUrlRef.current = null;
    }
    setQrUrl(null);
  }, []);

  const close = useCallback((): void => {
    revokeQr();
    onClose();
  }, [onClose, revokeQr]);

  // Revoga o objectURL no unmount sem tocar em estado pós-desmonte.
  useEffect(
    () => () => {
      if (qrUrlRef.current !== null) {
        try {
          URL.revokeObjectURL(qrUrlRef.current);
        } catch {
          // ambiente sem revoke: o GC da aba cobre
        }
        qrUrlRef.current = null;
      }
    },
    [],
  );

  const refreshQr = useCallback(async (): Promise<void> => {
    setQrNote(null);
    setQrFailed(false);
    try {
      const url = await fetchQrObjectUrl();
      if (qrUrlRef.current !== null) {
        try {
          URL.revokeObjectURL(qrUrlRef.current);
        } catch {
          // ambiente sem revoke: o GC da aba cobre
        }
      }
      qrUrlRef.current = url;
      setQrUrl(url);
    } catch (err) {
      setQrNote(qrErrorText(err));
      setQrFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    deadlineRef.current = Date.now() + QR_TIMEOUT_MS;
    void refreshQr();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      if (cancelled) return;
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const parsed = parseSessionState(await api.get<unknown>(SESSION_PATH));
        if (cancelled) return;
        if (parsed === null) {
          setQrNote(UNEXPECTED_SESSION);
          schedule();
          return;
        }
        onStatusRef.current(parsed);
        const upper = parsed.status.toUpperCase();
        if (upper === "WORKING") {
          pushRef.current("WhatsApp conectado. Pareamento confirmado.");
          revokeQr();
          onClose();
          return;
        }
        if (upper === "STOPPED" || upper === "FAILED") {
          setQrNote("A sessão parou ou falhou durante o pareamento. Feche e use Conectar de novo.");
          setQrFailed(true);
          return;
        }
        if (upper === "REAUTH_REQUIRED") {
          setQrNote("Reautorização necessária. Feche e use Conectar para gerar um novo QR.");
          setQrFailed(true);
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setQrNote(`Não foi possível atualizar o estado (${userMessage(err)}). Tentando de novo…`);
      }
      if (cancelled) return;
      if (Date.now() >= deadlineRef.current) {
        setQrFailed(true);
        setQrNote("Tempo esgotado (2 min) sem pareamento. O QR expira em segundos — use Atualizar QR para gerar outro.");
        pushRef.current("Pareamento WhatsApp: tempo esgotado. Gere um novo QR.");
        return;
      }
      schedule();
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [open, onClose, refreshQr, revokeQr]);

  if (!open) return null;

  const retryQr = (): void => {
    deadlineRef.current = Date.now() + QR_TIMEOUT_MS;
    void refreshQr();
  };

  return (
    <Dialog title="Conectar WhatsApp via QR" open={open} onClose={close}>
      <div className="cc-form">
        <p className="cc-muted">
          Escaneie o QR no aparelho para parear. O código expira em segundos — a tela verifica o estado a cada
          ~5s até confirmar ou 2 min.
        </p>
        {qrUrl !== null ? (
          <img src={qrUrl} alt="QR Code para parear o WhatsApp" style={{ maxWidth: "100%" }} />
        ) : (
          <p className="cc-muted">Gerando QR…</p>
        )}
        {qrNote !== null ? (
          <p className={qrFailed ? "cc-field-error cc-u-mt-2" : "cc-muted cc-u-mt-2"}>{qrNote}</p>
        ) : null}
        <div className="cc-row cc-u-mt-2">
          <Button variant="secondary" onClick={retryQr}>
            Atualizar QR
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function WhatsAppDisconnectDialog({
  sessionName,
  open,
  onClose,
  onDisconnected,
}: {
  sessionName: string | null;
  open: boolean;
  onClose: () => void;
  onDisconnected: (next: WhatsappSessionState) => void;
}): React.JSX.Element | null {
  const { push } = useToast();
  const [confirmed, setConfirmed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const submit = async (): Promise<void> => {
    if (!confirmed) {
      setSaveError("Confirme que deseja desconectar para continuar.");
      return;
    }
    setSaveError(null);
    setBusy(true);
    try {
      const res = await api.post<unknown>(DISCONNECT_PATH, {}, { idempotencyKey: newIdempotencyKey() });
      const parsed = parseSessionState(res);
      if (parsed === null) {
        setSaveError(UNEXPECTED_SESSION);
        push(UNEXPECTED_SESSION);
        return;
      }
      push("Sessão WhatsApp pausada. Histórico preservado — só a sessão foi parada.");
      onDisconnected(parsed);
    } catch (err) {
      const msg = conflictOrGeneric(err);
      setSaveError(msg);
      push(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Desconectar sessão WhatsApp" open={open} onClose={onClose}>
      <div className="cc-form">
        <p>
          Pausar a sessão{sessionName !== null ? ` ${sessionName}` : ""}? Novos pareamentos e efeitos são
          pausados, mas o vínculo e o histórico são preservados — só a sessão é parada.
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

/**
 * Mensagem de teste para destinatário autorizado (S3b/S3c, #87).
 *
 * Validação E.164-like + confirmação explícita de escopo (SOMENTE o número
 * digitado — nunca broadcast) e gating: o botão só habilita com sessão
 * WORKING. O submit chama `POST .../test-message` (contrato S3c:
 * `{ to, text }` com `Idempotency-Key` nova por tentativa); a resposta
 * sanitizada `{ to, textLength, sessionName, providerMessageId }` nunca
 * devolve o conteúdo. Erros viram instrução em pt-BR (409 `SESSION_NOT_READY`
 * → reconectar; 404 `NO_SESSION` → parear; 429 → aguardar).
 */
function WhatsAppTestDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const { push } = useToast();
  const [recipient, setRecipient] = useState("");
  const [text, setText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const submit = async (): Promise<void> => {
    const to = recipient.trim();
    if (!E164_RE.test(to)) {
      setFieldError("Informe o destinatário no formato internacional, ex.: +5511999990001 (só dígitos, com DDI).");
      return;
    }
    if (text.trim().length === 0) {
      setFieldError("Escreva uma mensagem curta de teste.");
      return;
    }
    if (text.length > MAX_TEST_TEXT) {
      setFieldError(`A mensagem deve ter no máximo ${MAX_TEST_TEXT} caracteres.`);
      return;
    }
    if (!confirmed) {
      setFieldError("Confirme que o envio vai SOMENTE para este número.");
      return;
    }
    setFieldError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await api.post<{ to: string }>(TEST_MESSAGE_PATH, { to, text }, { idempotencyKey: newIdempotencyKey() });
      const sentTo = typeof res.to === "string" && res.to.length > 0 ? res.to : to;
      setNotice(`Mensagem de teste enviada para ${sentTo}. Verifique o aparelho de destino.`);
      push(`Mensagem de teste enviada para ${sentTo}.`);
    } catch (err) {
      const msg = testMessageErrorText(err);
      setFieldError(msg);
      push(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Enviar mensagem de teste" open={open} onClose={onClose}>
      <div className="cc-form">
        <p className="cc-muted">
          Somente para o número digitado e confirmado abaixo — nunca broadcast. Formato internacional com DDI.
        </p>
        <Field label="Destinatário autorizado (E.164)" error={fieldError}>
          <Input
            value={recipient}
            onChange={(e) => {
              setRecipient(e.target.value);
              setFieldError(null);
              setNotice(null);
            }}
            placeholder="+5511999990001"
            inputMode="tel"
          />
        </Field>
        <Field label={`Mensagem curta (até ${MAX_TEST_TEXT} caracteres)`}>
          <Textarea
            value={text}
            maxLength={MAX_TEST_TEXT}
            onChange={(e) => {
              setText(e.target.value);
              setFieldError(null);
              setNotice(null);
            }}
            placeholder="Olá! Teste de pareamento do WhatsApp."
          />
        </Field>
        <Field label="Confirmação de escopo">
          <label className="cc-row" style={{ gap: "0.5rem", alignItems: "center" }}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => {
                setConfirmed(e.target.checked);
                setFieldError(null);
              }}
            />
            Confirmo que a mensagem vai SOMENTE para este número
          </label>
        </Field>
        {notice !== null ? <p className="cc-muted">{notice}</p> : null}
        <div className="cc-row cc-u-mt-4">
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? "Enviando…" : "Enviar para este número"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
