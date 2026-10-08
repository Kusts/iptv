"use client";

import { useState } from "react";
import { Shell } from "../../components/Shell";
import { ConfirmAction, PermissionGate, useRevenueCommand } from "../../components/RevenueOps";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/Badge";
import { Table } from "../../components/ui/Table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../components/ui/States";
import { Field, Input, Select, Textarea } from "../../components/ui/Input";
import { useApi } from "../../lib/useApi";
import { formatDateTime } from "../../lib/money";
import { useOptionalHasPermission } from "../../lib/auth";

const READ_PERMISSION = "crm.person.read";
const WRITE_PERMISSION = "crm.lead.write";

const LEAD_STATUSES = [
  "CONTACTED",
  "QUALIFIED",
  "ENGAGED",
  "OFFERED",
  "CONVERTED",
  "NURTURE",
  "LOST",
  "DISQUALIFIED",
] as const;

interface PersonRow {
  id: string;
  status: string;
  canonicalName: string | null;
  locale: string | null;
  timezone: string | null;
  createdAt: string;
}

interface PersonDetail extends PersonRow {
  identities: { id: string; identityType: string; normalizedValue: string; verificationStatus: string }[];
}

interface LeadRow {
  id: string;
  personId: string;
  status: string;
  stage: string;
  createdAt: string;
}

interface LeadDetail extends LeadRow {
  qualifiedAt: string | null;
  lostAt: string | null;
  closedReason: string | null;
}

export default function CrmPage(): React.JSX.Element {
  const [tab, setTab] = useState<"persons" | "leads">("persons");

  return (
    <Shell>
      <h1>CRM</h1>
      <PermissionGate permission={READ_PERMISSION} label="o CRM">
        <div className="cc-row" style={{ marginBottom: "1rem" }}>
          <Button variant={tab === "persons" ? "primary" : "secondary"} onClick={() => setTab("persons")}>
            Pessoas
          </Button>
          <Button variant={tab === "leads" ? "primary" : "secondary"} onClick={() => setTab("leads")}>
            Leads
          </Button>
        </div>
        {tab === "persons" ? <PersonsSection /> : <LeadsSection />}
      </PermissionGate>
    </Shell>
  );
}

function PersonsSection(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ persons: PersonRow[] }>("/v1/crm/persons");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <Button onClick={reload} variant="secondary">
          Recarregar
        </Button>
        {canWrite ? <Button onClick={() => setCreateOpen(true)}>Registrar pessoa</Button> : null}
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && data.persons.length === 0 ? (
        <EmptyState title="Nenhuma pessoa" hint="Pessoas registradas a partir de conversas e capturas aparecem aqui." />
      ) : null}
      {data && data.persons.length > 0 ? (
        <div className="cc-grid-2">
          <Table
            columns={[
              {
                header: "Nome",
                render: (p) => <span className="cc-mono">{p.canonicalName ?? p.id.slice(0, 8)}</span>,
              },
              { header: "Status", render: (p) => <StatusPill status={p.status} /> },
              { header: "Criada em", render: (p) => formatDateTime(p.createdAt) },
              {
                header: "Ações",
                render: (p) => (
                  <Button variant="secondary" onClick={() => setSelectedId(p.id)}>
                    Detalhe
                  </Button>
                ),
              },
            ]}
            rows={data.persons}
          />
          {selectedId ? (
            <PersonDetailPanel key={selectedId} id={selectedId} />
          ) : (
            <EmptyState title="Selecione uma pessoa" hint="Identidades vinculadas (visão 360) aparecem ao lado." />
          )}
        </div>
      ) : null}
      {canWrite ? <RegisterPersonDialog open={createOpen} onClose={() => setCreateOpen(false)} onDone={reload} /> : null}
    </div>
  );
}

