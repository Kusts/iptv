"use client";

import Link from "next/link";
import {
  Tv,
  Zap,
  ShieldAlert,
  CreditCard,
  MessageSquare,
  ShoppingCart,
  LifeBuoy,
  TrendingUp,
  Gift,
  Briefcase,
  DollarSign,
  BarChart3,
  ArrowRight,
} from "lucide-react";
import { NeedsAttention } from "../components/NeedsAttention";
import { Shell } from "../components/Shell";
import { Card } from "../components/ui/Card";
import { EmptyState, ErrorState, LoadingSkeleton } from "../components/ui/States";
import { useApi } from "../lib/useApi";
import { useOptionalHasPermission } from "../lib/auth";
import type { HealthResponse } from "../lib/api";

const QUICK_ACTIONS = [
  { href: "/conversations", label: "Conversas", desc: "Assumir, devolver e responder manualmente", icon: MessageSquare },
  { href: "/subscriptions", label: "Assinaturas", desc: "Estado projetado e ciclos vigentes", icon: Tv },
  { href: "/orders", label: "Pedidos", desc: "Cotações, ordens e totais", icon: ShoppingCart },
  { href: "/support", label: "Suporte", desc: "Tickets, meu trabalho e resolução", icon: LifeBuoy },
  { href: "/hitl", label: "Centro HITL", desc: "Fila de revisão humana com controle de SLA", icon: ShieldAlert },
  { href: "/growth", label: "Crescimento", desc: "Campanhas, públicos e experimentos", icon: TrendingUp },
  { href: "/referrals", label: "Indicações", desc: "Indicações, recompensas e gift-pass", icon: Gift },
  { href: "/resellers", label: "Revendedores", desc: "Parceiros, rede, créditos e pedidos", icon: Briefcase },
  { href: "/finance", label: "Finanças", desc: "Contribuição, CAC e visão econômica", icon: DollarSign },
  { href: "/analytics", label: "Analytics", desc: "Métricas projetadas e control-center", icon: BarChart3 },
];

export default function Home(): React.JSX.Element {
  return (
    <Shell>
      <div className="cc-dashboard-header">
        <div>
          <h1 className="cc-dashboard-title">Painel — Torre de Controle</h1>
          <p className="cc-dashboard-subtitle">
            Monitoramento operacional em tempo real de assinaturas, atendimento e infraestrutura IPTV.
          </p>
        </div>
        <div className="cc-telemetry-badge">
          <span className="cc-telemetry-indicator" aria-hidden="true" />
          <span>Serviços Operacionais</span>
        </div>
      </div>

      {/* KPI Cards em Grid */}
      <div className="cc-kpi-grid">
        <Link href="/subscriptions" className="cc-kpi-card">
          <div className="cc-kpi-card-header">
            <span className="cc-kpi-card-title">Assinaturas</span>
            <div className="cc-kpi-icon">
              <Tv size={18} />
            </div>
          </div>
          <div className="cc-kpi-value">Ativas & Ciclos</div>
          <div className="cc-kpi-footer">
            <span>Gestão e cancelamento</span>
            <span className="cc-kpi-link">
              Ver assinaturas <ArrowRight size={13} />
            </span>
          </div>
        </Link>

        <Link href="/fulfillment" className="cc-kpi-card">
          <div className="cc-kpi-card-header">
            <span className="cc-kpi-card-title">Ativação & Streaming</span>
            <div className="cc-kpi-icon">
              <Zap size={18} />
            </div>
          </div>
          <div className="cc-kpi-value">Fulfillment</div>
          <div className="cc-kpi-footer">
            <span>Provisionamento de linhas</span>
            <span className="cc-kpi-link">
              Operações <ArrowRight size={13} />
            </span>
          </div>
        </Link>

        <Link href="/hitl" className="cc-kpi-card">
          <div className="cc-kpi-card-header">
            <span className="cc-kpi-card-title">Revisão Humana</span>
            <div className="cc-kpi-icon">
              <ShieldAlert size={18} />
            </div>
          </div>
          <div className="cc-kpi-value">Centro HITL</div>
          <div className="cc-kpi-footer">
            <span>Decisão de exceções</span>
            <span className="cc-kpi-link">
              Fila de revisão <ArrowRight size={13} />
            </span>
          </div>
        </Link>

        <Link href="/billing" className="cc-kpi-card">
          <div className="cc-kpi-card-header">
            <span className="cc-kpi-card-title">Receita & Cobrança</span>
            <div className="cc-kpi-icon">
              <CreditCard size={18} />
            </div>
          </div>
          <div className="cc-kpi-value">Financeiro PIX</div>
          <div className="cc-kpi-footer">
            <span>Cobranças e reembolsos</span>
            <span className="cc-kpi-link">
              Cobranças <ArrowRight size={13} />
            </span>
          </div>
        </Link>
      </div>

      {/* Fila de Ação Prioritária (Precisa de você) */}
      <NeedsAttention />

      {/* Telemetria de Infraestrutura & Resumo em Grid */}
      <div className="cc-telemetry-grid">
        <HealthCard />
        <HomeAnalyticsCard />
      </div>

      {/* Atalhos Operacionais Modernizados */}
      <Card title="Atalhos operacionais">
        <div className="cc-quick-grid">
          {QUICK_ACTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} className="cc-quick-item">
                <div className="cc-quick-item-icon">
                  <Icon size={16} />
                </div>
                <div>
                  <div className="cc-quick-item-title">{item.label}</div>
                  <div className="cc-quick-item-desc">{item.desc}</div>
                </div>
              </Link>
            );
          })}
        </div>
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
      <div className="cc-row cc-u-mb-2">
        <span className="cc-badge cc-badge-success">
          <span className="cc-badge-dot" aria-hidden="true" />
          {data.status}
        </span>
        <span className="cc-muted">Versão:</span>
        <span className="cc-mono">{data.version}</span>
      </div>
      <p className="cc-muted cc-u-m-0">
        Agendador: <strong>{data.scheduler}</strong> (tick {data.tickSeconds}s) · request{" "}
        <span className="cc-mono">{data.requestId.slice(0, 8)}…</span>
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
      <p className="cc-muted cc-u-mb-2">
        <strong>{sections.length}</strong> seções monitoradas ·{" "}
        <span className={degraded.length > 0 ? "cc-badge cc-badge-danger" : "cc-badge cc-badge-success"}>
          <span className="cc-badge-dot" aria-hidden="true" />
          {degraded.length} degradadas
        </span>{" "}
        · <Link href="/analytics">ver Analytics</Link>
      </p>
      {degraded.length > 0 ? (
        <p className="cc-muted">Degradadas: {degraded.join(", ").slice(0, 160)}</p>
      ) : (
        <EmptyState title="Sem degradação" hint="Todas as seções do control-center responderam." />
      )}
    </Card>
  );
}
