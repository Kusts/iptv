import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import TrialsPage from "../app/trials/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/trials",
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
        if (url.includes("/v1/trials/request")) {
          return jsonResponse(200, { id: "trial-new-123", status: "REQUESTED" });
        }
        if (url.includes("/v1/trials/retrials")) {
          return jsonResponse(200, { id: "retrial-new-456", status: "REQUESTED" });
        }
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

describe("TrialsPage", () => {
  const samplePerson = { id: "00000000-0000-4000-8000-000000000201", canonicalName: "Cliente Teste" };

  const terminalTrial = {
    id: "00000000-0000-4000-8000-000000000777",
    personId: "00000000-0000-4000-8000-000000000201",
    trialKind: "SERVICE",
    lifecycleStatus: "ENDED",
    technicalOutcome: "COMPLETED",
    requestedDurationMinutes: 60,
    activatedAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    leadId: null,
    previousTrialId: null,
    retrialReason: null,
    adultContentEnabled: false,
    providerAccountId: null,
    endedAt: new Date().toISOString(),
    invalidatedReason: null,
    attempts: [],
    technicalResult: null,
  };

  it("abre modal 'Novo trial', autofilla pessoa do CRM e dispara solicitação", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["trial.read", "trial.write", "crm.person.read"],
      {
        "/v1/crm/persons": { persons: [samplePerson] },
        "/v1/trials": { trials: [] },
      },
      seen,
    );

    renderPage(<TrialsPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Novo trial" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Novo trial" }));
    await waitFor(() => expect(screen.getByText("Trial para Cliente Teste (seleção automática).")).toBeTruthy());

    // Clica em Solicitar trial
    fireEvent.click(screen.getByRole("button", { name: "Solicitar trial" }));

    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/trials/request"))).toBe(true),
    );

    const postCall = seen.posts.find((p) => p.url.includes("/v1/trials/request"));
    expect(postCall?.body).toEqual({
      personId: samplePerson.id,
      durationMinutes: 60,
      adultContentEnabled: false,
    });
  });

  it("com trial terminal (ENDED), permite solicitar retrial com justificativa", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["trial.read", "trial.write"],
      {
        "/v1/trials/00000000-0000-4000-8000-000000000777": terminalTrial,
        "/v1/trials": { trials: [terminalTrial] },
      },
      seen,
    );

    renderPage(<TrialsPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Solicitar retrial" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Solicitar retrial" }));
    await waitFor(() => expect(screen.getByText("Trial anterior: 00000000-0000-4000-8000-000000000777 (ENDED)")).toBeTruthy());

    fireEvent.change(
      screen.getByPlaceholderText("Ex.: Instabilidade de rota no primeiro teste; reteste aprovado"),
      { target: { value: "Reteste autorizado pelo operador" } },
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirmar retrial" }));

    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/trials/retrials"))).toBe(true),
    );

    const retrialCall = seen.posts.find((p) => p.url.includes("/v1/trials/retrials"));
    expect(retrialCall?.body).toEqual({
      previousTrialId: terminalTrial.id,
      reason: "Reteste autorizado pelo operador",
      durationMinutes: 60,
      adultContentEnabled: false,
    });
  });

  it("sem permissão trial.write, esconde botão 'Novo trial' e 'Solicitar retrial'", async () => {
    const seen = { posts: [] as { url: string; body?: unknown }[] };
    sessionMocks(
      ["trial.read"],
      {
        "/v1/trials/00000000-0000-4000-8000-000000000777": terminalTrial,
        "/v1/trials": { trials: [terminalTrial] },
      },
      seen,
    );

    renderPage(<TrialsPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Trials" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Novo trial" })).toBeNull();

    await waitFor(() => expect(screen.getByRole("button", { name: "Detalhe" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detalhe" }));

    await waitFor(() => expect(screen.getByText("Detalhe do trial")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Solicitar retrial" })).toBeNull();
  });
});
