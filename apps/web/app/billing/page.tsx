"use client";

import { useState } from "react";
import { Shell } from "../../components/Shell";
import { ConfirmAction, PermissionGate, useRevenueCommand } from "../../components/RevenueOps";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/Badge";
import { Table } from "../../components/ui/Table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../components/ui/States";
import { Field, Select, Textarea } from "../../components/ui/Input";
import { useApi } from "../../lib/useApi";
import { formatDateTime, formatMinor } from "../../lib/money";
import { useOptionalHasPermission } from "../../lib/auth";

const READ_PERMISSION = "billing.read";
const CHARGE_WRITE = "billing.charge.write";
const REFUND_EXECUTE = "billing.refund.execute";
const EXCEPTION_RESOLVE = "billing.exception.resolve";

interface ChargeRow {
  id: string;
  order_id: string;
  status: string;
  amount_minor: string | number;
  currency: string;
  payment_method: string | null;
  created_at: string;
  paid_at: string | null;
}

interface PaymentRow {
  id: string;
  order_id: string;
  charge_id: string | null;
  status: string;
  amount_minor: string | number;
  currency: string;
  confirmed_at: string | null;
}

interface RefundRequestRow {
  id: string;
  payment_id: string;
  status: string;
  amount_minor: string | number;
  currency: string;
  requested_at: string;
  decided_at: string | null;
  executed_at: string | null;
}

interface BillingExceptionRow {
  id: string;
  kind: string;
  status: string;
  charge_id: string | null;
  payment_id: string | null;
  refund_id: string | null;
  reason: string | null;
  created_at: string;
}

type Tab = "charges" | "payments" | "refunds" | "exceptions";

export default function BillingPage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("charges");

  return (
    <Shell>
      <h1>Cobrança</h1>
      <PermissionGate permission={READ_PERMISSION} label="a cobrança">
        <div className="cc-row" style={{ marginBottom: "1rem" }}>
          <Button variant={tab === "charges" ? "primary" : "secondary"} onClick={() => setTab("charges")}>
            Cobranças
          </Button>
          <Button variant={tab === "payments" ? "primary" : "secondary"} onClick={() => setTab("payments")}>
            Pagamentos
          </Button>
          <Button variant={tab === "refunds" ? "primary" : "secondary"} onClick={() => setTab("refunds")}>
            Reembolsos
          </Button>
          <Button variant={tab === "exceptions" ? "primary" : "secondary"} onClick={() => setTab("exceptions")}>
            Exceções
          </Button>
        </div>
        {tab === "charges" ? <ChargesSection /> : null}
        {tab === "payments" ? <PaymentsSection /> : null}
        {tab === "refunds" ? <RefundsSection /> : null}
        {tab === "exceptions" ? <ExceptionsSection /> : null}
      </PermissionGate>
    </Shell>
  );
}

function ChargesSection(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ charges: ChargeRow[] }>("/v1/charges");
  const { busy, run } = useRevenueCommand();
  const [dialog, setDialog] = useState<{ path: string; title: string; label: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(CHARGE_WRITE);

  const charges = data?.charges ?? [];

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <Button variant="secondary" onClick={reload}>
          Recarregar
        </Button>
        {canWrite ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void run("/v1/charges/expire-due", {}, "Expiração de cobranças vencidas solicitada.", reload)}
          >
            Expirar vencidas
          </Button>
        ) : null}
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && charges.length === 0 ? (
        <EmptyState title="Nenhuma cobrança" hint="Cobranças criadas para pedidos aparecem aqui." />
      ) : null}
      {charges.length > 0 ? (
        <Table
          columns={[
            { header: "Status", render: (c) => <StatusPill status={c.status} /> },
            { header: "Valor", render: (c) => formatMinor(c.amount_minor, c.currency) },
            { header: "Método", render: (c) => c.payment_method ?? "—" },
            { header: "Criada em", render: (c) => formatDateTime(c.created_at) },
            {
              header: "Ações",
              render: (c) => (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSelectedId(c.id);
                    setDialog({ path: `/v1/charges/${c.id}/reconcile`, title: "Conciliar cobrança", label: "Conciliar" });
                  }}
                >
                  Conciliar
                </Button>
              ),
            },
          ]}
          rows={charges}
        />
      ) : null}
      {canWrite && selectedId ? (
        <Card title="Ações da cobrança">
          <p className="cc-mono">{selectedId}</p>
          <div className="cc-row" style={{ marginTop: "0.5rem" }}>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setDialog({ path: `/v1/charges/${selectedId}/reconcile`, title: "Conciliar cobrança", label: "Conciliar" })}
            >
              Conciliar
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => setDialog({ path: `/v1/charges/${selectedId}/cancel`, title: "Cancelar cobrança", label: "Cancelar" })}
            >
              Cancelar
            </Button>
          </div>
        </Card>
      ) : null}
      {!canWrite ? (
        <p className="cc-muted">Você não tem a permissão billing.charge.write; conciliação e cancelamento ficam indisponíveis.</p>
      ) : null}
      <ConfirmAction
        title={dialog?.title ?? ""}
        open={dialog !== null}
        confirmLabel={dialog?.label ?? "Confirmar"}
        busy={busy}
        onClose={() => setDialog(null)}
        onConfirm={() => {
          if (dialog) void run(dialog.path, {}, "Comando de cobrança enviado.", () => { setDialog(null); reload(); });
        }}
      >
        <p className="cc-muted">O servidor valida estado e idempotência antes de aplicar. Confirme para enviar.</p>
      </ConfirmAction>
    </div>
  );
}

