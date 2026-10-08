import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import CrmPage from "../app/crm/page";
import TrialsPage from "../app/trials/page";
import BillingPage from "../app/billing/page";
import FulfillmentPage from "../app/fulfillment/page";
import RenewalsPage from "../app/renewals/page";
import InventoryPage from "../app/inventory/page";

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
        seen.posts.push(url);
        return jsonResponse(200, {});
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

describe("CRM", () => {
  it("lista pessoas e transiciona lead com confirmação", async () => {
    const seen = { posts: [] as string[] };
    sessionMocks(["crm.person.read", "crm.lead.write"], {
      "/v1/crm/persons": { persons: [] },
      "/v1/crm/leads": { leads: [{ id: "l1", personId: "p1", status: "CONTACTED", stage: "novo", createdAt: new Date().toISOString() }] },
      "/v1/crm/leads/l1": {
        id: "l1", personId: "p1", status: "CONTACTED", stage: "novo",
        createdAt: new Date().toISOString(), qualifiedAt: null, lostAt: null, closedReason: null,
      },
    }, seen);
    renderPage(<CrmPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "CRM" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Leads" }));
    await waitFor(() => expect(screen.getByText("novo")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Transição de status" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Transição de status" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar transição" }));
    await waitFor(() => expect(screen.getByText("Transição de lead registrada.")).toBeTruthy());
    expect(seen.posts.some((u) => u.includes("/v1/crm/leads/l1/transition"))).toBe(true);
  });

  it("sem permissão de leitura exibe gate em vez de buscar", async () => {
    const seen = { posts: [] as string[] };
    sessionMocks([], {}, seen);
    renderPage(<CrmPage />);
    await waitFor(() => expect(screen.getByText(/Sem permissão para o CRM/)).toBeTruthy());
  });
});

describe("Trials", () => {
  it("lista trials e encerra com confirmação", async () => {
    const seen = { posts: [] as string[] };
    sessionMocks(["trial.read", "trial.write"], {
      "/v1/trials?": { trials: [] },
      "/v1/trials": {
        trials: [{
          id: "t1", personId: "p1", trialKind: "SERVICE", lifecycleStatus: "ACTIVE",
          technicalOutcome: null, requestedDurationMinutes: 60, activatedAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(), createdAt: new Date().toISOString(),
        }],
      },
      "/v1/trials/t1": {
        id: "t1", personId: "p1", leadId: null, previousTrialId: null, trialKind: "SERVICE",
        retrialReason: null, lifecycleStatus: "ACTIVE", technicalOutcome: null, requestedDurationMinutes: 60,
        adultContentEnabled: false, providerAccountId: null, activatedAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(), endedAt: null, invalidatedReason: null,
        createdAt: new Date().toISOString(), attempts: [], technicalResult: null,
      },
    }, seen);
    renderPage(<TrialsPage />);
    await waitFor(() => expect(screen.getByText("SERVICE")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Encerrar" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Encerrar" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Encerrar trial");
    fireEvent.click(within(dialog).getByRole("button", { name: "Encerrar" }));
    await waitFor(() => expect(screen.getByText("Comando de trial enviado.")).toBeTruthy());
    expect(seen.posts.some((u) => u.includes("/v1/trials/t1/end"))).toBe(true);
  });
});

describe("Billing", () => {
  it("lista cobranças com valor formatado e concilia", async () => {
    const seen = { posts: [] as string[] };
    sessionMocks(["billing.read", "billing.charge.write"], {
      "/v1/charges": {
        charges: [{
          id: "c1", order_id: "o1", status: "PENDING", amount_minor: "19990",
          currency: "BRL", payment_method: "pix", created_at: new Date().toISOString(), paid_at: null,
        }],
      },
    }, seen);
    renderPage(<BillingPage />);
    await waitFor(() => expect(screen.getByText("R$ 199,90")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Conciliar" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Conciliar cobrança");
    fireEvent.click(within(dialog).getByRole("button", { name: "Conciliar" }));
    await waitFor(() => expect(screen.getByText("Comando de cobrança enviado.")).toBeTruthy());
    expect(seen.posts.some((u) => u.includes("/v1/charges/c1/reconcile"))).toBe(true);
  });
});

describe("Fulfillment", () => {
  it("consulta estado e solicita provisionamento", async () => {
    const seen = { posts: [] as string[] };
    sessionMocks(["subscription.read", "subscription.write"], {
      "/v1/fulfillment/subscriptions/s1": {
        operationId: "op1", action: "activate", status: "RUNNING",
        effectCertainty: "UNCERTAIN", requestedAt: new Date().toISOString(),
      },
    }, seen);
    renderPage(<FulfillmentPage />);
    await waitFor(() => expect(screen.getByText("Ativação (fulfillment)")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("UUID da assinatura"), { target: { value: "s1" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar estado" }));
    await waitFor(() => expect(screen.getByText("op1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Solicitar novamente (fallback manual)" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar solicitação" }));
    await waitFor(() => expect(screen.getByText("Provisionamento solicitado.")).toBeTruthy());
    expect(seen.posts.some((u) => u.includes("/v1/fulfillment/subscriptions/s1/request"))).toBe(true);
  });
});

describe("Renewals", () => {
  it("lista pedidos de renovação e renova com confirmação", async () => {
    const seen = { posts: [] as string[] };
    sessionMocks(["subscription.read", "subscription.write"], {
      "/v1/renewals?": {
        orders: [{
          id: "o9", orderType: "RENEWAL", status: "SETTLED", currency: "BRL",
          netAmountMinor: "9990", cycle: { id: "cy1", cycleNo: 2 },
          createdAt: new Date().toISOString(), settledAt: new Date().toISOString(),
        }],
      },
      "/v1/recovery-tasks?": { tasks: [] },
    }, seen);
    renderPage(<RenewalsPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Renovações" })).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("UUID da assinatura"), { target: { value: "s1" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar renovações" }));
    await waitFor(() => expect(screen.getByText("R$ 99,90")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Renovar" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Renovar assinatura");
    fireEvent.click(within(dialog).getByRole("button", { name: "Renovar" }));
    await waitFor(() => expect(screen.getByText("Comando de renovação enviado.")).toBeTruthy());
    expect(seen.posts.some((u) => u.includes("/v1/renewals/renew"))).toBe(true);
  });
});

describe("Inventory", () => {
  it("lista app trials e valida com confirmação", async () => {
    const seen = { posts: [] as string[] };
    sessionMocks(["trial.read", "trial.write"], {
      "/v1/inventory/app-trials": {
        items: [{
          id: "a1", personId: "p1", customerId: null, supplierId: "sup-12345",
          supplierAppExternalId: null, status: "REQUESTED",
          requestedAt: new Date().toISOString(), validatedAt: null, expiresAt: null,
        }],
      },
    }, seen);
    renderPage(<InventoryPage />);
    await waitFor(() => expect(screen.getByText("Inventário (apps/MK)")).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: "Validar" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Validar" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar validação" }));
    await waitFor(() => expect(screen.getByText("App trial validado.")).toBeTruthy());
    expect(seen.posts.some((u) => u.includes("/v1/inventory/app-trials/a1/validate"))).toBe(true);
  });
});
