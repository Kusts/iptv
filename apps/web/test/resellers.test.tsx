import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import ResellersPage from "../app/resellers/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/resellers",
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

function sessionMocks(
  permissions: string[],
  routes: Record<string, unknown>,
  seen: { posts: { url: string; body?: unknown }[] },
): void {
  window.localStorage.setItem("iptv.session_token", "tok-ops");
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
      if (url.includes("/v1/me")) {
        return jsonResponse(200, {
          user: { id: "u1", email: "op@tenant.com" },
          activeTenant: { id: "t1" },
          roleKeys: [],
          permissions,
        });
      }
      if ((init?.method ?? "GET") === "POST") {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        seen.posts.push({ url, body });
        return jsonResponse(200, { status: "OK" });
      }
      const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
      for (const [key, body] of ordered) {
        if (url.includes(key)) {
          return jsonResponse(200, body);
        }
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

describe("ResellersPage", () => {
  it("lista parceiros, exibe detalhes e permite ativar e converter em tenant", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["crm.person.read", "crm.lead.write"],
      {
        "/v1/partners/p-100/summary": {
          id: "p-100",
          displayName: "Revenda Sul Oficial",
          status: "ONBOARDING",
          accountType: "RESELLER",
        },
        "/v1/partners": {
          items: [
            {
              id: "p-100",
              displayName: "Revenda Sul Oficial",
              status: "ONBOARDING",
              kind: "SERVICE_RESELLER",
            },
          ],
        },
      },
      seen,
    );

    renderPage(<ResellersPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Revendedores" })).toBeTruthy());

    // Exibe parceiro na tabela
    await waitFor(() => expect(screen.getByText("Revenda Sul Oficial")).toBeTruthy());
    expect(screen.getByText("ONBOARDING")).toBeTruthy();

    // Clica em Detalhe
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByText("Resumo do parceiro")).toBeTruthy());
    expect(screen.getByText("Ações do parceiro")).toBeTruthy();

    // Ativar parceiro
    fireEvent.click(screen.getByRole("button", { name: "Ativar" }));
    const dialogAtivar = await screen.findByRole("dialog");
    expect(dialogAtivar.getAttribute("aria-label")).toBe("Ativar parceiro");
    fireEvent.click(within(dialogAtivar).getByRole("button", { name: "Ativar" }));
    await waitFor(() => expect(screen.getByText("Comando de parceiro enviado.")).toBeTruthy());
    expect(seen.posts.some((p) => p.url.includes("/v1/partners/p-100/activate"))).toBe(true);

    // Converter em tenant
    fireEvent.click(screen.getByRole("button", { name: "Converter em tenant" }));
    const dialogConverter = await screen.findByRole("dialog");
    expect(dialogConverter.getAttribute("aria-label")).toBe("Converter em tenant");
    fireEvent.click(within(dialogConverter).getByRole("button", { name: "Converter" }));
    await waitFor(() => expect(seen.posts.some((p) => p.url.includes("/v1/partners/p-100/convert-to-tenant"))).toBe(true));
  });

  it("permite cadastrar novo parceiro via CreatePartnerDialog", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["crm.person.read", "crm.lead.write"],
      {
        "/v1/partners": { items: [] },
      },
      seen,
    );

    renderPage(<ResellersPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Revendedores" })).toBeTruthy());

    // Abre modal Novo parceiro
    fireEvent.click(screen.getByRole("button", { name: "Novo parceiro" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Novo parceiro");

    // Preenche nome
    fireEvent.change(screen.getByPlaceholderText("Ex.: Distribuidora Parceira Sul"), {
      target: { value: "Revenda Centro-Oeste" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Cadastrar parceiro" }));

    await waitFor(() => expect(screen.getByText("Parceiro cadastrado com sucesso.")).toBeTruthy());
    expect(
      seen.posts.some(
        (p) =>
          p.url.includes("/v1/partners") &&
          (p.body as any)?.displayName === "Revenda Centro-Oeste" &&
          (p.body as any)?.initialStatus === "ONBOARDING",
      ),
    ).toBe(true);
  });

  it("aba Rede e créditos: consulta rede e recarrega crédito com confirmação", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["crm.person.read", "commerce.order.write"],
      {
        "/v1/partners/p-net-1/network": { directChildren: [{ id: "p-child-001" }] },
        "/v1/partners/p-net-1/credits": {
          partnerAccountId: "p-net-1",
          balances: [{ currency: "BRL", availableMinor: "25000" }],
        },
        "/v1/partners": {
          items: [
            {
              id: "p-net-1",
              displayName: "Parceiro Rede Matriz",
              status: "ACTIVE",
            },
          ],
        },
      },
      seen,
    );

    renderPage(<ResellersPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Revendedores" })).toBeTruthy());

    // Muda para aba Rede e créditos
    fireEvent.click(screen.getByRole("button", { name: "Rede e créditos" }));

    // Seleciona parceiro via select assistido
    const select = await screen.findByLabelText("Selecionar parceiro cadastrado");
    fireEvent.change(select, { target: { value: "p-net-1" } });

    // Exibe saldo de crédito formatado
    await waitFor(() => expect(screen.getByText("R$ 250,00")).toBeTruthy());
    expect(screen.getByText(/Rede direta \(1 filhos\)/)).toBeTruthy();

    // Recarregar crédito
    fireEvent.click(screen.getByRole("button", { name: "Recarregar crédito" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Recarregar crédito");

    fireEvent.change(within(dialog).getByLabelText("Valor (minor units, ex.: 10000 = R$ 100,00)"), {
      target: { value: "50000" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar recarga" }));

    await waitFor(() => expect(screen.getByText("Crédito do parceiro recarregado.")).toBeTruthy());
    expect(
      seen.posts.some(
        (p) =>
          p.url.includes("/v1/partners/p-net-1/credits/topup") &&
          (p.body as any)?.amountMinor === "50000" &&
          (p.body as any)?.currency === "BRL",
      ),
    ).toBe(true);
  });

  it("aba Pedidos: consulta pedido de revenda por ID", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["crm.person.read"],
      {
        "/v1/partners": { items: [] },
        "/v1/reseller-orders/ord-resell-999": {
          id: "ord-resell-999",
          status: "SETTLED",
          totalMinor: "45000",
          currency: "BRL",
          createdAt: "2026-10-28T15:00:00Z",
        },
      },
      seen,
    );

    renderPage(<ResellersPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Revendedores" })).toBeTruthy());

    // Muda para aba Pedidos
    fireEvent.click(screen.getByRole("button", { name: "Pedidos" }));
    fireEvent.change(screen.getByPlaceholderText("UUID do pedido"), {
      target: { value: "ord-resell-999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Consultar pedido" }));

    await waitFor(() => expect(screen.getByText("R$ 450,00")).toBeTruthy());
    expect(screen.getByText("SETTLED")).toBeTruthy();
    expect(screen.getByText("ord-resell-999")).toBeTruthy();
  });

  it("sem permissões: gate de leitura bloqueia página e sem escrita omite botões de mutação", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };

    // Caso 1: Sem permissão de leitura
    sessionMocks([], {}, seen);
    const { unmount } = render(
      <AuthProvider>
        <ToastProvider>
          <ResellersPage />
        </ToastProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Sem permissão para os revendedores/)).toBeTruthy());
    unmount();

    // Caso 2: Apenas leitura crm.person.read (sem crm.lead.write nem commerce.order.write)
    sessionMocks(
      ["crm.person.read"],
      {
        "/v1/partners": {
          items: [
            {
              id: "p-ro",
              displayName: "Parceiro Leitura",
              status: "ONBOARDING",
            },
          ],
        },
        "/v1/partners/p-ro/summary": { id: "p-ro", displayName: "Parceiro Leitura" },
        "/v1/partners/p-ro/network": { directChildren: [] },
        "/v1/partners/p-ro/credits": { partnerAccountId: "p-ro", balances: [] },
      },
      seen,
    );

    renderPage(<ResellersPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Revendedores" })).toBeTruthy());

    // Aba Parceiros: sem botão 'Novo parceiro' nem ações de ativação
    expect(screen.queryByRole("button", { name: "Novo parceiro" })).toBeNull();
    const detalheBtn = await screen.findByRole("button", { name: "Detalhe" });
    fireEvent.click(detalheBtn);
    await waitFor(() => expect(screen.getByText("Resumo do parceiro")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Ativar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Converter em tenant" })).toBeNull();
    expect(
      screen.getByText("Você não tem a permissão crm.lead.write; ativação e conversão ficam indisponíveis."),
    ).toBeTruthy();

    // Aba Rede e créditos: sem botão 'Recarregar crédito'
    fireEvent.click(screen.getByRole("button", { name: "Rede e créditos" }));
    fireEvent.change(screen.getByPlaceholderText("UUID do parceiro"), { target: { value: "p-ro" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar rede" }));
    await waitFor(() => expect(screen.getByText(/Rede direta \(0 filhos\)/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Recarregar crédito" })).toBeNull();
    expect(
      screen.getByText("Você não tem a permissão commerce.order.write; recarga de crédito fica indisponível."),
    ).toBeTruthy();
  });
});
