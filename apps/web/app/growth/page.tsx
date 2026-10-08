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

const READ_PERMISSION = "crm.person.read";
const WRITE_PERMISSION = "crm.lead.write";
const EXP_READ = "experiments.read";
const EXP_WRITE = "experiments.write";

interface CampaignRow {
  id: string;
  campaignKey: string;
  name: string;
  objective: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface AudienceRow {
  id: string;
  audienceKey?: string;
  name?: string;
  key?: string;
  status?: string;
  createdAt?: string;
  [key: string]: unknown;
}

interface ExperimentRow {
  id: string;
  key?: string;
  experimentKey?: string;
  name?: string;
  status: string;
  createdAt?: string;
  [key: string]: unknown;
}

type Tab = "campaigns" | "audiences" | "attribution" | "experiments";

export default function GrowthPage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("campaigns");

  return (
    <Shell>
      <h1>Crescimento</h1>
      <PermissionGate permission={READ_PERMISSION} label="o crescimento">
        <div className="cc-row" style={{ marginBottom: "1rem" }}>
          <Button variant={tab === "campaigns" ? "primary" : "secondary"} onClick={() => setTab("campaigns")}>
            Campanhas
          </Button>
          <Button variant={tab === "audiences" ? "primary" : "secondary"} onClick={() => setTab("audiences")}>
            Públicos
          </Button>
          <Button variant={tab === "attribution" ? "primary" : "secondary"} onClick={() => setTab("attribution")}>
            Atribuição
          </Button>
          <Button variant={tab === "experiments" ? "primary" : "secondary"} onClick={() => setTab("experiments")}>
            Experimentos
          </Button>
        </div>
        {tab === "campaigns" ? <CampaignsSection /> : null}
        {tab === "audiences" ? <AudiencesSection /> : null}
        {tab === "attribution" ? <AttributionSection /> : null}
        {tab === "experiments" ? <ExperimentsSection /> : null}
      </PermissionGate>
    </Shell>
  );
}

function CampaignsSection(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ items: CampaignRow[] }>("/v1/campaigns");
  const { busy, run } = useRevenueCommand();
  const [dialog, setDialog] = useState<{ path: string; title: string; label: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  const rows = data?.items ?? [];

  const confirm = (): void => {
    if (!dialog) return;
    void run(dialog.path, {}, "Comando de campanha enviado.", () => {
      setDialog(null);
      setSelectedId(null);
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
        <EmptyState title="Nenhuma campanha" hint="Campanhas de aquisição criadas pelo operador aparecem aqui." />
      ) : null}
      {rows.length > 0 ? (
        <div className="cc-grid-2">
          <Table
            columns={[
              { header: "Nome", render: (c) => <span className="cc-mono">{c.name}</span> },
              { header: "Status", render: (c) => <StatusPill status={c.status} /> },
              { header: "Atualizada em", render: (c) => formatDateTime(c.updatedAt) },
              {
                header: "Ações",
                render: (c) => (
                  <Button variant="secondary" onClick={() => setSelectedId(c.id)}>
                    Detalhe
                  </Button>
                ),
              },
            ]}
            rows={rows}
          />
          {selectedId ? <CampaignDetailPanel key={selectedId} id={selectedId} /> : (
            <EmptyState title="Selecione uma campanha" hint="Transições de ciclo de vida aparecem ao lado." />
          )}
        </div>
      ) : null}
      {canWrite && selectedId ? (
        <Card title="Transições da campanha">
          <p className="cc-mono">{selectedId}</p>
          <div className="cc-row" style={{ marginTop: "0.5rem" }}>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setDialog({ path: `/v1/campaigns/${selectedId}/activate`, title: "Ativar campanha", label: "Ativar" })}
            >
              Ativar
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setDialog({ path: `/v1/campaigns/${selectedId}/pause`, title: "Pausar campanha", label: "Pausar" })}
            >
              Pausar
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setDialog({ path: `/v1/campaigns/${selectedId}/complete`, title: "Concluir campanha", label: "Concluir" })}
            >
              Concluir
            </Button>
          </div>
        </Card>
      ) : null}
      {!canWrite ? (
        <p className="cc-muted">Você não tem a permissão crm.lead.write; transições de campanha ficam indisponíveis.</p>
      ) : null}
      <ConfirmAction
        title={dialog?.title ?? ""}
        open={dialog !== null}
        confirmLabel={dialog?.label ?? "Confirmar"}
        busy={busy}
        onClose={() => setDialog(null)}
        onConfirm={confirm}
      >
        <p className="cc-muted">O servidor valida o ciclo de vida antes de aplicar. Confirme para enviar.</p>
      </ConfirmAction>
    </div>
  );
}

