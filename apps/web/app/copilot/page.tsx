"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell";
import { CopilotWidget, loadDrafts, removeDraft, type CopilotDraft } from "../../components/CopilotWidget";
import { useAuth } from "../../lib/auth";
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
