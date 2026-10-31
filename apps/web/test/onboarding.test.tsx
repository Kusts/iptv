import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import OnboardingPage from "../app/settings/onboarding/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/onboarding",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const SESSION_OK = {
  user: { id: "u1", email: "op@tenant.com", displayName: null },
  activeTenantId: "t1",
  tenantContextRevision: "1",
  memberships: [],
};

interface Fixture {
  permissions: string[];
  integrations: unknown[];
  sessionStatus: number;
  sessionBody: unknown;
  plans: unknown[];
}

function installFetch(fx: Fixture): void {
  window.localStorage.setItem("iptv.session_token", "tok-ops");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/v1/auth/session")) return jsonResponse(200, SESSION_OK);
      if (url.includes("/v1/me")) {
        return jsonResponse(200, {
          user: { id: "u1", email: "op@tenant.com" },
          activeTenant: { id: "t1" },
          roleKeys: [],
          permissions: fx.permissions,
        });
      }
      if (url.includes("/v1/integrations/whatsapp/session")) {
        return jsonResponse(fx.sessionStatus, fx.sessionBody);
      }
      if (url.includes("/v1/integrations")) return jsonResponse(200, { integrations: fx.integrations });
      if (url.includes("/v1/catalog/plans")) return jsonResponse(200, { plans: fx.plans });
      return jsonResponse(404, { code: "NOT_FOUND" });
    }),
  );
}

function renderPage(): void {
  render(
    <AuthProvider>
      <ToastProvider>
        <OnboardingPage />
      </ToastProvider>
    </AuthProvider>,
  );
}

function integration(provider: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider,
    environment: "SANDBOX",
    connection_status: "NOT_CONFIGURED",
    capability_status: "UNKNOWN",
    last_checked_at: null,
    last_error_code: null,
    configured: false,
    ...overrides,
  };
}

const FULL: Fixture = {
  permissions: ["integration.read"],
  integrations: [
    integration("asaas", {
      connection_status: "CONNECTED_READ_ONLY",
      capability_status: "AVAILABLE",
      last_checked_at: "2026-10-30T12:00:00.000Z",
      configured: true,
      // Marcador de vazamento simulado: a API nunca envia, a UI nunca renderiza.
      secret_ref: "infisical://test/integrations/t1/asaas/ASAAS_API_KEY",
    }),
    integration("whatsapp", { configured: true, connection_status: "DRAFT" }),
    integration("cinevision", {
      connection_status: "CONNECTED_READ_ONLY",
      capability_status: "AVAILABLE",
      last_checked_at: "2026-10-30T12:00:00.000Z",
      configured: true,
    }),
  ],
  sessionStatus: 200,
  sessionBody: { sessionName: "tenant-abc123", status: "WORKING", lastInbound: null },
  plans: [{ id: "plan-1" }],
};

beforeEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  clearApiCache();
});

