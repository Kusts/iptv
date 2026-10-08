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

const READ_PERMISSION = "crm.person.read";
const QUALIFY_WRITE = "crm.lead.write";
const REDEEM_WRITE = "commerce.order.write";

interface ReferralRow {
  id: string;
  status: string;
  createdAt?: string;
  created_at?: string;
  confirmedAt?: string | null;
  confirmed_at?: string | null;
  [key: string]: unknown;
}

interface RewardRow {
  id: string;
  status: string;
  amountMinor?: string | number;
  amount_minor?: string | number;
  currency?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

type Tab = "referrals" | "rewards" | "giftpass";

export default function ReferralsPage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("referrals");

  return (
    <Shell>
      <h1>Indicações</h1>
      <PermissionGate permission={READ_PERMISSION} label="as indicações">
        <div className="cc-row" style={{ marginBottom: "1rem" }}>
          <Button variant={tab === "referrals" ? "primary" : "secondary"} onClick={() => setTab("referrals")}>
            Indicações
          </Button>
          <Button variant={tab === "rewards" ? "primary" : "secondary"} onClick={() => setTab("rewards")}>
            Recompensas
          </Button>
          <Button variant={tab === "giftpass" ? "primary" : "secondary"} onClick={() => setTab("giftpass")}>
            Gift-pass
          </Button>
        </div>
        {tab === "referrals" ? <ReferralsSection /> : null}
        {tab === "rewards" ? <RewardsSection /> : null}
        {tab === "giftpass" ? <GiftPassSection /> : null}
      </PermissionGate>
    </Shell>
  );
}

function useCustomerId(): { customerId: string; setCustomerId: (v: string) => void } {
  const [customerId, setCustomerId] = useState("");
  return { customerId, setCustomerId };
}

function ReferralsSection(): React.JSX.Element {
  const { customerId, setCustomerId } = useCustomerId();
  const [activeId, setActiveId] = useState<string | null>(null);
  const qs = activeId ? `/v1/customers/${activeId}/referrals` : null;
  const { data, error, loading, reload } = useApi<{ referrals: ReferralRow[]; items?: ReferralRow[] }>(qs);
  const { busy, run } = useRevenueCommand();
  const [dialog, setDialog] = useState<string | null>(null);
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(QUALIFY_WRITE);

  const rows = data?.referrals ?? data?.items ?? [];

  const confirm = (): void => {
    if (!dialog) return;
    void run(`/v1/referrals/${dialog}/qualification`, {}, "Qualificação de indicação enviada.", () => {
      setDialog(null);
      reload();
    });
  };

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <Field label="ID do cliente (UUID)">
          <Input
            placeholder="UUID do cliente"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            style={{ maxWidth: "320px" }}
          />
        </Field>
        <Button onClick={() => setActiveId(customerId.trim().length > 0 ? customerId.trim() : null)}>
          Consultar indicações
        </Button>
      </div>
      {activeId === null ? (
        <EmptyState title="Informe o cliente" hint="Indicações são listadas por cliente (escopo permissionado)." />
      ) : null}
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && rows.length === 0 ? (
        <EmptyState title="Nenhuma indicação" hint="Indicações criadas para este cliente aparecem aqui." />
      ) : null}
      {rows.length > 0 ? (
        <Table
          columns={[
            { header: "Status", render: (r) => <StatusPill status={r.status} /> },
            { header: "Criada em", render: (r) => formatDateTime(String(r.createdAt ?? r.created_at ?? "")) },
            { header: "Confirmada em", render: (r) => formatDateTime((r.confirmedAt ?? r.confirmed_at ?? null) as string | null) },
            {
              header: "Ações",
              render: (r) =>
                canWrite ? (
                  <Button variant="secondary" disabled={busy} onClick={() => setDialog(String(r.id))}>
                    Qualificar
                  </Button>
                ) : (
                  <span className="cc-muted">—</span>
                ),
            },
          ]}
          rows={rows.map((r) => ({ ...r, id: String(r.id) }))}
        />
      ) : null}
      {!canWrite ? (
        <p className="cc-muted">Você não tem a permissão crm.lead.write; qualificação fica indisponível.</p>
      ) : null}
      <ConfirmAction title="Qualificar indicação" open={dialog !== null} confirmLabel="Confirmar qualificação" busy={busy} onClose={() => setDialog(null)} onConfirm={confirm}>
        <p className="cc-muted">O servidor valida elegibilidade antes de qualificar. Confirme para enviar.</p>
      </ConfirmAction>
    </div>
  );
}

