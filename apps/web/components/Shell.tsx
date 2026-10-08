"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";
import { Select } from "./ui/Input";
import { Button } from "./ui/Button";

const NAV = [
  { href: "/", label: "Painel" },
  { href: "/conversations", label: "Conversas" },
  { href: "/subscriptions", label: "Assinaturas" },
  { href: "/orders", label: "Pedidos" },
  { href: "/support", label: "Suporte" },
  { href: "/conhecimento", label: "Conhecimento" },
  { href: "/hitl", label: "Centro HITL" },
  { href: "/provider-operations", label: "Operações de Provider" },
  { href: "/copilot", label: "Copilot" },
  { href: "/crm", label: "CRM" },
  { href: "/trials", label: "Trials" },
  { href: "/billing", label: "Cobrança" },
  { href: "/fulfillment", label: "Ativação" },
  { href: "/renewals", label: "Renovações" },
  { href: "/inventory", label: "Inventário" },
  { href: "/growth", label: "Growth" },
  { href: "/referrals", label: "Indicações" },
  { href: "/resellers", label: "Revendas" },
  { href: "/finance", label: "Finanças" },
  { href: "/analytics", label: "Analytics" },
];

export function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { token, user, tenants, activeTenantId, loading, logout, switchTenant } = useAuth();
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

  return (
    <div className="cc-shell">
      <nav className="cc-sidebar" aria-label="Navegação principal">
        <strong>Control Center</strong>
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} aria-current={pathname === item.href ? "page" : undefined}>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="cc-main">
        <header className="cc-topbar">
          <label className="cc-muted" htmlFor="tenant-switcher">Tenant: {activeName}</label>
          <Select
            id="tenant-switcher"
            aria-label="Trocar de tenant"
            value={activeTenantId ?? ""}
            disabled={switching}
            onChange={(e) => void onSwitch(e.target.value)}
            style={{ maxWidth: "280px" }}
          >
            {tenants.map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.tenantName} ({t.roleKey})
              </option>
            ))}
          </Select>
          {switchError ? <span className="cc-field-error">{switchError}</span> : null}
          <span style={{ flex: 1 }} />
          <span className="cc-muted">{user?.email}</span>
          <Button variant="secondary" onClick={() => void onLogout()}>
            Sair
          </Button>
        </header>
        <main className="cc-content">{children}</main>
      </div>
    </div>
  );
}