function PersonDetailPanel({ id }: { id: string }): React.JSX.Element {
  const { data, error, loading, reload } = useApi<PersonDetail>(`/v1/crm/persons/${id}`);

  if (loading) return <LoadingSkeleton lines={4} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <EmptyState title="Pessoa não encontrada" />;
  return (
    <Card title="Visão 360 da pessoa">
      <p className="cc-mono">{data.id}</p>
      <div className="cc-row">
        <StatusPill status={data.status} />
        <span className="cc-muted">
          {data.locale ?? "—"} · {data.timezone ?? "—"}
        </span>
      </div>
      <h4>Identidades ({data.identities.length})</h4>
      {data.identities.length === 0 ? (
        <p className="cc-muted">Sem identidades vinculadas.</p>
      ) : (
        <ul>
          {data.identities.map((i) => (
            <li key={i.id}>
              <span className="cc-mono">{i.identityType}</span> <StatusPill status={i.verificationStatus} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RegisterPersonDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const { busy, run } = useRevenueCommand();
  const [canonicalName, setCanonicalName] = useState("");
  const [identityType, setIdentityType] = useState("phone_e164");
  const [identityValue, setIdentityValue] = useState("");

  const confirm = (): void => {
    const body = {
      ...(canonicalName.trim().length > 0 ? { canonicalName: canonicalName.trim() } : {}),
      identities:
        identityValue.trim().length > 0
          ? [{ identityType: identityType.trim(), normalizedValue: identityValue.trim() }]
          : [],
    };
    void run("/v1/crm/persons", body, "Pessoa registrada.", () => {
      setCanonicalName("");
      setIdentityValue("");
      onClose();
      onDone();
    });
  };

  return (
    <ConfirmAction title="Registrar pessoa" open={open} confirmLabel="Confirmar registro" busy={busy} onClose={onClose} onConfirm={confirm}>
      <Field label="Nome canônico (opcional)">
        <Input value={canonicalName} onChange={(e) => setCanonicalName(e.target.value)} disabled={busy} />
      </Field>
      <Field label="Tipo de identidade">
        <Input value={identityType} onChange={(e) => setIdentityType(e.target.value)} disabled={busy} />
      </Field>
      <Field label="Valor da identidade (opcional)">
        <Input value={identityValue} onChange={(e) => setIdentityValue(e.target.value)} disabled={busy} />
      </Field>
    </ConfirmAction>
  );
}

function LeadsSection(): React.JSX.Element {
  const [status, setStatus] = useState("");
  const qs = status.length > 0 ? `/v1/crm/leads?status=${encodeURIComponent(status)}` : "/v1/crm/leads";
  const { data, error, loading, reload } = useApi<{ leads: LeadRow[] }>(qs);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <label className="cc-muted" htmlFor="crm-lead-status">
          Status:
        </label>
        <Select id="crm-lead-status" value={status} onChange={(e) => { setStatus(e.target.value); setSelectedId(null); }} style={{ maxWidth: "240px" }}>
          <option value="">Todos</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
          <option value="NEW">NEW</option>
        </Select>
        {canWrite ? <Button onClick={() => setCaptureOpen(true)}>Capturar lead</Button> : null}
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && data.leads.length === 0 ? (
        <EmptyState title="Nenhum lead" hint="Leads capturados a partir de pessoas aparecem aqui." />
      ) : null}
      {data && data.leads.length > 0 ? (
        <div className="cc-grid-2">
          <Table
            columns={[
              { header: "Estágio", render: (l) => <span className="cc-mono">{l.stage}</span> },
              { header: "Status", render: (l) => <StatusPill status={l.status} /> },
              { header: "Criado em", render: (l) => formatDateTime(l.createdAt) },
              {
                header: "Ações",
                render: (l) => (
                  <Button variant="secondary" onClick={() => setSelectedId(l.id)}>
                    Detalhe
                  </Button>
                ),
              },
            ]}
            rows={data.leads}
          />
          {selectedId ? (
            <LeadDetailPanel key={selectedId} id={selectedId} onChanged={reload} />
          ) : (
            <EmptyState title="Selecione um lead" hint="Próxima ação (transição de status) aparece ao lado." />
          )}
        </div>
      ) : null}
      {canWrite ? <CaptureLeadDialog open={captureOpen} onClose={() => setCaptureOpen(false)} onDone={reload} /> : null}
    </div>
  );
}

function LeadDetailPanel({ id, onChanged }: { id: string; onChanged: () => void }): React.JSX.Element {
  const { data, error, loading, reload } = useApi<LeadDetail>(`/v1/crm/leads/${id}`);
  const { busy, run } = useRevenueCommand();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toStatus, setToStatus] = useState<string>("CONTACTED");
  const [reason, setReason] = useState("");
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  if (loading) return <LoadingSkeleton lines={4} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <EmptyState title="Lead não encontrado" />;

  const confirm = (): void => {
    void run(
      `/v1/crm/leads/${id}/transition`,
      { toStatus, ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}) },
      "Transição de lead registrada.",
      () => {
        setDialogOpen(false);
        setReason("");
        reload();
        onChanged();
      },
    );
  };

  return (
    <Card title="Detalhe do lead">
      <p className="cc-mono">{data.id}</p>
      <div className="cc-row">
        <StatusPill status={data.status} />
        <span className="cc-muted">estágio {data.stage}</span>
      </div>
      <p className="cc-muted">
        Qualificado em {formatDateTime(data.qualifiedAt)} · Perdido em {formatDateTime(data.lostAt)}
      </p>
      {canWrite ? (
        <div className="cc-row" style={{ marginTop: "0.75rem" }}>
          <Button disabled={busy} onClick={() => setDialogOpen(true)}>
            Transição de status
          </Button>
        </div>
      ) : (
        <p className="cc-muted">Você não tem a permissão crm.lead.write; transições ficam indisponíveis.</p>
      )}
      <ConfirmAction title="Transição de lead" open={dialogOpen} confirmLabel="Confirmar transição" busy={busy} onClose={() => setDialogOpen(false)} onConfirm={confirm}>
        <Field label="Próximo status">
          <Select value={toStatus} onChange={(e) => setToStatus(e.target.value)} disabled={busy}>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Motivo (opcional)">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} disabled={busy} />
        </Field>
      </ConfirmAction>
    </Card>
  );
}

function CaptureLeadDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const { busy, run } = useRevenueCommand();
  const [personId, setPersonId] = useState("");
  const [stage, setStage] = useState("");

  const confirm = (): void => {
    void run(
      "/v1/crm/leads",
      { personId: personId.trim(), ...(stage.trim().length > 0 ? { stage: stage.trim() } : {}) },
      "Lead capturado.",
      () => {
        setPersonId("");
        setStage("");
        onClose();
        onDone();
      },
    );
  };

  return (
    <ConfirmAction title="Capturar lead" open={open} confirmLabel="Confirmar captura" busy={busy} onClose={onClose} onConfirm={confirm}>
      <Field label="ID da pessoa (UUID)">
        <Input value={personId} onChange={(e) => setPersonId(e.target.value)} disabled={busy} />
      </Field>
      <Field label="Estágio (opcional)">
        <Input value={stage} onChange={(e) => setStage(e.target.value)} disabled={busy} />
      </Field>
    </ConfirmAction>
  );
}
