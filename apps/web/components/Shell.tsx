"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  BarChart3,
  MessageSquare,
  Users,
  LifeBuoy,
  Settings,
  Tv,
  Zap,
  Server,
  Boxes,
  PlayCircle,
  ShieldAlert,
  Bot,
  BookOpen,
  ShoppingCart,  CreditCard,
  DollarSign,
  RefreshCw,
  Briefcase,
  Gift,
  TrendingUp,
  Sun,
  Moon,
  LogOut,
  Radio,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";
import { useTheme } from "../lib/theme";
import { Select } from "./ui/Input";
import { Button } from "./ui/Button";
import { CopilotWidget } from "./CopilotWidget";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    title: "Visão Geral",
    items: [
      { href: "/", label: "Painel", icon: LayoutDashboard },
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
    ],
  },
  {
    title: "Atendimento & Clientes",
    items: [
      { href: "/conversations", label: "Conversas", icon: MessageSquare },
      { href: "/crm", label: "CRM", icon: Users },
      { href: "/support", label: "Suporte", icon: LifeBuoy },
    ],
  },
  {
    title: "Operações IPTV",
    items: [
      { href: "/subscriptions", label: "Assinaturas", icon: Tv },
      { href: "/fulfillment", label: "Ativação", icon: Zap },
      { href: "/provider-operations", label: "Operações de Provider", icon: Server },
      { href: "/inventory", label: "Inventário", icon: Boxes },
      { href: "/trials", label: "Trials", icon: PlayCircle },
    ],
  },
  {
    title: "Configurações",
    items: [{ href: "/settings/integrations", label: "Integrações", icon: Settings }],
  },
  {
    title: "IA & Supervisão",
    items: [
      { href: "/hitl", label: "Centro HITL", icon: ShieldAlert },
      { href: "/copilot", label: "Copilot", icon: Bot },
      { href: "/conhecimento", label: "Conhecimento", icon: BookOpen },
    ],
  },
  {
    title: "Receita & Crescimento",
    items: [
      { href: "/orders", label: "Pedidos", icon: ShoppingCart },
      { href: "/billing", label: "Cobrança", icon: CreditCard },
      { href: "/finance", label: "Finanças", icon: DollarSign },
      { href: "/renewals", label: "Renovações", icon: RefreshCw },
      { href: "/resellers", label: "Revendas", icon: Briefcase },
      { href: "/referrals", label: "Indicações", icon: Gift },
      { href: "/growth", label: "Growth", icon: TrendingUp },
    ],
  },
];

export function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { token, user, tenants, activeTenantId, loading, logout, switchTenant } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const pathname = usePathname();
  const router = useRouter();
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && token === null) router.replace("/login");
  }, [loading, token, router]);

  if (loading) return <main className="cc-content"><p>Carregando sessão…</p></main>;
  if (token === null) return <main className="cc-content"><p>Redirecionando para o login…</p></main>;

  const onSwitch = async (tenantId: string): Promise<void> => {
    if (tenantId === activeTenantId) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      await switchTenant(tenantId);
    } catch (err) {
      // Conflito de troca concorrente: o tenant atual foi cometido (estado
      // autoritativo) e a mensagem específica orienta o operador; demais
      // falhas mantêm o erro genérico.
      setSwitchError(
        err instanceof ApiError && err.code === "TENANT_SWITCH_CONFLICT"
          ? err.message
          : "Não foi possível trocar de tenant.",
      );
    } finally {
      setSwitching(false);
    }
  };

  const onLogout = async (): Promise<void> => {
    await logout();
    router.replace("/login");
  };

  const activeName = tenants.find((t) => t.tenantId === activeTenantId)?.tenantName ?? "—";
  const userInitial = (user?.email?.[0] ?? "U").toUpperCase();

  return (
    <div className="cc-shell">
      <nav className="cc-sidebar" aria-label="Navegação principal">
        <div className="cc-sidebar-brand">
          <div className="cc-brand-title">
            <Radio className="cc-nav-icon cc-brand-icon" />
            <span>Control Center</span>
          </div>
          <span className="cc-brand-badge">Piloto</span>
        </div>

        <div className="cc-sidebar-nav">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title}>
              <div className="cc-nav-section-title">{section.title}</div>
              {section.items.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <Icon className="cc-nav-icon" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      </nav>

      <div className="cc-main">
        <header className="cc-topbar">
          <div className="cc-topbar-tenant">
            <label className="cc-topbar-tenant-label" htmlFor="tenant-switcher">
              Tenant: {activeName}
            </label>
            <Select
              id="tenant-switcher"
              aria-label="Trocar de tenant"
              value={activeTenantId ?? ""}
              disabled={switching}
              onChange={(e) => void onSwitch(e.target.value)}
              className="cc-u-maxw-280"
            >
              {tenants.map((t) => (
                <option key={t.tenantId} value={t.tenantId}>
                  {t.tenantName} ({t.roleKey})
                </option>
              ))}
            </Select>
          </div>

          {switchError ? <span className="cc-field-error">{switchError}</span> : null}

          <span className="cc-u-flex-1" />

          <Button
            variant="secondary"
            onClick={toggleTheme}
            aria-label="Alternar tema claro e escuro"
            title={theme === "dark" ? "Mudar para modo claro" : "Mudar para modo escuro"}
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </Button>

          <div className="cc-topbar-user">
            <div className="cc-user-avatar">{userInitial}</div>
            <span className="cc-muted">{user?.email}</span>
          </div>

          <Button variant="secondary" onClick={() => void onLogout()}>
            <LogOut size={14} />
            <span>Sair</span>
          </Button>
        </header>

        <main className="cc-content">{children}</main>
        <CopilotWidget />
      </div>
    </div>
  );
}
