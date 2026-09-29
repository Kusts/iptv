"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { api, userMessage, type CopilotAskResponse, type CopilotScreenInput, type CopilotSuggestion } from "../lib/api";
import { useOptionalApiScope } from "../lib/auth";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { EmptyState, ErrorState, LoadingSkeleton } from "./ui/States";
import { useToast } from "./ui/Toast";

export interface CopilotDraft {
  id: string;
  label: string;
  command: string;
  input: Record<string, unknown>;
  createdAt: string;
}

interface ChatEntry {
  id: string;
  role: "user" | "copilot";
  text: string;
  answer?: CopilotAskResponse;
}

/**
 * MVP session memory (finding W14b-4): drafts and chat history live ONLY in
 * module memory (`Map` keyed by identity scope), never in `localStorage`.
 * A reload (fresh module registry) or a scope change starts empty, so
 * customer data cannot survive in persistent storage. Entries are capped
 * (`MAX_HISTORY`/`MAX_DRAFTS`) to bound memory per scope.
 */
const MAX_HISTORY = 20;
const MAX_DRAFTS = 50;

const memoryDrafts = new Map<string, CopilotDraft[]>();
const memoryHistory = new Map<string, ChatEntry[]>();

/** Test/dev seam: drop all in-memory Copilot state (simulates a reload). */
export function clearCopilotSessionMemory(): void {
  memoryDrafts.clear();
  memoryHistory.clear();
}

export function loadDrafts(scope: string): CopilotDraft[] {
  return [...(memoryDrafts.get(scope) ?? [])];
}

function saveDraft(scope: string, draft: CopilotDraft): void {
  const next = [...(memoryDrafts.get(scope) ?? []), draft].slice(-MAX_DRAFTS);
  memoryDrafts.set(scope, next);
}

export function removeDraft(scope: string, id: string): void {
  const current = memoryDrafts.get(scope);
  if (current === undefined) return;
  memoryDrafts.set(scope, current.filter((d) => d.id !== id));
}

function loadHistory(scope: string): ChatEntry[] {
  return [...(memoryHistory.get(scope) ?? [])].slice(-MAX_HISTORY);
}

