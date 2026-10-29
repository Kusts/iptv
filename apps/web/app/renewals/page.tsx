"use client";

import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell";
import { ConfirmAction, PermissionGate, useRevenueCommand } from "../../components/RevenueOps";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/Badge";
import { Table } from "../../components/ui/Table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../components/ui/States";
import { Field, Input, Select } from "../../components/ui/Input";
import { useApi } from "../../lib/useApi";
import { formatDateTime, formatMinor } from "../../lib/money";
import { useOptionalHasPermission } from "../../lib/auth";
import type { SubscriptionRow } from "../../lib/api";

/**
 * DECISÃO P4a: `/renewals` é página standalone (não aba de `/subscriptions`).
 * Motivo: a superfície combina pedidos de renovação (GET /v1/renewals) com a
 * fila de winback (GET /v1/recovery-tasks) e comandos de expiração/lembrete em
 * lote — composição distinta da página de assinaturas, com filtros e ações
 * próprios. Deep links entre as páginas usam o ID da assinatura.
 */
const READ_PERMISSION = "subscription.read";
const WRITE_PERMISSION = "subscription.write";

interface RenewalOrder {
  id: string;
  orderType: string;
  status: string;
  currency: string;
  netAmountMinor: string;
  cycle: { id: string; cycleNo: number } | null;
  createdAt: string;
  settledAt: string | null;
}

interface RecoveryTask {
  id: string;
  subscriptionId: string;
  cycleId: string | null;
  renewalOrderId: string | null;
  reason: string | null;
  status: string;
  outcome: string | null;
  createdAt: string;
}

export default function RenewalsPage(): React.JSX.Element {
  const hasPermission = useOptionalHasPermission();
  const canRead = hasPermission(READ_PERMISSION);

  const [subscriptionId, setSubscriptionId] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [taskStatus, setTaskStatus] = useState("");

  const subsQuery = useApi<{ subscriptions: SubscriptionRow[] }>(canRead ? "/v1/subscriptions" : null);
  const subscriptions = subsQuery.data?.subscriptions ?? [];

  useEffect(() => {
    if (typeof window !== "undefined") {
      const fromQuery = new URLSearchParams(window.location.search).get("subscriptionId");
      if (fromQuery && fromQuery.trim().length > 0) {
        const trimmed = fromQuery.trim();
        setSubscriptionId(trimmed);
        setQuery(trimmed);
      }
    }
  }, []);

  const handleSelectChange = (id: string): void => {
    setSubscriptionId(id);
    if (id.trim().length > 0) {
      setQuery(id.trim());
    }
  };

  const handleConsult = (): void => {
    const trimmed = subscriptionId.trim();
    setQuery(trimmed.length > 0 ? trimmed : null);
  };

  return (
    <Shell>
      <h1>Renovações</h1>
      <PermissionGate permission={READ_PERMISSION} label="as renovações">
        <div className="cc-form cc-u-mb-4">
          {subscriptions.length > 0 ? (
            <Field label="Assinatura cadastrada">
              <Select
                value={subscriptionId}
                onChange={(e) => handleSelectChange(e.target.value)}
                aria-label="Selecionar assinatura"
              >
                <option value="">Selecione uma assinatura…</option>
                {subscriptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id.slice(0, 8)}… ({s.status}) - plano {s.planId.slice(0, 8)}…
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="ID da assinatura">
            <Input
              value={subscriptionId}
              onChange={(e) => setSubscriptionId(e.target.value)}
              placeholder="UUID da assinatura"
            />
          </Field>
          <div className="cc-row cc-u-mt-2">
            <Button variant="secondary" onClick={handleConsult}>
              Consultar renovações
            </Button>
            {subsQuery.loading ? <span className="cc-muted">Carregando assinaturas…</span> : null}
          </div>
        </div>
        {query === null ? (
          <EmptyState title="Informe uma assinatura" hint="Pedidos de renovação, lembretes e winback aparecem aqui." />
        ) : (
          <div key={query}>
            <RenewalOrdersPanel subscriptionId={query} />
            <RecoveryTasksPanel subscriptionId={query} status={taskStatus} onStatusChange={setTaskStatus} />
          </div>
        )}
      </PermissionGate>
    </Shell>
  );
}

function RenewalOrdersPanel({ subscriptionId }: { subscriptionId: string }): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ orders: RenewalOrder[] }>(
    `/v1/renewals?subscriptionId=${encodeURIComponent(subscriptionId)}`,
  );
  const { busy, run } = useRevenueCommand();
  const [dialog, setDialog] = useState<{ path: string; title: string; label: string; body: unknown } | null>(null);
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  const orders = data?.orders ?? [];

  const command = (path: string, title: string, label: string, body: unknown): void => {
    setDialog({ path, title, label, body });
  };

  return (
    <div>
      <div className="cc-row cc-u-mb-4">
        <Button variant="secondary" onClick={reload}>
          Recarregar
        </Button>
        {canWrite ? (
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void run("/v1/renewals/reminders-due", {}, "Lembretes vencidos processados.", reload)}
            >
              Processar lembretes
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void run("/v1/renewals/expire-overdue-due", {}, "Expiração de vencidos processada.", reload)}
            >
              Expirar vencidos
            </Button>
          </>
        ) : null}
      </div>
      {loading ? <LoadingSkeleton lines={4} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && orders.length === 0 ? (
        <EmptyState title="Nenhum pedido de renovação" hint="Renovações cotadas e ativadas para esta assinatura aparecem aqui." />
      ) : null}
      {orders.length > 0 ? (
        <Table
          columns={[
            { header: "Status", render: (o) => <StatusPill status={o.status} /> },
            { header: "Valor", render: (o) => formatMinor(o.netAmountMinor, o.currency) },
            { header: "Ciclo", render: (o) => (o.cycle ? `#${o.cycle.cycleNo}` : "—") },
            { header: "Criado em", render: (o) => formatDateTime(o.createdAt) },
          ]}
          rows={orders}
        />
      ) : null}
      {canWrite ? (
        <Card title="Ações de renovação">
          <div className="cc-row cc-u-mt-2">
            <Button variant="secondary" disabled={busy} onClick={() => command("/v1/renewals/quote", "Cotar renovação", "Cotar", { subscriptionId })}>
              Cotar
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => command("/v1/renewals/renew", "Renovar assinatura", "Renovar", { subscriptionId })}>
              Renovar
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => command("/v1/renewals/trust-renew", "Renovação de confiança", "Trust renew", { subscriptionId })}>
              Trust renew
            </Button>
          </div>
        </Card>
      ) : (
        <p className="cc-muted">Você não tem a permissão subscription.write; ações de renovação ficam indisponíveis.</p>
      )}
      <ConfirmAction
        title={dialog?.title ?? ""}
        open={dialog !== null}
        confirmLabel={dialog?.label ?? "Confirmar"}
        busy={busy}
        onClose={() => setDialog(null)}
        onConfirm={() => {
          if (dialog) void run(dialog.path, dialog.body, "Comando de renovação enviado.", () => { setDialog(null); reload(); });
        }}
      >
        <p className="cc-muted">O servidor cota, valida e audita antes de aplicar. Confirme para enviar.</p>
      </ConfirmAction>
    </div>
  );
}

