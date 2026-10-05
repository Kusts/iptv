"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  api,
  userMessage,
  CENTER_SOURCES,
  PROVIDER_OPERATION_SOURCE,
  PROVIDER_OPERATION_READ_PERMISSION,
  type CenterResponse,
  type CenterSource,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { clearApiCache, useApi } from "../lib/useApi";
import { slaLabel } from "../lib/status";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { EmptyState, ErrorState, LoadingSkeleton } from "./ui/States";
import { Select } from "./ui/Input";
import { useToast } from "./ui/Toast";
import { formatDateTime } from "../lib/money";

const SOURCE_LABELS: Record<string, string> = {
  human_review: "Revisões humanas",
  comm_exception: "Exceções de comunicação",
  billing_exception: "Exceções de cobrança",
  recovery_task: "Recuperação",
  [PROVIDER_OPERATION_SOURCE]: "Operações de provedor",
};

/** Chave estável entre fontes: ids podem colidir cross-source. */
function rowKey(item: { source: CenterSource; id: string }): string {
  return `${item.source}:${item.id}`;
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

export function HitlCenter(): React.JSX.Element {
  const [source, setSource] = useState<string>("");
  const { hasPermission } = useAuth();
  const canReadProvider = hasPermission(PROVIDER_OPERATION_READ_PERMISSION);
  /**
   * `provider_operation` exige `provider.operation.read`: a opção some do
   * filtro e, se o caller escolher sem permissão, o filtro volta para
   * "todas" — nunca persistindo uma query que a API responde com 403.
   */
  const sources = useMemo(
    () => (canReadProvider ? [...CENTER_SOURCES] : CENTER_SOURCES.filter((s) => s !== PROVIDER_OPERATION_SOURCE)),
    [canReadProvider],
  );
  const activeSource = source === PROVIDER_OPERATION_SOURCE && !canReadProvider ? "" : source;
  const query =
    activeSource === "" ? "/v1/human-reviews/center" : `/v1/human-reviews/center?source=${activeSource}`;
  const { data, error, loading, reload, refresh, refreshError } = useApi<CenterResponse>(query);
  const { push } = useToast();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * Defesa contra resposta velha/cacheada: mesmo que um payload em cache
   * (ou um escopo anterior) traga linhas de `provider_operation`, elas não
   * são renderizadas sem a permissão — a API também as omite, mas a UI não
   * depende só disso.
   */
  const items = useMemo(() => {
    if (data === null) return null;
    return canReadProvider ? data.items : data.items.filter((i) => i.source !== PROVIDER_OPERATION_SOURCE);
  }, [data, canReadProvider]);

  // Revalida o cache compartilhado do centro ao montar/voltar para /hitl
  // (navegação a partir do Control Center não trata cache velho como
  // autoritativo) e ao trocar o filtro de origem com cache existente. O
  // `refresh` nunca derruba o dado atual e é no-op sem dado visível (o
  // hard inicial continua sendo o único fetch do mount sem cache).
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const queryRef = useRef(query);
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
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  useEffect(() => {
    if (queryRef.current !== query) {
      queryRef.current = query;
      refreshRef.current();
    }
  }, [query]);

  const canDecide = hasPermission("agent.review.decide");

  const act = async (
    item: { source: CenterSource; id: string },
    action: "claim" | "approve" | "reject",
  ): Promise<void> => {
    setBusyKey(rowKey(item));
    setActionError(null);
    try {
      if (item.source === "human_review" && action === "claim") {
        await api.post(`/v1/human-reviews/${item.id}/claim`, {});
        push("Item assumido.");
      } else if (item.source === "human_review" && (action === "approve" || action === "reject")) {
        await api.post(`/v1/human-reviews/${item.id}/${action}`, {});
        push(action === "approve" ? "Revisão aprovada." : "Revisão rejeitada.");
      } else {
        push("Ação registrada na fila de origem (somente leitura aqui).");
      }
      clearApiCache(query);
      reload();
    } catch (err) {
      setActionError(userMessage(err));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <label className="cc-muted" htmlFor="hitl-source">Origem:</label>
        <Select
          id="hitl-source"
          value={activeSource}
          onChange={(e) => setSource(e.target.value)}
          style={{ maxWidth: "260px" }}
        >
          <option value="">Todas</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </Select>
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data !== null && refreshError !== null ? (
        <div role="alert" className="cc-row" style={{ marginBottom: "1rem" }}>
          <span className="cc-muted">Dados possivelmente desatualizados: {refreshError}</span>
          <button type="button" onClick={() => refresh()}>
            Tentar atualizar
          </button>
        </div>
      ) : null}
      {actionError ? <p className="cc-field-error">{actionError}</p> : null}
      {items !== null && items.length === 0 ? (
        <EmptyState title="Fila vazia" hint="Nenhum item aguardando revisão humana." />
      ) : null}
      {items
        ? sources.filter((s) => activeSource === "" || s === activeSource).map((s) => {
            const group = items.filter((i) => i.source === s);
            if (group.length === 0) return null;
            return (
              <Card key={s} title={`${SOURCE_LABELS[s]} (${group.length})`}>
                {group.map((item) => (
                  <div key={rowKey(item)} className="cc-card" style={{ marginBottom: "0.5rem" }}>
                    <div className="cc-row">
                      <Badge tone={slaTone(item.sla)}>
                        {slaText(item.sla)}
                      </Badge>
                      <span className="cc-mono">{item.kind}</span>
                      <span className="cc-muted">{formatDateTime(item.createdAt)} · há {Math.round(item.ageMinutes)} min</span>
                    </div>
                    <p>{item.summary}</p>
                    <p className="cc-mono">{item.id}</p>
                    <div className="cc-row">
                      {item.source === "human_review" ? (
                        <>
                          <Button
                            variant="secondary"
                            disabled={busyKey === rowKey(item)}
                            onClick={() => void act(item, "claim")}
                          >
                            Assumir
                          </Button>
                          <span title={canDecide ? undefined : "Você não tem permissão para decidir revisões (agent.review.decide)."}>
                            <Button
                              disabled={!canDecide || busyKey === rowKey(item)}
                              onClick={() => void act(item, "approve")}
                            >
                              Aprovar
                            </Button>
                          </span>
                          <span title={canDecide ? undefined : "Você não tem permissão para decidir revisões (agent.review.decide)."}>
                            <Button
                              variant="danger"
                              disabled={!canDecide || busyKey === rowKey(item)}
                              onClick={() => void act(item, "reject")}
                            >
                              Rejeitar
                            </Button>
                          </span>
                        </>
                      ) : item.source === PROVIDER_OPERATION_SOURCE ? (
                        // `deepLink` da API é um path /v1 (não navegável):
                        // a fila de provider tem tela própria, então o operador
                        // segue para ela com a operação pré-selecionada.
                        <Link href={`/provider-operations?id=${encodeURIComponent(item.id)}`}>
                          Abrir operações de provider
                        </Link>
                      ) : (
                        <span className="cc-muted">Tratar na fila de origem (deep link: {item.deepLink}).</span>
                      )}
                    </div>
                  </div>
                ))}
              </Card>
            );
          })
        : null}
      {data ? <p className="cc-muted">Política SLA: {data.slaPolicy.ref} (atenção ≥ {data.slaPolicy.warnAfterHours}h, estouro ≥ {data.slaPolicy.breachAfterHours}h).</p> : null}
    </div>
  );
}
