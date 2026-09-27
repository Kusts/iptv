"use client";

import { useState } from "react";
import { Shell } from "../../components/Shell";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/Badge";
import { Table } from "../../components/ui/Table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../components/ui/States";
import { Field, Select } from "../../components/ui/Input";
import { useApi } from "../../lib/useApi";
import { formatDateTime } from "../../lib/money";
import { api, userMessage } from "../../lib/api";
import { useToast } from "../../components/ui/Toast";
import type { TicketDetail, TicketRow } from "../../lib/api";

export default function SupportPage(): React.JSX.Element {
  const [tab, setTab] = useState<"all" | "mine">("all");
  const path = tab === "all" ? "/v1/tickets" : "/v1/tickets/my-work";
  const { data, error, loading, reload } = useApi<{ tickets: TicketRow[] }>(path);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <Shell>
      <h1>Suporte</h1>
      <div className="cc-row">
        <Button variant={tab === "all" ? "primary" : "secondary"} onClick={() => { setTab("all"); setSelectedId(null); }}>
          Todos
        </Button>
        <Button variant={tab === "mine" ? "primary" : "secondary"} onClick={() => { setTab("mine"); setSelectedId(null); }}>
          Meu trabalho
        </Button>
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && data.tickets.length === 0 ? (
        <EmptyState title="Nenhum ticket" hint="Tickets abertos pelo time ou pelo agente aparecem aqui." />
      ) : null}
      {data && data.tickets.length > 0 ? (
        <div className="cc-grid-2">
          <Table
            columns={[
              { header: "Resumo", render: (t) => t.summary.slice(0, 60) },
              { header: "Status", render: (t) => <StatusPill status={t.status} /> },
              { header: "Prioridade", render: (t) => t.priority },
              {
                header: "Ações",
                render: (t) => (
                  <Button variant="secondary" onClick={() => setSelectedId(t.id)}>
                    Abrir
                  </Button>
                ),
              },
            ]}
            rows={data.tickets}
          />
          {selectedId ? <TicketDetailPanel key={selectedId} id={selectedId} /> : <EmptyState title="Selecione um ticket" />}
        </div>
      ) : null}
    </Shell>
  );
}

function TicketDetailPanel({ id }: { id: string }): React.JSX.Element {
  const { data, error, loading, reload } = useApi<TicketDetail>(`/v1/tickets/${id}`);
  const { push } = useToast();
  const [outcome, setOutcome] = useState("SUCCEEDED");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const resolve = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      await api.post(`/v1/tickets/${id}/resolve`, { outcome });
      push("Ticket resolvido.");
      reload();
    } catch (err) {
      setMsg(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingSkeleton lines={4} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <EmptyState title="Ticket não encontrado" />;
  const t = data.ticket;
  return (
    <Card title="Detalhe do ticket">
      <p>{t.summary}</p>
      <div className="cc-row">
        <StatusPill status={t.status} />
        <span className="cc-muted">{t.priority} · {t.category}</span>
        <span className="cc-muted">Criado em {formatDateTime(t.createdAt)}</span>
      </div>
      <h4>Tentativas de solução ({data.attempts.length})</h4>
      {data.attempts.length === 0 ? (
        <p className="cc-muted">Nenhuma tentativa registrada. A resolução exige uma tentativa com resultado SUCCEEDED ou PARTIAL.</p>
      ) : (
        <ul>
          {data.attempts.map((a) => (
            <li key={a.id}>
              #{a.attemptNo} <StatusPill status={a.outcome} /> <span className="cc-muted">{a.actorType}</span>
            </li>
          ))}
        </ul>
      )}
      <h4>Resolver</h4>
      <div className="cc-form">
        <Field label="Resultado da solução">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)} disabled={busy}>
            <option value="SUCCEEDED">SUCCEEDED — funcionou</option>
            <option value="PARTIAL">PARTIAL — funcionou em parte</option>
            <option value="FAILED">FAILED — não funcionou</option>
            <option value="INCONCLUSIVE">INCONCLUSIVE — inconclusivo</option>
          </Select>
        </Field>
        <Button disabled={busy} onClick={() => void resolve()}>
          {busy ? "Resolvendo…" : "Resolver ticket"}
        </Button>
        {msg ? <p className="cc-muted">{msg}</p> : null}
      </div>
    </Card>
  );
}