function CampaignDetailPanel({ id }: { id: string }): React.JSX.Element {
  const { data, error, loading, reload } = useApi<CampaignRow>(`/v1/campaigns/${id}`);
  if (loading) return <LoadingSkeleton lines={4} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <EmptyState title="Campanha não encontrada" />;
  return (
    <Card title="Detalhe da campanha">
      <p><strong>{data.name}</strong></p>
      <p className="cc-mono">{data.campaignKey}</p>
      <div className="cc-row">
        <StatusPill status={data.status} />
        <span className="cc-muted">{data.objective ?? "sem objetivo registrado"}</span>
      </div>
      <p className="cc-muted">
        Criada em {formatDateTime(data.createdAt)} · atualizada em {formatDateTime(data.updatedAt)}
      </p>
    </Card>
  );
}

function AudiencesSection(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ items: AudienceRow[]; audiences?: AudienceRow[] }>("/v1/audiences");
  const { busy, run } = useRevenueCommand();
  const [open, setOpen] = useState(false);
  const [audienceKey, setAudienceKey] = useState("");
  const [name, setName] = useState("");
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  const rows = data?.items ?? data?.audiences ?? [];

  const confirm = (): void => {
    void run(
      "/v1/audiences",
      { audienceKey: audienceKey.trim(), ...(name.trim().length > 0 ? { name: name.trim() } : {}) },
      "Público registrado.",
      () => {
        setAudienceKey("");
        setName("");
        setOpen(false);
        reload();
      },
    );
  };

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <Button variant="secondary" onClick={reload}>
          Recarregar
        </Button>
        {canWrite ? <Button onClick={() => setOpen(true)}>Registrar público</Button> : null}
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && rows.length === 0 ? (
        <EmptyState title="Nenhum público" hint="Públicos de segmentação aparecem aqui." />
      ) : null}
      {rows.length > 0 ? (
        <Table
          columns={[
            { header: "Chave", render: (a) => <span className="cc-mono">{String(a.audienceKey ?? a.key ?? a.id).slice(0, 24)}</span> },
            { header: "Nome", render: (a) => String(a.name ?? "—") },
            { header: "Status", render: (a) => (a.status !== undefined ? <StatusPill status={String(a.status)} /> : <span className="cc-muted">—</span>) },
          ]}
          rows={rows.map((r) => ({ ...r, id: String(r.id) }))}
        />
      ) : null}
      {!canWrite ? (
        <p className="cc-muted">Você não tem a permissão crm.lead.write; registro de público fica indisponível.</p>
      ) : null}
      <ConfirmAction title="Registrar público" open={open} confirmLabel="Confirmar registro" busy={busy} onClose={() => setOpen(false)} onConfirm={confirm}>
        <Field label="Chave do público">
          <Input value={audienceKey} onChange={(e) => setAudienceKey(e.target.value)} disabled={busy} />
        </Field>
        <Field label="Nome (opcional)">
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </Field>
      </ConfirmAction>
    </div>
  );
}