describe("OnboardingPage (S5a, #89)", () => {
  it("fluxo completo mockado: estados reais por etapa, sem segredo no DOM", async () => {
    installFetch(FULL);
    const { container } = render(
      <AuthProvider>
        <ToastProvider>
          <OnboardingPage />
        </ToastProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByRole("heading", { name: "Onboarding — configuração inicial" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Etapa 3 — Asaas (Cobranças)")).toBeTruthy());

    // 10 etapas renderizadas
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(screen.getByText(new RegExp(`Etapa ${n} —`))).toBeTruthy();
    }
    // Catálogo com plano + Asaas conectado + WhatsApp WORKING concluem
    await waitFor(() => expect(screen.getByText("Catálogo com 1 plano(s) publicado(s).")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Sessão WhatsApp conectada (WORKING). Pareamento confirmado.")).toBeTruthy());
    // Diagnóstico lista saúde real (3 vínculos)
    expect(screen.getAllByText(/último teste:/).length).toBe(3);
    // S5-follow-ups manuais explícitos
    expect(screen.getByText(/S5-follow-up: sem endpoint de preferências comerciais/)).toBeTruthy();
    expect(screen.getByText(/S5-follow-up: sem endpoint de níveis de autonomia/)).toBeTruthy();
    // Sanitização
    const html = container.innerHTML;
    expect(html).not.toContain("secret_ref");
    expect(html).not.toContain("infisical://");
  });

  it("pular integração marca Pulada com resumo do modo manual", async () => {
    installFetch({
      ...FULL,
      integrations: [integration("asaas"), integration("whatsapp"), integration("cinevision")],
      sessionStatus: 404,
      sessionBody: { code: "NO_SESSION" },
      plans: [],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("Etapa 3 — Asaas (Cobranças)")).toBeTruthy());
    const skipButtons = screen.getAllByRole("button", { name: "Pular etapa" });
    expect(skipButtons.length).toBe(3);
    fireEvent.click(skipButtons[0] as HTMLElement);
    await waitFor(() => expect(screen.getAllByText(/Modo manual para cobrança/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/Indisponível: cobrança PIX automática/).length).toBeGreaterThan(0);
  });

  it("atenção em sessão com falha e erro de integração", async () => {
    installFetch({
      ...FULL,
      integrations: [
        integration("asaas", {
          connection_status: "DEGRADED",
          last_error_code: "PROVIDER_UNAVAILABLE",
          last_checked_at: "2026-10-30T12:00:00.000Z",
          configured: true,
        }),
        integration("whatsapp"),
        integration("cinevision"),
      ],
      sessionStatus: 200,
      sessionBody: { sessionName: "tenant-abc123", status: "FAILED", lastInbound: null },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("Etapa 3 — Asaas (Cobranças)")).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/Precisa de atenção: estado DEGRADED/)).toBeTruthy());
    expect(screen.getByText(/Sessão precisa de atenção: FAILED/)).toBeTruthy();
  });

  it("sem integration.read mostra gating sem buscar integrações", async () => {
    const seen: string[] = [];
    window.localStorage.setItem("iptv.session_token", "tok-ops");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        if (url.includes("/v1/auth/session")) return jsonResponse(200, SESSION_OK);
        if (url.includes("/v1/me")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "op@tenant.com" },
            activeTenant: { id: "t1" },
            roleKeys: [],
            permissions: [],
          });
        }
        if (url.includes("/v1/catalog/plans")) return jsonResponse(200, { plans: [] });
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Sem permissão")).toBeTruthy());
    expect(seen.some((u) => u.includes("/v1/integrations"))).toBe(false);
  });

  it("go-live só libera com confirmação explícita e sem POST", async () => {
    const posts: string[] = [];
    window.localStorage.setItem("iptv.session_token", "tok-ops");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if ((init?.method ?? "GET").toUpperCase() === "POST") posts.push(url);
        if (url.includes("/v1/auth/session")) return jsonResponse(200, SESSION_OK);
        if (url.includes("/v1/me")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "op@tenant.com" },
            activeTenant: { id: "t1" },
            roleKeys: [],
            permissions: ["integration.read"],
          });
        }
        if (url.includes("/v1/integrations/whatsapp/session")) {
          return jsonResponse(404, { code: "NO_SESSION" });
        }
        if (url.includes("/v1/integrations")) return jsonResponse(200, { integrations: [] });
        if (url.includes("/v1/catalog/plans")) return jsonResponse(200, { plans: [] });
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Etapa 10 — Go-live explícito")).toBeTruthy());
    const button = screen.getByRole("button", { name: "Registrar go-live" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Confirmo que o tenant está pronto para operar/));
    await waitFor(() => expect((screen.getByRole("button", { name: "Registrar go-live" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Registrar go-live" }));
    await waitFor(() => expect(screen.getByText(/Go-live registrado em/)).toBeTruthy());
    expect(posts.filter((u) => !u.includes("/v1/auth/")).length).toBe(0);
  });
});
