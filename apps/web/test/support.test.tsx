import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import SupportPage from "../app/support/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/support",
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

function renderPage(page: ReactNode): { unmount: () => void } {
  const result = render(
    <AuthProvider>
      <ToastProvider>{page}</ToastProvider>
    </AuthProvider>,
  );
  return { unmount: result.unmount };
}

const TICKET_ID = "00000000-0000-4000-8000-000000000abc";

function ticketDetail(status: string, attempts: Array<{ id: string; outcome: string; procedureKey: string | null; attemptNo: number }>) {
  return {
    ticket: {
      id: TICKET_ID,
      personId: "00000000-0000-4000-8000-000000000def",
      customerId: null,
      conversationId: null,
      status,
      priority: "NORMAL",
      category: "BILLING",
      summary: "Ajuda com a renovacao",
      assigneeUserId: null,
      firstResponseAt: null,
      resolvedAt: null,
      closedAt: null,
      createdAt: "2026-11-10T00:00:00Z",
      updatedAt: "2026-11-10T00:00:00Z",
    },
    incidents: [],
    problems: [],
    attempts: attempts.map((a) => ({
      id: a.id,
      solutionId: null,
      procedureKey: a.procedureKey,
      attemptNo: a.attemptNo,
      actorType: "user",
      outcome: a.outcome,
      completedAt: "2026-11-10T00:01:00Z",
    })),
    solutionOutcomes: [],
    conversation: null,
  };
}

function listWithTicket() {
  return {
    tickets: [
      {
        id: TICKET_ID,
        status: "NEW",
        priority: "NORMAL",
        summary: "Ajuda com a renovacao",
        personId: "00000000-0000-4000-8000-000000000def",
        createdAt: "2026-11-10T00:00:00Z",
      },
    ],
  };
}

describe("SupportPage", () => {
  it("permite transicionar um ticket NEW para TRIAGING e registra tentativa de solução", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["support.ticket.write"],
      {
        "/v1/tickets": listWithTicket(),
        "/v1/tickets/my-work": { tickets: [] },
        "/v1/crm/persons": { persons: [] },
        [`/v1/tickets/${TICKET_ID}`]: ticketDetail("NEW", []),
      },
      seen,
    );

    renderPage(<SupportPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Suporte" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Ajuda com a renovacao")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));

    await waitFor(() => expect(screen.getByText("Ajuda com a renovacao")).toBeTruthy());
    const triage = screen.getByRole("button", { name: "Triagem" });
    expect(triage).toBeTruthy();
    fireEvent.click(triage);

    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes(`/v1/tickets/${TICKET_ID}/transition`) && (p.body as any)?.toStatus === "TRIAGING")).toBe(true),
    );
    await waitFor(() => expect(screen.getByPlaceholderText("ex.: restart-app")).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText("ex.: restart-app"), { target: { value: "restart-app" } });
    fireEvent.click(screen.getByRole("button", { name: "Registrar tentativa" }));
    await waitFor(() =>
      expect(
        seen.posts.some(
          (p) =>
            p.url.includes(`/v1/tickets/${TICKET_ID}/attempts`) &&
            (p.body as any)?.procedureKey === "restart-app" &&
            (p.body as any)?.outcome === "SUCCEEDED",
        ),
      ).toBe(true),
    );
  });

  it("orienta a avançar de triagem antes de resolver com tentativa desbloqueante", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["support.ticket.write"],
      {
        "/v1/tickets": listWithTicket(),
        "/v1/tickets/my-work": { tickets: [] },
        "/v1/crm/persons": { persons: [] },
        [`/v1/tickets/${TICKET_ID}`]: ticketDetail("TRIAGING", [
          { id: "att-triage", outcome: "SUCCEEDED", procedureKey: "restart-app", attemptNo: 1 },
        ]),
      },
      seen,
    );

    renderPage(<SupportPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Suporte" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Ajuda com a renovacao")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));

    const resolve = await screen.findByRole("button", { name: "Resolver ticket" });
    expect((resolve as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Mova o ticket de Triagem para Em andamento para habilitar a resolução."),
    ).toBeTruthy();
  });

  it("resolve somente com atendimento ativo e tentativa desbloqueante", async () => {
    // NEW: resolve bloqueado.
    const seenNew = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["support.ticket.write"],
      {
        "/v1/tickets": listWithTicket(),
        "/v1/tickets/my-work": { tickets: [] },
        "/v1/crm/persons": { persons: [] },
        [`/v1/tickets/${TICKET_ID}`]: ticketDetail("NEW", []),
      },
      seenNew,
    );
    const first = renderPage(<SupportPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Suporte" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Ajuda com a renovacao")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    await waitFor(() => expect(screen.getByText("Ajuda com a renovacao")).toBeTruthy());
    const resolveNew = screen.getByRole("button", { name: "Resolver ticket" }) as HTMLButtonElement;
    expect(resolveNew.disabled).toBe(true);
    expect(screen.getByText(/Registre uma tentativa com resultado SUCCEEDED ou PARTIAL/)).toBeTruthy();
    first.unmount();

    // IN_PROGRESS com tentativa SUCCEEDED: resolve habilitado.
    clearApiCache();
    window.localStorage.clear();
    const seenOk = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["support.ticket.write"],
      {
        "/v1/tickets": { tickets: [listWithTicket().tickets[0]] },
        "/v1/tickets/my-work": { tickets: [] },
        "/v1/crm/persons": { persons: [] },
        [`/v1/tickets/${TICKET_ID}`]: ticketDetail("IN_PROGRESS", [
          { id: "att-1", outcome: "SUCCEEDED", procedureKey: "restart-app", attemptNo: 1 },
        ]),
      },
      seenOk,
    );
    renderPage(<SupportPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Suporte" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Ajuda com a renovacao")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    await waitFor(() => expect(screen.getByText("Ajuda com a renovacao")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Resolvido" })).toBeNull();
    const resolveOk = screen.getByRole("button", { name: "Resolver ticket" }) as HTMLButtonElement;
    expect(resolveOk.disabled).toBe(false);
    fireEvent.click(resolveOk);
    await waitFor(() =>
      expect(seenOk.posts.some((p) => p.url.includes(`/v1/tickets/${TICKET_ID}/resolve`))).toBe(true),
    );
  });

  it("sem support.ticket.write omite o formulário de novo ticket", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(["support.ticket.read"], { "/v1/tickets": listWithTicket(), "/v1/tickets/my-work": { tickets: [] } }, seen);
    renderPage(<SupportPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Suporte" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Abrir ticket" })).toBeNull();
  });
});
