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
import { formatDateTime, formatMinor } from "../../lib/money";
import { useOptionalHasPermission } from "../../lib/auth";

const READ_PERMISSION = "trial.read";
const TRIAL_WRITE = "trial.write";
const PROVIDER_READ = "provider.operation.read";
const PROVIDER_WRITE = "provider.operation.write";
const PROCUREMENT_WRITE = "commerce.order.write";

interface AppTrialRow {
  id: string;
  personId: string;
  customerId: string | null;
  supplierId: string;
  supplierAppExternalId: string | null;
  status: string;
  requestedAt: string;
  validatedAt: string | null;
  expiresAt: string | null;
}

interface ReconciliationFinding {
  id: string;
  entityType: string;
  entityId: string;
  expected: string | null;
  observed: string | null;
  status: string;
  resolutionRef: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface SupplierBalance {
  supplierId: string;
  balanceMinor: string;
  currency: string;
  observedAt: string;
  evidenceRef: string | null;
  snapshotId: string;
}

export default function InventoryPage(): React.JSX.Element {
  const [tab, setTab] = useState<"trials" | "findings">("trials");

  return (
    <Shell>
      <h1>Inventário (apps/MK)</h1>
      <PermissionGate permission={READ_PERMISSION} label="o inventário">
        <div className="cc-row" style={{ marginBottom: "1rem" }}>
          <Button variant={tab === "trials" ? "primary" : "secondary"} onClick={() => setTab("trials")}>
            App trials
          </Button>
          <Button variant={tab === "findings" ? "primary" : "secondary"} onClick={() => setTab("findings")}>
            Reconciliação
          </Button>
        </div>
        {tab === "trials" ? <AppTrialsSection /> : <FindingsSection />}
        <SupplierBalancePanel />
        <ProcurementPanel />
      </PermissionGate>
    </Shell>
  );
}

function AppTrialsSection(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ items: AppTrialRow[] }>("/v1/inventory/app-trials");
  const { busy, run } = useRevenueCommand();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(TRIAL_WRITE);

  const items = data?.items ?? [];

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
            onClick={() => void run("/v1/inventory/app-trials/expire-due", {}, "Expiração de app trials solicitada.", reload)}
          >
            Expirar vencidos
          </Button>
        ) : null}
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && items.length === 0 ? (
        <EmptyState title="Nenhum app trial" hint="Trials de aplicativo de fornecedor aparecem aqui." />
      ) : null}
      {items.length > 0 ? (
        <Table
          columns={[
            { header: "Status", render: (t) => <StatusPill status={t.status} /> },
            { header: "Fornecedor", render: (t) => <span className="cc-mono">{t.supplierId.slice(0, 8)}</span> },
            { header: "Solicitado em", render: (t) => formatDateTime(t.requestedAt) },
            { header: "Expira em", render: (t) => formatDateTime(t.expiresAt) },
            {
              header: "Ações",
              render: (t) =>
                canWrite ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setSelectedId(t.id);
                      setDialogOpen(true);
                    }}
                  >
                    Validar
                  </Button>
                ) : (
                  <span className="cc-muted">—</span>
                ),
            },
          ]}
          rows={items}
        />
      ) : null}
      <ConfirmAction title="Validar app trial" open={dialogOpen && selectedId !== null} confirmLabel="Confirmar validação" busy={busy} onClose={() => { setDialogOpen(false); setSelectedId(null); }} onConfirm={() => {
        if (selectedId) void run(`/v1/inventory/app-trials/${selectedId}/validate`, {}, "App trial validado.", () => { setDialogOpen(false); setSelectedId(null); reload(); });
      }}>
        <p className="cc-muted">O servidor valida estado e janela antes de aplicar. Confirme para enviar.</p>
      </ConfirmAction>
    </div>
  );
}