function RecoveryTasksPanel({
  subscriptionId,
  status,
  onStatusChange,
}: {
  subscriptionId: string;
  status: string;
  onStatusChange: (s: string) => void;
}): React.JSX.Element {
  const statusQs = status.length > 0 ? `&status=${encodeURIComponent(status)}` : "";
  const { data, error, loading, reload } = useApi<{ tasks: RecoveryTask[] }>(
    `/v1/recovery-tasks?subscriptionId=${encodeURIComponent(subscriptionId)}${statusQs}`,
  );
  const { busy, run } = useRevenueCommand();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  const tasks = data?.tasks ?? [];

  return (
    <div className="cc-u-mt-4">
      <h3>Winback (tarefas de recuperação)</h3>
      <div className="cc-row cc-u-mb-4">
        <label className="cc-muted" htmlFor="recovery-status">
          Status:
        </label>
        <Select id="recovery-status" value={status} onChange={(e) => onStatusChange(e.target.value)} className="cc-u-maxw-240">
          <option value="">Todos</option>
          <option value="OPEN">OPEN</option>
          <option value="RESOLVED">RESOLVED</option>
        </Select>
      </div>
      {loading ? <LoadingSkeleton lines={4} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && tasks.length === 0 ? (
        <EmptyState title="Nenhuma tarefa de recuperação" hint="Tarefas de winback abertas para esta assinatura aparecem aqui." />
      ) : null}
      {tasks.length > 0 ? (
        <Table
          columns={[
            { header: "Status", render: (t) => <StatusPill status={t.status} /> },
            { header: "Motivo", render: (t) => (t.reason ?? "—").slice(0, 80) },
            { header: "Resultado", render: (t) => t.outcome ?? "—" },
            { header: "Criada em", render: (t) => formatDateTime(t.createdAt) },
            {
              header: "Ações",
              render: (t) =>
                canWrite ? (
                  <Button variant="secondary" disabled={busy} onClick={() => setSelectedId(t.id)}>
                    Resolver
                  </Button>
                ) : (
                  <span className="cc-muted">—</span>
                ),
            },
          ]}
          rows={tasks}
        />
      ) : null}
      <ConfirmAction title="Resolver tarefa de recuperação" open={canWrite && selectedId !== null} confirmLabel="Confirmar resolução" busy={busy} onClose={() => setSelectedId(null)} onConfirm={() => {
        if (selectedId) void run(`/v1/recovery-tasks/${selectedId}/resolve`, {}, "Tarefa de recuperação resolvida.", () => { setSelectedId(null); reload(); });
      }}>
        <p className="cc-muted">Marca a tarefa de winback como trabalhada pelo operador. Confirme para enviar.</p>
      </ConfirmAction>
    </div>
  );
}
