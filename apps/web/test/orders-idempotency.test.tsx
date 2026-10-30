import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import OrdersPage from "../app/orders/page";

export const PIX_STORAGE_PREFIX = "pix-idempotency-key:";

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

interface SeenPost {
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface ChargeMock {
  mode: "ok-qr" | "ok-noqr" | "uncertain" | "expired" | "paid" | "always-409" | "flaky-then-ok";
  payload?: string;
}

function sessionMocks(
  permissions: string[],
  routes: Record<string, unknown>,
  seen: { posts: SeenPost[] },
  charge: ChargeMock = { mode: "ok-qr" },
): void {
  window.localStorage.setItem("iptv.session_token", "tok-ops");
  let chargeCalls = 0;
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
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (url.endsWith("/v1/charges")) {
          seen.posts.push({ url, body, headers });
          chargeCalls += 1;
          switch (charge.mode) {
            case "always-409":
              return jsonResponse(409, { code: "PRECONDITION_FAILED" });
            case "flaky-then-ok":
              if (chargeCalls === 1) return jsonResponse(409, { code: "PRECONDITION_FAILED" });
              return jsonResponse(200, {
                id: "chg-123",
                status: "PROCESSING",
                providerChargeId: "pay_mock_456",
                qrCode: "00020126580014br.gov.bcb.pix0136test-pix-copia-e-cola",
                effectUncertain: false,
              });
            case "uncertain":
              return jsonResponse(200, {
                id: "chg-unc-1",
                status: "PROCESSING",
                providerChargeId: "pay_mock_unc",
                qrCode: "UNCE RT AIN-PIX".replace(/ /g, ""),
                effectUncertain: true,
              });
            case "expired":
              return jsonResponse(200, {
                id: "chg-exp-1",
                status: "EXPIRED",
                providerChargeId: "pay_mock_exp",
                qrCode: null,
                effectUncertain: false,
              });
            case "paid":
              return jsonResponse(200, {
                id: "chg-paid-1",
                status: "PAID",
                providerChargeId: "pay_mock_paid",
                qrCode: "PAID-PIX-PAYLOAD",
                effectUncertain: false,
              });
            case "ok-noqr":
              return jsonResponse(200, {
                id: "chg-123",
                status: "PROCESSING",
                providerChargeId: "pay_mock_456",
                qrCode: null,
                effectUncertain: false,
              });
            case "ok-qr":
            default:
              return jsonResponse(200, {
                id: "chg-123",
                status: "PROCESSING",
                providerChargeId: "pay_mock_456",
                qrCode: "00020126580014br.gov.bcb.pix0136test-pix-copia-e-cola",
                effectUncertain: false,
              });
          }
        }
        seen.posts.push({ url, body, headers });
        if (url.includes("/v1/billing-customers/provision")) {
          return jsonResponse(200, {
            id: "prov-1",
            personId: body?.personId,
            providerCustomerId: "cus_mock_123",
            provisioned: true,
          });
        }
        return jsonResponse(200, { id: "ord-1", status: "AWAITING_PAYMENT" });
      }
      // GET /v1/charges/:id/pix — payload copia-e-cola (NUNCA encodedImage na UI)
      if (url.includes("/pix")) {
        return jsonResponse(200, {
          chargeId: "chg-123",
          payload: charge.payload ?? "PIX-RECOVERED-PAYLOAD-123",
          encodedImage: "BASE64-FAKE-IMAGE-DATA-NEVER-SHOW",
          expirationDate: null,
        });
      }
      const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
      for (const [key, responseBody] of ordered) {
        if (url.includes(key)) return jsonResponse(200, responseBody);
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

const ORDER_ID = "00000000-0000-4000-8000-000000000102";

function awaitingOrder() {
  return {
    id: ORDER_ID,
    status: "AWAITING_PAYMENT",
    currency: "BRL",
    person_id: "00000000-0000-4000-8000-000000000201",
    gross_amount_minor: 3000,
    discount_amount_minor: 0,
    reward_amount_minor: 0,
    net_amount_minor: 3000,
    settled_amount_minor: 0,
    created_at: new Date().toISOString(),
    awaiting_payment_at: new Date().toISOString(),
    settled_at: null,
    cancelled_at: null,
    expires_at: null,
  };
}

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

function chargePosts(seen: { posts: SeenPost[] }): SeenPost[] {
  return seen.posts.filter((p) => p.url.endsWith("/v1/charges"));
}

function chargeKeys(seen: { posts: SeenPost[] }): (string | undefined)[] {
  return chargePosts(seen).map((p) => p.headers?.["idempotency-key"]);
}

describe("OrdersPage PIX idempotency (G01B)", () => {
  it("reload reusa a mesma idempotency-key (sem nova cobrança no provider)", async () => {
    const seen = { posts: [] as SeenPost[] };
    const routes = {
      [`/v1/orders/${ORDER_ID}`]: { order: awaitingOrder(), items: sampleItems },
      "/v1/orders": { orders: [awaitingOrder()] },
    };
    sessionMocks(["billing.read", "billing.charge.write"], routes, seen, { mode: "ok-qr" });

    const first = render(
      <AuthProvider>
        <ToastProvider>
          <OrdersPage />
        </ToastProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Gerar cobrança PIX" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Gerar cobrança PIX" }));
    await waitFor(() => expect(chargePosts(seen).length).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(screen.getByText("Cobrança PIX gerada:")).toBeTruthy());
    const key1 = chargeKeys(seen)[0];
    expect(key1).toBeTruthy();

    // Simula reload: estado React perdido, localStorage persistente.
    first.unmount();
    clearApiCache();

    render(
      <AuthProvider>
        <ToastProvider>
          <OrdersPage />
        </ToastProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByText("Detalhe do pedido")).toBeTruthy());
    // Se o botão ainda estiver visível (sem recovery), tenta gerar de novo:
    // com a key estável isso é replay seguro, nunca nova cobrança.
    const retryBtn = screen.queryByRole("button", { name: "Gerar cobrança PIX" });
    if (retryBtn) fireEvent.click(retryBtn);

    await waitFor(() => expect(chargePosts(seen).length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getByText("Cobrança PIX gerada:")).toBeTruthy());
    const keys = chargeKeys(seen);
    // TODAS as tentativas (manual + recovery pós-reload) usam a mesma key.
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(key1);
    // Key persistida em localStorage.
    expect(window.localStorage.getItem(`${PIX_STORAGE_PREFIX}${ORDER_ID}`)).toBe(key1);
  });