function FindingsSection(): React.JSX.Element {
  const gate = useOptionalHasPermission();
  const { data, error, loading, reload } = useApi<{ items: ReconciliationFinding[] }>(
    gate(PROVIDER_READ) ? "/v1/reconciliation-findings" : null,
  );
  const items = data?.items ?? [];

  if (!gate(PROVIDER_READ)) {
    return (
      <EmptyState
        title="Sem permissão para achados de reconciliação"
        hint="Esta seção exige a permissão provider.operation.read do seu perfil neste tenant."
      />
    );
  }

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <Button variant="secondary" onClick={reload}>
          Recarregar
        </Button>
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && items.length === 0 ? (
        <EmptyState title="Nenhum achado" hint="Divergências entre esperado e observado aparecem aqui." />
      ) : null}
      {items.length > 0 ? (
        <Table
          columns={[
            { header: "Entidade", render: (f) => <span className="cc-mono">{f.entityType}</span> },
            { header: "Status", render: (f) => <StatusPill status={f.status} /> },
            { header: "Criado em", render: (f) => formatDateTime(f.createdAt) },
          ]}
          rows={items}
        />
      ) : null}
    </div>
  );
}

function SupplierBalancePanel(): React.JSX.Element {
  const gate = useOptionalHasPermission();
  const { busy, run } = useRevenueCommand();
  const [supplierId, setSupplierId] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const { data, error, loading, reload } = useApi<SupplierBalance>(
    gate(PROVIDER_READ) && query !== null ? `/v1/inventory/supplier-balance?supplierId=${encodeURIComponent(query)}` : null,
  );

  if (!gate(PROVIDER_READ)) return <></>;

  return (
    <Card title="Saldo do fornecedor">
      <div className="cc-form">
        <Field label="ID do fornecedor">
          <Input value={supplierId} onChange={(e) => setSupplierId(e.target.value)} placeholder="UUID do fornecedor" />
        </Field>
        <div className="cc-row">
          <Button variant="secondary" onClick={() => setQuery(supplierId.trim().length > 0 ? supplierId.trim() : null)}>
            Consultar saldo
          </Button>
          {gate(PROVIDER_WRITE) ? (
            <Button
              variant="secondary"
              disabled={busy || supplierId.trim().length === 0}
              onClick={() => void run("/v1/inventory/supplier-balance/refreshes", { supplierId: supplierId.trim() }, "Atualização de saldo solicitada.", reload)}
            >
              Solicitar atualização
            </Button>
          ) : null}
        </div>
      </div>
      {loading ? <LoadingSkeleton lines={2} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data !== null ? (
        <p>
          Saldo: <strong>{formatMinor(data.balanceMinor, data.currency)}</strong>{" "}
          <span className="cc-muted">observado em {formatDateTime(data.observedAt)}</span>
        </p>
      ) : null}
    </Card>
  );
}

function ProcurementPanel(): React.JSX.Element {
  const gate = useOptionalHasPermission();
  const { busy, run } = useRevenueCommand();
  const [licenseId, setLicenseId] = useState("");
  const [reservationId, setReservationId] = useState("");

  if (!gate(PROCUREMENT_WRITE) && !gate(PROVIDER_WRITE)) return <></>;

  return (
    <Card title="Compras e licenças">
      {gate(PROVIDER_WRITE) ? (
        <div className="cc-form">
          <Field label="ID da licença">
            <Input value={licenseId} onChange={(e) => setLicenseId(e.target.value)} placeholder="UUID da licença" />
          </Field>
          <div className="cc-row">
            <Button
              variant="secondary"
              disabled={busy || licenseId.trim().length === 0}
              onClick={() => void run(`/v1/licenses/${licenseId.trim()}/activate`, {}, "Ativação de licença enviada.", () => setLicenseId(""))}
            >
              Ativar licença
            </Button>
            <Button
              variant="secondary"
              disabled={busy || licenseId.trim().length === 0}
              onClick={() => void run(`/v1/licenses/${licenseId.trim()}/reconcile`, {}, "Reconciliação de compra enviada.", () => setLicenseId(""))}
            >
              Conciliar compra
            </Button>
          </div>
        </div>
      ) : null}
      {gate(PROCUREMENT_WRITE) ? (
        <div className="cc-form" style={{ marginTop: "0.75rem" }}>
          <Field label="ID da reserva de crédito">
            <Input value={reservationId} onChange={(e) => setReservationId(e.target.value)} placeholder="UUID da reserva" />
          </Field>
          <Button
            variant="secondary"
            disabled={busy || reservationId.trim().length === 0}
            onClick={() => void run(`/v1/inventory/credit-reservations/${reservationId.trim()}/release`, {}, "Reserva de crédito liberada.", () => setReservationId(""))}
          >
            Liberar reserva
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
