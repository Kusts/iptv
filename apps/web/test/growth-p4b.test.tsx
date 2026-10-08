import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import GrowthPage from "../app/growth/page";
import ReferralsPage from "../app/referrals/page";
import ResellersPage from "../app/resellers/page";
import FinancePage from "../app/finance/page";
import AnalyticsPage from "../app/analytics/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

beforeEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  clearApiCache();
});

function sessionMocks(permissions: string[], routes: Record<string, unknown>, seen: { posts: string[] }): void {
  window.localStorage.setItem("iptv.session_token", "tok-p4b");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/v1/auth/session")) {
        return jsonResponse(200, {
          user: { id: "u1", email: "op@tenant.com", displayName: null },
          activeTenantId: "t1",
          tenantContextRevision: "1",
          memberships: [],
        });
      }
      if ((init?.method ?? "GET") === "POST") {
        seen.posts.push(url);
        return jsonResponse(200, {});
      }
      // Rotas primeiro: `/v1/metrics/...` contém `/v1/me` como substring
      // ("me" de "metrics") — o fallback de sessão/me vem depois.
      const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
      for (const [key, body] of ordered) {
        if (url.includes(key)) return jsonResponse(200, body);
      }
      if (url.includes("/v1/me")) {
        return jsonResponse(200, {
          user: { id: "u1", email: "op@tenant.com" },
          activeTenant: { id: "t1" },
          roleKeys: [],
          permissions,
        });
      }
      return jsonResponse(404, { code: "NOT_FOUND" });
    }),
  );
}

function renderPage(page: ReactNode): void {
  render(
    <AuthProvider>
      <ToastProvider>{page}</ToastProvider>
    </AuthProvider>,
  );
}

describe("Growth", () => {
  it("lista campanhas e ativa com confirmação", async () => {
    const seen = { posts: [] as string[] };
    sessionMocks(["crm.person.read", "crm.lead.write"], {
      "/v1/campaigns/c1": {
        id: "c1", campaignKey: "cmp-1", name: "Aquisição Q4", objective: "ACQ",
        status: "DRAFT", currentVersionId: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
      "/v1/campaigns": {
        items: [{
          id: "c1", campaignKey: "cmp-1", name: "Aquisição Q4", objective: "ACQ",
          status: "DRAFT", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }],
      },
    }, seen);
    renderPage(<GrowthPage />);
    await waitFor(() => expect(screen.getByText("Aquisição Q4")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByText("cmp-1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Ativar" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Ativar campanha");
    fireEvent.click(within(dialog).getByRole("button", { name: "Ativar" }));
    await waitFor(() => expect(screen.getByText("Comando de campanha enviado.")).toBeTruthy());
    expect(seen.posts.some((u) => u.includes("/v1/campaigns/c1/activate"))).toBe(true);
  });

  it("sem permissão de leitura exibe gate", async () => {
    const seen = { posts: [] as string[] };
    sessionMocks([], {}, seen);
    renderPage(<GrowthPage />);
    await waitFor(() => expect(screen.getByText(/Sem permissão para o crescimento/)).toBeTruthy());
  });
});

describe("Referrals", () => {
  it("lista recompensas por cliente e resgata com confirmação", async () => {
    const seen = { posts: [] as string[] };
    sessionMocks(["crm.person.read", "commerce.order.write"], {
      "/v1/customers/c9/rewards": {
        rewards: [{
          id: "r1", status: "AVAILABLE", amountMinor: "5000", currency: "BRL",
          createdAt: new Date().toISOString(),
        }],
      },
    }, seen);
    renderPage(<ReferralsPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Indicações" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Recompensas" }));
    fireEvent.change(screen.getByPlaceholderText("UUID do cliente"), { target: { value: "c9" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar recompensas" }));
    await waitFor(() => expect(screen.getByText("R$ 50,00")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Resgatar" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Resgatar recompensa");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar resgate" }));
    await waitFor(() => expect(screen.getByText("Resgate de recompensa enviado.")).toBeTruthy());
    expect(seen.posts.some((u) => u.includes("/v1/rewards/r1/redeem"))).toBe(true);
  });
});

describe("Resellers", () => {
  it("consulta rede do parceiro e recarrega crédito com confirmação", async () => {
    const seen = { posts: [] as string[] };
    sessionMocks(["crm.person.read", "commerce.order.write"], {
      "/v1/partners/p1/network": { directChildren: [] },
      "/v1/partners/p1/credits": { partnerAccountId: "p1", balances: [{ currency: "BRL", availableMinor: "10000" }] },
      "/v1/partners": { items: [] },
    }, seen);
    renderPage(<ResellersPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Revendedores" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Rede e créditos" }));
    fireEvent.change(screen.getByPlaceholderText("UUID do parceiro"), { target: { value: "p1" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar rede" }));
    await waitFor(() => expect(screen.getByText("R$ 100,00")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Recarregar crédito" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Recarregar crédito");
    fireEvent.change(within(dialog).getByLabelText("Valor (minor units, ex.: 10000 = R$ 100,00)"), { target: { value: "10000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar recarga" }));
    await waitFor(() => expect(screen.getByText("Crédito do parceiro recarregado.")).toBeTruthy());
    expect(seen.posts.some((u) => u.includes("/v1/partners/p1/credits/topup"))).toBe(true);
  });
});

describe("Finance", () => {
  it("recalcula projeções com confirmação e exibe CAC com janela", async () => {
    const seen = { posts: [] as string[] };
    sessionMocks(["billing.read", "billing.charge.write"], {
      "/v1/metrics/cac": { cacMinor: "2500", currency: "BRL", window: "30d" },
    }, seen);
    renderPage(<FinancePage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Finanças" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Recalcular projeções" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Recalcular projeções financeiras");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar recálculo" }));
    await waitFor(() => expect(screen.getByText("Recálculo financeiro solicitado.")).toBeTruthy());
    expect(seen.posts.some((u) => u.includes("/v1/finance/recompute"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "CAC" }));
    await waitFor(() => expect(screen.getByText("R$ 25,00")).toBeTruthy());
  });
});

describe("Analytics", () => {
  it("lista métricas projetadas e recalcula com confirmação", async () => {
    const seen = { posts: [] as string[] };
    sessionMocks(["crm.person.read", "billing.charge.write"], {
      "/v1/analytics/overview": {
        metrics: {
          "acq.touches": {
            bucket: new Date().toISOString(), value: { count: 12 }, valueMinor: null,
            computedAt: new Date().toISOString(), dataQuality: "OK",
          },
        },
        trackedMetrics: 1, totalMetrics: 20,
        latestComputedAt: new Date().toISOString(), dataQuality: "OK", degradedMetrics: 0,
      },
    }, seen);
    renderPage(<AnalyticsPage />);
    await waitFor(() => expect(screen.getByText("acq.touches")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Recalcular métricas" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Recalcular métricas do analytics");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar recálculo" }));
    await waitFor(() => expect(screen.getByText("Recálculo de métricas solicitado.")).toBeTruthy());
    expect(seen.posts.some((u) => u.includes("/v1/analytics/recompute"))).toBe(true);
  });
});
