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

const READ_PERMISSION = "crm.person.read";
const QUALIFY_WRITE = "crm.lead.write";
const REDEEM_WRITE = "commerce.order.write";

interface PersonOption {
  id: string;
  canonicalName: string | null;
}

function personOptionLabel(p: PersonOption): string {
  return p.canonicalName && p.canonicalName.trim().length > 0
    ? `${p.canonicalName} (${p.id.slice(0, 8)})`
    : p.id;
}

interface ReferralRow {
  id: string;
  status: string;
  code?: string | null;
  referralCode?: string | null;
  referral_code?: string | null;
  referredPersonId?: string | null;
  referred_person_id?: string | null;
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
  economicValueMinor?: string | number | null;
  economic_value_minor?: string | number | null;
  currency?: string;
  createdAt?: string;
  created_at?: string;
  availableAt?: string | null;
  available_at?: string | null;
  [key: string]: unknown;
}

type Tab = "referrals" | "rewards" | "giftpass";

export default function ReferralsPage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("referrals");

  return (
    <Shell>
      <h1>Indicações</h1>
      <PermissionGate permission={READ_PERMISSION} label="as indicações">
        <div className="cc-row cc-u-mb-4">
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

interface CreateReferralDialogProps {
  open: boolean;
  initialCustomerId?: string;
  persons: PersonOption[];
  onClose: () => void;
  onDone: () => void;
}

function CreateReferralDialog({
  open,
  initialCustomerId,
  persons,
  onClose,
  onDone,
}: CreateReferralDialogProps): React.JSX.Element {
  const { busy, run } = useRevenueCommand();
  const [advocateCustomerId, setAdvocateCustomerId] = useState(initialCustomerId ?? "");
  const [referredPersonId, setReferredPersonId] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      if (initialCustomerId) {
        setAdvocateCustomerId(initialCustomerId);
      } else if (persons.length === 1 && persons[0]) {
        setAdvocateCustomerId(persons[0].id);
      }
      setFormError(null);
    }
  }, [open, initialCustomerId, persons]);

  const confirm = (): void => {
    setFormError(null);
    const autoAdvocate = persons.length === 1 && persons[0] ? persons[0].id : "";
    const adv = (advocateCustomerId || autoAdvocate || (initialCustomerId ?? "")).trim();
    if (!adv) {
      setFormError("Informe o ID do cliente indicador (advocate).");
      return;
    }

    const refPerson = referredPersonId.trim();
    const code = referralCode.trim();

    if (!refPerson && !code) {
      setFormError("Informe a pessoa indicada ou um código de indicação.");
      return;
    }

    const payload: Record<string, unknown> = {};
    if (refPerson) payload["referredPersonId"] = refPerson;
    if (code) payload["referralCode"] = code;

    void run(
      `/v1/customers/${adv}/referrals`,
      payload,
      "Indicação criada com sucesso.",
      () => {
        setReferredPersonId("");
        setReferralCode("");
        setFormError(null);
        onClose();
        onDone();
      },
    );
  };

  return (
    <ConfirmAction
      title="Nova indicação"
      open={open}
      confirmLabel="Criar indicação"
      busy={busy}
      onClose={() => {
        setFormError(null);
        onClose();
      }}
      onConfirm={confirm}
    >
      {persons.length > 0 ? (
        <Field label="Cliente indicador cadastrado (CRM)">
          <Select
            value={advocateCustomerId}
            onChange={(e) => setAdvocateCustomerId(e.target.value)}
            disabled={busy}
          >
            <option value="">Selecione um cliente indicador...</option>
            {persons.map((p) => (
              <option key={`adv-${p.id}`} value={p.id}>
                {personOptionLabel(p)}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Field label="ID do cliente indicador (UUID)">
        <Input
          placeholder="UUID do cliente indicador"
          value={advocateCustomerId}
          onChange={(e) => setAdvocateCustomerId(e.target.value)}
          disabled={busy}
        />
      </Field>

      {persons.length > 0 ? (
        <Field label="Pessoa indicada (CRM)">
          <Select
            value={referredPersonId}
            onChange={(e) => setReferredPersonId(e.target.value)}
            disabled={busy}
          >
            <option value="">Selecione a pessoa indicada (opcional)...</option>
            {persons.map((p) => (
              <option key={`ref-${p.id}`} value={p.id}>
                {personOptionLabel(p)}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Field label="ID da pessoa indicada (UUID)">
        <Input
          placeholder="UUID da pessoa indicada"
          value={referredPersonId}
          onChange={(e) => setReferredPersonId(e.target.value)}
          disabled={busy}
        />
      </Field>

      <Field label="Código de indicação (opcional)">
        <Input
          placeholder="Ex.: AMIGO10"
          value={referralCode}
          onChange={(e) => setReferralCode(e.target.value)}
          disabled={busy}
        />
      </Field>

      {formError ? <p className="cc-error">{formError}</p> : null}
    </ConfirmAction>
  );
}

function ReferralsSection(): React.JSX.Element {
  const { customerId, setCustomerId } = useCustomerId();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const qs = activeId ? `/v1/customers/${activeId}/referrals` : null;
  const { data, error, loading, reload } = useApi<{ referrals?: ReferralRow[]; items?: ReferralRow[] }>(qs);
  const { busy, run } = useRevenueCommand();
  const [dialog, setDialog] = useState<string | null>(null);
  const hasPermission = useOptionalHasPermission();
  const canRead = hasPermission(READ_PERMISSION);
  const canWrite = hasPermission(QUALIFY_WRITE);

  const { data: personsData } = useApi<{ items?: PersonOption[]; persons?: PersonOption[] }>(
    canRead ? "/v1/crm/persons" : null,
  );
  const personList = personsData?.items ?? personsData?.persons ?? [];

  const rows = data?.referrals ?? data?.items ?? [];

  const confirm = (): void => {
    if (!dialog) return;
    void run(`/v1/referrals/${dialog}/qualification`, {}, "Qualificação de indicação enviada.", () => {
      setDialog(null);
      reload();
    });
  };

  const handleSelectPerson = (id: string): void => {
    setCustomerId(id);
    if (id.trim().length > 0) {
      setActiveId(id.trim());
    }
  };

  return (
    <div>
      <div className="cc-row cc-u-mb-4" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: "1rem" }}>
        {personList.length > 0 ? (
          <div style={{ minWidth: "260px" }}>
            <Field label="Pessoa cadastrada (CRM)">
              <Select value={customerId} onChange={(e) => handleSelectPerson(e.target.value)}>
                <option value="">Selecione uma pessoa...</option>
                {personList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {personOptionLabel(p)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : null}
        <Field label="ID do cliente (UUID)">
          <Input
            placeholder="UUID do cliente"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className="cc-u-maxw-320"
          />
        </Field>
        <Button onClick={() => setActiveId(customerId.trim().length > 0 ? customerId.trim() : null)}>
          Consultar indicações
        </Button>
        {canWrite ? (
          <Button variant="secondary" onClick={() => setCreateOpen(true)}>
            Nova indicação
          </Button>
        ) : null}
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
            {
              header: "Código",
              render: (r) => (
                <span className="cc-mono">{String(r.referralCode ?? r.referral_code ?? r.code ?? "—")}</span>
              ),
            },
            {
              header: "Pessoa indicada",
              render: (r) => (
                <span className="cc-mono">
                  {r.referredPersonId ?? r.referred_person_id ? String(r.referredPersonId ?? r.referred_person_id).slice(0, 8) : "—"}
                </span>
              ),
            },
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
      <ConfirmAction
        title="Qualificar indicação"
        open={dialog !== null}
        confirmLabel="Confirmar qualificação"
        busy={busy}
        onClose={() => setDialog(null)}
        onConfirm={confirm}
      >
        <p className="cc-muted">O servidor valida elegibilidade antes de qualificar. Confirme para enviar.</p>
      </ConfirmAction>

      <CreateReferralDialog
        open={createOpen}
        initialCustomerId={activeId ?? customerId}
        persons={personList}
        onClose={() => setCreateOpen(false)}
        onDone={() => {
          setCreateOpen(false);
          reload();
        }}
      />
    </div>
  );
}

function RewardsSection(): React.JSX.Element {
  const { customerId, setCustomerId } = useCustomerId();
  const [activeId, setActiveId] = useState<string | null>(null);
  const qs = activeId ? `/v1/customers/${activeId}/rewards` : null;
  const { data, error, loading, reload } = useApi<{ rewards?: RewardRow[]; items?: RewardRow[] }>(qs);
  const { busy, run } = useRevenueCommand();
  const [dialog, setDialog] = useState<string | null>(null);
  const hasPermission = useOptionalHasPermission();
  const canRead = hasPermission(READ_PERMISSION);
  const canRedeem = hasPermission(REDEEM_WRITE);

  const { data: personsData } = useApi<{ items?: PersonOption[]; persons?: PersonOption[] }>(
    canRead ? "/v1/crm/persons" : null,
  );
  const personList = personsData?.items ?? personsData?.persons ?? [];

  const rows = data?.rewards ?? data?.items ?? [];

  const confirm = (): void => {
    if (!dialog) return;
    void run(`/v1/rewards/${dialog}/redeem`, {}, "Resgate de recompensa enviado.", () => {
      setDialog(null);
      reload();
    });
  };

  const handleSelectPerson = (id: string): void => {
    setCustomerId(id);
    if (id.trim().length > 0) {
      setActiveId(id.trim());
    }
  };

  return (
    <div>
      <div className="cc-row cc-u-mb-4" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: "1rem" }}>
        {personList.length > 0 ? (
          <div style={{ minWidth: "260px" }}>
            <Field label="Pessoa cadastrada (CRM)">
              <Select value={customerId} onChange={(e) => handleSelectPerson(e.target.value)}>
                <option value="">Selecione uma pessoa...</option>
                {personList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {personOptionLabel(p)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : null}
        <Field label="ID do cliente (UUID)">
          <Input
            placeholder="UUID do cliente"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className="cc-u-maxw-320"
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
              render: (r) =>
                formatMinor(
                  (r.economicValueMinor ?? r.economic_value_minor ?? r.amountMinor ?? r.amount_minor ?? "0") as
                    | string
                    | number,
                  String(r.currency ?? "BRL"),
                ),
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
      <ConfirmAction
        title="Resgatar recompensa"
        open={dialog !== null}
        confirmLabel="Confirmar resgate"
        busy={busy}
        onClose={() => setDialog(null)}
        onConfirm={confirm}
      >
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
        <div className="cc-row cc-u-mt-2">
          <Button disabled={busy} onClick={() => setOpen(true)}>
            Resgatar código
          </Button>
        </div>
      ) : (
        <p className="cc-muted">Você não tem a permissão crm.lead.write; resgate fica indisponível.</p>
      )}
      <ConfirmAction
        title="Resgatar gift-pass"
        open={open}
        confirmLabel="Confirmar resgate"
        busy={busy}
        onClose={() => setOpen(false)}
        onConfirm={confirm}
      >
        <Field label="Código do gift-pass">
          <Input value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />
        </Field>
      </ConfirmAction>
    </Card>
  );
}
