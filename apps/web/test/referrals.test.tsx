import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import ReferralsPage from "../app/referrals/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/referrals",
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

describe("ReferralsPage", () => {
  it("consulta indicações de cliente e realiza qualificação sob crm.lead.write", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["crm.person.read", "crm.lead.write"],
      {
        "/v1/crm/persons": {
          items: [{ id: "c-100", canonicalName: "Cliente Indicador" }],
        },
        "/v1/customers/c-100/referrals": {
          items: [
            {
              id: "ref-1",
              status: "PENDING",
              referralCode: "AMIGO2026",
              referredPersonId: "p-200",
              createdAt: "2026-10-20T10:00:00.000Z",
              confirmedAt: null,
            },
          ],
        },
      },
      seen,
    );

    renderPage(<ReferralsPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Indicações" })).toBeTruthy());

    // Can use manual input or select assist
    fireEvent.change(screen.getByPlaceholderText("UUID do cliente"), { target: { value: "c-100" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar indicações" }));

    await waitFor(() => expect(screen.getByText("AMIGO2026")).toBeTruthy());
    expect(screen.getByText("PENDING")).toBeTruthy();

    // Qualify action
    fireEvent.click(screen.getByRole("button", { name: "Qualificar" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Qualificar indicação");

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar qualificação" }));
    await waitFor(() => expect(screen.getByText("Qualificação de indicação enviada.")).toBeTruthy());

    expect(seen.posts.some((p) => p.url.includes("/v1/referrals/ref-1/qualification"))).toBe(true);
  });

  it("cria nova indicação para um cliente sob crm.lead.write", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["crm.person.read", "crm.lead.write"],
      {
        "/v1/crm/persons": {
          items: [
            { id: "c-100", canonicalName: "Cliente Indicador" },
            { id: "p-200", canonicalName: "Amigo Indicado" },
          ],
        },
        "/v1/customers/c-100/referrals": { items: [] },
      },
      seen,
    );

    renderPage(<ReferralsPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Indicações" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Nova indicação" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Nova indicação");

    fireEvent.change(within(dialog).getByPlaceholderText("UUID do cliente indicador"), {
      target: { value: "c-100" },
    });
    fireEvent.change(within(dialog).getByPlaceholderText("UUID da pessoa indicada"), {
      target: { value: "p-200" },
    });
    fireEvent.change(within(dialog).getByPlaceholderText("Ex.: AMIGO10"), {
      target: { value: "AMIGO10" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Criar indicação" }));

    await waitFor(() => expect(screen.getByText("Indicação criada com sucesso.")).toBeTruthy());
    const creationPost = seen.posts.find((p) => p.url.includes("/v1/customers/c-100/referrals"));
    expect(creationPost).toBeTruthy();
    expect(creationPost?.body).toEqual({
      referredPersonId: "p-200",
      referralCode: "AMIGO10",
    });
  });

  it("consulta recompensas do cliente e realiza resgate sob commerce.order.write", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["crm.person.read", "commerce.order.write"],
      {
        "/v1/crm/persons": {
          items: [{ id: "c-999", canonicalName: "Cliente Recompensado" }],
        },
        "/v1/customers/c-999/rewards": {
          rewards: [
            {
              id: "rew-10",
              status: "AVAILABLE",
              economicValueMinor: "7500",
              currency: "BRL",
              createdAt: "2026-10-25T14:30:00.000Z",
            },
          ],
        },
      },
      seen,
    );

    renderPage(<ReferralsPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Indicações" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Recompensas" }));
    fireEvent.change(screen.getByPlaceholderText("UUID do cliente"), { target: { value: "c-999" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar recompensas" }));

    await waitFor(() => expect(screen.getByText("R$ 75,00")).toBeTruthy());
    expect(screen.getByText("AVAILABLE")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Resgatar" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Resgatar recompensa");

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar resgate" }));
    await waitFor(() => expect(screen.getByText("Resgate de recompensa enviado.")).toBeTruthy());

    expect(seen.posts.some((p) => p.url.includes("/v1/rewards/rew-10/redeem"))).toBe(true);
  });

  it("resgata código de gift-pass sob crm.lead.write", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(["crm.person.read", "crm.lead.write"], {}, seen);

    renderPage(<ReferralsPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Indicações" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Gift-pass" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Resgatar gift-pass" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Resgatar código" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Resgatar gift-pass");

    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "GIFT-PASS-2026" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar resgate" }));

    await waitFor(() => expect(screen.getByText("Gift-pass resgatado.")).toBeTruthy());
    const passPost = seen.posts.find((p) => p.url.includes("/v1/gift-passes/redeem"));
    expect(passPost).toBeTruthy();
    expect(passPost?.body).toEqual({ code: "GIFT-PASS-2026" });
  });

  it("enforces permission gates for read and writes", async () => {
    // 1. Without crm.person.read
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks([], {}, seen);
    renderPage(<ReferralsPage />);
    await waitFor(() => expect(screen.getByText(/Sem permissão para as indicações/)).toBeTruthy());
  });

  it("oculta ações de escrita quando faltam permissões crm.lead.write ou commerce.order.write", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["crm.person.read"],
      {
        "/v1/customers/c-100/referrals": {
          items: [{ id: "ref-1", status: "PENDING", createdAt: "2026-10-20T10:00:00.000Z" }],
        },
        "/v1/customers/c-100/rewards": {
          items: [{ id: "rew-1", status: "AVAILABLE", amountMinor: "2000", currency: "BRL" }],
        },
      },
      seen,
    );

    renderPage(<ReferralsPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Indicações" })).toBeTruthy());

    // Without crm.lead.write: no "Nova indicação" button, message shown
    expect(screen.queryByRole("button", { name: "Nova indicação" })).toBeNull();
    expect(
      screen.getByText("Você não tem a permissão crm.lead.write; qualificação fica indisponível."),
    ).toBeTruthy();

    // Check referrals table actions
    fireEvent.change(screen.getByPlaceholderText("UUID do cliente"), { target: { value: "c-100" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar indicações" }));
    await waitFor(() => expect(screen.getByText("PENDING")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Qualificar" })).toBeNull();

    // Switch to rewards tab without commerce.order.write: no "Resgatar" button
    fireEvent.click(screen.getByRole("button", { name: "Recompensas" }));
    expect(
      screen.getByText("Você não tem a permissão commerce.order.write; resgate fica indisponível."),
    ).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("UUID do cliente"), { target: { value: "c-100" } });
    fireEvent.click(screen.getByRole("button", { name: "Consultar recompensas" }));
    await waitFor(() => expect(screen.getByText("AVAILABLE")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Resgatar" })).toBeNull();

    // Switch to gift-pass tab without crm.lead.write: no "Resgatar código" button
    fireEvent.click(screen.getByRole("button", { name: "Gift-pass" }));
    expect(
      screen.getByText("Você não tem a permissão crm.lead.write; resgate fica indisponível."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resgatar código" })).toBeNull();
  });
});
