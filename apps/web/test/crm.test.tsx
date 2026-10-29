import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import CrmPage from "../app/crm/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/crm",
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
        return jsonResponse(200, { id: "mock-res-123", status: "OK" });
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

describe("CrmPage", () => {
  const samplePerson = {
    id: "00000000-0000-4000-8000-000000000201",
    status: "ACTIVE",
    canonicalName: "Maria Silva",
    locale: "pt-BR",
    timezone: "America/Sao_Paulo",
    createdAt: new Date().toISOString(),
  };

  const samplePersonDetail = {
    ...samplePerson,
    identities: [
      {
        id: "id-1",
        identityType: "phone_e164",
        normalizedValue: "+5511999998888",
        verificationStatus: "VERIFIED",
      },
    ],
  };

  const sampleLead = {
    id: "00000000-0000-4000-8000-000000000301",
    personId: samplePerson.id,
    status: "CONTACTED",
    stage: "prospeccao",
    createdAt: new Date().toISOString(),
  };

  const sampleLeadDetail = {
    ...sampleLead,
    qualifiedAt: null,
    lostAt: null,
    closedReason: null,
  };

  it("renderiza aba Pessoas, detalhe da pessoa (visão 360) e captura lead para esta pessoa", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["crm.person.read", "crm.lead.write"],
      {
        "/v1/crm/persons/00000000-0000-4000-8000-000000000201": samplePersonDetail,
        "/v1/crm/persons": { persons: [samplePerson] },
        "/v1/crm/leads": { leads: [] },
      },
      seen,
    );

    renderPage(<CrmPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "CRM" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Maria Silva")).toBeTruthy());

    // Clica em Detalhe
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByText("Visão 360 da pessoa")).toBeTruthy());
    expect(screen.getByText("phone_e164")).toBeTruthy();
    expect(screen.getByText("VERIFIED")).toBeTruthy();

    // Clica em Capturar lead para esta pessoa
    const captureBtn = screen.getByRole("button", { name: "Capturar lead para esta pessoa" });
    fireEvent.click(captureBtn);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Capturar lead");
    expect(screen.getByText(/Lead para Maria Silva/)).toBeTruthy();

    // Confirma captura
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar captura" }));

    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/crm/leads"))).toBe(true),
    );

    const postCall = seen.posts.find((p) => p.url.includes("/v1/crm/leads"));
    expect(postCall?.body).toEqual({
      personId: samplePerson.id,
    });
  });

  it("na aba Leads, abre CaptureLeadDialog, autofilla pessoa única e captura lead com estágio", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["crm.person.read", "crm.lead.write"],
      {
        "/v1/crm/persons": { persons: [samplePerson] },
        "/v1/crm/leads": { leads: [] },
      },
      seen,
    );

    renderPage(<CrmPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Leads" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Leads" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Capturar lead" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Capturar lead" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Capturar lead");
    await waitFor(() =>
      expect(screen.getByText(/Lead para Maria Silva \(seleção automática\)/)).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText("Estágio (opcional)"), { target: { value: "qualificado" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar captura" }));

    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/crm/leads"))).toBe(true),
    );

    const postCall = seen.posts.find((p) => p.url.includes("/v1/crm/leads"));
    expect(postCall?.body).toEqual({
      personId: samplePerson.id,
      stage: "qualificado",
    });
  });

  it("na aba Leads, seleciona lead e realiza transição de status com motivo", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["crm.person.read", "crm.lead.write"],
      {
        "/v1/crm/leads/00000000-0000-4000-8000-000000000301": sampleLeadDetail,
        "/v1/crm/leads": { leads: [sampleLead] },
      },
      seen,
    );

    renderPage(<CrmPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Leads" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Leads" }));

    await waitFor(() => expect(screen.getByText("prospeccao")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Transição de status" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Transição de status" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Transição de lead");

    fireEvent.change(within(dialog).getByLabelText("Próximo status"), { target: { value: "QUALIFIED" } });
    fireEvent.change(within(dialog).getByLabelText("Motivo (opcional)"), {
      target: { value: "Cliente confirmou interesse no plano" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar transição" }));

    await waitFor(() =>
      expect(
        seen.posts.some((p) =>
          p.url.includes("/v1/crm/leads/00000000-0000-4000-8000-000000000301/transition"),
        ),
      ).toBe(true),
    );

    const transCall = seen.posts.find((p) =>
      p.url.includes("/v1/crm/leads/00000000-0000-4000-8000-000000000301/transition"),
    );
    expect(transCall?.body).toEqual({
      toStatus: "QUALIFIED",
      reason: "Cliente confirmou interesse no plano",
    });
  });

  it("sem permissão crm.lead.write, esconde botões de mutação", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["crm.person.read"],
      {
        "/v1/crm/persons/00000000-0000-4000-8000-000000000201": samplePersonDetail,
        "/v1/crm/persons": { persons: [samplePerson] },
        "/v1/crm/leads": { leads: [sampleLead] },
      },
      seen,
    );

    renderPage(<CrmPage />);
    await waitFor(() => expect(screen.getByText("Maria Silva")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Registrar pessoa" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByText("Visão 360 da pessoa")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Capturar lead para esta pessoa" })).toBeNull();

    // Vai para Leads
    fireEvent.click(screen.getByRole("button", { name: "Leads" }));
    await waitFor(() => expect(screen.getByText("prospeccao")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Capturar lead" })).toBeNull();
  });

  it("sem permissão crm.person.read, exibe bloqueio do PermissionGate", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks([], {}, seen);

    renderPage(<CrmPage />);
    await waitFor(() => expect(screen.getByText(/Sem permissão para o CRM/)).toBeTruthy());
  });
});
