import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import RenewalsPage from "../app/renewals/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/renewals",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

beforeEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/renewals");
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

describe("RenewalsPage", () => {
  it("renderiza lista de assinaturas cadastradas e consulta renovações ao selecionar via select", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["subscription.read", "subscription.write"],
      {
        "/v1/subscriptions": {
          subscriptions: [
            {
              id: "sub-1111-2222-3333-444455556666",
              planId: "plan-monthly-seeded-001",
              status: "ACTIVE",
              currentPeriodEnd: "2026-11-01T00:00:00Z",
            },
          ],
        },
        "/v1/renewals?subscriptionId=sub-1111-2222-3333-444455556666": {
          orders: [
            {
              id: "ro-001",
              orderType: "RENEWAL",
              status: "SETTLED",
              currency: "BRL",
              netAmountMinor: "3990",
              cycle: { id: "cy-1", cycleNo: 1 },
              createdAt: "2026-10-01T00:00:00Z",
              settledAt: "2026-10-01T00:01:00Z",
            },
          ],
        },
        "/v1/recovery-tasks?subscriptionId=sub-1111-2222-3333-444455556666": {
          tasks: [],
        },
      },
      seen,
    );

    renderPage(<RenewalsPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Renovações" })).toBeTruthy());

    // Seletor de assinaturas deve estar visível
    const select = await screen.findByLabelText("Selecionar assinatura");
    expect(select).toBeTruthy();

    // Seleciona a assinatura via dropdown
    fireEvent.change(select, { target: { value: "sub-1111-2222-3333-444455556666" } });

    // Tabela com pedidos de renovação deve carregar automaticamente
    await waitFor(() => expect(screen.getByText("R$ 39,90")).toBeTruthy());
    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByText("SETTLED")).toBeTruthy();
  });

  it("carrega automaticamente a assinatura a partir de window.location.search (?subscriptionId=...)", async () => {
    window.history.replaceState({}, "", "/renewals?subscriptionId=sub-from-query-9999");
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["subscription.read", "subscription.write"],
      {
        "/v1/subscriptions": { subscriptions: [] },
        "/v1/renewals?subscriptionId=sub-from-query-9999": {
          orders: [
            {
              id: "ro-query-1",
              orderType: "RENEWAL",
              status: "AWAITING_PAYMENT",
              currency: "BRL",
              netAmountMinor: "4990",
              cycle: { id: "cy-2", cycleNo: 2 },
              createdAt: "2026-10-15T00:00:00Z",
              settledAt: null,
            },
          ],
        },
        "/v1/recovery-tasks?subscriptionId=sub-from-query-9999": {
          tasks: [],
        },
      },
      seen,
    );

    renderPage(<RenewalsPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Renovações" })).toBeTruthy());

    // Deve carregar direto sem precisar clicar em consultar
    await waitFor(() => expect(screen.getByText("R$ 49,90")).toBeTruthy());
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getByText("AWAITING_PAYMENT")).toBeTruthy();
  });

  it("com subscription.write, permite cotar, renovar e disparar tarefas em lote", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["subscription.read", "subscription.write"],
      {
        "/v1/subscriptions": { subscriptions: [] },
        "/v1/renewals?subscriptionId=sub-action-test": {
          orders: [],
        },
        "/v1/recovery-tasks?subscriptionId=sub-action-test": {
          tasks: [],
        },
      },
      seen,
    );

    renderPage(<RenewalsPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Renovações" })).toBeTruthy());

    // Consulta manual via input
    fireEvent.change(screen.getByPlaceholderText("UUID da assinatura"), {
      target: { value: "sub-action-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Consultar renovações" }));

    await waitFor(() => expect(screen.getByText("Nenhum pedido de renovação")).toBeTruthy());

    // Testa cotar renovação
    fireEvent.click(screen.getByRole("button", { name: "Cotar" }));
    const dialogQuote = await screen.findByRole("dialog");
    expect(dialogQuote.getAttribute("aria-label")).toBe("Cotar renovação");
    fireEvent.click(within(dialogQuote).getByRole("button", { name: "Cotar" }));
    await waitFor(() => expect(screen.getByText("Comando de renovação enviado.")).toBeTruthy());
    expect(seen.posts.some((p) => p.url.includes("/v1/renewals/quote") && (p.body as any)?.subscriptionId === "sub-action-test")).toBe(true);

    // Testa processar lembretes
    fireEvent.click(screen.getByRole("button", { name: "Processar lembretes" }));
    await waitFor(() => expect(screen.getByText("Lembretes vencidos processados.")).toBeTruthy());
    expect(seen.posts.some((p) => p.url.includes("/v1/renewals/reminders-due"))).toBe(true);

    // Testa expirar vencidos
    fireEvent.click(screen.getByRole("button", { name: "Expirar vencidos" }));
    await waitFor(() => expect(screen.getByText("Expiração de vencidos processada.")).toBeTruthy());
    expect(seen.posts.some((p) => p.url.includes("/v1/renewals/expire-overdue-due"))).toBe(true);
  });

  it("exibe tarefas de recuperação (winback) e permite resolver com confirmação", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["subscription.read", "subscription.write"],
      {
        "/v1/subscriptions": { subscriptions: [] },
        "/v1/renewals?subscriptionId=sub-winback-1": {
          orders: [],
        },
        "/v1/recovery-tasks?subscriptionId=sub-winback-1": {
          tasks: [
            {
              id: "rec-task-123",
              subscriptionId: "sub-winback-1",
              cycleId: "cy-1",
              renewalOrderId: null,
              reason: "Cartão expirado no ciclo anterior",
              status: "OPEN",
              outcome: null,
              createdAt: "2026-10-20T10:00:00Z",
            },
          ],
        },
      },
      seen,
    );

    renderPage(<RenewalsPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Renovações" })).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("UUID da assinatura"), {
      target: { value: "sub-winback-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Consultar renovações" }));

    await waitFor(() => expect(screen.getByText(/Cartão expirado no ciclo anterior/)).toBeTruthy());

    // Clica em Resolver
    fireEvent.click(screen.getByRole("button", { name: "Resolver" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Resolver tarefa de recuperação");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar resolução" }));

    await waitFor(() => expect(screen.getByText("Tarefa de recuperação resolvida.")).toBeTruthy());
    expect(seen.posts.some((p) => p.url.includes("/v1/recovery-tasks/rec-task-123/resolve"))).toBe(true);
  });

  it("sem permissões: gate de leitura bloqueia e sem escrita omite botões de mutação", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };

    // Caso 1: Sem permissão de leitura
    sessionMocks([], {}, seen);
    const { unmount } = render(
      <AuthProvider>
        <ToastProvider>
          <RenewalsPage />
        </ToastProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Sem permissão para as renovações/)).toBeTruthy());
    unmount();

    // Caso 2: Com permissão de leitura mas sem permissão de escrita
    sessionMocks(
      ["subscription.read"],
      {
        "/v1/subscriptions": { subscriptions: [] },
        "/v1/renewals?subscriptionId=sub-ro": {
          orders: [
            {
              id: "ro-ro",
              orderType: "RENEWAL",
              status: "SETTLED",
              currency: "BRL",
              netAmountMinor: "3990",
              cycle: null,
              createdAt: "2026-10-01T00:00:00Z",
              settledAt: null,
            },
          ],
        },
        "/v1/recovery-tasks?subscriptionId=sub-ro": {
          tasks: [],
        },
      },
      seen,
    );

    renderPage(<RenewalsPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Renovações" })).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("UUID da assinatura"), {
      target: { value: "sub-ro" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Consultar renovações" }));

    await waitFor(() => expect(screen.getByText("R$ 39,90")).toBeTruthy());

    // Botões de mutação não devem existir
    expect(screen.queryByRole("button", { name: "Processar lembretes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expirar vencidos" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cotar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Renovar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Trust renew" })).toBeNull();
    expect(
      screen.getByText("Você não tem a permissão subscription.write; ações de renovação ficam indisponíveis."),
    ).toBeTruthy();
  });
});
