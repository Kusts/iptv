"use client";

import Link from "next/link";
import { Shell } from "../components/Shell";
import { Card } from "../components/ui/Card";
import { EmptyState, ErrorState, LoadingSkeleton } from "../components/ui/States";
import { useApi } from "../lib/useApi";
import type { HealthResponse } from "../lib/api";

export default function Home(): React.JSX.Element {
  return (
    <Shell>
      <h1>Painel</h1>
      <HealthCard />
      <Card title="Atalhos operacionais">
        <ul>
          <li><Link href="/conversations">Conversas</Link> — assumir, devolver e responder manualmente.</li>
          <li><Link href="/subscriptions">Assinaturas</Link> — estado projetado e ciclos.</li>
          <li><Link href="/orders">Pedidos</Link> — status e totais.</li>
          <li><Link href="/support">Suporte</Link> — tickets, meu trabalho e resolução.</li>
          <li><Link href="/hitl">Centro HITL</Link> — fila de revisão humana com SLA.</li>
        </ul>
      </Card>
    </Shell>
  );
}

function HealthCard(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<HealthResponse>("/v1/health");
  if (loading) return <LoadingSkeleton lines={3} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <EmptyState title="Sem dados de saúde" />;
  return (
    <Card title="Saúde da API">
      <p>
        Status: <strong>{data.status}</strong> · Versão: <span className="cc-mono">{data.version}</span>
      </p>
      <p className="cc-muted">
        Agendador: {data.scheduler} (tick {data.tickSeconds}s) · request {data.requestId}
      </p>
    </Card>
  );
}
