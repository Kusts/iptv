"use client";

import Link from "next/link";
import { NeedsAttention } from "../components/NeedsAttention";
import { Shell } from "../components/Shell";
import { Card } from "../components/ui/Card";
import { EmptyState, ErrorState, LoadingSkeleton } from "../components/ui/States";
import { useApi } from "../lib/useApi";
import { useOptionalHasPermission } from "../lib/auth";
import type { HealthResponse } from "../lib/api";

export default function Home(): React.JSX.Element {
  return (
    <Shell>
      <h1>Painel</h1>
      <HealthCard />
      <NeedsAttention />
      <HomeAnalyticsCard />
      <Card title="Atalhos operacionais">
        <ul>
          <li><Link href="/conversations">Conversas</Link> — assumir, devolver e responder manualmente.</li>
          <li><Link href="/subscriptions">Assinaturas</Link> — estado projetado e ciclos.</li>
          <li><Link href="/orders">Pedidos</Link> — status e totais.</li>
          <li><Link href="/support">Suporte</Link> — tickets, meu trabalho e resolução.</li>
          <li><Link href="/hitl">Centro HITL</Link> — fila de revisão humana com SLA.</li>
          <li><Link href="/growth">Crescimento</Link> — campanhas, públicos, atribuição e experimentos.</li>
          <li><Link href="/referrals">Indicações</Link> — indicações, recompensas e gift-pass.</li>
          <li><Link href="/resellers">Revendedores</Link> — parceiros, rede, créditos e pedidos.</li>
          <li><Link href="/finance">Finanças</Link> — contribuição, CAC, coortes e visão geral.</li>
          <li><Link href="/analytics">Analytics</Link> — métricas projetadas e control-center.</li>
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

/**
 * P4b — resumo analytics no lar: contagens do control-center com degradação
 * explícita. Renderiza somente com `support.ticket.read`; sem ela, nada é
 * exibido (sem chamada à API).
 */
function HomeAnalyticsCard(): React.JSX.Element {
  const hasPermission = useOptionalHasPermission();
  const canRead = hasPermission("support.ticket.read");
  const { data, error, loading, reload } = useApi<{ degradedSections?: string[] } & Record<string, unknown>>(
    canRead ? "/v1/control-center/summary" : null,
  );

  if (!canRead) return <></>;
  if (loading) return <LoadingSkeleton lines={3} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <></>;
  const degraded = data.degradedSections ?? [];
  const sections = Object.keys(data).filter((k) => k !== "degradedSections");
  return (
    <Card title="Resumo operacional">
      <p className="cc-muted">
        {sections.length} seções · {degraded.length} degradadas · <Link href="/analytics">ver Analytics</Link>
      </p>
      {degraded.length > 0 ? (
        <p className="cc-muted">Degradadas: {degraded.join(", ").slice(0, 160)}</p>
      ) : (
        <EmptyState title="Sem degradação" hint="Todas as seções do control-center responderam." />
      )}
    </Card>
  );
}
