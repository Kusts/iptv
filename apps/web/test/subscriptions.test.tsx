import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import SubscriptionsPage from "../app/subscriptions/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/subscriptions",
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

describe("SubscriptionsPage", () => {
  const sampleSubscription = {
    id: "00000000-0000-4000-8000-000000000555",
    customerId: "00000000-0000-4000-8000-000000000888",
    planId: "00000000-0000-4000-8000-000000000311",
    status: "ACTIVE",
    projectedState: "ACTIVE",
    currentPeriodStart: new Date().toISOString(),
    currentPeriodEnd: new Date(Date.now() + 86400000 * 30).toISOString(),
    cancelAtPeriodEnd: false,
    originatingOrderId: "00000000-0000-4000-8000-000000000101",
    startedAt: new Date().toISOString(),
    cancelledAt: null,
    cycles: [
      {
        id: "cy-1",
        cycleNo: 1,
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 86400000 * 30).toISOString(),
        status: "ACTIVE",
      },
    ],
    entitlements: [
      {
        id: "ent-1",
        featureKey: "max_connections",
        status: "ACTIVE",
        startsAt: new Date().toISOString(),
        endsAt: null,
      },
    ],
  };

  it("renderiza lista de assinaturas e exibe detalhes ao clicar", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["subscription.read"],
      {
        "/v1/subscriptions/00000000-0000-4000-8000-000000000555": sampleSubscription,
        "/v1/subscriptions": { subscriptions: [sampleSubscription] },
      },
      seen,
    );

    renderPage(<SubscriptionsPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Assinaturas" })).toBeTruthy());

    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));

    await waitFor(() => expect(screen.getByText("Detalhe da assinatura")).toBeTruthy());
    expect(screen.getByText(sampleSubscription.id)).toBeTruthy();
    expect(screen.getByText("max_connections")).toBeTruthy();
    expect(screen.getByText(/Pedido de origem:/)).toBeTruthy();
  });

  it("para assinatura PENDING_ACTIVATION, exibe aviso e link para /fulfillment", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    const pendingSub = {
      ...sampleSubscription,
      status: "PENDING_ACTIVATION",
      projectedState: "PENDING_ACTIVATION",
    };

    sessionMocks(
      ["subscription.read"],
      {
        "/v1/subscriptions/00000000-0000-4000-8000-000000000555": pendingSub,
        "/v1/subscriptions": { subscriptions: [pendingSub] },
      },
      seen,
    );

    renderPage(<SubscriptionsPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));

    await waitFor(() => expect(screen.getByText(/Aguardando ativação:/)).toBeTruthy());
    expect(screen.getByText("Ir para /fulfillment")).toBeTruthy();
  });

  it("com subscription.write, permite cancelar no fim do período e retomar", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["subscription.read", "subscription.write"],
      {
        "/v1/subscriptions/00000000-0000-4000-8000-000000000555": sampleSubscription,
        "/v1/subscriptions": { subscriptions: [sampleSubscription] },
      },
      seen,
    );

    renderPage(<SubscriptionsPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Cancelar no fim do período" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Cancelar no fim do período" }));

    await waitFor(() =>
      expect(
        seen.posts.some((p) =>
          p.url.includes("/v1/subscriptions/00000000-0000-4000-8000-000000000555/cancel-at-period-end"),
        ),
      ).toBe(true),
    );

    // Clica em Retomar
    fireEvent.click(screen.getByRole("button", { name: "Retomar" }));
    await waitFor(() =>
      expect(
        seen.posts.some((p) =>
          p.url.includes("/v1/subscriptions/00000000-0000-4000-8000-000000000555/resume"),
        ),
      ).toBe(true),
    );
  });

  it("sem subscription.write, esconde botões de mutação e mostra aviso de permissão", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["subscription.read"],
      {
        "/v1/subscriptions/00000000-0000-4000-8000-000000000555": sampleSubscription,
        "/v1/subscriptions": { subscriptions: [sampleSubscription] },
      },
      seen,
    );

    renderPage(<SubscriptionsPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));

    await waitFor(() => expect(screen.getByText("Detalhe da assinatura")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Cancelar no fim do período" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retomar" })).toBeNull();
    expect(screen.getByText(/Você não tem a permissão subscription.write/)).toBeTruthy();
  });
});
