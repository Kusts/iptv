"use client";

import { useState } from "react";
import { Shell } from "../../components/Shell";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/Badge";
import { Table } from "../../components/ui/Table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../components/ui/States";
import { useApi } from "../../lib/useApi";
import { formatDateTime } from "../../lib/money";
import { userMessage, api } from "../../lib/api";
import type { SubscriptionDetail, SubscriptionRow } from "../../lib/api";

export default function SubscriptionsPage(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ subscriptions: SubscriptionRow[] }>("/v1/subscriptions");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <Shell>
      <h1>Assinaturas</h1>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && data.subscriptions.length === 0 ? (
        <EmptyState title="Nenhuma assinatura" hint="Assinaturas ativadas a partir de pedidos aparecem aqui." />
      ) : null}
      {data && data.subscriptions.length > 0 ? (
        <div className="cc-grid-2">
          <Table
            columns={[
              { header: "Plano", render: (s) => <span className="cc-mono">{s.planId.slice(0, 8)}</span> },
              { header: "Status", render: (s) => <StatusPill status={s.status} /> },
              { header: "Projeção", render: (s) => <StatusPill status={s.projectedState} /> },
              { header: "Fim do período", render: (s) => formatDateTime(s.currentPeriodEnd) },
              {
                header: "Ações",
                render: (s) => (
                  <Button variant="secondary" onClick={() => setSelectedId(s.id)}>
                    Detalhe
                  </Button>
                ),
              },
            ]}
            rows={data.subscriptions}
          />
          {selectedId ? (
            <SubscriptionDetailPanel key={selectedId} id={selectedId} />
          ) : (
            <EmptyState title="Selecione uma assinatura" hint="Ciclos e direitos aparecem ao lado." />
          )}
        </div>
      ) : null}
    </Shell>
  );
}

function SubscriptionDetailPanel({ id }: { id: string }): React.JSX.Element {
  const { data, error, loading, reload } = useApi<SubscriptionDetail>(`/v1/subscriptions/${id}`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const command = async (path: string, ok: string): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      await api.post(path, {});
      setMsg(ok);
      reload();
    } catch (err) {
      setMsg(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingSkeleton lines={4} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <EmptyState title="Assinatura não encontrada" />;
  return (
    <Card title="Detalhe da assinatura">
      <p className="cc-mono">{data.id}</p>
      <div className="cc-row">
        <StatusPill status={data.status} />
        <StatusPill status={data.projectedState} />
        {data.cancelAtPeriodEnd ? <span className="cc-muted">Cancela no fim do período</span> : null}
      </div>
      <h4>Ciclos</h4>
      {data.cycles.length === 0 ? (
        <p className="cc-muted">Sem ciclos.</p>
      ) : (
        <ul>
          {data.cycles.map((c) => (
            <li key={c.id}>
              #{c.cycleNo} <StatusPill status={c.status} /> {formatDateTime(c.startsAt)} → {formatDateTime(c.endsAt)}
            </li>
          ))}
        </ul>
      )}
      <h4>Direitos</h4>
      {data.entitlements.length === 0 ? (
        <p className="cc-muted">Sem direitos vinculados.</p>
      ) : (
        <ul>
          {data.entitlements.map((e) => (
            <li key={e.id}>
              <span className="cc-mono">{e.featureKey}</span> <StatusPill status={e.status} />
            </li>
          ))}
        </ul>
      )}
      <div className="cc-row" style={{ marginTop: "0.75rem" }}>
        <Button variant="secondary" disabled={busy} onClick={() => void command(`/v1/subscriptions/${id}/resume`, "Assinatura retomada.")}>
          Retomar
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => void command(`/v1/subscriptions/${id}/cancel-at-period-end`, "Cancelamento agendado.")}>
          Cancelar no fim do período
        </Button>
      </div>
      {msg ? <p className="cc-muted">{msg}</p> : null}
    </Card>
  );
}