function AttributionSection(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ touches?: unknown[]; conversions?: unknown[]; unattributed?: number }>("/v1/attribution");
  const { busy, run } = useRevenueCommand();
  const [open, setOpen] = useState(false);
  const [campaignId, setCampaignId] = useState("");
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  const touches = data?.touches ?? [];
  const conversions = data?.conversions ?? [];

  const confirm = (): void => {
    void run("/v1/attribution/touches", { campaignId: campaignId.trim() }, "Toque de atribuição registrado.", () => {
      setCampaignId("");
      setOpen(false);
      reload();
    });
  };

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <Button variant="secondary" onClick={reload}>
          Recarregar
        </Button>
        {canWrite ? <Button onClick={() => setOpen(true)}>Registrar toque</Button> : null}
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data ? (
        <Card title="Funil de atribuição (janela: últimos 30 dias)">
          <p>
            Toques: <strong>{touches.length}</strong> · Conversões: <strong>{conversions.length}</strong>
            {data.unattributed !== undefined ? <> · Sem atribuição: <strong>{data.unattributed}</strong></> : null}
          </p>
          <p className="cc-muted">Contagens do funil first-touch servidas pelo servidor; números sempre com janela explícita.</p>
        </Card>
      ) : null}
      {!canWrite ? (
        <p className="cc-muted">Você não tem a permissão crm.lead.write; registro de toques fica indisponível.</p>
      ) : null}
      <ConfirmAction title="Registrar toque" open={open} confirmLabel="Confirmar registro" busy={busy} onClose={() => setOpen(false)} onConfirm={confirm}>
        <Field label="ID da campanha (UUID)">
          <Input value={campaignId} onChange={(e) => setCampaignId(e.target.value)} disabled={busy} />
        </Field>
      </ConfirmAction>
    </div>
  );
}

function ExperimentsSection(): React.JSX.Element {
  const hasPermission = useOptionalHasPermission();
  const canRead = hasPermission(EXP_READ);
  const canWrite = hasPermission(EXP_WRITE);
  const { data, error, loading, reload } = useApi<{ items: ExperimentRow[]; experiments?: ExperimentRow[] }>(
    canRead ? "/v1/experiments" : null,
  );
  const { busy, run } = useRevenueCommand();
  const [dialog, setDialog] = useState<{ path: string; title: string; label: string } | null>(null);

  if (!canRead) {
    return <EmptyState title="Sem permissão para experimentos" hint="Esta seção exige a permissão experiments.read do seu perfil neste tenant." />;
  }

  const rows = data?.items ?? data?.experiments ?? [];

  const confirm = (): void => {
    if (!dialog) return;
    void run(dialog.path, {}, "Comando de experimento enviado.", () => {
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
        <EmptyState title="Nenhum experimento" hint="Experimentos de produto aparecem aqui." />
      ) : null}
      {rows.length > 0 ? (
        <Table
          columns={[
            { header: "Chave", render: (e) => <span className="cc-mono">{String(e.key ?? e.experimentKey ?? e.id).slice(0, 24)}</span> },
            { header: "Status", render: (e) => <StatusPill status={e.status} /> },
            {
              header: "Ações",
              render: (e) =>
                canWrite ? (
                  <div className="cc-row">
                    <Button variant="secondary" disabled={busy} onClick={() => setDialog({ path: `/v1/experiments/${e.id}/start`, title: "Iniciar experimento", label: "Iniciar" })}>
                      Iniciar
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => setDialog({ path: `/v1/experiments/${e.id}/stop`, title: "Parar experimento", label: "Parar" })}>
                      Parar
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => setDialog({ path: `/v1/experiments/${e.id}/complete`, title: "Concluir experimento", label: "Concluir" })}>
                      Concluir
                    </Button>
                  </div>
                ) : (
                  <span className="cc-muted">—</span>
                ),
            },
          ]}
          rows={rows.map((r) => ({ ...r, id: String(r.id) }))}
        />
      ) : null}
      {!canWrite ? (
        <p className="cc-muted">Você não tem a permissão experiments.write; transições de experimento ficam indisponíveis.</p>
      ) : null}
      <ConfirmAction
        title={dialog?.title ?? ""}
        open={dialog !== null}
        confirmLabel={dialog?.label ?? "Confirmar"}
        busy={busy}
        onClose={() => setDialog(null)}
        onConfirm={confirm}
      >
        <p className="cc-muted">O servidor valida o ciclo de vida do experimento antes de aplicar. Confirme para enviar.</p>
      </ConfirmAction>
    </div>
  );
}
