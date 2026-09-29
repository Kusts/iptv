"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import type { CenterItem, CenterResponse } from "../lib/api";
import { formatDateTime } from "../lib/money";
import { slaLabel } from "../lib/status";
import { useApi } from "../lib/useApi";
import { Badge } from "./ui/Badge";
import { Card } from "./ui/Card";
import { EmptyState, ErrorState, LoadingSkeleton } from "./ui/States";

const SOURCE_LABELS: Record<string, string> = {
  human_review: "Revisão humana",
  comm_exception: "Exceção de comunicação",
  billing_exception: "Exceção de cobrança",
  recovery_task: "Recuperação",
};

const PREVIEW_LIMIT = 5;

/**
 * Prioridade do preview: banda de SLA existente primeiro
 * (BREACH > WARN > OK), depois createdAt ascendente, depois id estável.
 * Nunca usa `priority` (nulável por origem) nem inventa score; a ordem
 * completa da API/fila não é alterada — só a cópia do preview.
 */
const SLA_RANK: Record<string, number> = { BREACH: 0, WARN: 1, OK: 2 };

function slaRank(sla: string): number {
  return SLA_RANK[sla] ?? 3;
}

function comparePreview(a: CenterItem, b: CenterItem): number {
  const rank = slaRank(a.sla) - slaRank(b.sla);
  if (rank !== 0) return rank;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return 0;
}

/** Chave estável entre fontes: ids podem colidir cross-source. */
function rowKey(item: CenterItem): string {
  return `${item.source}:${item.id}`;
}

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/** Banda SLA desconhecida é neutra/informativa — nunca verde de sucesso. */
function slaTone(sla: string): "danger" | "warn" | "success" | "info" {
  if (sla === "BREACH") return "danger";
  if (sla === "WARN") return "warn";
  if (sla === "OK") return "success";
  return "info";
}

function slaText(sla: string): string {
  if (sla === "BREACH" || sla === "WARN" || sla === "OK") return slaLabel(sla);
  return "SLA desconhecido";
}

export function NeedsAttention(): React.JSX.Element {
  const { data, error, loading, reload, refresh, refreshError } = useApi<CenterResponse>("/v1/human-reviews/center");

  // Frescor do preview sem skeleton: revalida o cache no mount/retorno,
  // no foco/visibilidade e em intervalo limitado (60s visível). O
  // `refresh` nunca derruba o dado atual; guardas de chave+geração no
  // hook impedem escrita tardia em outro escopo de identidade.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    refreshRef.current();
    const onFocus = (): void => {
      refreshRef.current();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") refreshRef.current();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const id = window.setInterval(() => {
      if (document.visibilityState !== "hidden") refreshRef.current();
    }, 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(id);
    };
  }, []);

  if (loading) return <LoadingSkeleton lines={4} />;
  if (error !== null) {
    return (
      <Card title="Precisa de você">
        <ErrorState message={error} onRetry={reload} />
      </Card>
    );
  }
  if (data === null) return <EmptyState title="Sem dados de trabalho" />;
  if (data.items.length === 0) {
    return (
      <Card title="Precisa de você">
        {refreshError !== null ? (
          <div role="alert" className="cc-row" style={{ marginBottom: "0.75rem" }}>
            <span className="cc-muted">Dados possivelmente desatualizados: {refreshError}</span>
            <button type="button" onClick={() => refresh()}>
              Tentar atualizar
            </button>
          </div>
        ) : null}
        <EmptyState title="Nada pendente" hint="Nenhum trabalho aguardando você agora." />
      </Card>
    );
  }

  const sorted = [...data.items].sort(comparePreview);
  const preview = sorted.slice(0, PREVIEW_LIMIT);
  const remaining = data.items.length - preview.length;
  // Exatamente as linhas fora do preview ordenado (sem colisão por id).
  const hiddenBreaches = sorted.slice(PREVIEW_LIMIT).filter((item) => item.sla === "BREACH").length;

  return (
    <Card title={`Precisa de você (${data.items.length})`}>
      {refreshError !== null ? (
        <div role="alert" className="cc-row" style={{ marginBottom: "0.75rem" }}>
          <span className="cc-muted">Dados possivelmente desatualizados: {refreshError}</span>
          <button type="button" onClick={() => refresh()}>
            Tentar atualizar
          </button>
        </div>
      ) : null}
      <ul style={{ listStyle: "none", padding: 0, margin: "0 0 0.75rem" }}>
        {preview.map((item) => (
          <li key={rowKey(item)} style={{ marginBottom: "0.75rem" }}>
            <div className="cc-row">
              <Badge tone={slaTone(item.sla)}>{slaText(item.sla)}</Badge>
              <span className="cc-muted">{sourceLabel(item.source)}</span>
              <span className="cc-mono">{item.kind}</span>
            </div>
            <p style={{ margin: "0.25rem 0" }}>{item.summary}</p>
            <p className="cc-muted" style={{ margin: 0 }}>
              {formatDateTime(item.createdAt)} · há {Math.round(item.ageMinutes)} min
            </p>
          </li>
        ))}
      </ul>
      {remaining > 0 ? (
        <p className="cc-muted">
          e mais {remaining} {remaining === 1 ? "item" : "itens"} na fila
          {hiddenBreaches > 0
            ? ` (${hiddenBreaches} com SLA estourado${hiddenBreaches === 1 ? "" : "s"})`
            : null}
          .
        </p>
      ) : null}
      <p style={{ marginBottom: 0 }}>
        <Link href="/hitl">Abrir fila do Centro HITL</Link>
      </p>
    </Card>
  );
}
