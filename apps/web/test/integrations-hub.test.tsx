import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import IntegrationsHubPage from "../app/settings/integrations/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/integrations",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

interface SeenPost {
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Seen {
  posts: SeenPost[];
  gets: string[];
}

type PostResponder = (url: string, body: Record<string, unknown>) => { status: number; body: unknown } | null;

function providerOf(url: string): string {
  const match = /\/v1\/integrations\/([^/]+)\//.exec(url);
  const found = match?.[1];
  return found ?? "unknown";
}

function defaultPostResponder(url: string): { status: number; body: unknown } {
  const provider = providerOf(url);
  const base = {
    id: "bind-1",
    provider,
    environment: "SANDBOX",
    last_checked_at: "2026-10-30T12:00:00.000Z",
    last_error_code: null,
  };
  if (url.includes("/whatsapp/")) {
    return { status: 501, body: { code: "CAPABILITY_UNCERTIFIED", message: "whatsapp integration is uncertified" } };
  }
  if (url.includes("/test")) {
    return { status: 200, body: { ...base, connection_status: "CONNECTED_READ_ONLY", version: 2 } };
  }
  if (url.includes("/configure")) {
    return { status: 201, body: { ...base, connection_status: "DRAFT", version: 3 } };
  }
  if (url.includes("/disable")) {
    return { status: 201, body: { ...base, connection_status: "DISABLED", version: 4 } };
  }
  return { status: 404, body: { code: "NOT_FOUND" } };
}

const SESSION_OK = {
  user: { id: "u1", email: "op@tenant.com", displayName: null },
  activeTenantId: "t1",
  tenantContextRevision: "1",
  memberships: [],
};

function installFetch(opts: {
  permissions: string[];
  integrations?: unknown;
  integrationsStatus?: number;
  onPost?: PostResponder;
  failGetsWith?: { status: number; body: unknown };
  offlineGets?: boolean;
}): Seen {
  const seen: Seen = { posts: [], gets: [] };
  window.localStorage.setItem("iptv.session_token", "tok-ops");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/v1/auth/session")) return jsonResponse(200, SESSION_OK);
      if (url.includes("/v1/me")) {
        return jsonResponse(200, {
          user: { id: "u1", email: "op@tenant.com" },
          activeTenant: { id: "t1" },
          roleKeys: [],
          permissions: opts.permissions,
        });
      }
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        seen.posts.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
        const custom = opts.onPost?.(url, body);
        if (custom) return jsonResponse(custom.status, custom.body);
        const fallback = defaultPostResponder(url);
        return jsonResponse(fallback.status, fallback.body);
      }
      seen.gets.push(url);
      if (opts.offlineGets && url.includes("/v1/integrations")) {
        throw new TypeError("Failed to fetch");
      }
      // Contrato S3a: sessão/QR do WhatsApp têm rotas próprias (fora do GET
      // genérico de integrações). Sem vínculo, 404 fail-closed.
      if (url.includes("/v1/integrations/whatsapp/session")) {
        return jsonResponse(404, { code: "NO_SESSION", message: "no whatsapp session bound in this tenant" });
      }
      if (url.includes("/v1/integrations/whatsapp/qr")) {
        return jsonResponse(404, { code: "QR_NOT_READY", message: "no QR available" });
      }
      if (url.includes("/v1/integrations")) {
        if (opts.failGetsWith) return jsonResponse(opts.failGetsWith.status, opts.failGetsWith.body);
        return jsonResponse(opts.integrationsStatus ?? 200, opts.integrations);
      }
      return jsonResponse(404, { code: "NOT_FOUND" });
    }),
  );
  return seen;
}

function fullPermissions(): string[] {
  return ["integration.read", "integration.manage", "integration.test"];
}

