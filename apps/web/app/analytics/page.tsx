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
import { formatMinor } from "../../lib/money";
import { useOptionalHasPermission } from "../../lib/auth";

const READ_PERMISSION = "crm.person.read";
const RECOMPUTE_WRITE = "billing.charge.write";
const SUMMARY_READ = "support.ticket.read";

interface MetricSnapshot {
  bucket: string;
  value: Record<string, unknown>;
  valueMinor: string | null;
  computedAt: string;
  dataQuality: string;
}

interface OverviewResponse {
  metrics: Record<string, MetricSnapshot | null>;
  trackedMetrics: number;
  totalMetrics: number;
  latestComputedAt: string | null;
  dataQuality: string;
  degradedMetrics: number;
}

type Tab = "metrics" | "definitions" | "summary";

export default function AnalyticsPage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("metrics");

  return (
    <Shell>
      <h1>Analytics</h1>
      <PermissionGate permission={READ_PERMISSION} label="o analytics">
        <RecomputeBar />
        <div className="cc-row" style={{ marginBottom: "1rem" }}>
          <Button variant={tab === "metrics" ? "primary" : "secondary"} onClick={() => setTab("metrics")}>
            Métricas
          </Button>
          <Button variant={tab === "definitions" ? "primary" : "secondary"} onClick={() => setTab("definitions")}>
            Definições
          </Button>
          <Button variant={tab === "summary" ? "primary" : "secondary"} onClick={() => setTab("summary")}>
            Control-center
          </Button>
        </div>
        {tab === "metrics" ? <MetricsSection /> : null}
        {tab === "definitions" ? <DefinitionsSection /> : null}
        {tab === "summary" ? <ControlCenterSection /> : null}
      </PermissionGate>
    </Shell>
  );
}

function RecomputeBar(): React.JSX.Element {
  const { busy, run } = useRevenueCommand();
  const [open, setOpen] = useState(false);
  const hasPermission = useOptionalHasPermission();
  const canRecompute = hasPermission(RECOMPUTE_WRITE);

  if (!canRecompute) {
    return <p className="cc-muted">Você não tem a permissão billing.charge.write; recompute de métricas fica indisponível.</p>;
  }

  return (
    <div className="cc-row" style={{ marginBottom: "1rem" }}>
      <Button variant="secondary" disabled={busy} onClick={() => setOpen(true)}>
        Recalcular métricas
      </Button>
      <ConfirmAction title="Recalcular métricas do analytics" open={open} confirmLabel="Confirmar recálculo" busy={busy} onClose={() => setOpen(false)} onConfirm={() => void run("/v1/analytics/recompute", {}, "Recálculo de métricas solicitado.", () => setOpen(false))}>
        <p className="cc-muted">Snapshots diários são recalculados dos fatos canônicos. Confirme para enviar.</p>
      </ConfirmAction>
    </div>
  );
}

function MetricsSection(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<OverviewResponse>("/v1/analytics/overview");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  if (loading) return <LoadingSkeleton lines={6} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <EmptyState title="Sem métricas" />;

  const entries = Object.entries(data.metrics);

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <Button variant="secondary" onClick={reload}>
          Recarregar
        </Button>
      </div>
      <Card title={`Métricas projetadas (${data.trackedMetrics}/${data.totalMetrics}; qualidade: ${data.dataQuality})`}>
        <p className="cc-muted">Janela: bucket diário (UTC) por métrica; valores monetários em BRL com `formatMinor`.</p>
        {entries.length === 0 ? <p className="cc-muted">Nenhum snapshot projetado ainda.</p> : null}
        {entries.length > 0 ? (
          <Table
            columns={[
              { header: "Métrica", render: (r) => <span className="cc-mono">{r.key}</span> },
              {
                header: "Valor",
                render: (r) => (r.snapshot?.valueMinor !== null && r.snapshot?.valueMinor !== undefined
                  ? formatMinor(String(r.snapshot.valueMinor), "BRL")
                  : <span className="cc-mono">{JSON.stringify(r.snapshot?.value ?? null).slice(0, 60)}</span>),
              },
              { header: "Qualidade", render: (r) => <StatusPill status={r.snapshot?.dataQuality ?? "EMPTY"} /> },
              {
                header: "Ações",
                render: (r) => (
                  <Button variant="secondary" onClick={() => setSelectedKey(r.key)}>
                    Detalhe
                  </Button>
                ),
              },
            ]}
            rows={entries.map(([key, snapshot]) => ({ id: key, key, snapshot }))}
          />
        ) : null}
      </Card>
      {selectedKey ? <MetricDetailPanel metricKey={selectedKey} /> : null}
    </div>
  );
}