function RewardsSection(): React.JSX.Element {
  const { customerId, setCustomerId } = useCustomerId();
  const [activeId, setActiveId] = useState<string | null>(null);
  const qs = activeId ? `/v1/customers/${activeId}/rewards` : null;
  const { data, error, loading, reload } = useApi<{ rewards: RewardRow[]; items?: RewardRow[] }>(qs);
  const { busy, run } = useRevenueCommand();
  const [dialog, setDialog] = useState<string | null>(null);
  const hasPermission = useOptionalHasPermission();
  const canRedeem = hasPermission(REDEEM_WRITE);

  const rows = data?.rewards ?? data?.items ?? [];

  const confirm = (): void => {
    if (!dialog) return;
    void run(`/v1/rewards/${dialog}/redeem`, {}, "Resgate de recompensa enviado.", () => {
      setDialog(null);
      reload();
    });
  };

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <Field label="ID do cliente (UUID)">
          <Input
            placeholder="UUID do cliente"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            style={{ maxWidth: "320px" }}
          />
        </Field>
        <Button onClick={() => setActiveId(customerId.trim().length > 0 ? customerId.trim() : null)}>
          Consultar recompensas
        </Button>
      </div>
      {activeId === null ? (
        <EmptyState title="Informe o cliente" hint="Recompensas são listadas por cliente (escopo permissionado)." />
      ) : null}
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && rows.length === 0 ? (
        <EmptyState title="Nenhuma recompensa" hint="Recompensas ganhas por indicação aparecem aqui." />
      ) : null}
      {rows.length > 0 ? (
        <Table
          columns={[
            { header: "Status", render: (r) => <StatusPill status={r.status} /> },
            {
              header: "Valor",
              render: (r) => formatMinor((r.amountMinor ?? r.amount_minor ?? "0") as string | number, String(r.currency ?? "BRL")),
            },
            { header: "Criada em", render: (r) => formatDateTime(String(r.createdAt ?? r.created_at ?? "")) },
            {
              header: "Ações",
              render: (r) =>
                canRedeem ? (
                  <Button variant="secondary" disabled={busy} onClick={() => setDialog(String(r.id))}>
                    Resgatar
                  </Button>
                ) : (
                  <span className="cc-muted">—</span>
                ),
            },
          ]}
          rows={rows.map((r) => ({ ...r, id: String(r.id) }))}
        />
      ) : null}
      {!canRedeem ? (
        <p className="cc-muted">Você não tem a permissão commerce.order.write; resgate fica indisponível.</p>
      ) : null}
      <ConfirmAction title="Resgatar recompensa" open={dialog !== null} confirmLabel="Confirmar resgate" busy={busy} onClose={() => setDialog(null)} onConfirm={confirm}>
        <p className="cc-muted">O resgate gera pedido de ajuste sem inflar vendas. Confirme para enviar.</p>
      </ConfirmAction>
    </div>
  );
}

function GiftPassSection(): React.JSX.Element {
  const { busy, run } = useRevenueCommand();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(QUALIFY_WRITE);

  const confirm = (): void => {
    void run("/v1/gift-passes/redeem", { code: code.trim() }, "Gift-pass resgatado.", () => {
      setCode("");
      setOpen(false);
    });
  };

  return (
    <Card title="Resgatar gift-pass">
      <p className="cc-muted">Resgate manual de código de gift-pass; o servidor valida elegibilidade e idempotência.</p>
      {canWrite ? (
        <div className="cc-row" style={{ marginTop: "0.5rem" }}>
          <Button disabled={busy} onClick={() => setOpen(true)}>
            Resgatar código
          </Button>
        </div>
      ) : (
        <p className="cc-muted">Você não tem a permissão crm.lead.write; resgate fica indisponível.</p>
      )}
      <ConfirmAction title="Resgatar gift-pass" open={open} confirmLabel="Confirmar resgate" busy={busy} onClose={() => setOpen(false)} onConfirm={confirm}>
        <Field label="Código do gift-pass">
          <Input value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />
        </Field>
      </ConfirmAction>
    </Card>
  );
}