function sampleList(): { integrations: unknown[] } {
  return {
    integrations: [
      {
        provider: "asaas",
        environment: "SANDBOX",
        connection_status: "CONNECTED_READ_ONLY",
        capability_status: "AVAILABLE",
        last_checked_at: "2026-10-30T12:00:00.000Z",
        last_error_code: null,
        configured: true,
        // Campo que a API NUNCA envia (sanitização no SELECT): se vazar um
        // dia, a UI não pode renderizá-lo.
        secret_ref: "infisical://test/integrations/t1/asaas/ASAAS_API_KEY",
      },
      {
        provider: "whatsapp",
        environment: "SANDBOX",
        connection_status: "NOT_CONFIGURED",
        capability_status: "UNCERTIFIED",
        last_checked_at: null,
        last_error_code: null,
        configured: false,
      },
      {
        provider: "cinevision",
        environment: "SANDBOX",
        connection_status: "DRAFT",
        capability_status: "UNKNOWN",
        last_checked_at: null,
        last_error_code: null,
        configured: true,
      },
    ],
  };
}

function renderPage(page: ReactNode): void {
  render(
    <AuthProvider>
      <ToastProvider>{page}</ToastProvider>
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  clearApiCache();
});

describe("IntegrationsHubPage", () => {
  it("lista os 3 cards em pt-BR sem expor segredos", async () => {
    installFetch({ permissions: fullPermissions(), integrations: sampleList() });
    const { container } = render(
      <AuthProvider>
        <ToastProvider>
          <IntegrationsHubPage />
        </ToastProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByRole("heading", { name: "Integrações" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    expect(screen.getByText("WhatsApp (Atendimento)")).toBeTruthy();
    expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy();
    expect(screen.getByText("Conectado (somente leitura)")).toBeTruthy();
    expect(screen.getByText("Não configurado")).toBeTruthy();
    // Sanitização: nem o marcador simulado de vazamento aparece no DOM.
    const html = container.innerHTML;
    expect(html).not.toContain("secret_ref");
    expect(html).not.toContain("infisical://");
  });

  it("sem integration.read mostra estado sanitizado sem buscar a API", async () => {
    const seen = installFetch({ permissions: [], integrations: sampleList() });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Sem permissão")).toBeTruthy());
    expect(screen.getByText(/Você não tem permissão para ver as integrações/)).toBeTruthy();
    expect(seen.gets.some((u) => u.includes("/v1/integrations"))).toBe(false);
  });

  it("sem manage/test oculta ações de escrita e mostra somente leitura", async () => {
    installFetch({ permissions: ["integration.read"], integrations: sampleList() });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Conectar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconfigurar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Testar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Desconectar" })).toBeNull();
    expect(screen.getAllByText("Somente leitura para o seu perfil.").length).toBeGreaterThan(0);
  });

  it("lista vazia mostra estado vazio em pt-BR", async () => {
    installFetch({ permissions: fullPermissions(), integrations: { integrations: [] } });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Nenhuma integração encontrada")).toBeTruthy());
  });

  it("falha da API mostra erro com retry que recarrega", async () => {
    let calls = 0;
    const seen = installFetch({
      permissions: fullPermissions(),
      integrations: sampleList(),
      onPost: () => null,
    });
    void seen;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/v1/auth/session")) return jsonResponse(200, SESSION_OK);
        if (url.includes("/v1/me")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "op@tenant.com" },
            activeTenant: { id: "t1" },
            roleKeys: [],
            permissions: fullPermissions(),
          });
        }
        if (url.includes("/v1/integrations")) {
          calls += 1;
          if (calls === 1) return jsonResponse(500, { code: "INTERNAL" });
          return jsonResponse(200, sampleList());
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Não foi possível carregar.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("offline mostra mensagem de conexão em pt-BR", async () => {
    installFetch({ permissions: fullPermissions(), integrations: sampleList(), offlineGets: true });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() =>
      expect(screen.getByText("Não foi possível alcançar a API. Verifique sua conexão.")).toBeTruthy(),
    );
  });

  it("whatsapp exibe conexão via QR sem form de segredo", async () => {
    installFetch({ permissions: fullPermissions(), integrations: sampleList() });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("WhatsApp (Atendimento)")).toBeTruthy());
    const card = screen.getByText("WhatsApp (Atendimento)").closest("section");
    expect(card).not.toBeNull();
    const scope = within(card as HTMLElement);
    // S3b: o card agora conecta de verdade (sem sessão vinculada neste mock).
    await waitFor(() => expect(scope.getByText(/Nenhuma sessão WhatsApp vinculada/)).toBeTruthy());
    expect(scope.getByRole("button", { name: "Conectar WhatsApp" })).toBeTruthy();
    expect(scope.queryByText("Chave de API")).toBeNull();
    expect((card as HTMLElement).querySelector('input[type="password"]')).toBeNull();
    expect(scope.queryByRole("button", { name: "Testar" })).toBeNull();
    expect(scope.queryByRole("button", { name: "Desconectar" })).toBeNull();
  });

  it("conectar asaas novo envia secret + environment sem expectedVersion", async () => {
    const fresh = {
      integrations: [
        {
          provider: "asaas",
          environment: "SANDBOX",
          connection_status: "NOT_CONFIGURED",
          capability_status: "AVAILABLE",
          last_checked_at: null,
          last_error_code: null,
          configured: false,
        },
        {
          provider: "whatsapp",
          environment: "SANDBOX",
          connection_status: "NOT_CONFIGURED",
          capability_status: "UNCERTIFIED",
          last_checked_at: null,
          last_error_code: null,
          configured: false,
        },
        {
          provider: "cinevision",
          environment: "SANDBOX",
          connection_status: "NOT_CONFIGURED",
          capability_status: "UNKNOWN",
          last_checked_at: null,
          last_error_code: null,
          configured: false,
        },
      ],
    };
    const seen = installFetch({ permissions: fullPermissions(), integrations: fresh });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    const card = screen.getByText("Asaas (Cobranças)").closest("section");
    const scope = within(card as HTMLElement);
    fireEvent.click(scope.getByRole("button", { name: "Conectar" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Conectar integração" })).toBeTruthy());
    const dialog = within(screen.getByRole("dialog", { name: "Conectar integração" }));
    const apiKeyInput = dialog.getByLabelText(/Chave de API/);
    expect(apiKeyInput.getAttribute("type")).toBe("password");
    fireEvent.change(apiKeyInput, { target: { value: "hub-fixture-synthetic-key-001" } });
    fireEvent.click(dialog.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/integrations/asaas/configure"))).toBe(true),
    );
    const call = seen.posts.find((p) => p.url.includes("/v1/integrations/asaas/configure"));
    expect(call?.body).toEqual({
      environment: "SANDBOX",
      secret: { apiKey: "hub-fixture-synthetic-key-001" },
    });
    await waitFor(() => expect(screen.getByText(/Integração conectada/)).toBeTruthy());
    // Segredo digitado nunca é renderizado como texto após o salvamento.
    expect(document.body.textContent ?? "").not.toContain("hub-fixture-synthetic-key-001");
  });

  it("valida campos imediatamente sem rede", async () => {
    const fresh = {
      integrations: [
        {
          provider: "cinevision",
          environment: "SANDBOX",
          connection_status: "NOT_CONFIGURED",
          capability_status: "UNKNOWN",
          last_checked_at: null,
          last_error_code: null,
          configured: false,
        },
        {
          provider: "asaas",
          environment: "SANDBOX",
          connection_status: "NOT_CONFIGURED",
          capability_status: "AVAILABLE",
          last_checked_at: null,
          last_error_code: null,
          configured: false,
        },
        {
          provider: "whatsapp",
          environment: "SANDBOX",
          connection_status: "NOT_CONFIGURED",
          capability_status: "UNCERTIFIED",
          last_checked_at: null,
          last_error_code: null,
          configured: false,
        },
      ],
    };
    const seen = installFetch({ permissions: fullPermissions(), integrations: fresh });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    const card = screen.getByText("CINEVISION (Servidor/Ativação)").closest("section");
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Conectar conta" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Conectar conta CINEVISION" })).toBeTruthy());
    const dialog = within(screen.getByRole("dialog", { name: "Conectar conta CINEVISION" }));
    fireEvent.click(dialog.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(dialog.getByText("Informe o usuário.")).toBeTruthy());
    expect(seen.posts.length).toBe(0);
  });

  it("testar sonda a API e exibe toast com o resultado", async () => {
    const seen = installFetch({ permissions: fullPermissions(), integrations: sampleList() });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    const card = screen.getByText("Asaas (Cobranças)").closest("section");
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Testar" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/integrations/asaas/test"))).toBe(true),
    );
    await waitFor(() => expect(screen.getByText(/Teste concluído/)).toBeTruthy());
  });

  it("reconfigurar envia expectedVersion aprendido no teste", async () => {
    const seen = installFetch({ permissions: fullPermissions(), integrations: sampleList() });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    const card = screen.getByText("Asaas (Cobranças)").closest("section");
    const scope = within(card as HTMLElement);
    // Primeiro o Testar aprende a versão (resposta version 2 do mock).
    fireEvent.click(scope.getByRole("button", { name: "Testar" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/integrations/asaas/test"))).toBe(true),
    );
    await waitFor(() => expect(screen.getByText(/Teste concluído/)).toBeTruthy());
    // Reconfigurar reutiliza a versão sem nova sonda (recarrega o card após o reload da lista).
    const testsBefore = seen.posts.filter((p) => p.url.includes("/asaas/test")).length;
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    const freshCard = screen.getByText("Asaas (Cobranças)").closest("section");
    const freshScope = within(freshCard as HTMLElement);
    fireEvent.click(freshScope.getByRole("button", { name: "Reconfigurar" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Reconfigurar integração" })).toBeTruthy());
    const dialog = within(screen.getByRole("dialog", { name: "Reconfigurar integração" }));
    fireEvent.change(dialog.getByLabelText(/Chave de API/), { target: { value: "hub-fixture-synthetic-key-002" } });
    fireEvent.click(dialog.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/integrations/asaas/configure"))).toBe(true),
    );
    const call = seen.posts.find((p) => p.url.includes("/v1/integrations/asaas/configure"));
    expect(call?.body).toEqual({
      environment: "SANDBOX",
      expectedVersion: 2,
      secret: { apiKey: "hub-fixture-synthetic-key-002" },
    });
    expect(seen.posts.filter((p) => p.url.includes("/asaas/test")).length).toBe(testsBefore);
  });

  it("desconectar exige confirmação explícita e preserva histórico", async () => {
    const seen = installFetch({ permissions: fullPermissions(), integrations: sampleList() });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    const card = screen.getByText("Asaas (Cobranças)").closest("section");
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Desconectar" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Desconectar integração" })).toBeTruthy());
    const dialog = within(screen.getByRole("dialog", { name: "Desconectar integração" }));
    expect(dialog.getByText(/é preservado/)).toBeTruthy();
    // Sem marcar a confirmação, o botão segue desabilitado e nada é enviado.
    expect(dialog.getByRole("button", { name: "Desconectar" })).toBeDisabled();
    expect(seen.posts.some((p) => p.url.includes("/disable"))).toBe(false);
    fireEvent.click(dialog.getByLabelText(/Confirmo que desejo desconectar/));
    fireEvent.click(dialog.getByRole("button", { name: "Desconectar" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/integrations/asaas/disable"))).toBe(true),
    );
    await waitFor(() => expect(screen.getByText(/Histórico preservado/)).toBeTruthy());
  });

  it("409 de concorrência mostra instrução em pt-BR sem vazar detalhe", async () => {
    installFetch({
      permissions: fullPermissions(),
      integrations: sampleList(),
      onPost: (url) => {
        if (url.includes("/asaas/test")) {
          return {
            status: 200,
            body: {
              id: "bind-1",
              provider: "asaas",
              environment: "SANDBOX",
              connection_status: "CONNECTED_READ_ONLY",
              version: 2,
              last_checked_at: "2026-10-30T12:00:00.000Z",
              last_error_code: null,
            },
          };
        }
        if (url.includes("/asaas/disable")) {
          return { status: 409, body: { code: "PRECONDITION_FAILED" } };
        }
        return null;
      },
    });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    const card = screen.getByText("Asaas (Cobranças)").closest("section");
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Desconectar" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Desconectar integração" })).toBeTruthy());
    const dialog = within(screen.getByRole("dialog", { name: "Desconectar integração" }));
    fireEvent.click(dialog.getByLabelText(/Confirmo que desejo desconectar/));
    fireEvent.click(dialog.getByRole("button", { name: "Desconectar" }));
    await waitFor(() => expect(dialog.getByText(/Conflito de concorrência/)).toBeTruthy());
  });

  it("código INVALID_CREDENTIALS exibe instrução de resolução", async () => {
    const withError = sampleList();
    (withError.integrations[0] as Record<string, unknown>)["last_error_code"] = "INVALID_CREDENTIALS";
    installFetch({ permissions: fullPermissions(), integrations: withError });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    expect(screen.getByText("INVALID_CREDENTIALS")).toBeTruthy();
    const card = screen.getByText("Asaas (Cobranças)").closest("section");
    expect(within(card as HTMLElement).getByText(/Confira a chave de API/)).toBeTruthy();
  });

  it("código PROVIDER_CONTRACT_MISMATCH pede revisão de ambiente/contrato, sem sugerir conexão", async () => {
    const withError = sampleList();
    (withError.integrations[0] as Record<string, unknown>)["last_error_code"] = "PROVIDER_CONTRACT_MISMATCH";
    (withError.integrations[0] as Record<string, unknown>)["connection_status"] = "TESTING";
    installFetch({ permissions: fullPermissions(), integrations: withError });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    const card = screen.getByText("Asaas (Cobranças)").closest("section");
    expect(within(card as HTMLElement).getByText(/fora do contrato esperado/)).toBeTruthy();
    expect(within(card as HTMLElement).getByText("TESTING")).toBeTruthy();
    expect(within(card as HTMLElement).queryByText(/CONNECTED_READ_ONLY/)).toBeNull();
  });
});

