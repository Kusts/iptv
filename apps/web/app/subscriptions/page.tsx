"use client";

import { useState } from "react";
import Link from "next/link";
import { Shell } from "../../components/Shell";
import { PermissionGate } from "../../components/RevenueOps";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/Badge";
import { Table } from "../../components/ui/Table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../components/ui/States";
import { useToast } from "../../components/ui/Toast";
import { useApi } from "../../lib/useApi";
import { formatDateTime } from "../../lib/money";
import { useOptionalHasPermission } from "../../lib/auth";
import { userMessage, api } from "../../lib/api";
import type { SubscriptionDetail, SubscriptionRow } from "../../lib/api";

const READ_PERMISSION = "subscription.read";
const WRITE_PERMISSION = "subscription.write";

export default function SubscriptionsPage(): React.JSX.Element {
  const { data, error, loading, reload, refresh } = useApi<{ subscriptions: SubscriptionRow[] }>("/v1/subscriptions");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <Shell>
      <div className="cc-row cc-u-mb-4" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h1>Assinaturas</h1>
        <Button variant="secondary" onClick={reload}>
          Recarregar
        </Button>
      </div>
      <PermissionGate permission={READ_PERMISSION} label="as assinaturas">
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
              <SubscriptionDetailPanel key={selectedId} id={selectedId} onMutated={refresh} />
            ) : (
              <EmptyState title="Selecione uma assinatura" hint="Ciclos e direitos aparecem ao lado." />
            )}
          </div>
        ) : null}
      </PermissionGate>
    </Shell>
  );
}

function SubscriptionDetailPanel({ id, onMutated }: { id: string; onMutated?: () => void }): React.JSX.Element {
  const { data, error, loading, reload, refresh } = useApi<SubscriptionDetail>(`/v1/subscriptions/${id}`);
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  const command = async (path: string, ok: string): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      await api.post(path, {});
      setMsg(ok);
      push(ok);
      refresh();
      onMutated?.();
    } catch (err) {
      const errText = userMessage(err);
      setMsg(errText);
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
      {data.status === "PENDING_ACTIVATION" ? (
        <div className="cc-card cc-u-mt-3" style={{ padding: "0.75rem" }}>
          <p>
            <strong>Aguardando ativação:</strong> Esta assinatura ainda não foi provisionada no provedor.
          </p>
          <p>
            <Link href="/fulfillment">Ir para /fulfillment</Link> para solicitar o provisionamento.
          </p>
        </div>
      ) : null}
      {data.originatingOrderId ? (
        <p className="cc-muted cc-u-mt-2">
          Pedido de origem: <Link href="/orders"><span className="cc-mono">{data.originatingOrderId.slice(0, 8)}…</span></Link>
        </p>
      ) : null}
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
      {canWrite ? (
        <div className="cc-row cc-u-mt-3">
          <Button variant="secondary" disabled={busy} onClick={() => void command(`/v1/subscriptions/${id}/resume`, "Assinatura retomada.")}>
            Retomar
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void command(`/v1/subscriptions/${id}/cancel-at-period-end`, "Cancelamento agendado.")}>
            Cancelar no fim do período
          </Button>
        </div>
      ) : (
        <p className="cc-muted cc-u-mt-3">Você não tem a permissão subscription.write; ações ficam indisponíveis.</p>
      )}
      {msg ? <p className="cc-muted cc-u-mt-2">{msg}</p> : null}
    </Card>
  );
}
