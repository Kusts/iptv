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
    id: "bind-cine-1",
    provider,
    environment: "SANDBOX",
    last_checked_at: "2026-10-30T12:00:00.000Z",
    last_error_code: null,
  };
  if (url.includes("/test")) {
    return { status: 200, body: { ...base, connection_status: "TESTING", version: 2 } };
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
  onPost?: PostResponder;
}): Seen {
  const seen: Seen = { posts: [], gets: [] };
  // Espelho mutável do vínculo CINEVISION: o POST .../test atualiza a linha
  // (como o backend real) e o GET seguinte reflete o novo estado — sem isso
  // o reload pós-validação mostraria estado obsoleto.
  const list = opts.integrations as { integrations: Record<string, unknown>[] };
  const cineState: Record<string, unknown> = {
    ...(list.integrations.find((i) => i["provider"] === "cinevision") ?? {}),
  };
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
        const fallback = defaultPostResponder(url);
        const answered = custom ?? fallback;
        if (url.includes("/v1/integrations/cinevision/test") && answered.status === 200) {
          const payload = answered.body as Record<string, unknown>;
          for (const key of ["connection_status", "version", "last_checked_at", "last_error_code"]) {
            if (payload[key] !== undefined) cineState[key] = payload[key];
          }
        }
        return jsonResponse(answered.status, answered.body);
      }
      seen.gets.push(url);
      if (url.includes("/v1/integrations/whatsapp/session")) {
        return jsonResponse(404, { code: "NO_SESSION", message: "no whatsapp session bound in this tenant" });
      }
      if (url.includes("/v1/integrations/whatsapp/qr")) {
        return jsonResponse(404, { code: "QR_NOT_READY", message: "no QR available" });
      }
      if (url.includes("/v1/integrations")) {
        const refreshed = {
          integrations: (list.integrations as Record<string, unknown>[]).map((item) =>
            item["provider"] === "cinevision" ? { ...item, ...cineState } : item,
          ),
        };
        return jsonResponse(200, refreshed);
      }
      return jsonResponse(404, { code: "NOT_FOUND" });
    }),
  );
  return seen;
}

function fullPermissions(): string[] {
  return ["integration.read", "integration.manage", "integration.test"];
}

function cinevisionOnly(status: Record<string, unknown>): { integrations: unknown[] } {
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
        ...status,
      },
    ],
  };
}

function liveCinevision(): { integrations: unknown[] } {
  return cinevisionOnly({ connection_status: "DRAFT", configured: true });
}

function renderPage(page: ReactNode): void {
  render(
    <AuthProvider>
      <ToastProvider>{page}</ToastProvider>
    </AuthProvider>,
  );
}

function cinevisionScope(): ReturnType<typeof within> {
  const card = screen.getByText("CINEVISION (Servidor/Ativação)").closest("section");
  expect(card).not.toBeNull();
  return within(card as HTMLElement);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  clearApiCache();
});