function persistHistory(scope: string, entries: ChatEntry[]): void {
  memoryHistory.set(scope, entries.slice(-MAX_HISTORY));
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function confidenceTone(confidence: string): "success" | "info" {
  return confidence === "OBSERVED" ? "success" : "info";
}

/**
 * Widget global do Tenant Copilot (Wave 14-COPILOT): botão flutuante +
 * painel de conversa com o contexto da tela atual (rota). Leituras e
 * comandos passam pela API permission-scoped; drafts e histórico vivem só
 * em memória isolada por escopo de sessão (nunca em `localStorage`) e
 * drafts nunca executam sozinhos. Respostas de `ask` em voo são descartadas
 * quando o escopo de identidade muda antes da chegada.
 */
export function CopilotWidget(): React.JSX.Element {
  const pathname = usePathname();
  const authScope = useOptionalApiScope();
  // Fora do provider (ex.: testes isolados): namespace anônimo isolado.
  const apiScope = authScope ?? "public:anonymous";
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [entries, setEntries] = useState<ChatEntry[]>(() => loadHistory(apiScope));
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [busyDraft, setBusyDraft] = useState<string | null>(null);
  const scopeRef = useRef(apiScope);
  scopeRef.current = apiScope;

  useEffect(() => {
    setEntries(loadHistory(apiScope));
    setAskError(null);
  }, [apiScope]);

  const screen: CopilotScreenInput = { route: pathname ?? "/" };

  const send = async (): Promise<void> => {
    const text = question.trim();
    if (text.length === 0 || asking) return;
    // Finding W14b-3: capture the identity scope at send time. If the scope
    // changes while the ask is in flight (logout / tenant switch), the late
    // response must not populate the NEW scope's state or history.
    const requestScope = scopeRef.current;
    setAsking(true);
    setAskError(null);
    const userEntry: ChatEntry = { id: newId(), role: "user", text };
    setEntries((prev) => {
      const next = [...prev, userEntry];
      persistHistory(requestScope, next);
      return next;
    });
    setQuestion("");
    try {
      const answer = await api.post<CopilotAskResponse>("/v1/agent/copilot/ask", { question: text, screen });
      if (scopeRef.current !== requestScope) return;
      const entry: ChatEntry = { id: newId(), role: "copilot", text: answer.summary, answer };
      setEntries((prev) => {
        const next = [...prev, entry];
        persistHistory(requestScope, next);
        return next;
      });
    } catch (err) {
      if (scopeRef.current !== requestScope) return;
      setAskError(userMessage(err));
    } finally {
      if (scopeRef.current === requestScope) {
        setAsking(false);
      }
    }
  };

  const prepareDraft = (suggestion: CopilotSuggestion): void => {
    if (suggestion.draftCommand === undefined) return;
    saveDraft(scopeRef.current, {
      id: newId(),
      label: suggestion.label,
      command: suggestion.draftCommand,
      input: suggestion.draftInput ?? {},
      createdAt: new Date().toISOString(),
    });
    push("Draft salvo no workspace do Copilot.");
  };

  const executeDraft = async (command: string, input: Record<string, unknown>, key: string): Promise<void> => {
    setBusyDraft(key);
    try {
      const res = await api.post<{ status: string; message: string; reviewId?: string }>(
        "/v1/agent/copilot/execute",
        { command, input },
      );
      if (res.status === "pending_review") {
        push(`Enviado para aprovação humana${res.reviewId ? ` (${res.reviewId.slice(0, 8)}…)` : ""}. Nada foi executado.`);
      } else {
        push("Comando executado pelo pipeline autorizado.");
      }
    } catch (err) {
      push(userMessage(err));
    } finally {
      setBusyDraft(null);
    }
  };

  return (
    <div className="cc-copilot" aria-label="Tenant Copilot">
      <Button variant="secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "Fechar Copilot" : "Copilot"}
      </Button>
      {open ? (
        <Card title={`Copilot · ${screen.route}`}>
          {entries.length === 0 ? (
            <EmptyState
              title="Pergunte sobre esta tela"
              hint="O Copilot explica a visão atual com os dados que você pode ler e prepara ações pelo pipeline autorizado."
            />
          ) : null}
          <div className="cc-copilot-log">
            {entries.map((entry) =>
              entry.role === "user" ? (
                <p key={entry.id} className="cc-copilot-user">
                  {entry.text}
                </p>
              ) : (
                <div key={entry.id} className="cc-copilot-answer">
                  <p>{entry.text}</p>
                  {entry.answer ? (
                    <p>
                      <Badge tone={confidenceTone(entry.answer.confidence)}>{entry.answer.confidence}</Badge>
                    </p>
                  ) : null}
                  {entry.answer?.suggestions.map((suggestion, idx) => (
                    <div key={idx} className="cc-card" style={{ marginBottom: "0.5rem" }}>
                      <p>
                        <strong>{suggestion.kind}</strong> — {suggestion.label}
                      </p>
                      {suggestion.reason ? <p className="cc-muted">{suggestion.reason}</p> : null}
                      {suggestion.needsInput ? (
                        <p className="cc-muted">Falta informar: {suggestion.needsInput.join(", ")}</p>
                      ) : null}
                      <div className="cc-row">
                        {suggestion.deepLink ? (
                          <a className="cc-muted" href={suggestion.deepLink}>
                            Abrir visão
                          </a>
                        ) : null}
                        {suggestion.draftCommand ? (
                          <>
                            <Button variant="secondary" onClick={() => prepareDraft(suggestion)}>
                              Salvar draft
                            </Button>
                            <Button
                              disabled={busyDraft === `${entry.id}:${idx}` || (suggestion.needsInput?.length ?? 0) > 0}
                              onClick={() =>
                                void executeDraft(
                                  suggestion.draftCommand as string,
                                  suggestion.draftInput ?? {},
                                  `${entry.id}:${idx}`,
                                )
                              }
                            >
                              {busyDraft === `${entry.id}:${idx}` ? "Executando…" : "Executar"}
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ),
            )}
          </div>
          {asking ? <LoadingSkeleton lines={2} /> : null}
          {askError !== null ? <ErrorState message={askError} onRetry={() => void send()} /> : null}
          <div className="cc-row">
            <input
              aria-label="Pergunta ao Copilot"
              placeholder="Ex.: explique esta tela"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void send();
              }}
              style={{ flex: 1 }}
            />
            <Button disabled={asking || question.trim().length === 0} onClick={() => void send()}>
              Enviar
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
