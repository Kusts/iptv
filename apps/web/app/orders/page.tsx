"use client";

import { useState } from "react";
import { Shell } from "../../components/Shell";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/Badge";
import { Table } from "../../components/ui/Table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../components/ui/States";
import { useApi } from "../../lib/useApi";
import { formatDateTime, formatMinor } from "../../lib/money";
import type { OrderDetail, OrderRow } from "../../lib/api";

function rowAmount(r: OrderRow): string | number {
  return r.netAmountMinor ?? r.net_amount_minor ?? 0;
}

function rowCreated(r: OrderRow): string | null {
  return r.createdAt ?? r.created_at ?? null;
}

export default function OrdersPage(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ orders: OrderRow[] }>("/v1/orders");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <Shell>
      <h1>Pedidos</h1>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && data.orders.length === 0 ? (
        <EmptyState title="Nenhum pedido" hint="Pedidos cotados e submetidos aparecem aqui." />
      ) : null}
      {data && data.orders.length > 0 ? (
        <div className="cc-grid-2">
          <Table
            columns={[
              { header: "Status", render: (o) => <StatusPill status={o.status} /> },
              { header: "Total", render: (o) => formatMinor(rowAmount(o), o.currency) },
              { header: "Criado em", render: (o) => formatDateTime(rowCreated(o)) },
              {
                header: "Ações",
                render: (o) => (
                  <Button variant="secondary" onClick={() => setSelectedId(o.id)}>
                    Detalhe
                  </Button>
                ),
              },
            ]}
            rows={data.orders}
          />
          {selectedId ? <OrderDetailPanel key={selectedId} id={selectedId} /> : <EmptyState title="Selecione um pedido" />}
        </div>
      ) : null}
    </Shell>
  );
}

function OrderDetailPanel({ id }: { id: string }): React.JSX.Element {
  const { data, error, loading, reload } = useApi<OrderDetail>(`/v1/orders/${id}`);
  if (loading) return <LoadingSkeleton lines={4} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <EmptyState title="Pedido não encontrado" />;
  const o = data.order;
  return (
    <Card title="Detalhe do pedido">
      <p className="cc-mono">{o.id}</p>
      <div className="cc-row">
        <StatusPill status={o.status} />
        <strong>{formatMinor(o.net_amount_minor, o.currency)}</strong>
      </div>
      <ul>
        <li>Bruto: {formatMinor(o.gross_amount_minor, o.currency)}</li>
        <li>Desconto: {formatMinor(o.discount_amount_minor, o.currency)}</li>
        <li>Recompensa: {formatMinor(o.reward_amount_minor, o.currency)}</li>
        <li>Liquidado: {formatMinor(o.settled_amount_minor, o.currency)}</li>
      </ul>
      <h4>Itens</h4>
      {data.items.length === 0 ? (
        <p className="cc-muted">Sem itens.</p>
      ) : (
        <ul>
          {data.items.map((i) => (
            <li key={i.id}>
              {i.item_type} × {i.quantity} — {formatMinor(i.net_minor, o.currency)}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