describe("CinevisionCard (S4b, #88)", () => {
  it("exibe conta, capacidades e pendências em pt-BR sem segredo", async () => {
    installFetch({ permissions: fullPermissions(), integrations: liveCinevision() });
    const { container } = render(
      <AuthProvider>
        <ToastProvider>
          <IntegrationsHubPage />
        </ToastProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    const scope = cinevisionScope();
    expect(scope.getByText("Conta CINEVISION")).toBeTruthy();
    expect(scope.getByText("Servidores, clientes e saldo")).toBeTruthy();
    expect(scope.getByText("Importação")).toBeTruthy();
    expect(scope.getAllByText(/painel CINEVISION/).length).toBeGreaterThan(0);
    const html = container.innerHTML;
    expect(html).not.toContain("secret_ref");
    expect(html).not.toContain("infisical://");
    expect(html).not.toMatch(/idempotency-key/i);
  });

  it("conectar conta: sem campo de URL, valida sem rede e salva via configure", async () => {
    const seen = installFetch({ permissions: fullPermissions(), integrations: cinevisionOnly({}) });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    const scope = cinevisionScope();
    fireEvent.click(scope.getByRole("button", { name: "Conectar conta" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Conectar conta CINEVISION" })).toBeTruthy());
    const dialog = within(screen.getByRole("dialog", { name: "Conectar conta CINEVISION" }));
    // Endereço fixo exibido, sem URL arbitrária: nenhum input de URL existe.
    expect(dialog.getByText(/endereço do painel é fixo no servidor/)).toBeTruthy();
    expect(dialog.queryByLabelText(/URL/)).toBeNull();
    expect(dialog.queryByPlaceholderText(/https?:\/\//)).toBeNull();
    // Salvamento vazio: validação local, sem rede.
    fireEvent.click(dialog.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(dialog.getByText("Informe o usuário.")).toBeTruthy());
    expect(seen.posts.length).toBe(0);
    // Preenchido: POST configure sem URL, com Idempotency-Key.
    fireEvent.change(dialog.getByLabelText(/Usuário/), { target: { value: "cine-fixture-user" } });
    fireEvent.change(dialog.getByLabelText(/Senha/), { target: { value: "cine-fixture-pass-001" } });
    fireEvent.click(dialog.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/integrations/cinevision/configure"))).toBe(true),
    );
    const call = seen.posts.find((p) => p.url.includes("/v1/integrations/cinevision/configure"));
    expect(call?.body).toEqual({
      environment: "SANDBOX",
      secret: { username: "cine-fixture-user", password: "cine-fixture-pass-001" },
    });
    expect(call?.headers?.["idempotency-key"]).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Integração conectada/)).toBeTruthy());
    // Credencial digitada nunca é renderizada como texto após o salvamento.
    expect(document.body.textContent ?? "").not.toContain("cine-fixture-pass-001");
  });

  it("reconfigurar envia expectedVersion aprendido no teste", async () => {
    const seen = installFetch({ permissions: fullPermissions(), integrations: liveCinevision() });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    let scope = cinevisionScope();
    fireEvent.click(scope.getByRole("button", { name: "Validar acesso" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/integrations/cinevision/test"))).toBe(true),
    );
    await waitFor(() => expect(screen.getByText(/Validação concluída/)).toBeTruthy());
    const testsBefore = seen.posts.filter((p) => p.url.includes("/cinevision/test")).length;
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    scope = cinevisionScope();
    fireEvent.click(scope.getByRole("button", { name: "Reconfigurar conta" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Reconfigurar conta CINEVISION" })).toBeTruthy());
    const dialog = within(screen.getByRole("dialog", { name: "Reconfigurar conta CINEVISION" }));
    fireEvent.change(dialog.getByLabelText(/Usuário/), { target: { value: "cine-fixture-user-2" } });
    fireEvent.change(dialog.getByLabelText(/Senha/), { target: { value: "cine-fixture-pass-002" } });
    fireEvent.click(dialog.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/integrations/cinevision/configure"))).toBe(true),
    );
    const call = seen.posts.find((p) => p.url.includes("/v1/integrations/cinevision/configure"));
    expect(call?.body).toEqual({
      environment: "SANDBOX",
      expectedVersion: 2,
      secret: { username: "cine-fixture-user-2", password: "cine-fixture-pass-002" },
    });
    expect(seen.posts.filter((p) => p.url.includes("/cinevision/test")).length).toBe(testsBefore);
  });

  it("validar acesso exibe CONNECTED_READ_ONLY com data e sem prometer write", async () => {
    const seen = installFetch({
      permissions: fullPermissions(),
      integrations: liveCinevision(),
      onPost: (url) => {
        if (url.includes("/cinevision/test")) {
          return {
            status: 200,
            body: {
              id: "bind-cine-1",
              provider: "cinevision",
              environment: "SANDBOX",
              connection_status: "CONNECTED_READ_ONLY",
              version: 2,
              last_checked_at: "2026-10-30T12:00:00.000Z",
              last_error_code: null,
            },
          };
        }
        return null;
      },
    });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    cinevisionScope().getByRole("button", { name: "Validar acesso" });
    fireEvent.click(cinevisionScope().getByRole("button", { name: "Validar acesso" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/v1/integrations/cinevision/test"))).toBe(true),
    );
    // O reload pós-validação remonta o card: reescopa antes de afirmar.
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    await waitFor(() => expect(cinevisionScope().getByText("Conectado (somente leitura)")).toBeTruthy());
    const scope = cinevisionScope();
    expect(scope.getByText(/somente leitura — nenhum write/)).toBeTruthy();
    // Só o teste foi transmitido: nenhum endpoint inventado de leitura/importação.
    expect(seen.posts.every((p) => p.url.includes("/cinevision/test"))).toBe(true);
  });

  it("challenge vira instrução manual HUMAN_REQUIRED sem bypass", async () => {
    installFetch({
      permissions: fullPermissions(),
      integrations: liveCinevision(),
      onPost: (url) => {
        if (url.includes("/cinevision/test")) {
          return {
            status: 200,
            body: {
              id: "bind-cine-1",
              provider: "cinevision",
              environment: "SANDBOX",
              connection_status: "TESTING",
              version: 2,
              last_checked_at: "2026-10-30T12:00:00.000Z",
              last_error_code: "CHALLENGE_DETECTED",
            },
          };
        }
        return null;
      },
    });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    fireEvent.click(cinevisionScope().getByRole("button", { name: "Validar acesso" }));
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    await waitFor(() => expect(cinevisionScope().getByText("CHALLENGE_DETECTED")).toBeTruthy());
    const scope = cinevisionScope();
    expect(scope.getAllByText(/verificação humana/).length).toBeGreaterThan(0);
    expect(scope.getAllByText(/sem bypass/).length).toBeGreaterThan(0);
  });

  it("servidores/clientes/saldo: sem endpoint de leitura, fallback manual sem mock", async () => {
    const seen = installFetch({ permissions: fullPermissions(), integrations: liveCinevision() });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    const scope = cinevisionScope();
    expect(scope.getByText(/não expõe endpoint de leitura de servidores/)).toBeTruthy();
    expect(scope.getAllByText(/S4c/).length).toBeGreaterThan(0);
    expect(seen.posts.length).toBe(0);
  });

  it("sem vínculo ativo: importação orienta conectar conta primeiro, sem rede", async () => {
    const seen = installFetch({ permissions: fullPermissions(), integrations: cinevisionOnly({}) });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    const scope = cinevisionScope();
    expect(scope.getByText("Importação")).toBeTruthy();
    expect(scope.getByText(/use Conectar conta primeiro/)).toBeTruthy();
    expect(scope.queryByRole("button", { name: "Pré-visualizar importação" })).toBeNull();
    expect(seen.posts.some((p) => p.url.includes("/import"))).toBe(false);
  });

  it("preview 404 sem vínculo vivo orienta conectar conta primeiro", async () => {
    const seen = installFetch({
      permissions: fullPermissions(),
      integrations: liveCinevision(),
      onPost: (url) => {
        if (url.includes("/cinevision/import-preview")) {
          return { status: 404, body: { code: "NOT_FOUND" } };
        }
        return null;
      },
    });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    fireEvent.click(cinevisionScope().getByRole("button", { name: "Pré-visualizar importação" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/cinevision/import-preview"))).toBe(true),
    );
    await waitFor(() =>
      expect(cinevisionScope().getByText(/use Conectar conta primeiro/)).toBeTruthy(),
    );
  });
});

describe("CinevisionCard importação assistida (S4d, #88)", () => {
  const PREVIEW_HASH = "a".repeat(64);

  const previewPayload = {
    provider: "cinevision",
    version: "cinevision-import-v1",
    total: 3,
    novos: 1,
    duplicados: 1,
    conflitos: 1,
    previewHash: PREVIEW_HASH,
    items: [
      { externalId: "cine-ext-001", decision: "novo" },
      { externalId: "cine-ext-002", decision: "duplicado" },
      { externalId: "cine-ext-003", decision: "conflito" },
    ],
  };

  it("fluxo completo mockado: preview 3 itens → confirma → resumo, sem segredo no DOM", async () => {
    const seen = installFetch({
      permissions: fullPermissions(),
      integrations: liveCinevision(),
      onPost: (url) => {
        if (url.includes("/cinevision/import-preview")) {
          return { status: 200, body: previewPayload };
        }
        if (url.includes("/cinevision/import-execute")) {
          return {
            status: 200,
            body: {
              provider: "cinevision",
              version: "cinevision-import-v1",
              total: 3,
              criados: 1,
              pulados: 1,
              conflitos: 1,
              previewHash: PREVIEW_HASH,
            },
          };
        }
        return null;
      },
    });
    const { container } = render(
      <AuthProvider>
        <ToastProvider>
          <IntegrationsHubPage />
        </ToastProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());

    // Pré-visualização: POST sem body de escrita, com Idempotency-Key.
    fireEvent.click(cinevisionScope().getByRole("button", { name: "Pré-visualizar importação" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/cinevision/import-preview"))).toBe(true),
    );
    const previewCall = seen.posts.find((p) => p.url.includes("/cinevision/import-preview"));
    expect(previewCall?.body).toEqual({});
    expect(previewCall?.headers?.["idempotency-key"]).toBeTruthy();

    // Tabela de preview: externo + decisão em pt-BR.
    await waitFor(() => expect(cinevisionScope().getByText("cine-ext-001")).toBeTruthy());
    const scope = cinevisionScope();
    expect(scope.getByText("cine-ext-002")).toBeTruthy();
    expect(scope.getByText("cine-ext-003")).toBeTruthy();
    expect(scope.getByText("Novo")).toBeTruthy();
    expect(scope.getByText("Duplicado")).toBeTruthy();
    expect(scope.getByText("Conflito")).toBeTruthy();
    expect(scope.getByText("Confirmo a importação dos 1 novos clientes desta pré-visualização")).toBeTruthy();

    // Sem confirmação explícita não há escrita.
    const confirmButton = scope.getByRole("button", { name: "Confirmar importação" });
    expect(confirmButton).toBeDisabled();
    fireEvent.click(confirmButton);
    expect(seen.posts.some((p) => p.url.includes("/import-execute"))).toBe(false);

    // Confirmação explícita + execute com hash + Idempotency-Key.
    fireEvent.click(scope.getByText(/Confirmo a importação dos 1 novos clientes/));
    fireEvent.click(scope.getByRole("button", { name: "Confirmar importação" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/cinevision/import-execute"))).toBe(true),
    );
    const execCall = seen.posts.find((p) => p.url.includes("/cinevision/import-execute"));
    expect(execCall?.body).toEqual({ previewHash: PREVIEW_HASH, confirmed: true });
    expect(execCall?.headers?.["idempotency-key"]).toBeTruthy();

    // Resumo + sem segredo/hash no DOM.
    await waitFor(() => expect(cinevisionScope().getByText(/1 criados/)).toBeTruthy());
    const html = container.innerHTML;
    expect(html).not.toContain(PREVIEW_HASH);
    expect(html).not.toContain("secret_ref");
    expect(html).not.toContain("infisical://");
    expect(document.body.textContent ?? "").not.toContain("cine-fixture-pass");
  });

  it("execute 409 (tamper) orienta re-preview sem concluir", async () => {
    const seen = installFetch({
      permissions: fullPermissions(),
      integrations: liveCinevision(),
      onPost: (url) => {
        if (url.includes("/cinevision/import-preview")) {
          return { status: 200, body: previewPayload };
        }
        if (url.includes("/cinevision/import-execute")) {
          return { status: 409, body: { code: "PRECONDITION_FAILED" } };
        }
        return null;
      },
    });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    fireEvent.click(cinevisionScope().getByRole("button", { name: "Pré-visualizar importação" }));
    await waitFor(() => expect(cinevisionScope().getByText("cine-ext-001")).toBeTruthy());
    const scope = cinevisionScope();
    fireEvent.click(scope.getByText(/Confirmo a importação dos 1 novos clientes/));
    fireEvent.click(scope.getByRole("button", { name: "Confirmar importação" }));
    await waitFor(() =>
      expect(seen.posts.some((p) => p.url.includes("/cinevision/import-execute"))).toBe(true),
    );
    await waitFor(() =>
      expect(cinevisionScope().getByText(/execute a pré-visualização de novo/)).toBeTruthy(),
    );
    // Sem resumo de sucesso após o 409.
    expect(cinevisionScope().queryByText(/Importação concluída/)).toBeNull();
  });

  it("sem manage: preview liberado (read), confirmação exige manage", async () => {
    const seen = installFetch({
      permissions: ["integration.read", "integration.test"],
      integrations: liveCinevision(),
      onPost: (url) => {
        if (url.includes("/cinevision/import-preview")) {
          return { status: 200, body: previewPayload };
        }
        return null;
      },
    });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    fireEvent.click(cinevisionScope().getByRole("button", { name: "Pré-visualizar importação" }));
    await waitFor(() => expect(cinevisionScope().getByText("cine-ext-001")).toBeTruthy());
    const scope = cinevisionScope();
    expect(scope.queryByRole("button", { name: "Confirmar importação" })).toBeNull();
    expect(scope.getByText(/exige integration.manage/)).toBeTruthy();
    expect(seen.posts.some((p) => p.url.includes("/import-execute"))).toBe(false);
  });

  it("sem manage/test mostra somente leitura sem ações de escrita", async () => {
    installFetch({ permissions: ["integration.read"], integrations: liveCinevision() });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    const scope = cinevisionScope();
    expect(scope.queryByRole("button", { name: "Conectar conta" })).toBeNull();
    expect(scope.queryByRole("button", { name: "Reconfigurar conta" })).toBeNull();
    expect(scope.queryByRole("button", { name: "Validar acesso" })).toBeNull();
    expect(scope.getByText("Somente leitura para o seu perfil.")).toBeTruthy();
  });

  it("409 no configure mostra instrução de concorrência em pt-BR", async () => {
    installFetch({
      permissions: fullPermissions(),
      integrations: liveCinevision(),
      onPost: (url) => {
        if (url.includes("/cinevision/test")) {
          return {
            status: 200,
            body: {
              id: "bind-cine-1",
              provider: "cinevision",
              environment: "SANDBOX",
              connection_status: "TESTING",
              version: 2,
              last_checked_at: "2026-10-30T12:00:00.000Z",
              last_error_code: null,
            },
          };
        }
        if (url.includes("/cinevision/configure")) {
          return { status: 409, body: { code: "PRECONDITION_FAILED" } };
        }
        return null;
      },
    });
    renderPage(<IntegrationsHubPage />);
    await waitFor(() => expect(screen.getByText("CINEVISION (Servidor/Ativação)")).toBeTruthy());
    const scope = cinevisionScope();
    fireEvent.click(scope.getByRole("button", { name: "Reconfigurar conta" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Reconfigurar conta CINEVISION" })).toBeTruthy());
    const dialog = within(screen.getByRole("dialog", { name: "Reconfigurar conta CINEVISION" }));
    fireEvent.change(dialog.getByLabelText(/Usuário/), { target: { value: "cine-fixture-user-3" } });
    fireEvent.change(dialog.getByLabelText(/Senha/), { target: { value: "cine-fixture-pass-003" } });
    fireEvent.click(dialog.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(dialog.getByText(/Conflito de concorrência/)).toBeTruthy());
  });
});
