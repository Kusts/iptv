import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import BillingPage from "../app/billing/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/billing",
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

describe("BillingPage", () => {
  it("aba Cobranças: lista cobranças, permite expirar vencidas, conciliar e cancelar", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["billing.read", "billing.charge.write"],
      {
        "/v1/charges": {
          charges: [
            {
              id: "c-1111",
              order_id: "o-1111",
              status: "PENDING",
              amount_minor: "9990",
              currency: "BRL",
              payment_method: "pix",
              created_at: "2026-10-25T10:00:00Z",
              paid_at: null,
            },
          ],
        },
      },
      seen,
    );

    renderPage(<BillingPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Cobrança" })).toBeTruthy());

    // Exibe valor formatado e status
    await waitFor(() => expect(screen.getByText("R$ 99,90")).toBeTruthy());
    expect(screen.getByText("PENDING")).toBeTruthy();

    // Expirar vencidas
    fireEvent.click(screen.getByRole("button", { name: "Expirar vencidas" }));
    await waitFor(() => expect(screen.getByText("Expiração de cobranças vencidas solicitada.")).toBeTruthy());
    expect(seen.posts.some((p) => p.url.includes("/v1/charges/expire-due"))).toBe(true);

    // Aguarda o término do reload pós-expiração e concilia
    const conciliarBtn = await screen.findByRole("button", { name: "Conciliar" });
    fireEvent.click(conciliarBtn);
    const dialogConciliar = await screen.findByRole("dialog");
    expect(dialogConciliar.getAttribute("aria-label")).toBe("Conciliar cobrança");
    fireEvent.click(within(dialogConciliar).getByRole("button", { name: "Conciliar" }));
    await waitFor(() => expect(screen.getByText("Comando de cobrança enviado.")).toBeTruthy());
    expect(seen.posts.some((p) => p.url.includes("/v1/charges/c-1111/reconcile"))).toBe(true);

    // Cancelar no card de ações da cobrança selecionada
    await waitFor(() => expect(screen.getByText("Ações da cobrança")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    const dialogCancelar = await screen.findByRole("dialog");
    expect(dialogCancelar.getAttribute("aria-label")).toBe("Cancelar cobrança");
    fireEvent.click(within(dialogCancelar).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(seen.posts.some((p) => p.url.includes("/v1/charges/c-1111/cancel"))).toBe(true));
  });

  it("aba Pagamentos: lista pagamentos e permite solicitar reembolso para pagamento confirmado", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["billing.read", "billing.refund.request"],
      {
        "/v1/charges": { charges: [] },
        "/v1/payments": {
          payments: [
            {
              id: "pay-2222",
              order_id: "o-2222",
              charge_id: "c-2222",
              status: "CONFIRMED",
              amount_minor: "4990",
              currency: "BRL",
              confirmed_at: "2026-10-26T12:00:00Z",
            },
          ],
        },
      },
      seen,
    );

    renderPage(<BillingPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Cobrança" })).toBeTruthy());

    // Muda para aba Pagamentos
    fireEvent.click(screen.getByRole("button", { name: "Pagamentos" }));
    await waitFor(() => expect(screen.getByText("R$ 49,90")).toBeTruthy());
    expect(screen.getByText("CONFIRMED")).toBeTruthy();

    // Clica em Solicitar reembolso
    fireEvent.click(screen.getByRole("button", { name: "Solicitar reembolso" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Solicitar reembolso de pagamento");

    // Preenche motivo e envia solicitação
    const reasonInput = screen.getByPlaceholderText("Informe a justificativa para a revisão humana...");
    fireEvent.change(reasonInput, { target: { value: "Cliente desistiu da compra dentro do prazo legal." } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Enviar solicitação" }));

    await waitFor(() => expect(screen.getByText("Solicitação de reembolso registrada para revisão.")).toBeTruthy());
    expect(
      seen.posts.some(
        (p) =>
          p.url.includes("/v1/refund-requests") &&
          (p.body as any)?.paymentId === "pay-2222" &&
          (p.body as any)?.amountMinor === "4990" &&
          (p.body as any)?.reason === "Cliente desistiu da compra dentro do prazo legal.",
      ),
    ).toBe(true);
  });

  it("aba Reembolsos: lista solicitações e permite executar reembolso aprovado ou conciliar", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["billing.read", "billing.refund.execute"],
      {
        "/v1/charges": { charges: [] },
        "/v1/refund-requests": {
          refund_requests: [
            {
              id: "rr-approved-3333",
              payment_id: "pay-3333",
              status: "APPROVED",
              amount_minor: "3000",
              currency: "BRL",
              requested_at: "2026-10-27T10:00:00Z",
              decided_at: "2026-10-27T10:30:00Z",
              executed_at: null,
            },
            {
              id: "rr-executed-4444",
              payment_id: "pay-4444",
              status: "EXECUTED",
              amount_minor: "2000",
              currency: "BRL",
              requested_at: "2026-10-27T08:00:00Z",
              decided_at: "2026-10-27T08:15:00Z",
              executed_at: "2026-10-27T08:20:00Z",
            },
          ],
        },
      },
      seen,
    );

    renderPage(<BillingPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Cobrança" })).toBeTruthy());

    // Muda para aba Reembolsos
    fireEvent.click(screen.getByRole("button", { name: "Reembolsos" }));
    await waitFor(() => expect(screen.getByText("R$ 30,00")).toBeTruthy());
    expect(screen.getByText("APPROVED")).toBeTruthy();
    expect(screen.getByText("R$ 20,00")).toBeTruthy();
    expect(screen.getByText("EXECUTED")).toBeTruthy();

    // Executar reembolso aprovado
    fireEvent.click(screen.getByRole("button", { name: "Executar" }));
    const dialogExec = await screen.findByRole("dialog");
    expect(dialogExec.getAttribute("aria-label")).toBe("Executar reembolso aprovado");
    fireEvent.click(within(dialogExec).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(screen.getByText("Execução de reembolso enviada.")).toBeTruthy());
    expect(seen.posts.some((p) => p.url.includes("/v1/refund-requests/rr-approved-3333/execute"))).toBe(true);

    // Aguarda o reload pós-execução e concilia o reembolso executado
    const conciliarBtn = await screen.findByRole("button", { name: "Conciliar" });
    fireEvent.click(conciliarBtn);
    const dialogReconcile = await screen.findByRole("dialog");
    expect(dialogReconcile.getAttribute("aria-label")).toBe("Conciliar reembolso");
    fireEvent.click(within(dialogReconcile).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(screen.getByText("Conciliação de reembolso enviada.")).toBeTruthy());
    expect(seen.posts.some((p) => p.url.includes("/v1/refunds/rr-executed-4444/reconcile"))).toBe(true);
  });

  it("aba Exceções: filtra por status e permite resolver exceção com justificativa", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["billing.read", "billing.exception.resolve"],
      {
        "/v1/charges": { charges: [] },
        "/v1/billing-exceptions": {
          exceptions: [
            {
              id: "exc-5555",
              kind: "PROVIDER_UNKNOWN_EFFECT",
              status: "OPEN",
              charge_id: "c-5555",
              payment_id: null,
              refund_id: null,
              reason: "Efeito desconhecido na criação de PIX",
              created_at: "2026-10-28T09:00:00Z",
            },
          ],
        },
      },
      seen,
    );

    renderPage(<BillingPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Cobrança" })).toBeTruthy());

    // Muda para aba Exceções
    fireEvent.click(screen.getByRole("button", { name: "Exceções" }));
    await waitFor(() => expect(screen.getByText("PROVIDER_UNKNOWN_EFFECT")).toBeTruthy());
    expect(screen.getByText("Efeito desconhecido na criação de PIX")).toBeTruthy();

    // Clica em Resolver
    fireEvent.click(screen.getByRole("button", { name: "Resolver" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Resolver exceção");

    // Informa resolução
    const textarea = within(dialog).getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Verificado no gateway: cobrança expirou sem liquidação." } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar resolução" }));
    await waitFor(() => expect(screen.getByText("Exceção de cobrança resolvida.")).toBeTruthy());
    expect(
      seen.posts.some(
        (p) =>
          p.url.includes("/v1/billing-exceptions/exc-5555/resolve") &&
          (p.body as any)?.resolution === "Verificado no gateway: cobrança expirou sem liquidação.",
      ),
    ).toBe(true);
  });

  it("sem permissões: gate de leitura bloqueia página e sem permissões de mutação omite ações", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };

    // Caso 1: Sem permissão de leitura
    sessionMocks([], {}, seen);
    const { unmount } = render(
      <AuthProvider>
        <ToastProvider>
          <BillingPage />
        </ToastProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Sem permissão para a cobrança/)).toBeTruthy());
    unmount();

    // Caso 2: Apenas leitura (sem nenhuma permissão de escrita/execução/resolução)
    sessionMocks(
      ["billing.read"],
      {
        "/v1/charges": {
          charges: [
            {
              id: "c-ro",
              order_id: "o-ro",
              status: "PENDING",
              amount_minor: "5000",
              currency: "BRL",
              payment_method: "pix",
              created_at: "2026-10-25T10:00:00Z",
              paid_at: null,
            },
          ],
        },
        "/v1/payments": {
          payments: [
            {
              id: "pay-ro",
              order_id: "o-ro",
              charge_id: "c-ro",
              status: "CONFIRMED",
              amount_minor: "5000",
              currency: "BRL",
              confirmed_at: "2026-10-25T10:05:00Z",
            },
          ],
        },
        "/v1/refund-requests": {
          refund_requests: [
            {
              id: "rr-ro",
              payment_id: "pay-ro",
              status: "APPROVED",
              amount_minor: "5000",
              currency: "BRL",
              requested_at: "2026-10-25T11:00:00Z",
              decided_at: "2026-10-25T11:10:00Z",
              executed_at: null,
            },
          ],
        },
        "/v1/billing-exceptions": {
          exceptions: [
            {
              id: "exc-ro",
              kind: "MISMATCH",
              status: "OPEN",
              charge_id: null,
              payment_id: null,
              refund_id: null,
              reason: "Divergência",
              created_at: "2026-10-25T12:00:00Z",
            },
          ],
        },
      },
      seen,
    );

    renderPage(<BillingPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Cobrança" })).toBeTruthy());

    // Aba Cobranças: não deve ter botão 'Expirar vencidas'
    expect(screen.queryByRole("button", { name: "Expirar vencidas" })).toBeNull();
    expect(
      screen.getByText("Você não tem a permissão billing.charge.write; conciliação e cancelamento ficam indisponíveis."),
    ).toBeTruthy();

    // Aba Pagamentos: não deve ter botão 'Solicitar reembolso'
    fireEvent.click(screen.getByRole("button", { name: "Pagamentos" }));
    await waitFor(() => expect(screen.getByText("CONFIRMED")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Solicitar reembolso" })).toBeNull();
    expect(
      screen.getByText("Você não tem a permissão billing.refund.request; solicitação de reembolso indisponível."),
    ).toBeTruthy();

    // Aba Reembolsos: não deve ter botão 'Executar'
    fireEvent.click(screen.getByRole("button", { name: "Reembolsos" }));
    await waitFor(() => expect(screen.getByText("APPROVED")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Executar" })).toBeNull();
    expect(
      screen.getByText("Você não tem a permissão billing.refund.execute; execução e conciliação ficam indisponíveis."),
    ).toBeTruthy();

    // Aba Exceções: não deve ter botão 'Resolver'
    fireEvent.click(screen.getByRole("button", { name: "Exceções" }));
    await waitFor(() => expect(screen.getByText("MISMATCH")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Resolver" })).toBeNull();
    expect(
      screen.getByText("Você não tem a permissão billing.exception.resolve; resoluções ficam indisponíveis."),
    ).toBeTruthy();
  });
});
