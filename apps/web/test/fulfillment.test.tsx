import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import FulfillmentPage from "../app/fulfillment/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/fulfillment",
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
        return jsonResponse(200, { operationId: "op-mock-123", status: "QUEUED", already: false });
      }
      const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
      for (const [key, body] of ordered) {
        if (url.includes(key)) {
          if (body === null) {
            return jsonResponse(404, { code: "NOT_FOUND", message: "no fulfillment operation" });
          }
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

describe("FulfillmentPage", () => {
  const pendingSub = {
    id: "00000000-0000-4000-8000-000000000999",
    customerId: "00000000-0000-4000-8000-000000000888",
    planId: "00000000-0000-4000-8000-000000000311",
    status: "PENDING_ACTIVATION",
    projectedState: "PENDING_ACTIVATION",
    currentPeriodStart: new Date().toISOString(),
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  };

  it("renderiza fila de ativações pendentes e solicita provisionamento em 1 clique", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["subscription.read", "subscription.write"],
      {
        "/v1/subscriptions?status=PENDING_ACTIVATION": {
          subscriptions: [pendingSub],
        },
        "/v1/fulfillment/subscriptions/00000000-0000-4000-8000-000000000999": null, // 404
      },
      seen,
    );

    renderPage(<FulfillmentPage />);
    await waitFor(() => expect(screen.getByText("Ativação (fulfillment)")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Fila de ativações pendentes")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("PENDING_ACTIVATION")).toBeTruthy());

    // Clica no botão Ativar / Inspecionar na tabela da fila
    fireEvent.click(screen.getByRole("button", { name: "Ativar / Inspecionar" }));

    // O painel deve abrir e mostrar que não há operação ainda
    await waitFor(() => expect(screen.getByText("Sem operação de fulfillment")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Solicitar provisionamento" })).toBeTruthy();

    // Dispara a solicitação de provisionamento
    fireEvent.click(screen.getByRole("button", { name: "Solicitar provisionamento" }));

    // Confirma no modal
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirmar solicitação" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Confirmar solicitação" }));

    await waitFor(() => expect(screen.getByText("Provisionamento solicitado.")).toBeTruthy());
    expect(
      seen.posts.some((p) =>
        p.url.includes("/v1/fulfillment/subscriptions/00000000-0000-4000-8000-000000000999/request"),
      ),
    ).toBe(true);
  });

  it("sem permissão de escrita subscription.write, permite visualizar fila e consultar sem botão de mutação", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["subscription.read"],
      {
        "/v1/subscriptions?status=PENDING_ACTIVATION": {
          subscriptions: [pendingSub],
        },
        "/v1/fulfillment/subscriptions/00000000-0000-4000-8000-000000000999": null, // 404
      },
      seen,
    );

    renderPage(<FulfillmentPage />);
    await waitFor(() => expect(screen.getByText("Ativação (fulfillment)")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("PENDING_ACTIVATION")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Ativar / Inspecionar" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    // Não deve exibir card de mutação nem botão de solicitar provisionamento
    expect(screen.queryByText("Sem operação de fulfillment")).toBeNull();
    expect(screen.queryByRole("button", { name: "Solicitar provisionamento" })).toBeNull();
  });
});
