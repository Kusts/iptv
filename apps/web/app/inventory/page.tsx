"use client";

import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell";
import { ConfirmAction, PermissionGate, useRevenueCommand } from "../../components/RevenueOps";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/Badge";
import { Table } from "../../components/ui/Table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../components/ui/States";
import { Field, Input, Select, Textarea } from "../../components/ui/Input";
import { useApi } from "../../lib/useApi";
import { formatDateTime, formatMinor } from "../../lib/money";
import { useOptionalHasPermission } from "../../lib/auth";

const READ_PERMISSION = "trial.read";
const TRIAL_WRITE = "trial.write";
const CRM_PERSON_READ = "crm.person.read";
const PROVIDER_READ = "provider.operation.read";
const PROVIDER_WRITE = "provider.operation.write";
const PROCUREMENT_WRITE = "commerce.order.write";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PersonRow {
  id: string;
  canonicalName: string | null;
}

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
        <div className="cc-row cc-u-mb-4">
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
  const [statusFilter, setStatusFilter] = useState("");
  const qs = statusFilter.length > 0 ? `/v1/inventory/app-trials?status=${encodeURIComponent(statusFilter)}` : "/v1/inventory/app-trials";
  const { data, error, loading, reload } = useApi<{ items: AppTrialRow[] }>(qs);
  const { busy, run } = useRevenueCommand();
  const [createOpen, setCreateOpen] = useState(false);
  const [validateId, setValidateId] = useState<string | null>(null);
  const [invalidateId, setInvalidateId] = useState<string | null>(null);
  const [invalidateReason, setInvalidateReason] = useState("");
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(TRIAL_WRITE);

  const items = data?.items ?? [];

  return (
    <div>
      <div className="cc-row cc-u-mb-4">
        <Button variant="secondary" onClick={reload}>
          Recarregar
        </Button>
        {canWrite ? (
          <>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              Novo app trial
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void run("/v1/inventory/app-trials/expire-due", {}, "Expiração de app trials solicitada.", reload)}
            >
              Expirar vencidos
            </Button>
          </>
        ) : null}
      </div>
      <div className="cc-row cc-u-mb-4" style={{ alignItems: "center", gap: "0.5rem" }}>
        <label className="cc-muted" htmlFor="app-trial-status-filter">
          Filtrar status:
        </label>
        <Select
          id="app-trial-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="cc-u-maxw-200"
        >
          <option value="">Todos</option>
          <option value="REQUESTED">REQUESTED</option>
          <option value="VALIDATED">VALIDATED</option>
          <option value="INVALIDATED">INVALIDATED</option>
          <option value="EXPIRED">EXPIRED</option>
        </Select>
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
            {
              header: "App External ID",
              render: (t) => (t.supplierAppExternalId ? <span className="cc-mono">{t.supplierAppExternalId}</span> : <span className="cc-muted">—</span>),
            },
            { header: "Solicitado em", render: (t) => formatDateTime(t.requestedAt) },
            { header: "Expira em", render: (t) => formatDateTime(t.expiresAt) },
            {
              header: "Ações",
              render: (t) =>
                canWrite && t.status === "REQUESTED" ? (
                  <div className="cc-row" style={{ gap: "0.5rem" }}>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setValidateId(t.id)}
                    >
                      Validar
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        setInvalidateId(t.id);
                        setInvalidateReason("");
                      }}
                    >
                      Invalidar
                    </Button>
                  </div>
                ) : (
                  <span className="cc-muted">—</span>
                ),
            },
          ]}
          rows={items}
        />
      ) : null}
      {!canWrite ? (
        <p className="cc-muted cc-u-mt-3">Você não tem a permissão trial.write; ações de app trial ficam indisponíveis.</p>
      ) : null}

      <RequestAppTrialDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={() => {
          setCreateOpen(false);
          reload();
        }}
      />

      {/* Diálogo de Validação (preserva exatamente os rótulos originais para total compatibilidade) */}
      <ConfirmAction
        title="Validar app trial"
        open={validateId !== null}
        confirmLabel="Confirmar validação"
        busy={busy}
        onClose={() => setValidateId(null)}
        onConfirm={() => {
          if (validateId) {
            void run(
              `/v1/inventory/app-trials/${validateId}/validate`,
              { outcome: "VALIDATED" },
              "App trial validado.",
              () => {
                setValidateId(null);
                reload();
              },
            );
          }
        }}
      >
        <p className="cc-muted">O servidor valida estado e janela antes de aplicar. Confirme para enviar.</p>
      </ConfirmAction>

      {/* Diálogo de Invalidação */}
      <ConfirmAction
        title="Invalidar app trial"
        open={invalidateId !== null}
        confirmLabel="Confirmar invalidação"
        busy={busy}
        onClose={() => {
          setInvalidateId(null);
          setInvalidateReason("");
        }}
        onConfirm={() => {
          if (invalidateId) {
            void run(
              `/v1/inventory/app-trials/${invalidateId}/validate`,
              {
                outcome: "INVALIDATED",
                ...(invalidateReason.trim().length > 0 ? { reason: invalidateReason.trim() } : {}),
              },
              "App trial invalidado.",
              () => {
                setInvalidateId(null);
                setInvalidateReason("");
                reload();
              },
            );
          }
        }}
      >
        <p className="cc-muted">A invalidação encerra o trial de app do fornecedor com registro auditado.</p>
        <Field label="Motivo da invalidação (opcional)">
          <Textarea
            value={invalidateReason}
            onChange={(e) => setInvalidateReason(e.target.value)}
            rows={2}
            disabled={busy}
            placeholder="Ex.: Falha na ativação externa / teste inconclusivo..."
          />
        </Field>
      </ConfirmAction>
    </div>
  );
}

function RequestAppTrialDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const { busy, run } = useRevenueCommand();
  const hasPermission = useOptionalHasPermission();
  const canListPersons = hasPermission(CRM_PERSON_READ);
  const personsQuery = useApi<{ persons: PersonRow[] }>(canListPersons ? "/v1/crm/persons" : null);
  const persons = personsQuery.data?.persons ?? null;
  const personsAvailable = canListPersons && persons !== null && personsQuery.error === null;
  const personList: PersonRow[] | null = personsAvailable ? persons : null;

  const [personId, setPersonId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [supplierAppExternalId, setSupplierAppExternalId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const showPersonSelect = personList !== null && personList.length > 1;
  const singleAuto = personList !== null && personList.length === 1 ? personList[0] : null;
  const showManualPerson = !personsAvailable || personList === null || personList.length === 0;

  useEffect(() => {
    if (singleAuto) {
      setPersonId(singleAuto.id);
    }
  }, [singleAuto]);

  const confirm = (): void => {
    setFormError(null);
    const targetPersonId = (personId || (singleAuto ? singleAuto.id : "")).trim();
    if (!UUID_RE.test(targetPersonId)) {
      setFormError("Informe um UUID válido para a pessoa.");
      return;
    }
    const trimmedSupplier = supplierId.trim();
    if (!UUID_RE.test(trimmedSupplier)) {
      setFormError("Informe um UUID válido para o fornecedor.");
      return;
    }
    const trimmedAppId = supplierAppExternalId.trim();
    if (trimmedAppId.length === 0) {
      setFormError("Informe o identificador externo do aplicativo.");
      return;
    }

    void run(
      "/v1/inventory/app-trials",
      {
        personId: targetPersonId,
        supplierId: trimmedSupplier,
        supplierAppExternalId: trimmedAppId,
      },
      "App trial solicitado com sucesso.",
      () => {
        setPersonId("");
        setSupplierId("");
        setSupplierAppExternalId("");
        setFormError(null);
        onClose();
        onDone();
      },
    );
  };

  return (
    <ConfirmAction
      title="Solicitar app trial"
      open={open}
      confirmLabel="Solicitar trial"
      busy={busy}
      onClose={() => {
        setFormError(null);
        onClose();
      }}
      onConfirm={confirm}
    >
      {singleAuto ? (
        <p className="cc-muted">
          Pessoa: {singleAuto.canonicalName ?? singleAuto.id.slice(0, 8)} (seleção automática via CRM).
        </p>
      ) : null}
      {showPersonSelect ? (
        <Field label="Pessoa (CRM)">
          <Select
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
            disabled={busy}
          >
            <option value="">Selecione uma pessoa…</option>
            {personList?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.canonicalName && p.canonicalName.trim().length > 0 ? p.canonicalName : p.id.slice(0, 8)}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {showManualPerson ? (
        <Field label="ID da pessoa (UUID)">
          <Input
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
            disabled={busy}
            placeholder="UUID da pessoa"
          />
        </Field>
      ) : null}
      <Field label="ID do fornecedor (UUID)">
        <Input
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          disabled={busy}
          placeholder="UUID do fornecedor"
        />
      </Field>
      <Field label="Identificador externo do aplicativo">
        <Input
          value={supplierAppExternalId}
          onChange={(e) => setSupplierAppExternalId(e.target.value)}
          disabled={busy}
          placeholder="Ex.: app-pkg-cinevision-trial"
        />
      </Field>
      {formError ? <p className="cc-field-error">{formError}</p> : null}
    </ConfirmAction>
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
      <div className="cc-row cc-u-mb-4">
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
            { header: "ID da entidade", render: (f) => <span className="cc-mono">{f.entityId.slice(0, 8)}…</span> },
            { header: "Esperado", render: (f) => f.expected ?? "—" },
            { header: "Observado", render: (f) => f.observed ?? "—" },
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
        <div className="cc-form cc-u-mt-3">
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