function MetricDetailPanel({ metricKey }: { metricKey: string }): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ value?: Record<string, unknown>; valueMinor?: string | null; dataQuality?: string }>(`/v1/metrics/${encodeURIComponent(metricKey)}`);
  if (loading) return <LoadingSkeleton lines={4} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <EmptyState title="Métrica não encontrada" />;
  return (
    <Card title={`Métrica ${metricKey} (bucket diário UTC)`}>
      <p>
        Valor: <strong>{data.valueMinor ? formatMinor(data.valueMinor, "BRL") : <span className="cc-mono">{JSON.stringify(data.value ?? null).slice(0, 120)}</span>}</strong>
      </p>
      <p className="cc-muted">Qualidade: {data.dataQuality ?? "—"} · somente leitura (fonte canônica, nunca verdade).</p>
    </Card>
  );
}

function DefinitionsSection(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ items?: Array<Record<string, unknown>>; seeded?: boolean }>("/v1/metrics");

  const items = data?.items ?? [];
  const tableRows: Array<{ id: string } & Record<string, unknown>> = items.map((d, i) => ({ id: String(i), ...d }));

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
        <EmptyState title="Sem definições" hint="O catálogo de métricas (fórmula + versão) aparece aqui." />
      ) : null}
      {items.length > 0 ? (
        <Table
          columns={[
            { header: "Chave", render: (d) => <span className="cc-mono">{String(d.key ?? "?").slice(0, 32)}</span> },
            { header: "Família", render: (d) => String(d.family ?? "—") },
            { header: "Fórmula", render: (d) => <span className="cc-mono">{String(d.formulaRef ?? d.formula_version ?? "—").slice(0, 60)}</span> },
          ]}
          rows={tableRows}
        />
      ) : null}
    </div>
  );
}

function ControlCenterSection(): React.JSX.Element {
  const hasPermission = useOptionalHasPermission();
  const canRead = hasPermission(SUMMARY_READ);
  const { data, error, loading, reload } = useApi<Record<string, unknown>>(canRead ? "/v1/control-center/summary" : null);
  const [query, setQuery] = useState("");

  if (!canRead) {
    return <EmptyState title="Sem permissão para o resumo" hint="Esta seção exige a permissão support.ticket.read do seu perfil neste tenant." />;
  }

  const sections = data ? Object.entries(data).filter(([k]) => k !== "degradedSections") : [];
  const degraded = (data?.degradedSections ?? []) as string[];
  const filtered = query.trim().length > 0
    ? sections.filter(([k]) => k.toLowerCase().includes(query.trim().toLowerCase()))
    : sections;

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <Button variant="secondary" onClick={reload}>
          Recarregar
        </Button>
        <Field label="Filtrar seção">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ex.: business" style={{ maxWidth: "240px" }} />
        </Field>
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data ? (
        <Card title={`Resumo operacional (seções degradadas: ${degraded.length})`}>
          {filtered.length === 0 ? <p className="cc-muted">Nenhuma seção corresponde ao filtro.</p> : null}
          <ul>
            {filtered.map(([k, v]) => (
              <li key={k}>
                <span className="cc-mono">{k}</span>: <span className="cc-muted">{JSON.stringify(v).slice(0, 120)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
