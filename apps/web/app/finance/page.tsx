"use client";

import { useState } from "react";
import { Shell } from "../../components/Shell";
import { ConfirmAction, PermissionGate, useRevenueCommand } from "../../components/RevenueOps";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Table } from "../../components/ui/Table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../components/ui/States";
import { Field, Input } from "../../components/ui/Input";
import { useApi } from "../../lib/useApi";
import { formatMinor } from "../../lib/money";
import { useOptionalHasPermission } from "../../lib/auth";

const READ_PERMISSION = "billing.read";
const RECOMPUTE_WRITE = "billing.charge.write";

type Tab = "contribution" | "cac" | "cohorts" | "overview";

export default function FinancePage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("contribution");

  return (
    <Shell>
      <h1>Finanças</h1>
      <PermissionGate permission={READ_PERMISSION} label="as finanças">
        <RecomputeBar />
        <div className="cc-row" style={{ marginBottom: "1rem" }}>
          <Button variant={tab === "contribution" ? "primary" : "secondary"} onClick={() => setTab("contribution")}>
            Contribuição
          </Button>
          <Button variant={tab === "cac" ? "primary" : "secondary"} onClick={() => setTab("cac")}>
            CAC
          </Button>
          <Button variant={tab === "cohorts" ? "primary" : "secondary"} onClick={() => setTab("cohorts")}>
            Coortes
          </Button>
          <Button variant={tab === "overview" ? "primary" : "secondary"} onClick={() => setTab("overview")}>
            Visão geral
          </Button>
        </div>
        {tab === "contribution" ? <ContributionSection /> : null}
        {tab === "cac" ? <CacSection /> : null}
        {tab === "cohorts" ? <CohortsSection /> : null}
        {tab === "overview" ? <OverviewSection /> : null}
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
    return <p className="cc-muted">Você não tem a permissão billing.charge.write; recompute fica indisponível.</p>;
  }

  return (
    <div className="cc-row" style={{ marginBottom: "1rem" }}>
      <Button variant="secondary" disabled={busy} onClick={() => setOpen(true)}>
        Recalcular projeções
      </Button>
      <ConfirmAction title="Recalcular projeções financeiras" open={open} confirmLabel="Confirmar recálculo" busy={busy} onClose={() => setOpen(false)} onConfirm={() => void run("/v1/finance/recompute", {}, "Recálculo financeiro solicitado.", () => setOpen(false))}>
        <p className="cc-muted">O servidor recalcula as projeções de forma idempotente. Confirme para enviar.</p>
      </ConfirmAction>
    </div>
  );
}

function ContributionSection(): React.JSX.Element {
  const [customerId, setCustomerId] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const qs = activeId ? `/v1/finance/contribution?customerId=${encodeURIComponent(activeId)}` : null;
  const { data, error, loading, reload } = useApi<Record<string, unknown>>(qs);

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
          Consultar contribuição
        </Button>
      </div>
      {activeId === null ? (
        <EmptyState title="Informe o cliente" hint="Margem de contribuição é consultada por cliente (escopo permissionado)." />
      ) : null}
      {loading ? <LoadingSkeleton lines={4} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data ? <MoneyFactsCard title="Contribuição do cliente (BRL; janela: acumulado do cliente)" payload={data} /> : null}
    </div>
  );
}

function CacSection(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<Record<string, unknown>>("/v1/metrics/cac");

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <Button variant="secondary" onClick={reload}>
          Recarregar
        </Button>
      </div>
      {loading ? <LoadingSkeleton lines={4} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data ? <MoneyFactsCard title="CAC (BRL; janela: últimos 30 dias)" payload={data} /> : null}
    </div>
  );
}

function CohortsSection(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ cohorts?: Array<Record<string, unknown>>; dataQuality?: string }>("/v1/metrics/cohorts");

  const cohorts = data?.cohorts ?? [];
  const tableRows: Array<{ id: string } & Record<string, unknown>> = cohorts.map((c, i) => ({ id: String(i), ...c }));

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <Button variant="secondary" onClick={reload}>
          Recarregar
        </Button>
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && cohorts.length === 0 ? (
        <EmptyState title="Sem coortes" hint={data.dataQuality === "EMPTY" ? "Nenhum dado de coorte projetado ainda." : "Coortes aparecem aqui quando houver dados."} />
      ) : null}
      {cohorts.length > 0 ? (
        <Table
          columns={[
            { header: "Coorte", render: (c) => <span className="cc-mono">{String(c.cohort ?? c.key ?? "?").slice(0, 24)}</span> },
            { header: "Qualidade", render: (c) => <span className="cc-muted">{String(data?.dataQuality ?? c.dataQuality ?? "—")}</span> },
            { header: "Detalhe", render: (c) => <span className="cc-mono">{JSON.stringify(c).slice(0, 80)}</span> },
          ]}
          rows={tableRows}
        />
      ) : null}
    </div>
  );
}

function OverviewSection(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<Record<string, unknown>>("/v1/metrics/overview");

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <Button variant="secondary" onClick={reload}>
          Recarregar
        </Button>
      </div>
      {loading ? <LoadingSkeleton lines={4} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data ? <MoneyFactsCard title="Visão geral econômica (BRL; janela: acumulado do tenant)" payload={data} /> : null}
    </div>
  );
}

/**
 * Totais monetários com moeda explícita: chaves `*minor` usam `formatMinor`;
 * demais valores são exibidos crus com a moeda do payload quando presente.
 */
function MoneyFactsCard({ title, payload }: { title: string; payload: Record<string, unknown> }): React.JSX.Element {
  const currency = typeof payload.currency === "string" ? payload.currency : "BRL";
  const entries = Object.entries(payload).slice(0, 12);
  return (
    <Card title={title}>
      <ul>
        {entries.map(([k, v]) => (
          <li key={k}>
            <span className="cc-muted">{k}:</span>{" "}
            <strong>{/minor/i.test(k) && (typeof v === "string" || typeof v === "number") ? formatMinor(v, currency) : (typeof v === "object" ? JSON.stringify(v) : String(v ?? "—")).slice(0, 80)}</strong>
          </li>
        ))}
      </ul>
    </Card>
  );
}
