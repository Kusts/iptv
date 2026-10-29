"use client";

import { useState } from "react";
import { Shell } from "../../components/Shell";
import { ConfirmAction, PermissionGate, useRevenueCommand } from "../../components/RevenueOps";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/Badge";
import { Table } from "../../components/ui/Table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../components/ui/States";
import { Field, Input } from "../../components/ui/Input";
import { useApi } from "../../lib/useApi";
import { formatDateTime } from "../../lib/money";
import { useOptionalHasPermission } from "../../lib/auth";
import type { SubscriptionRow } from "../../lib/api";

const READ_PERMISSION = "subscription.read";
const WRITE_PERMISSION = "subscription.write";

interface FulfillmentStatus {
  operationId: string;
  action: string;
  status: string;
  effectCertainty: string;
  requestedAt: string;
}

export default function FulfillmentPage(): React.JSX.Element {
  const [subscriptionId, setSubscriptionId] = useState("");
  const [query, setQuery] = useState<string | null>(null);

  const pendingQuery = useApi<{ subscriptions: SubscriptionRow[] }>(
    "/v1/subscriptions?status=PENDING_ACTIVATION",
  );
  const pendingSubscriptions = pendingQuery.data?.subscriptions ?? [];

  const handleSelectPending = (id: string): void => {
    setSubscriptionId(id);
    setQuery(id);
  };

  return (
    <Shell>
      <h1>Ativação (fulfillment)</h1>
      <PermissionGate permission={READ_PERMISSION} label="o fulfillment">
        <div className="cc-u-mb-4">
          <div className="cc-row cc-u-mb-2" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <h3>Fila de ativações pendentes</h3>
            {pendingQuery.data ? (
              <Button variant="secondary" onClick={pendingQuery.reload}>
                Atualizar fila
              </Button>
            ) : null}
          </div>
          {pendingQuery.loading ? <LoadingSkeleton lines={3} /> : null}
          {pendingQuery.data && pendingSubscriptions.length === 0 ? (
            <p className="cc-muted">Nenhuma assinatura aguardando ativação no momento.</p>
          ) : null}
          {pendingSubscriptions.length > 0 ? (
            <Table
              columns={[
                {
                  header: "Assinatura",
                  render: (s) => <span className="cc-mono">{s.id.slice(0, 8)}…</span>,
                },
                {
                  header: "Plano",
                  render: (s) => <span className="cc-mono">{s.planId.slice(0, 8)}…</span>,
                },
                {
                  header: "Status",
                  render: (s) => <StatusPill status={s.status} />,
                },
                {
                  header: "Ações",
                  render: (s) => (
                    <Button
                      variant={query === s.id ? "primary" : "secondary"}
                      onClick={() => handleSelectPending(s.id)}
                    >
                      {query === s.id ? "Selecionada" : "Ativar / Inspecionar"}
                    </Button>
                  ),
                },
              ]}
              rows={pendingSubscriptions}
            />
          ) : null}
        </div>

        <h3>Consulta manual</h3>
        <div className="cc-form cc-u-mb-4">
          <Field label="ID da assinatura">
            <Input
              value={subscriptionId}
              onChange={(e) => setSubscriptionId(e.target.value)}
              placeholder="UUID da assinatura"
            />
          </Field>
          <Button
            variant="secondary"
            onClick={() => setQuery(subscriptionId.trim().length > 0 ? subscriptionId.trim() : null)}
          >
            Consultar estado
          </Button>
        </div>
        {query === null ? (
          <EmptyState
            title="Informe uma assinatura"
            hint="O estado de provisionamento e o fallback manual aparecem aqui."
          />
        ) : (
          <FulfillmentPanel
            key={query}
            id={query}
            onOperationTriggered={() => pendingQuery.refresh()}
          />
        )}
      </PermissionGate>
    </Shell>
  );
}

function FulfillmentPanel({
  id,
  onOperationTriggered,
}: {
  id: string;
  onOperationTriggered?: () => void;
}): React.JSX.Element {
  const { data, error, loading, reload } = useApi<FulfillmentStatus>(`/v1/fulfillment/subscriptions/${id}`);
  const { busy, run } = useRevenueCommand();
  const [dialogOpen, setDialogOpen] = useState(false);
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  const request = (): void => {
    void run(`/v1/fulfillment/subscriptions/${id}/request`, {}, "Provisionamento solicitado.", () => {
      setDialogOpen(false);
      reload();
      onOperationTriggered?.();
    });
  };

  return (
    <div>
      {loading ? <LoadingSkeleton lines={4} /> : null}
      {error !== null ? (
        <div>
          <ErrorState message={error} onRetry={reload} />
          {canWrite ? (
            <Card title="Sem operação de fulfillment">
              <p className="cc-muted">Nenhuma operação de provedor para esta assinatura. Solicite o provisionamento.</p>
              <div className="cc-row cc-u-mt-3">
                <Button disabled={busy} onClick={() => setDialogOpen(true)}>
                  Solicitar provisionamento
                </Button>
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}
      {data !== null ? (
        <Card title="Estado do provisionamento">
          <p className="cc-mono">{data.operationId}</p>
          <div className="cc-row">
            <StatusPill status={data.status} />
            <span className="cc-mono">{data.action}</span>
            <span className="cc-muted">certeza: {data.effectCertainty}</span>
          </div>
          <p className="cc-muted">Solicitada em {formatDateTime(data.requestedAt)}</p>
          <p className="cc-muted">
            Resolução e reconciliação da operação resultante ficam na superfície de Operações de Provider.
          </p>
          {canWrite ? (
            <div className="cc-row cc-u-mt-3">
              <Button variant="secondary" disabled={busy} onClick={() => setDialogOpen(true)}>
                Solicitar novamente (fallback manual)
              </Button>
            </div>
          ) : (
            <p className="cc-muted">Você não tem a permissão subscription.write; novas solicitações ficam indisponíveis.</p>
          )}
        </Card>
      ) : null}
      <ConfirmAction
        title="Solicitar provisionamento"
        open={dialogOpen}
        confirmLabel="Confirmar solicitação"
        busy={busy}
        onClose={() => setDialogOpen(false)}
        onConfirm={request}
      >
        <p className="cc-muted">Cria trabalho de provedor para uma assinatura pendente de ativação. Confirme para enviar.</p>
      </ConfirmAction>
    </div>
  );
}