  it("recovery no mount: re-POST mesma key e restaura payload copia-e-cola (sem encodedImage)", async () => {
    const seen = { posts: [] as SeenPost[] };
    const routes = {
      [`/v1/orders/${ORDER_ID}`]: { order: awaitingOrder(), items: sampleItems },
      "/v1/orders": { orders: [awaitingOrder()] },
    };
    const storedKey = "recovery-key-aaa-111";
    window.localStorage.setItem(`${PIX_STORAGE_PREFIX}${ORDER_ID}`, storedKey);
    sessionMocks(["billing.read", "billing.charge.write"], routes, seen, {
      mode: "ok-noqr",
      payload: "PIX-RECOVERED-PAYLOAD-123",
    });

    renderPage(<OrdersPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));

    // Recovery automático: re-POST com a MESMA key armazenada…
    await waitFor(() => expect(chargePosts(seen).length).toBeGreaterThanOrEqual(1));
    expect(chargeKeys(seen)[0]).toBe(storedKey);
    // …e restaura o payload copia-e-cola via GET /pix.
    await waitFor(() => expect(screen.getByText("PIX-RECOVERED-PAYLOAD-123")).toBeTruthy());
    expect(screen.queryByText("BASE64-FAKE-IMAGE-DATA-NEVER-SHOW")).toBeNull();
  });

  it("409 in_progress: informa processamento e faz replay limitado (sem polling infinito)", async () => {
    const seen = { posts: [] as SeenPost[] };
    const routes = {
      [`/v1/orders/${ORDER_ID}`]: { order: awaitingOrder(), items: sampleItems },
      "/v1/orders": { orders: [awaitingOrder()] },
    };
    sessionMocks(["billing.read", "billing.charge.write"], routes, seen, { mode: "always-409" });

    renderPage(<OrdersPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Gerar cobrança PIX" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Gerar cobrança PIX" }));

    // UI informa que há processamento em curso e orienta a não gerar nova.
    await waitFor(() => expect(screen.getByText(/processamento/i)).toBeTruthy());
    // Replay limitado: exatamente 2 POSTs (tentativa + 1 replay), mesma key…
    await waitFor(() => expect(chargePosts(seen).length).toBe(2), { timeout: 4000 });
    expect(new Set(chargeKeys(seen)).size).toBe(1);
    // …e sem polling infinito: após espera adicional, continua 2.
    await new Promise((r) => setTimeout(r, 1500));
    expect(chargePosts(seen).length).toBe(2);
  });

  it("effectUncertain: banner sem segundo botão de cobrança + CTA atualizar", async () => {
    const seen = { posts: [] as SeenPost[] };
    const routes = {
      [`/v1/orders/${ORDER_ID}`]: { order: awaitingOrder(), items: sampleItems },
      "/v1/orders": { orders: [awaitingOrder()] },
    };
    sessionMocks(["billing.read", "billing.charge.write"], routes, seen, { mode: "uncertain" });

    renderPage(<OrdersPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Gerar cobrança PIX" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Gerar cobrança PIX" }));

    await waitFor(() =>
      expect(screen.getByText(/não gere nova cobrança/i)).toBeTruthy(),
    );
    // Em vez de segundo botão de cobrança: CTA atualizar/reconciliar.
    expect(screen.getByRole("button", { name: /atualizar status/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Gerar cobrança PIX" })).toBeNull();
  });

  it("cobrança EXPIRED oferece gerar nova (limpa key); PAID nunca oferece nova", async () => {
    // --- EXPIRED ---
    const seenExp = { posts: [] as SeenPost[] };
    const routes = {
      [`/v1/orders/${ORDER_ID}`]: { order: awaitingOrder(), items: sampleItems },
      "/v1/orders": { orders: [awaitingOrder()] },
    };
    sessionMocks(["billing.read", "billing.charge.write"], routes, seenExp, { mode: "expired" });

    const expRender = render(
      <AuthProvider>
        <ToastProvider>
          <OrdersPage />
        </ToastProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Gerar cobrança PIX" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Gerar cobrança PIX" }));
    await waitFor(() => expect(chargePosts(seenExp).length).toBeGreaterThanOrEqual(1));
    const oldKey = chargeKeys(seenExp)[0];
    expect(oldKey).toBeTruthy();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Gerar nova cobrança" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Gerar nova cobrança" }));
    await waitFor(() => expect(chargePosts(seenExp).length).toBeGreaterThanOrEqual(2));
    const newKeys = chargeKeys(seenExp);
    expect(newKeys[newKeys.length - 1]).toBeTruthy();
    expect(newKeys[newKeys.length - 1]).not.toBe(oldKey);
    expRender.unmount();

    // --- PAID: nenhum botão de nova cobrança ---
    vi.unstubAllGlobals();
    window.localStorage.clear();
    clearApiCache();
    const seenPaid = { posts: [] as SeenPost[] };
    sessionMocks(["billing.read", "billing.charge.write"], routes, seenPaid, { mode: "paid" });
    render(
      <AuthProvider>
        <ToastProvider>
          <OrdersPage />
        </ToastProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Gerar cobrança PIX" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Gerar cobrança PIX" }));
    await waitFor(() => expect(chargePosts(seenPaid).length).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(screen.getByText("ID: chg-paid-1")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Gerar nova cobrança" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Gerar cobrança PIX" })).toBeNull();
  });
});
