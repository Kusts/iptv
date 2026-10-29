import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import OrdersPage from "../app/orders/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/orders",
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
        if (url.includes("/v1/orders/quote")) {
          return jsonResponse(200, {
            id: "ord-new-123",
            status: "DRAFT",
            netAmountMinor: "3000",
            currency: "BRL",
          });
        }
        if (url.includes("/v1/billing-customers/provision")) {
          return jsonResponse(200, {
            id: "prov-1",
            personId: body?.personId,
            providerCustomerId: "cus_mock_123",
            provisioned: true,
          });
        }
        if (url.includes("/v1/charges")) {
          return jsonResponse(200, {
            id: "chg-123",
            status: "PROCESSING",
            providerChargeId: "pay_mock_456",
            effectUncertain: false,
          });
        }
        if (url.includes("/v1/subscriptions/from-order")) {
          return jsonResponse(200, {
            id: "sub-from-ord-789",
            status: "PENDING_ACTIVATION",
            already: false,
          });
        }
        return jsonResponse(200, { id: "ord-1", status: "AWAITING_PAYMENT" });
      }
      const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
      for (const [key, body] of ordered) {
        if (url.includes(key)) return jsonResponse(200, body);
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

describe("OrdersPage", () => {
  const sampleOrder = {
    id: "00000000-0000-4000-8000-000000000101",
    status: "DRAFT",
    currency: "BRL",
    gross_amount_minor: 3000,
    discount_amount_minor: 0,
    reward_amount_minor: 0,
    net_amount_minor: 3000,
    settled_amount_minor: 0,
    created_at: new Date().toISOString(),
    awaiting_payment_at: null,
    settled_at: null,
    cancelled_at: null,
    expires_at: null,
  };

  const sampleItems = [
    {
      id: "item-1",
      item_type: "BASE_PLAN",
      sellable_type: "PLAN",
      sellable_id: "00000000-0000-4000-8000-000000000311",
      quantity: 1,
      unit_price_minor: 3000,
      gross_minor: 3000,
      net_minor: 3000,
    },
  ];

  it("renderiza lista de pedidos e exibe detalhes ao clicar", async () => {
    const seen = { posts: [] };
    sessionMocks(
      ["billing.read"],
      {
        "/v1/orders/00000000-0000-4000-8000-000000000101": {
          order: sampleOrder,
          items: sampleItems,
        },
        "/v1/orders": {
          orders: [sampleOrder],
        },
      },
      seen,
    );

    renderPage(<OrdersPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Pedidos" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("DRAFT")).toBeTruthy());

    // Clica em Detalhe
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByText("Detalhe do pedido")).toBeTruthy());
    expect(screen.getByText(sampleOrder.id)).toBeTruthy();
  });

  it("sem permissão de escrita, não exibe botão 'Novo pedido' nem ações de mutação", async () => {
    const seen = { posts: [] };
    sessionMocks(
      ["billing.read"],
      {
        "/v1/orders/00000000-0000-4000-8000-000000000101": {
          order: sampleOrder,
          items: sampleItems,
        },
        "/v1/orders": {
          orders: [sampleOrder],
        },
      },
      seen,
    );

    renderPage(<OrdersPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Pedidos" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Novo pedido" })).toBeNull();

    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByText("Detalhe do pedido")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Submeter pedido" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancelar pedido" })).toBeNull();
  });

  it("com commerce.order.write, permite submeter e cancelar pedido a partir do detalhe", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["billing.read", "commerce.order.write"],
      {
        "/v1/orders/00000000-0000-4000-8000-000000000101": {
          order: sampleOrder,
          items: sampleItems,
        },
        "/v1/orders": {
          orders: [sampleOrder],
        },
      },
      seen,
    );

    renderPage(<OrdersPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Novo pedido" })).toBeTruthy());

    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Submeter pedido" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Submeter pedido" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/orders/00000000-0000-4000-8000-000000000101/submit"))).toBe(true),
    );
  });

  it("abre modal 'Novo pedido', autofilla pessoa única e executa 'Cotar e submeter'", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    const person = { id: "00000000-0000-4000-8000-000000000201", canonicalName: "Cliente Teste" };

    sessionMocks(
      ["billing.read", "commerce.order.write", "crm.person.read"],
      {
        "/v1/crm/persons": { persons: [person] },
        "/v1/orders/ord-new-123": {
          order: { ...sampleOrder, id: "ord-new-123", status: "AWAITING_PAYMENT" },
          items: sampleItems,
        },
        "/v1/orders": {
          orders: [],
        },
      },
      seen,
    );

    renderPage(<OrdersPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Novo pedido" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Novo pedido" }));
    await waitFor(() => expect(screen.getByText("Pedido para Cliente Teste (seleção automática).")).toBeTruthy());

    // Clica em Cotar e submeter
    fireEvent.click(screen.getByRole("button", { name: "Cotar e submeter" }));

    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/orders/quote"))).toBe(true),
    );
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/orders/ord-new-123/submit"))).toBe(true),
    );

    const quoteCall = seen.posts.find((p) => p.url.includes("/v1/orders/quote"));
    expect(quoteCall?.body).toEqual({
      personId: person.id,
      items: [
        {
          sellableType: "PLAN",
          sellableId: "00000000-0000-4000-8000-000000000311",
          quantity: 1,
        },
      ],
      orderType: "NEW_SUBSCRIPTION",
      currency: "BRL",
    });
  });

  it("com billing.charge.write e pedido AWAITING_PAYMENT, exibe botão e gera cobrança PIX", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    const awaitingOrder = {
      ...sampleOrder,
      id: "00000000-0000-4000-8000-000000000102",
      person_id: "00000000-0000-4000-8000-000000000201",
      status: "AWAITING_PAYMENT",
    };

    sessionMocks(
      ["billing.read", "billing.charge.write"],
      {
        "/v1/orders/00000000-0000-4000-8000-000000000102": {
          order: awaitingOrder,
          items: sampleItems,
        },
        "/v1/orders": {
          orders: [awaitingOrder],
        },
      },
      seen,
    );

    renderPage(<OrdersPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Gerar cobrança PIX" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Gerar cobrança PIX" }));

    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/billing-customers/provision"))).toBe(true),
    );
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/charges"))).toBe(true),
    );

    const provCall = seen.posts.find((p) => p.url.includes("/v1/billing-customers/provision"));
    expect(provCall?.body).toEqual({ personId: "00000000-0000-4000-8000-000000000201" });

    const chargeCall = seen.posts.find((p) => p.url.includes("/v1/charges"));
    expect(chargeCall?.body).toEqual({
      orderId: "00000000-0000-4000-8000-000000000102",
      paymentMethod: "PIX",
      billingType: "PIX",
    });

    await waitFor(() => expect(screen.getByText("Cobrança PIX gerada:")).toBeTruthy());
    expect(screen.getByText("ID: chg-123")).toBeTruthy();
    expect(screen.getByText("Provedor: pay_mock_456")).toBeTruthy();
    expect(screen.getByText("Ver cobranças em /billing")).toBeTruthy();
  });

  it("com subscription.write e pedido SETTLED, exibe botão e cria assinatura a partir do pedido", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    const settledOrder = {
      ...sampleOrder,
      id: "00000000-0000-4000-8000-000000000103",
      status: "SETTLED",
      settled_amount_minor: 3000,
    };

    sessionMocks(
      ["billing.read", "subscription.write"],
      {
        "/v1/orders/00000000-0000-4000-8000-000000000103": {
          order: settledOrder,
          items: sampleItems,
        },
        "/v1/orders": {
          orders: [settledOrder],
        },
      },
      seen,
    );

    renderPage(<OrdersPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Criar assinatura" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Criar assinatura" }));

    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/subscriptions/from-order"))).toBe(true),
    );

    const subCall = seen.posts.find((p) => p.url.includes("/v1/subscriptions/from-order"));
    expect(subCall?.body).toEqual({ orderId: "00000000-0000-4000-8000-000000000103" });

    await waitFor(() => expect(screen.getByText("Assinatura gerada:")).toBeTruthy());
    expect(screen.getByText("ID: sub-from-ord-789")).toBeTruthy();
    expect(screen.getByText("Ver assinaturas em /subscriptions")).toBeTruthy();
    expect(screen.getByText("Ir para /fulfillment")).toBeTruthy();
  });
});
