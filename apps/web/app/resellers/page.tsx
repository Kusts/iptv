"use client";

import { useState } from "react";
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

const READ_PERMISSION = "crm.person.read";
const PARTNER_WRITE = "crm.lead.write";
const ORDER_WRITE = "commerce.order.write";

interface PartnerRow {
  id: string;
  status?: string;
  displayName?: string | null;
  kind?: string | null;
  createdAt?: string;
  [key: string]: unknown;
}

interface CreditBalance {
  currency?: string;
  availableMinor?: string | number;
  available_minor?: string | number;
  reservedMinor?: string | number;
  [key: string]: unknown;
}

interface ResellerOrderRow {
  id: string;
  status: string;
  totalMinor?: string | number;
  total_minor?: string | number;
  currency?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

type Tab = "partners" | "network" | "orders";

export default function ResellersPage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("partners");

  return (
    <Shell>
      <h1>Revendedores</h1>
      <PermissionGate permission={READ_PERMISSION} label="os revendedores">
        <div className="cc-row cc-u-mb-4">
          <Button variant={tab === "partners" ? "primary" : "secondary"} onClick={() => setTab("partners")}>
            Parceiros
          </Button>
          <Button variant={tab === "network" ? "primary" : "secondary"} onClick={() => setTab("network")}>
            Rede e créditos
          </Button>
          <Button variant={tab === "orders" ? "primary" : "secondary"} onClick={() => setTab("orders")}>
            Pedidos
          </Button>
        </div>
        {tab === "partners" ? <PartnersSection /> : null}
        {tab === "network" ? <NetworkSection /> : null}
        {tab === "orders" ? <OrdersSection /> : null}
      </PermissionGate>
    </Shell>
  );
}

function PartnersSection(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ items: PartnerRow[] }>("/v1/partners");
  const { busy, run } = useRevenueCommand();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ path: string; title: string; label: string } | null>(null);
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(PARTNER_WRITE);

  const rows = data?.items ?? [];

  const confirm = (): void => {
    if (!dialog) return;
    void run(dialog.path, {}, "Comando de parceiro enviado.", () => {
      setDialog(null);
      reload();
    });
  };

  return (
    <div>
      <div className="cc-row cc-u-mb-4">
        <Button variant="secondary" onClick={reload}>
          Recarregar
        </Button>
        {canWrite ? (
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            Novo parceiro
          </Button>
        ) : null}
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && rows.length === 0 ? (
        <EmptyState title="Nenhum parceiro" hint="Parceiros/revendedores cadastrados aparecem aqui." />
      ) : null}
      {rows.length > 0 ? (
        <div className="cc-grid-2">
          <Table
            columns={[
              { header: "Nome", render: (p) => <span className="cc-mono">{String(p.displayName ?? p.id).slice(0, 32)}</span> },
              { header: "Status", render: (p) => (p.status !== undefined ? <StatusPill status={String(p.status)} /> : <span className="cc-muted">—</span>) },
              {
                header: "Ações",
                render: (p) => (
                  <Button variant="secondary" onClick={() => setSelectedId(String(p.id))}>
                    Detalhe
                  </Button>
                ),
              },
            ]}
            rows={rows.map((r) => ({ ...r, id: String(r.id) }))}
          />
          {selectedId ? <PartnerDetailPanel key={selectedId} id={selectedId} /> : (
            <EmptyState title="Selecione um parceiro" hint="Resumo, rede e ativação aparecem ao lado." />
          )}
        </div>
      ) : null}
      {canWrite && selectedId ? (
        <Card title="Ações do parceiro">
          <p className="cc-mono">{selectedId}</p>
          <div className="cc-row cc-u-mt-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setDialog({ path: `/v1/partners/${selectedId}/activate`, title: "Ativar parceiro", label: "Ativar" })}
            >
              Ativar
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setDialog({ path: `/v1/partners/${selectedId}/convert-to-tenant`, title: "Converter em tenant", label: "Converter" })}
            >
              Converter em tenant
            </Button>
          </div>
        </Card>
      ) : null}
      {!canWrite ? (
        <p className="cc-muted cc-u-mt-3">Você não tem a permissão crm.lead.write; ativação e conversão ficam indisponíveis.</p>
      ) : null}

      <CreatePartnerDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={() => {
          setCreateOpen(false);
          reload();
        }}
      />

      <ConfirmAction
        title={dialog?.title ?? ""}
        open={dialog !== null}
        confirmLabel={dialog?.label ?? "Confirmar"}
        busy={busy}
        onClose={() => setDialog(null)}
        onConfirm={confirm}
      >
        <p className="cc-muted">O servidor valida elegibilidade antes de aplicar. Confirme para enviar.</p>
      </ConfirmAction>
    </div>
  );
}

function CreatePartnerDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const { busy, run } = useRevenueCommand();
  const [displayName, setDisplayName] = useState("");
  const [initialStatus, setInitialStatus] = useState<"ONBOARDING" | "PROSPECT">("ONBOARDING");
  const [formError, setFormError] = useState<string | null>(null);

  const confirm = (): void => {
    setFormError(null);
    const trimmed = displayName.trim();
    if (trimmed.length === 0) {
      setFormError("Informe o nome do parceiro.");
      return;
    }

    void run(
      "/v1/partners",
      { displayName: trimmed, initialStatus },
      "Parceiro cadastrado com sucesso.",
      () => {
        setDisplayName("");
        setInitialStatus("ONBOARDING");
        setFormError(null);
        onClose();
        onDone();
      },
    );
  };

  return (
    <ConfirmAction
      title="Novo parceiro"
      open={open}
      confirmLabel="Cadastrar parceiro"
      busy={busy}
      onClose={() => {
        setFormError(null);
        onClose();
      }}
      onConfirm={confirm}
    >
      <Field label="Nome de exibição do parceiro">
        <Input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          disabled={busy}
          placeholder="Ex.: Distribuidora Parceira Sul"
        />
      </Field>
      <Field label="Status inicial">
        <Select
          value={initialStatus}
          onChange={(e) => setInitialStatus(e.target.value as "ONBOARDING" | "PROSPECT")}
          disabled={busy}
        >
          <option value="ONBOARDING">ONBOARDING</option>
          <option value="PROSPECT">PROSPECT</option>
        </Select>
      </Field>
      {formError ? <p className="cc-field-error">{formError}</p> : null}
    </ConfirmAction>
  );
}

