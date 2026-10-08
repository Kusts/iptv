"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell";
import { CopilotWidget, loadDrafts, removeDraft, type CopilotDraft } from "../../components/CopilotWidget";
import { ConfirmAction, useRevenueCommand } from "../../components/RevenueOps";
import { useAuth, useOptionalHasPermission } from "../../lib/auth";
import { api, userMessage, type CenterResponse } from "../../lib/api";
import { clearApiCache, useApi } from "../../lib/useApi";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../components/ui/States";
import { useToast } from "../../components/ui/Toast";

/**
 * Workspace do Tenant Copilot (Wave 14-COPILOT, G18): conversa (widget),
 * drafts salvos isolados por escopo de sessão, revisões pendentes (HITL) e
 * navegação cross-domain por sugestão. Drafts nunca executam sozinhos:
 * executar passa sempre pelo `POST /v1/agent/copilot/execute`.
 */
export default function CopilotPage(): React.JSX.Element {
  return (
    <Shell>
      <h1>Copilot</h1>
      <CopilotWidget />
      <DraftsCard />
      <PendingReviewsCard />
      <AgentRunsCard />
      <AgentEvalsCard />
      <Card title="Navegação sugerida">
        <ul>
          <li><Link href="/conversations">Conversas</Link> — contexto de atendimento por conversa.</li>
          <li><Link href="/orders">Pedidos</Link> — status e totais permission-scoped.</li>
          <li><Link href="/subscriptions">Assinaturas</Link> — estado projetado e ciclos.</li>
          <li><Link href="/support">Suporte</Link> — tickets e resolução com HITL.</li>
          <li><Link href="/hitl">Centro HITL</Link> — fila de aprovação das ações sensíveis.</li>
        </ul>
      </Card>
    </Shell>
  );
}