describe("AsaasWizard (S2B, #86)", () => {
  function openWizard(): HTMLElement {
    const card = screen.getByText("Asaas (Cobranças)").closest("section") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Assistente de conexão" }));
    return within(card).getByRole("dialog", { name: "Assistente Asaas" }) as HTMLElement;
  }

  function dialogScope(): { scope: ReturnType<typeof within>; dialog: HTMLElement } {
    const dialog = screen.getByRole("dialog", { name: "Assistente Asaas" }) as HTMLElement;
    return { scope: within(dialog), dialog };
  }

  it("abre no ambiente SANDBOX com host fixo e sem campo de URL", async () => {
    installFetch({ permissions: fullPermissions(), integrations: sampleList() });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    openWizard();
    const { scope, dialog } = dialogScope();
    expect(scope.getByText("Etapa 1 de 4 — Ambiente")).toBeTruthy();
    const sandbox = scope.getByLabelText(/Sandbox/) as HTMLInputElement;
    expect(sandbox.checked).toBe(true);
    expect(scope.getByText("https://api-sandbox.asaas.com/v3")).toBeTruthy();
    expect(scope.queryByLabelText(/URL/)).toBeNull();
    expect(scope.queryByPlaceholderText(/https?:\/\//)).toBeNull();
    expect(dialog.innerHTML).not.toMatch(/secret_ref|infisical:\/\//);
  });

  it("produção exige confirmação explícita de impacto para avançar", async () => {
    installFetch({ permissions: fullPermissions(), integrations: sampleList() });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    openWizard();
    const { scope } = dialogScope();
    fireEvent.click(scope.getByLabelText(/Produção/));
    expect(scope.getByText("https://api.asaas.com/v3")).toBeTruthy();
    const next = scope.getByRole("button", { name: "Avançar para credencial" });
    expect(next).toBeDisabled();
    fireEvent.click(scope.getByLabelText(/Entendo que produção movimenta dinheiro real/));
    expect(scope.getByRole("button", { name: "Avançar para credencial" })).not.toBeDisabled();
  });

  it("credencial salva via configure com environment e expectedVersion", async () => {
    const seen = installFetch({ permissions: fullPermissions(), integrations: sampleList() });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    openWizard();
    let { scope } = dialogScope();
    fireEvent.click(scope.getByRole("button", { name: "Avançar para credencial" }));
    await waitFor(() => expect(scope.getByText("Etapa 2 de 4 — Credencial")).toBeTruthy());
    ({ scope } = dialogScope());
    const apiKeyInput = scope.getByLabelText(/Chave de API/) as HTMLInputElement;
    expect(apiKeyInput.getAttribute("type")).toBe("password");
    fireEvent.change(apiKeyInput, { target: { value: "wizard-fixture-synthetic-key-001" } });
    fireEvent.click(scope.getByRole("button", { name: "Salvar credencial" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/integrations/asaas/configure"))).toBe(true),
    );
    const calls = seen.posts.filter((p) => p.url.includes("/v1/integrations/asaas/configure"));
    expect(calls.length).toBe(1);
    expect(calls[0]?.body).toEqual({
      environment: "SANDBOX",
      expectedVersion: 2,
      secret: { apiKey: "wizard-fixture-synthetic-key-001" },
    });
    await waitFor(() => expect(scope.getByText(/Credencial salva/)).toBeTruthy());
    expect(document.body.textContent ?? "").not.toContain("wizard-fixture-synthetic-key-001");
  });

  it("configure com INVALID_CREDENTIALS exibe instrução de resolução", async () => {
    installFetch({
      permissions: fullPermissions(),
      integrations: sampleList(),
      onPost: (url) => {
        if (url.includes("/asaas/test")) {
          return {
            status: 200,
            body: {
              id: "bind-1",
              provider: "asaas",
              environment: "SANDBOX",
              connection_status: "TESTING",
              version: 2,
              last_checked_at: "2026-10-30T12:00:00.000Z",
              last_error_code: null,
            },
          };
        }
        if (url.includes("/asaas/configure")) {
          return { status: 400, body: { code: "INVALID_CREDENTIALS" } };
        }
        return null;
      },
    });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    openWizard();
    let { scope } = dialogScope();
    fireEvent.click(scope.getByRole("button", { name: "Avançar para credencial" }));
    await waitFor(() => expect(scope.getByText("Etapa 2 de 4 — Credencial")).toBeTruthy());
    ({ scope } = dialogScope());
    fireEvent.change(scope.getByLabelText(/Chave de API/), { target: { value: "wizard-fixture-bad-key" } });
    fireEvent.click(scope.getByRole("button", { name: "Salvar credencial" }));
    await waitFor(() => expect(scope.getByText(/Confira a chave de API/)).toBeTruthy());
  });

  it("webhook exibe URL canônica retornada com copiar e sem token", async () => {
    const seen = installFetch({
      permissions: fullPermissions(),
      integrations: sampleList(),
      onPost: (url, body) => {
        if (url.includes("/asaas/test")) {
          return {
            status: 200,
            body: {
              id: "bind-1",
              provider: "asaas",
              environment: "SANDBOX",
              connection_status: "CONNECTED_READ_ONLY",
              version: 2,
              last_checked_at: "2026-10-30T12:00:00.000Z",
              last_error_code: null,
            },
          };
        }
        if (url.includes("/asaas/webhook")) {
          return {
            status: 200,
            body: {
              webhookUrl: "https://app.exemplo.com/v1/webhooks/asaas/asaas-abc123",
              providerWebhookId: "wh_123",
              hasAuthToken: true,
              status: "ACTIVE",
            },
          };
        }
        return null;
      },
    });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    openWizard();
    let { scope } = dialogScope();
    // Pula ambiente (SANDBOX default) e credencial (binding já vivo: sonda aprende versão).
    fireEvent.click(scope.getByRole("button", { name: "Avançar para credencial" }));
    await waitFor(() => expect(scope.getByText("Etapa 2 de 4 — Credencial")).toBeTruthy());
    ({ scope } = dialogScope());
    fireEvent.click(scope.getByRole("button", { name: "Pular para webhook" }));
    await waitFor(() => expect(scope.getByText("Etapa 3 de 4 — Webhook")).toBeTruthy());
    ({ scope } = dialogScope());
    fireEvent.click(scope.getByRole("button", { name: "Configurar webhook automaticamente" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/integrations/asaas/webhook"))).toBe(true),
    );
    const call = seen.posts.find((p) => p.url.includes("/v1/integrations/asaas/webhook"));
    expect(call?.body).toEqual({ provider: "asaas", environment: "SANDBOX" });
    await waitFor(() =>
      expect(scope.getByText("https://app.exemplo.com/v1/webhooks/asaas/asaas-abc123")).toBeTruthy(),
    );
    expect(scope.getByRole("button", { name: /Copiar URL do webhook/ })).toBeTruthy();
    expect(scope.getByText("wh_123")).toBeTruthy();
    const html = (scope as unknown as { baseElement?: HTMLElement }).baseElement?.innerHTML ?? document.body.innerHTML;
    expect(html).not.toMatch(/authToken|access_token|secret_ref/);
  });

  it("webhook 503 exibe modo manual com formato esperado e validação", async () => {
    installFetch({
      permissions: fullPermissions(),
      integrations: sampleList(),
      onPost: (url) => {
        if (url.includes("/asaas/webhook")) {
          return { status: 503, body: { code: "WEBHOOK_BASE_URL_NOT_CONFIGURED" } };
        }
        return null;
      },
    });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    openWizard();
    let { scope } = dialogScope();
    fireEvent.click(scope.getByRole("button", { name: "Avançar para credencial" }));
    await waitFor(() => expect(scope.getByText("Etapa 2 de 4 — Credencial")).toBeTruthy());
    ({ scope } = dialogScope());
    fireEvent.click(scope.getByRole("button", { name: "Pular para webhook" }));
    await waitFor(() => expect(scope.getByText("Etapa 3 de 4 — Webhook")).toBeTruthy());
    ({ scope } = dialogScope());
    fireEvent.click(scope.getByRole("button", { name: "Configurar webhook automaticamente" }));
    await waitFor(() => expect(scope.getByText(/Modo manual/)).toBeTruthy());
    expect(scope.getByText(/\/v1\/webhooks\/asaas\/:tenantKey/)).toBeTruthy();
    expect(scope.getAllByText(/PAYMENT_RECEIVED/).length).toBeGreaterThanOrEqual(1);
    expect(scope.getAllByText(/PAYMENT_OVERDUE/).length).toBeGreaterThanOrEqual(1);
    expect(scope.getAllByText(/PAYMENT_REFUNDED/).length).toBeGreaterThanOrEqual(1);
    expect(scope.getByText(/responde 202/)).toBeTruthy();
  });

  it("webhook 409 de limite orienta update/delete manual", async () => {
    installFetch({
      permissions: fullPermissions(),
      integrations: sampleList(),
      onPost: (url) => {
        if (url.includes("/asaas/webhook")) {
          return { status: 409, body: { code: "PRECONDITION_FAILED" } };
        }
        return null;
      },
    });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    openWizard();
    let { scope } = dialogScope();
    fireEvent.click(scope.getByRole("button", { name: "Avançar para credencial" }));
    await waitFor(() => expect(scope.getByText("Etapa 2 de 4 — Credencial")).toBeTruthy());
    ({ scope } = dialogScope());
    fireEvent.click(scope.getByRole("button", { name: "Pular para webhook" }));
    await waitFor(() => expect(scope.getByText("Etapa 3 de 4 — Webhook")).toBeTruthy());
    ({ scope } = dialogScope());
    fireEvent.click(scope.getByRole("button", { name: "Configurar webhook automaticamente" }));
    await waitFor(() => expect(scope.getByText(/limite de 10 webhooks/)).toBeTruthy());
    expect(scope.getByText(/atualize ou exclua um webhook/)).toBeTruthy();
  });

  it("teste sandbox exige confirmação explícita e nunca auto-executa", async () => {
    const seen = installFetch({ permissions: fullPermissions(), integrations: sampleList() });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    openWizard();
    let { scope } = dialogScope();
    fireEvent.click(scope.getByRole("button", { name: "Avançar para credencial" }));
    await waitFor(() => expect(scope.getByText("Etapa 2 de 4 — Credencial")).toBeTruthy());
    ({ scope } = dialogScope());
    fireEvent.click(scope.getByRole("button", { name: "Pular para webhook" }));
    await waitFor(() => expect(scope.getByText("Etapa 3 de 4 — Webhook")).toBeTruthy());
    ({ scope } = dialogScope());
    fireEvent.click(scope.getByRole("button", { name: "Pular para teste sandbox" }));
    await waitFor(() => expect(scope.getByText("Etapa 4 de 4 — Teste em sandbox")).toBeTruthy());
    ({ scope } = dialogScope());
    // Entrar na etapa não dispara sonda sozinha.
    expect(seen.posts.some((p) => p.url.includes("/asaas/test"))).toBe(false);
    const run = scope.getByRole("button", { name: "Testar conexão em sandbox" });
    expect(run).toBeDisabled();
    fireEvent.click(scope.getByLabelText(/Confirmo que quero executar o teste em sandbox/));
    fireEvent.click(scope.getByRole("button", { name: "Testar conexão em sandbox" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/integrations/asaas/test"))).toBe(true),
    );
    await waitFor(() => expect(scope.getByText(/Teste concluído/)).toBeTruthy());
  });

  it("sem integration.manage o wizard não abre", async () => {
    installFetch({ permissions: ["integration.read", "integration.test"], integrations: sampleList() });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    const card = screen.getByText("Asaas (Cobranças)").closest("section") as HTMLElement;
    expect(within(card).queryByRole("button", { name: "Assistente de conexão" })).toBeNull();
  });

  it("sem integration.test a sonda sandbox fica indisponível", async () => {
    installFetch({ permissions: ["integration.read", "integration.manage"], integrations: sampleList() });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("Asaas (Cobranças)")).toBeTruthy());
    openWizard();
    let { scope } = dialogScope();
    fireEvent.click(scope.getByRole("button", { name: "Avançar para credencial" }));
    await waitFor(() => expect(scope.getByText("Etapa 2 de 4 — Credencial")).toBeTruthy());
    ({ scope } = dialogScope());
    fireEvent.click(scope.getByRole("button", { name: "Pular para webhook" }));
    await waitFor(() => expect(scope.getByText("Etapa 3 de 4 — Webhook")).toBeTruthy());
    ({ scope } = dialogScope());
    fireEvent.click(scope.getByRole("button", { name: "Pular para teste sandbox" }));
    await waitFor(() => expect(scope.getByText("Etapa 4 de 4 — Teste em sandbox")).toBeTruthy());
    ({ scope } = dialogScope());
    expect(scope.getByText(/não tem a permissão/)).toBeTruthy();
    expect(scope.queryByRole("button", { name: "Testar conexão em sandbox" })).toBeNull();
  });
});