function PartnerDetailPanel({ id }: { id: string }): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ summary?: Record<string, unknown>; partner?: PartnerRow } & PartnerRow>(`/v1/partners/${id}/summary`);
  if (loading) return <LoadingSkeleton lines={4} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <EmptyState title="Parceiro não encontrado" />;
  const summary = (data.summary ?? data) as Record<string, unknown>;
  return (
    <Card title="Resumo do parceiro">
      <p className="cc-mono">{id}</p>
      <ul>
        {Object.entries(summary).slice(0, 8).map(([k, v]) => (
          <li key={k}>
            <span className="cc-muted">{k}:</span> <span className="cc-mono">{String(v ?? "—").slice(0, 60)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function NetworkSection(): React.JSX.Element {
  const { data: partnersData } = useApi<{ items: PartnerRow[] }>("/v1/partners");
  const partnerList = partnersData?.items ?? [];

  const [partnerId, setPartnerId] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const networkQs = activeId ? `/v1/partners/${activeId}/network` : null;
  const creditsQs = activeId ? `/v1/partners/${activeId}/credits` : null;
  const network = useApi<{ directChildren?: PartnerRow[]; items?: PartnerRow[] }>(networkQs);
  const credits = useApi<{ balances?: CreditBalance[]; partnerAccountId?: string }>(creditsQs);
  const { busy, run } = useRevenueCommand();
  const [topupOpen, setTopupOpen] = useState(false);
  const [amountMinor, setAmountMinor] = useState("");
  const [currency, setCurrency] = useState("BRL");
  const hasPermission = useOptionalHasPermission();
  const canOrder = hasPermission(ORDER_WRITE);

  const children = network.data?.directChildren ?? network.data?.items ?? [];
  const balances = credits.data?.balances ?? [];

  const handleSelectPartner = (id: string): void => {
    setPartnerId(id);
    if (id.trim().length > 0) {
      setActiveId(id.trim());
    }
  };

  const confirmTopup = (): void => {
    if (!activeId) return;
    void run(
      `/v1/partners/${activeId}/credits/topup`,
      { amountMinor: amountMinor.trim(), currency: currency.trim() },
      "Crédito do parceiro recarregado.",
      () => {
        setAmountMinor("");
        setTopupOpen(false);
        credits.reload();
      },
    );
  };

  return (
    <div>
      <div className="cc-row cc-u-mb-4" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: "1rem" }}>
        {partnerList.length > 0 ? (
          <div style={{ minWidth: "260px" }}>
            <Field label="Parceiro cadastrado">
              <Select
                value={partnerId}
                onChange={(e) => handleSelectPartner(e.target.value)}
                aria-label="Selecionar parceiro cadastrado"
              >
                <option value="">Selecione um parceiro…</option>
                {partnerList.map((p) => (
                  <option key={String(p.id)} value={String(p.id)}>
                    {String(p.displayName ?? p.id).slice(0, 32)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : null}
        <Field label="ID do parceiro (UUID)">
          <Input
            placeholder="UUID do parceiro"
            value={partnerId}
            onChange={(e) => setPartnerId(e.target.value)}
            className="cc-u-maxw-320"
          />
        </Field>
        <div style={{ marginBottom: "0.25rem" }}>
          <Button onClick={() => setActiveId(partnerId.trim().length > 0 ? partnerId.trim() : null)}>
            Consultar rede
          </Button>
        </div>
        {canOrder && activeId ? (
          <div style={{ marginBottom: "0.25rem" }}>
            <Button variant="secondary" disabled={busy} onClick={() => setTopupOpen(true)}>
              Recarregar crédito
            </Button>
          </div>
        ) : null}
      </div>
      {activeId === null ? (
        <EmptyState title="Informe o parceiro" hint="Rede e saldos são consultados por parceiro (escopo permissionado)." />
      ) : null}
      {network.loading || credits.loading ? <LoadingSkeleton lines={4} /> : null}
      {network.error !== null ? <ErrorState message={network.error} onRetry={() => { network.reload(); credits.reload(); }} /> : null}
      {activeId !== null && network.data ? (
        <Card title={`Rede direta (${children.length} filhos)`}>
          {children.length === 0 ? (
            <p className="cc-muted">Sem filhos diretos.</p>
          ) : (
            <ul>
              {children.map((c) => (
                <li key={String(c.id)} className="cc-mono">{String(c.id).slice(0, 13)}…</li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
      {activeId !== null && credits.data ? (
        <Card title="Saldos de crédito (moeda explícita por linha)">
          {balances.length === 0 ? (
            <p className="cc-muted">Sem saldos registrados.</p>
          ) : (
            <ul>
              {balances.map((b, i) => (
                <li key={i}>
                  {formatMinor((b.availableMinor ?? b.available_minor ?? "0") as string | number, String(b.currency ?? "BRL"))}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
      {!canOrder ? (
        <p className="cc-muted cc-u-mt-3">Você não tem a permissão commerce.order.write; recarga de crédito fica indisponível.</p>
      ) : null}
      <ConfirmAction title="Recarregar crédito" open={topupOpen} confirmLabel="Confirmar recarga" busy={busy} onClose={() => setTopupOpen(false)} onConfirm={confirmTopup}>
        <Field label="Valor (minor units, ex.: 10000 = R$ 100,00)">
          <Input value={amountMinor} onChange={(e) => setAmountMinor(e.target.value)} disabled={busy} />
        </Field>
        <Field label="Moeda">
          <Input value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={busy} />
        </Field>
      </ConfirmAction>
    </div>
  );
}

function OrdersSection(): React.JSX.Element {
  const [orderId, setOrderId] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const qs = activeId ? `/v1/reseller-orders/${activeId}` : null;
  const { data, error, loading, reload } = useApi<ResellerOrderRow>(qs);

  return (
    <div>
      <div className="cc-row cc-u-mb-4">
        <Field label="ID do pedido (UUID)">
          <Input
            placeholder="UUID do pedido"
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            className="cc-u-maxw-320"
          />
        </Field>
        <Button onClick={() => setActiveId(orderId.trim().length > 0 ? orderId.trim() : null)}>
          Consultar pedido
        </Button>
      </div>
      {activeId === null ? (
        <EmptyState title="Informe o pedido" hint="Pedidos de revenda são consultados por ID (escopo permissionado)." />
      ) : null}
      {loading ? <LoadingSkeleton lines={4} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data ? (
        <Card title="Pedido de revenda">
          <div className="cc-row">
            <StatusPill status={data.status} />
            <span>{formatMinor((data.totalMinor ?? data.total_minor ?? "0") as string | number, String(data.currency ?? "BRL"))}</span>
          </div>
          <p className="cc-mono">{data.id}</p>
          <p className="cc-muted">Criado em {formatDateTime(String(data.createdAt ?? data.created_at ?? ""))}</p>
        </Card>
      ) : null}
    </div>
  );
}
