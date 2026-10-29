import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import InventoryPage from "../app/inventory/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/inventory",
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

describe("InventoryPage", () => {
  it("lista app trials, expira vencidos e valida com confirmação", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["trial.read", "trial.write"],
      {
        "/v1/inventory/app-trials": {
          items: [
            {
              id: "at-1111",
              personId: "00000000-0000-4000-8000-000000000001",
              customerId: null,
              supplierId: "00000000-0000-4000-8000-000000000099",
              supplierAppExternalId: "app-cine-ext-1",
              status: "REQUESTED",
              requestedAt: "2026-10-28T10:00:00Z",
              validatedAt: null,
              expiresAt: "2026-10-28T12:00:00Z",
            },
          ],
        },
      },
      seen,
    );

    renderPage(<InventoryPage />);
    await waitFor(() => expect(screen.getByText("Inventário (apps/MK)")).toBeTruthy());

    // Exibe item na tabela
    await waitFor(() => expect(screen.getByText("app-cine-ext-1")).toBeTruthy());
    expect(screen.getAllByText("REQUESTED").length).toBeGreaterThan(0);

    // Expirar vencidos
    fireEvent.click(screen.getByRole("button", { name: "Expirar vencidos" }));
    await waitFor(() => expect(screen.getByText("Expiração de app trials solicitada.")).toBeTruthy());
    expect(seen.posts.some((p) => p.url.includes("/v1/inventory/app-trials/expire-due"))).toBe(true);

    // Validar app trial (preserva rótulos exatos do teste legado)
    const validarBtn = await screen.findByRole("button", { name: "Validar" });
    fireEvent.click(validarBtn);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Validar app trial");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar validação" }));
    await waitFor(() => expect(screen.getByText("App trial validado.")).toBeTruthy());
    expect(seen.posts.some((p) => p.url.includes("/v1/inventory/app-trials/at-1111/validate"))).toBe(true);
  });

  it("permite solicitar novo app trial com autofill de pessoa do CRM", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["trial.read", "trial.write", "crm.person.read"],
      {
        "/v1/crm/persons": {
          persons: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              canonicalName: "Cliente Piloto Inventário",
            },
          ],
        },
        "/v1/inventory/app-trials": { items: [] },
      },
      seen,
    );

    renderPage(<InventoryPage />);
    await waitFor(() => expect(screen.getByText("Inventário (apps/MK)")).toBeTruthy());

    // Abre modal Novo app trial
    fireEvent.click(screen.getByRole("button", { name: "Novo app trial" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Solicitar app trial");

    // Verifica que pessoa do CRM foi auto-selecionada
    await waitFor(() => expect(screen.getByText(/Cliente Piloto Inventário/)).toBeTruthy());

    // Preenche fornecedor e ID externo
    fireEvent.change(screen.getByPlaceholderText("UUID do fornecedor"), {
      target: { value: "00000000-0000-4000-8000-000000000099" },
    });
    fireEvent.change(screen.getByPlaceholderText("Ex.: app-pkg-cinevision-trial"), {
      target: { value: "mk-pkg-trial-demo" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Solicitar trial" }));

    await waitFor(() => expect(screen.getByText("App trial solicitado com sucesso.")).toBeTruthy());
    expect(
      seen.posts.some(
        (p) =>
          p.url.includes("/v1/inventory/app-trials") &&
          (p.body as any)?.personId === "00000000-0000-4000-8000-000000000001" &&
          (p.body as any)?.supplierId === "00000000-0000-4000-8000-000000000099" &&
          (p.body as any)?.supplierAppExternalId === "mk-pkg-trial-demo",
      ),
    ).toBe(true);
  });

  it("permite invalidar app trial com justificativa", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["trial.read", "trial.write"],
      {
        "/v1/inventory/app-trials": {
          items: [
            {
              id: "at-inval",
              personId: "00000000-0000-4000-8000-000000000002",
              customerId: null,
              supplierId: "00000000-0000-4000-8000-000000000099",
              supplierAppExternalId: "app-invalid-test",
              status: "REQUESTED",
              requestedAt: "2026-10-28T11:00:00Z",
              validatedAt: null,
              expiresAt: null,
            },
          ],
        },
      },
      seen,
    );

    renderPage(<InventoryPage />);
    await waitFor(() => expect(screen.getByText("Inventário (apps/MK)")).toBeTruthy());

    // Clica em Invalidar
    await waitFor(() => expect(screen.getByRole("button", { name: "Invalidar" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Invalidar" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Invalidar app trial");

    // Informa justificativa
    const textarea = within(dialog).getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Falha de credencial do app externo" } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar invalidação" }));

    await waitFor(() => expect(screen.getByText("App trial invalidado.")).toBeTruthy());
    expect(
      seen.posts.some(
        (p) =>
          p.url.includes("/v1/inventory/app-trials/at-inval/validate") &&
          (p.body as any)?.outcome === "INVALIDATED" &&
          (p.body as any)?.reason === "Falha de credencial do app externo",
      ),
    ).toBe(true);
  });

  it("aba Reconciliação e painéis de Saldo do fornecedor e Compras/licenças", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["trial.read", "provider.operation.read", "provider.operation.write", "commerce.order.write"],
      {
        "/v1/inventory/app-trials": { items: [] },
        "/v1/reconciliation-findings": {
          items: [
            {
              id: "f-1",
              entityType: "LICENSE",
              entityId: "00000000-0000-4000-8000-000000000888",
              expected: "ACTIVE",
              observed: "SUSPENDED",
              status: "OPEN",
              resolutionRef: null,
              createdAt: "2026-10-28T12:00:00Z",
              resolvedAt: null,
            },
          ],
        },
        "/v1/inventory/supplier-balance?supplierId=sup-mk-01": {
          supplierId: "sup-mk-01",
          balanceMinor: "150000",
          currency: "BRL",
          observedAt: "2026-10-28T12:30:00Z",
          evidenceRef: null,
          snapshotId: "snap-1",
        },
      },
      seen,
    );

    renderPage(<InventoryPage />);
    await waitFor(() => expect(screen.getByText("Inventário (apps/MK)")).toBeTruthy());

    // Muda para aba Reconciliação
    fireEvent.click(screen.getByRole("button", { name: "Reconciliação" }));
    await waitFor(() => expect(screen.getByText("LICENSE")).toBeTruthy());
    expect(screen.getByText("SUSPENDED")).toBeTruthy();

    // Consulta saldo do fornecedor
    fireEvent.change(screen.getByPlaceholderText("UUID do fornecedor"), { target: { value: "sup-mk-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar saldo" }));
    await waitFor(() => expect(screen.getByText("R$ 1.500,00")).toBeTruthy());

    // Solicitar atualização de saldo
    fireEvent.click(screen.getByRole("button", { name: "Solicitar atualização" }));
    await waitFor(() => expect(screen.getByText("Atualização de saldo solicitada.")).toBeTruthy());
    expect(seen.posts.some((p) => p.url.includes("/v1/inventory/supplier-balance/refreshes"))).toBe(true);

    // Painel Compras e licenças: ativar licença
    fireEvent.change(screen.getByPlaceholderText("UUID da licença"), {
      target: { value: "00000000-0000-4000-8000-000000000777" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ativar licença" }));
    await waitFor(() => expect(screen.getByText("Ativação de licença enviada.")).toBeTruthy());
    expect(seen.posts.some((p) => p.url.includes("/v1/licenses/00000000-0000-4000-8000-000000000777/activate"))).toBe(true);

    // Painel Compras e licenças: liberar reserva de crédito
    fireEvent.change(screen.getByPlaceholderText("UUID da reserva"), {
      target: { value: "00000000-0000-4000-8000-000000000666" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Liberar reserva" }));
    await waitFor(() => expect(screen.getByText("Reserva de crédito liberada.")).toBeTruthy());
    expect(seen.posts.some((p) => p.url.includes("/v1/inventory/credit-reservations/00000000-0000-4000-8000-000000000666/release"))).toBe(true);
  });

  it("sem permissões: gate de leitura bloqueia página e sem escrita esconde botões", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };

    // Caso 1: Sem permissão de leitura
    sessionMocks([], {}, seen);
    const { unmount } = render(
      <AuthProvider>
        <ToastProvider>
          <InventoryPage />
        </ToastProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Sem permissão para o inventário/)).toBeTruthy());
    unmount();

    // Caso 2: Apenas leitura trial.read (sem trial.write nem provider nem procurement)
    sessionMocks(
      ["trial.read"],
      {
        "/v1/inventory/app-trials": {
          items: [
            {
              id: "at-ro",
              personId: "00000000-0000-4000-8000-000000000001",
              customerId: null,
              supplierId: "00000000-0000-4000-8000-000000000099",
              supplierAppExternalId: "app-ro",
              status: "REQUESTED",
              requestedAt: "2026-10-28T10:00:00Z",
              validatedAt: null,
              expiresAt: null,
            },
          ],
        },
      },
      seen,
    );

    renderPage(<InventoryPage />);
    await waitFor(() => expect(screen.getByText("Inventário (apps/MK)")).toBeTruthy());

    // Botões de mutação não devem aparecer
    expect(screen.queryByRole("button", { name: "Novo app trial" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expirar vencidos" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Validar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invalidar" })).toBeNull();
    expect(screen.getByText("Você não tem a permissão trial.write; ações de app trial ficam indisponíveis.")).toBeTruthy();

    // Painéis de saldo e compras não devem renderizar
    expect(screen.queryByText("Saldo do fornecedor")).toBeNull();
    expect(screen.queryByText("Compras e licenças")).toBeNull();
  });
});
