"use client";

import { useState } from "react";
import { api, userMessage, type KnowledgeCorrectionsResponse, type KnowledgeGapsResponse, type KnowledgeItemsResponse } from "../lib/api";
import { useApi } from "../lib/useApi";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { StatusPill } from "./ui/Badge";
import { EmptyState, ErrorState, LoadingSkeleton } from "./ui/States";
import { useToast } from "./ui/Toast";

/**
 * Filas de maturação do conhecimento (Wave 15): candidatos a verificar,
 * correções abertas e gaps de conhecimento, mais a recalibragem manual
 * de freshness. Leitura via `useApi`, ações via POST direto.
 */
export function KnowledgeQueues(): React.JSX.Element {
  const candidates = useApi<KnowledgeItemsResponse>("/v1/knowledge/items?status=CANDIDATE");
  const degraded = useApi<KnowledgeItemsResponse>("/v1/knowledge/items?status=DEGRADED");
  const corrections = useApi<KnowledgeCorrectionsResponse>("/v1/knowledge/corrections?status=OPEN");
  const gaps = useApi<KnowledgeGapsResponse>("/v1/knowledge/gaps?status=OPEN");
  const { push } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const reloadAll = (): void => {
    candidates.reload();
    degraded.reload();
    corrections.reload();
    gaps.reload();
  };

  const act = async (key: string, fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      push(done);
      reloadAll();
    } catch (err) {
      setMsg(userMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const refresh = (): Promise<unknown> => api.post("/v1/knowledge/freshness/refresh", {});

  return (
    <div className="cc-grid-2">
      <Card title="Candidatos a verificar">
        {candidates.loading ? <LoadingSkeleton lines={3} /> : null}
        {candidates.error !== null ? <ErrorState message={candidates.error} onRetry={candidates.reload} /> : null}
        {candidates.data && candidates.data.items.length === 0 ? (
          <EmptyState title="Nenhum candidato" hint="Itens criados como CANDIDATE aparecem aqui." />
        ) : null}
        {candidates.data && candidates.data.items.length > 0 ? (
          <ul>
            {candidates.data.items.map((item) => (
              <li key={item.id} className="cc-row">
                <span className="cc-muted">{(item.contentText ?? item.id).slice(0, 60)}</span>
                <StatusPill status={item.status} />
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void act(`verify:${item.id}`, () => api.post(`/v1/knowledge/items/${item.id}/verify`, {}), "Item verificado.")}
                >
                  {busy === `verify:${item.id}` ? "Verificando…" : "Verificar"}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card title="Correções abertas">
        {corrections.loading ? <LoadingSkeleton lines={3} /> : null}
        {corrections.error !== null ? <ErrorState message={corrections.error} onRetry={corrections.reload} /> : null}
        {corrections.data && corrections.data.corrections.length === 0 ? (
          <EmptyState title="Nenhuma correção" hint="Correções propostas contra itens aparecem aqui." />
        ) : null}
        {corrections.data && corrections.data.corrections.length > 0 ? (
          <ul>
            {corrections.data.corrections.map((c) => (
              <li key={c.id} className="cc-row">
                <span className="cc-muted">{c.proposedText.slice(0, 60)}</span>
                <StatusPill status={c.status} />
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void act(`apply:${c.id}`, () => api.post(`/v1/knowledge/corrections/${c.id}/apply`, {}), "Correção aplicada.")}
                >
                  {busy === `apply:${c.id}` ? "Aplicando…" : "Aplicar"}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void act(`reject:${c.id}`, () => api.post(`/v1/knowledge/corrections/${c.id}/reject`, {}), "Correção rejeitada.")}
                >
                  Rejeitar
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card title="Gaps de conhecimento">
        {gaps.loading ? <LoadingSkeleton lines={3} /> : null}
        {gaps.error !== null ? <ErrorState message={gaps.error} onRetry={gaps.reload} /> : null}
        {gaps.data && gaps.data.gaps.length === 0 ? (
          <EmptyState title="Nenhum gap" hint="Perguntas sem resposta (ex.: ticket sem solução) aparecem aqui." />
        ) : null}
        {gaps.data && gaps.data.gaps.length > 0 ? (
          <ul>
            {gaps.data.gaps.map((g) => (
              <li key={g.id} className="cc-row">
                <span className="cc-muted">{g.question.slice(0, 60)}</span>
                <StatusPill status={g.status} />
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void act(`close:${g.id}`, () => api.post(`/v1/knowledge/gaps/${g.id}/close`, {}), "Gap fechado.")}
                >
                  {busy === `close:${g.id}` ? "Fechando…" : "Fechar"}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card title="Freshness">
        <p className="cc-muted">
          Recalibra o freshness_score pela idade dos itens; VERIFIED envelhecidos viram DEGRADED.
        </p>
        {degraded.data && degraded.data.items.length > 0 ? (
          <ul>
            {degraded.data.items.map((item) => (
              <li key={item.id} className="cc-row">
                <span className="cc-muted">{(item.contentText ?? item.id).slice(0, 60)}</span>
                <StatusPill status={item.status} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="Nenhum item degradado" />
        )}
        <Button disabled={busy !== null} onClick={() => void act("refresh", refresh, "Freshness recalibrado.")}>
          {busy === "refresh" ? "Recalibrando…" : "Recalibrar freshness"}
        </Button>
        {msg ? <p className="cc-muted">{msg}</p> : null}
      </Card>
    </div>
  );
}