function DraftsCard(): React.JSX.Element {
  const { apiScope } = useAuth();
  const { push } = useToast();
  const [drafts, setDrafts] = useState<CopilotDraft[]>(() => loadDrafts(apiScope));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setDrafts(loadDrafts(apiScope));
  }, [apiScope]);

  const refresh = (): void => setDrafts(loadDrafts(apiScope));

  const execute = async (draft: CopilotDraft, reviewId?: string): Promise<void> => {
    setBusyId(draft.id);
    setActionError(null);
    try {
      const res = await api.post<{ status: string; message: string; reviewId?: string }>(
        "/v1/agent/copilot/execute",
        reviewId === undefined
          ? { command: draft.command, input: draft.input }
          : { command: draft.command, input: draft.input, reviewId },
      );
      if (res.status === "pending_review") {
        push(`Ação sensível aguarda aprovação humana. Nada foi executado.${res.reviewId ? ` Revisão ${res.reviewId.slice(0, 8)}…` : ""}`);
      } else {
        push("Comando executado pelo pipeline autorizado.");
        removeDraft(apiScope, draft.id);
        refresh();
      }
      clearApiCache();
    } catch (err) {
      setActionError(userMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const discard = (id: string): void => {
    removeDraft(apiScope, id);
    refresh();
  };

  return (
    <Card title={`Drafts salvos (${drafts.length})`}>
      {drafts.length === 0 ? (
        <EmptyState title="Nenhum draft" hint="Pergunte ao Copilot e salve uma ação proposta para executá-la aqui." />
      ) : null}
      {actionError ? <p className="cc-field-error">{actionError}</p> : null}
      {drafts.map((draft) => (
        <div key={draft.id} className="cc-card" style={{ marginBottom: "0.5rem" }}>
          <p>
            <strong>{draft.label}</strong>
          </p>
          <p className="cc-mono">
            {draft.command} · {JSON.stringify(draft.input).slice(0, 200)}
          </p>
          <div className="cc-row">
            <Button disabled={busyId === draft.id} onClick={() => void execute(draft)}>
              {busyId === draft.id ? "Executando…" : "Executar"}
            </Button>
            <Button variant="secondary" onClick={() => discard(draft.id)}>
              Descartar
            </Button>
          </div>
        </div>
      ))}
    </Card>
  );
}

function PendingReviewsCard(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<CenterResponse>("/v1/human-reviews/center?source=human_review");
  const { hasPermission } = useAuth();

  if (loading) return <LoadingSkeleton lines={3} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null || data.items.length === 0) {
    return (
      <Card title="Aprovações pendentes">
        <EmptyState title="Fila vazia" hint="Ações sensíveis do Copilot aguardam aprovação aqui." />
      </Card>
    );
  }
  const canDecide = hasPermission("agent.review.decide");
  return (
    <Card title={`Aprovações pendentes (${data.items.length})`}>
      {data.items.map((item) => (
        <div key={item.id} className="cc-card" style={{ marginBottom: "0.5rem" }}>
          <div className="cc-row">
            <Badge tone="info">{item.kind}</Badge>
            <span className="cc-muted">{item.id.slice(0, 8)}…</span>
          </div>
          <p>{item.summary}</p>
          <p className="cc-muted">
            {canDecide ? (
              <>
                Decida em <Link href="/hitl">Centro HITL</Link> — a execução usa a revisão aprovada.
              </>
            ) : (
              "Você não tem permissão para decidir revisões (agent.review.decide)."
            )}
          </p>
        </div>
      ))}
    </Card>
  );
}

/**
 * P4b — runs do agente por conversa (extensão do workspace Copilot; sem rota
 * `/agent` nova para não tocar na navegação do Shell). Somente leitura.
 */
function AgentRunsCard(): React.JSX.Element {
  const hasPermission = useOptionalHasPermission();
  const canRead = hasPermission("agent.review.request");
  const [conversationId, setConversationId] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const qs = canRead && activeId ? `/v1/agent/runs?conversationId=${encodeURIComponent(activeId)}` : null;
  const { data, error, loading, reload } = useApi<{
    runs: { id: string; status: string; mode: string; model: string; proposalLabel: string | null; createdAt: string }[];
  }>(qs);

  if (!canRead) return <></>;

  const runs = data?.runs ?? [];

  return (
    <Card title="Runs do agente (por conversa)">
      <div className="cc-row" style={{ marginBottom: "0.5rem" }}>
        <input
          aria-label="ID da conversa"
          placeholder="UUID da conversa"
          value={conversationId}
          onChange={(e) => setConversationId(e.target.value)}
          style={{ maxWidth: "320px" }}
        />
        <Button variant="secondary" onClick={() => setActiveId(conversationId.trim().length > 0 ? conversationId.trim() : null)}>
          Consultar runs
        </Button>
      </div>
      {activeId === null ? (
        <EmptyState title="Informe a conversa" hint="Runs do pipeline são listados por conversa (escopo permissionado)." />
      ) : null}
      {loading ? <LoadingSkeleton lines={3} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && runs.length === 0 ? <EmptyState title="Sem runs" hint="Nenhum run registrado para esta conversa." /> : null}
      {runs.length > 0 ? (
        <ul>
          {runs.map((r) => (
            <li key={r.id}>
              <Badge tone="info">{r.status}</Badge> <span className="cc-mono">{r.id.slice(0, 8)}…</span>{" "}
              <span className="cc-muted">{r.mode} · {r.model} · {r.proposalLabel ?? "sem proposta"}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/**
 * P4b — disparo manual de evals do agente (extensão do workspace Copilot).
 * POST com confirmação; gate `agent.eval.run`.
 */
function AgentEvalsCard(): React.JSX.Element {
  const hasPermission = useOptionalHasPermission();
  const canRun = hasPermission("agent.eval.run");
  const { busy, run } = useRevenueCommand();
  const [open, setOpen] = useState(false);
  const [suite, setSuite] = useState("");

  if (!canRun) return <></>;

  const confirm = (): void => {
    void run(
      "/v1/agent/evals/run",
      { ...(suite.trim().length > 0 ? { suite: suite.trim() } : {}) },
      "Eval do agente disparado.",
      () => {
        setSuite("");
        setOpen(false);
      },
    );
  };

  return (
    <Card title="Evals do agente">
      <p className="cc-muted">Execução manual da suíte de avaliação; resultados ficam no pipeline do servidor.</p>
      <div className="cc-row" style={{ marginTop: "0.5rem" }}>
        <Button disabled={busy} onClick={() => setOpen(true)}>
          Executar eval
        </Button>
      </div>
      <ConfirmAction title="Executar eval do agente" open={open} confirmLabel="Confirmar execução" busy={busy} onClose={() => setOpen(false)} onConfirm={confirm}>
        <p className="cc-muted">Suíte (opcional, vazio = padrão do servidor).</p>
        <input aria-label="Suíte de eval" placeholder="suite (opcional)" value={suite} onChange={(e) => setSuite(e.target.value)} disabled={busy} />
      </ConfirmAction>
    </Card>
  );
}