function PaymentsSection(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ payments: PaymentRow[] }>("/v1/payments");
  const payments = data?.payments ?? [];

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <Button variant="secondary" onClick={reload}>
          Recarregar
        </Button>
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && payments.length === 0 ? (
        <EmptyState title="Nenhum pagamento" hint="Pagamentos confirmados via webhook aparecem aqui." />
      ) : null}
      {payments.length > 0 ? (
        <Table
          columns={[
            { header: "Status", render: (p) => <StatusPill status={p.status} /> },
            { header: "Valor", render: (p) => formatMinor(p.amount_minor, p.currency) },
            { header: "Confirmado em", render: (p) => formatDateTime(p.confirmed_at) },
          ]}
          rows={payments}
        />
      ) : null}
    </div>
  );
}

function RefundsSection(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ refund_requests: RefundRequestRow[] }>("/v1/refund-requests");
  const { busy, run } = useRevenueCommand();
  const [dialog, setDialog] = useState<{ id: string; kind: "execute" | "reconcile" } | null>(null);
  const hasPermission = useOptionalHasPermission();
  const canExecute = hasPermission(REFUND_EXECUTE);

  const rows = data?.refund_requests ?? [];

  const confirm = (): void => {
    if (!dialog) return;
    const path =
      dialog.kind === "execute" ? `/v1/refund-requests/${dialog.id}/execute` : `/v1/refunds/${dialog.id}/reconcile`;
    void run(path, {}, dialog.kind === "execute" ? "Execução de reembolso enviada." : "Conciliação de reembolso enviada.", () => {
      setDialog(null);
      reload();
    });
  };

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <Button variant="secondary" onClick={reload}>
          Recarregar
        </Button>
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && rows.length === 0 ? (
        <EmptyState title="Nenhuma solicitação de reembolso" hint="Pedidos de reembolso do operador aparecem aqui." />
      ) : null}
      {rows.length > 0 ? (
        <Table
          columns={[
            { header: "Status", render: (r) => <StatusPill status={r.status} /> },
            { header: "Valor", render: (r) => formatMinor(r.amount_minor, r.currency) },
            { header: "Solicitado em", render: (r) => formatDateTime(r.requested_at) },
            {
              header: "Ações",
              render: (r) =>
                canExecute ? (
                  <Button variant="secondary" disabled={busy} onClick={() => setDialog({ id: r.id, kind: "execute" })}>
                    Executar
                  </Button>
                ) : (
                  <span className="cc-muted">—</span>
                ),
            },
          ]}
          rows={rows}
        />
      ) : null}
      {!canExecute ? (
        <p className="cc-muted">Você não tem a permissão billing.refund.execute; execução e conciliação ficam indisponíveis.</p>
      ) : null}
      <ConfirmAction
        title={dialog?.kind === "execute" ? "Executar reembolso aprovado" : "Conciliar reembolso"}
        open={dialog !== null}
        confirmLabel="Confirmar"
        busy={busy}
        onClose={() => setDialog(null)}
        onConfirm={confirm}
      >
        <p className="cc-muted">A execução de reembolso permanece com gate humano no servidor. Confirme para enviar.</p>
      </ConfirmAction>
    </div>
  );
}

function ExceptionsSection(): React.JSX.Element {
  const [status, setStatus] = useState("");
  const qs = status.length > 0 ? `/v1/billing-exceptions?status=${encodeURIComponent(status)}` : "/v1/billing-exceptions";
  const { data, error, loading, reload } = useApi<{ exceptions: BillingExceptionRow[] }>(qs);
  const { busy, run } = useRevenueCommand();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");
  const hasPermission = useOptionalHasPermission();
  const canResolve = hasPermission(EXCEPTION_RESOLVE);

  const rows = data?.exceptions ?? [];

  const confirm = (): void => {
    if (!selectedId) return;
    void run(
      `/v1/billing-exceptions/${selectedId}/resolve`,
      { ...(resolution.trim().length > 0 ? { resolution: resolution.trim() } : {}) },
      "Exceção de cobrança resolvida.",
      () => {
        setSelectedId(null);
        setResolution("");
        reload();
      },
    );
  };

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <label className="cc-muted" htmlFor="billing-exception-status">
          Status:
        </label>
        <Select id="billing-exception-status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: "240px" }}>
          <option value="">Todos</option>
          <option value="OPEN">OPEN</option>
          <option value="RESOLVED">RESOLVED</option>
        </Select>
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && rows.length === 0 ? (
        <EmptyState title="Nenhuma exceção" hint="Exceções de cobrança e reconciliação aparecem aqui." />
      ) : null}
      {rows.length > 0 ? (
        <Table
          columns={[
            { header: "Tipo", render: (e) => <span className="cc-mono">{e.kind}</span> },
            { header: "Status", render: (e) => <StatusPill status={e.status} /> },
            { header: "Motivo", render: (e) => (e.reason ?? "—").slice(0, 80) },
            { header: "Criada em", render: (e) => formatDateTime(e.created_at) },
            {
              header: "Ações",
              render: (e) =>
                canResolve ? (
                  <Button variant="secondary" onClick={() => setSelectedId(e.id)}>
                    Resolver
                  </Button>
                ) : (
                  <span className="cc-muted">—</span>
                ),
            },
          ]}
          rows={rows}
        />
      ) : null}
      {!canResolve ? (
        <p className="cc-muted">Você não tem a permissão billing.exception.resolve; resoluções ficam indisponíveis.</p>
      ) : null}
      <ConfirmAction title="Resolver exceção" open={canResolve && selectedId !== null} confirmLabel="Confirmar resolução" busy={busy} onClose={() => { setSelectedId(null); setResolution(""); }} onConfirm={confirm}>
        <Field label="Resolução (opcional)">
          <Textarea value={resolution} onChange={(e) => setResolution(e.target.value)} rows={3} disabled={busy} />
        </Field>
      </ConfirmAction>
    </div>
  );
}
