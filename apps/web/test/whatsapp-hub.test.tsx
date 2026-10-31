import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";
import IntegrationsHubPage from "../app/settings/integrations/page";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function pngResponse(): Response {
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
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

interface SeenGet {
  url: string;
  headers?: Record<string, string>;
}

interface Seen {
  posts: SeenPost[];
  gets: SeenGet[];
}

type SessionAnswer =
  | { kind: "state"; sessionName: string; status: string; lastInbound?: { occurredAt: string; preview: string } | null }
  | { kind: "error"; status: number; body: unknown };

const NO_SESSION: SessionAnswer = {
  kind: "error",
  status: 404,
  body: { code: "NO_SESSION", message: "no whatsapp session bound in this tenant" },
};

const SESSION_NAME = "tenant-abc123def456";

function stateAnswer(status: string): SessionAnswer {
  return { kind: "state", sessionName: SESSION_NAME, status };
}

function installWhatsappFetch(opts: {
  permissions?: string[];
  sessionScript?: SessionAnswer[];
  sessionFallback?: SessionAnswer;
  qrScript?: Array<"ok" | { status: number; body: unknown }>;
  connectResult?: { http: number; body: unknown };
  reconnectResult?: { http: number; body: unknown };
  disconnectResult?: { http: number; body: unknown };
  testMessageScript?: Array<{ http: number; body: unknown }>;
}): Seen {
  const seen: Seen = { posts: [], gets: [] };
  const sessionQueue = [...(opts.sessionScript ?? [])];
  const sessionFallback = opts.sessionFallback ?? NO_SESSION;
  const qrQueue = [...(opts.qrScript ?? [])];
  const testMessageQueue = [...(opts.testMessageScript ?? [])];
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
          permissions: opts.permissions ?? ["integration.read", "integration.manage", "integration.test"],
        });
      }
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        seen.posts.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
        if (url.includes("/v1/integrations/whatsapp/test-message")) {
          const next = testMessageQueue.shift();
          if (next !== undefined) {
            return jsonResponse(next.http, next.body);
          }
          // Sucesso S3c: ecoa o `to` confirmado (resposta sanitizada, sem conteúdo).
          return jsonResponse(200, {
            to: body["to"],
            textLength: typeof body["text"] === "string" ? body["text"].length : 0,
            sessionName: SESSION_NAME,
            providerMessageId: "waha-test-1",
          });
        }
        if (url.includes("/v1/integrations/whatsapp/session")) {
          const r = opts.connectResult ?? {
            http: 201,
            body: {
              sessionName: SESSION_NAME,
              status: "SCAN_QR_CODE",
              webhookUrl: "https://app.exemplo.com/v1/webhooks/waha/waha-abc123def456",
              hasWebhookSecret: true,
              reused: false,
            },
          };
          return jsonResponse(r.http, r.body);
        }
        if (url.includes("/v1/integrations/whatsapp/reconnect")) {
          const r = opts.reconnectResult ?? {
            http: 200,
            body: {
              sessionName: SESSION_NAME,
              status: "STARTING",
              webhookUrl: "https://app.exemplo.com/v1/webhooks/waha/waha-abc123def456",
              hasWebhookSecret: true,
              reused: true,
            },
          };
          return jsonResponse(r.http, r.body);
        }
        if (url.includes("/v1/integrations/whatsapp/disconnect")) {
          const r = opts.disconnectResult ?? {
            http: 200,
            body: {
              sessionName: SESSION_NAME,
              status: "STOPPED",
              webhookUrl: "https://app.exemplo.com/v1/webhooks/waha/waha-abc123def456",
              hasWebhookSecret: true,
              reused: true,
            },
          };
          return jsonResponse(r.http, r.body);
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }
      seen.gets.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.includes("/v1/integrations/whatsapp/qr")) {
        const next = qrQueue.shift() ?? "ok";
        if (next === "ok") return pngResponse();
        return jsonResponse(next.status, next.body);
      }
      if (url.includes("/v1/integrations/whatsapp/session")) {
        const answer = sessionQueue.shift() ?? sessionFallback;
        if (answer.kind === "state") {
          return jsonResponse(200, {
            sessionName: answer.sessionName,
            status: answer.status,
            lastInbound: answer.lastInbound ?? null,
          });
        }
        return jsonResponse(answer.status, answer.body);
      }
      if (url.includes("/v1/integrations")) {
        return jsonResponse(200, {
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
              connection_status: "DRAFT",
              capability_status: "UNKNOWN",
              last_checked_at: null,
              last_error_code: null,
              configured: true,
            },
          ],
        });
      }
      return jsonResponse(404, { code: "NOT_FOUND" });
    }),
  );
  return seen;
}

function renderHub(): void {
  render(
    <AuthProvider>
      <ToastProvider>
        <IntegrationsHubPage />
      </ToastProvider>
    </AuthProvider>,
  );
}

function whatsappScope(): ReturnType<typeof within> {
  const card = screen.getByText("WhatsApp (Atendimento)").closest("section");
  expect(card).not.toBeNull();
  return within(card as HTMLElement);
}

function sessionGets(seen: Seen): SeenGet[] {
  return seen.gets.filter((g) => g.url.includes("/v1/integrations/whatsapp/session"));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  clearApiCache();
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:mock-qr");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
});

describe("WhatsAppSessionCard (S3b, #87)", () => {
  it("sem sessão vinculada mostra Conectar WhatsApp sem QR nem ações", async () => {
    const seen = installWhatsappFetch({ sessionScript: [NO_SESSION] });
    renderHub();
    await waitFor(() => expect(screen.getByText("WhatsApp (Atendimento)")).toBeTruthy());
    const scope = whatsappScope();
    await waitFor(() => expect(scope.getByText(/Nenhuma sessão WhatsApp vinculada/)).toBeTruthy());
    expect(scope.getByRole("button", { name: "Conectar WhatsApp" })).toBeTruthy();
    expect(scope.queryByRole("button", { name: "Reconectar" })).toBeNull();
    expect(scope.queryByRole("button", { name: "Desconectar" })).toBeNull();
    expect(scope.queryByRole("button", { name: "Enviar mensagem de teste" })).toBeNull();
    expect(scope.queryByAltText("QR Code para parear o WhatsApp")).toBeNull();
    expect(seen.gets.some((g) => g.url.includes("/whatsapp/qr"))).toBe(false);
  });

  it("conecta via QR até WORKING com polling, toast e revogação do objectURL", async () => {
    vi.useFakeTimers();
    const seen = installWhatsappFetch({
      sessionScript: [NO_SESSION, stateAnswer("WORKING")],
    });
    renderHub();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const scope = whatsappScope();
    expect(scope.getByText(/Nenhuma sessão WhatsApp vinculada/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(scope.getByRole("button", { name: "Conectar WhatsApp" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    // POST session com Idempotency-Key e corpo vazio; dialog de QR abriu.
    const connectPost = seen.posts.find((p) => p.url.includes("/whatsapp/session"));
    expect(connectPost?.body).toEqual({});
    expect(connectPost?.headers?.["idempotency-key"]).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Conectar WhatsApp via QR" })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByAltText("QR Code para parear o WhatsApp")).toBeTruthy();
    // QR saiu como blob/objectURL autenticado, sem persistência em storage.
    const qrGet = seen.gets.find((g) => g.url.includes("/whatsapp/qr"));
    expect(qrGet?.headers?.["authorization"]).toBe("Bearer tok-ops");
    // Polling a cada ~5s: primeiro tick encontra WORKING e encerra.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText(/Pareamento confirmado/)).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Conectar WhatsApp via QR" })).toBeNull();
    expect(scope.getByText("Conectada")).toBeTruthy();
    expect(sessionGets(seen).length).toBe(2);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("QR 404 mostra instrução e Atualizar QR refaz sem novo POST de sessão", async () => {
    const seen = installWhatsappFetch({
      sessionScript: [NO_SESSION, stateAnswer("SCAN_QR_CODE")],
      qrScript: [{ status: 404, body: { code: "QR_NOT_READY", message: "expired" } }, "ok"],
    });
    renderHub();
    await waitFor(() => expect(screen.getByText("WhatsApp (Atendimento)")).toBeTruthy());
    const scope = whatsappScope();
    await waitFor(() => expect(scope.getByRole("button", { name: "Conectar WhatsApp" })).toBeTruthy());
    fireEvent.click(scope.getByRole("button", { name: "Conectar WhatsApp" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Conectar WhatsApp via QR" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/QR indisponível para este estado/)).toBeTruthy());
    const dialog = within(screen.getByRole("dialog", { name: "Conectar WhatsApp via QR" }));
    fireEvent.click(dialog.getByRole("button", { name: "Atualizar QR" }));
    await waitFor(() => expect(screen.getByAltText("QR Code para parear o WhatsApp")).toBeTruthy());
    expect(seen.posts.filter((p) => p.url.includes("/whatsapp/session"))).toHaveLength(1);
    expect(seen.gets.filter((g) => g.url.includes("/whatsapp/qr"))).toHaveLength(2);
  });

  it("timeout de 2 min para o polling com instrução e sem novas sondas", async () => {
    vi.useFakeTimers();
    const seen = installWhatsappFetch({
      sessionScript: [NO_SESSION],
      sessionFallback: stateAnswer("SCAN_QR_CODE"),
    });
    renderHub();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const scope = whatsappScope();
    await act(async () => {
      fireEvent.click(scope.getByRole("button", { name: "Conectar WhatsApp" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("dialog", { name: "Conectar WhatsApp via QR" })).toBeTruthy();
    // Avança em passos de 1s até o timeout: o toast de 4s ainda está visível
    // quando a nota persistente aparece (passos maiores o dispensariam).
    let timedOut = false;
    for (let i = 0; i < 150 && !timedOut; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      timedOut = screen.queryByText(/Tempo esgotado \(2 min\) sem pareamento/) !== null;
    }
    expect(timedOut).toBe(true);
    expect(screen.getByText(/tempo esgotado/)).toBeTruthy();
    const afterTimeout = sessionGets(seen).length;
    expect(afterTimeout).toBeGreaterThan(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(sessionGets(seen).length).toBe(afterTimeout);
  });

  it("exibe CAPPED verbatim com hint, sem virar desconectado genérico", async () => {
    installWhatsappFetch({ sessionScript: [stateAnswer("CAPPED")] });
    renderHub();
    await waitFor(() => expect(screen.getByText("WhatsApp (Atendimento)")).toBeTruthy());
    const scope = whatsappScope();
    await waitFor(() => expect(scope.getByText("Limitada pelo provedor")).toBeTruthy());
    // Verbatim preservado + hint de restriction; nada de rótulo genérico.
    expect(scope.getByText("CAPPED")).toBeTruthy();
    expect(scope.getByText(/não significa “desconectado”/)).toBeTruthy();
    expect(scope.queryByText("Desconectado")).toBeNull();
    expect(scope.queryByText("Desativado")).toBeNull();
  });

  it("reconectar atualiza o estado com toast e Idempotency-Key", async () => {
    const seen = installWhatsappFetch({ sessionScript: [stateAnswer("WORKING")] });
    renderHub();
    await waitFor(() => expect(screen.getByText("WhatsApp (Atendimento)")).toBeTruthy());
    const scope = whatsappScope();
    await waitFor(() => expect(scope.getByText("Conectada")).toBeTruthy());
    fireEvent.click(scope.getByRole("button", { name: "Reconectar" }));
    await waitFor(() => expect(screen.getByText(/Sessão WhatsApp reconectada/)).toBeTruthy());
    const call = seen.posts.find((p) => p.url.includes("/whatsapp/reconnect"));
    expect(call?.body).toEqual({});
    expect(call?.headers?.["idempotency-key"]).toBeTruthy();
    await waitFor(() => expect(scope.getByText("Iniciando")).toBeTruthy());
  });

  it("desconectar exige confirmação e preserva histórico", async () => {
    const seen = installWhatsappFetch({ sessionScript: [stateAnswer("WORKING")] });
    renderHub();
    await waitFor(() => expect(screen.getByText("WhatsApp (Atendimento)")).toBeTruthy());
    const scope = whatsappScope();
    await waitFor(() => expect(scope.getByText("Conectada")).toBeTruthy());
    fireEvent.click(scope.getByRole("button", { name: "Desconectar" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Desconectar sessão WhatsApp" })).toBeTruthy());
    const dialog = within(screen.getByRole("dialog", { name: "Desconectar sessão WhatsApp" }));
    expect(dialog.getByText(/vínculo e o histórico são preservados/)).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Desconectar" })).toBeDisabled();
    expect(seen.posts.some((p) => p.url.includes("/disconnect"))).toBe(false);
    fireEvent.click(dialog.getByLabelText(/Confirmo que desejo desconectar/));
    fireEvent.click(dialog.getByRole("button", { name: "Desconectar" }));
    await waitFor(() => expect(screen.getByText(/Histórico preservado/)).toBeTruthy());
    const call = seen.posts.find((p) => p.url.includes("/whatsapp/disconnect"));
    expect(call?.body).toEqual({});
    expect(call?.headers?.["idempotency-key"]).toBeTruthy();
    await waitFor(() => expect(scope.getByText("Parada")).toBeTruthy());
  });

  it("sem manage mostra estado mas oculta ações de escrita", async () => {
    installWhatsappFetch({
      permissions: ["integration.read"],
      sessionScript: [stateAnswer("WORKING")],
    });
    renderHub();
    await waitFor(() => expect(screen.getByText("WhatsApp (Atendimento)")).toBeTruthy());
    const scope = whatsappScope();
    await waitFor(() => expect(scope.getByText("Conectada")).toBeTruthy());
    expect(scope.queryByRole("button", { name: "Conectar WhatsApp" })).toBeNull();
    expect(scope.queryByRole("button", { name: "Reconectar" })).toBeNull();
    expect(scope.queryByRole("button", { name: "Desconectar" })).toBeNull();
    expect(scope.queryByRole("button", { name: "Enviar mensagem de teste" })).toBeNull();
    expect(scope.getByText("Somente leitura para o seu perfil.")).toBeTruthy();
  });

  it("mensagem de teste valida E.164, exige confirmação e envia via test-message", async () => {
    const seen = installWhatsappFetch({ sessionScript: [stateAnswer("WORKING")] });
    renderHub();
    await waitFor(() => expect(screen.getByText("WhatsApp (Atendimento)")).toBeTruthy());
    const scope = whatsappScope();
    await waitFor(() => expect(scope.getByText("Conectada")).toBeTruthy());
    fireEvent.click(scope.getByRole("button", { name: "Enviar mensagem de teste" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Enviar mensagem de teste" })).toBeTruthy());
    const dialog = within(screen.getByRole("dialog", { name: "Enviar mensagem de teste" }));
    // Sem nada: erro de formato, sem rede.
    fireEvent.click(dialog.getByRole("button", { name: "Enviar para este número" }));
    await waitFor(() => expect(dialog.getByText(/formato internacional/)).toBeTruthy());
    expect(seen.posts.length).toBe(0);
    // Sem DDI: ainda inválido, sem rede.
    fireEvent.change(dialog.getByPlaceholderText("+5511999990001"), { target: { value: "11999990001" } });
    fireEvent.click(dialog.getByRole("button", { name: "Enviar para este número" }));
    await waitFor(() => expect(dialog.getByText(/formato internacional/)).toBeTruthy());
    expect(seen.posts.length).toBe(0);
    // Válido mas sem confirmação de escopo: bloqueia, sem rede.
    fireEvent.change(dialog.getByPlaceholderText("+5511999990001"), { target: { value: "+5511999990001" } });
    fireEvent.change(dialog.getByPlaceholderText("Olá! Teste de pareamento do WhatsApp."), {
      target: { value: "Olá! Teste de pareamento." },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Enviar para este número" }));
    await waitFor(() => expect(dialog.getByText("Confirme que o envio vai SOMENTE para este número.")).toBeTruthy());
    expect(seen.posts.length).toBe(0);
    // Confirmado: POST .../test-message com { to, text } + Idempotency-Key.
    fireEvent.click(dialog.getByLabelText(/Confirmo que a mensagem vai SOMENTE para este número/));
    fireEvent.click(dialog.getByRole("button", { name: "Enviar para este número" }));
    await waitFor(() => expect(dialog.getByText(/Mensagem de teste enviada para \+5511999990001/)).toBeTruthy());
    const call = seen.posts.find((p) => p.url.includes("/whatsapp/test-message"));
    expect(call?.body).toEqual({ to: "+5511999990001", text: "Olá! Teste de pareamento." });
    expect(call?.headers?.["idempotency-key"]).toBeTruthy();
    expect(seen.gets.every((g) => !g.url.includes("send"))).toBe(true);
    await waitFor(() => expect(screen.getByText(/Verifique o aparelho de destino/)).toBeTruthy());
  });

  it("mensagem de teste mapeia 409 SESSION_NOT_READY em instrução", async () => {
    const seen = installWhatsappFetch({
      sessionScript: [stateAnswer("WORKING")],
      testMessageScript: [
        { http: 409, body: { code: "SESSION_NOT_READY", message: "SESSION_NOT_READY: sess is SCAN_QR_CODE" } },
      ],
    });
    renderHub();
    await waitFor(() => expect(screen.getByText("WhatsApp (Atendimento)")).toBeTruthy());
    const scope = whatsappScope();
    await waitFor(() => expect(scope.getByText("Conectada")).toBeTruthy());
    fireEvent.click(scope.getByRole("button", { name: "Enviar mensagem de teste" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Enviar mensagem de teste" })).toBeTruthy());
    const dialog = within(screen.getByRole("dialog", { name: "Enviar mensagem de teste" }));
    fireEvent.change(dialog.getByPlaceholderText("+5511999990001"), { target: { value: "+5511999990001" } });
    fireEvent.change(dialog.getByPlaceholderText("Olá! Teste de pareamento do WhatsApp."), {
      target: { value: "Oi" },
    });
    fireEvent.click(dialog.getByLabelText(/Confirmo que a mensagem vai SOMENTE para este número/));
    fireEvent.click(dialog.getByRole("button", { name: "Enviar para este número" }));
    await waitFor(() => expect(dialog.getByText(/não está Conectada/)).toBeTruthy());
    expect(seen.posts.filter((p) => p.url.includes("/whatsapp/test-message"))).toHaveLength(1);
  });

  it("exibe o último inbound quando o backend expõe (S3c)", async () => {
    installWhatsappFetch({
      sessionScript: [
        {
          kind: "state",
          sessionName: SESSION_NAME,
          status: "WORKING",
          lastInbound: { occurredAt: "2026-10-30T12:00:00.000Z", preview: "Olá, linha viva" },
        },
      ],
    });
    renderHub();
    await waitFor(() => expect(screen.getByText("WhatsApp (Atendimento)")).toBeTruthy());
    const scope = whatsappScope();
    await waitFor(() => expect(scope.getByText("Conectada")).toBeTruthy());
    expect(scope.getByText("Olá, linha viva")).toBeTruthy();
    expect(scope.queryByText("Nenhuma mensagem recebida ainda nesta linha.")).toBeNull();
  });

  it("sem inbound mostra linha muted em vez de inventar conteúdo", async () => {
    installWhatsappFetch({ sessionScript: [stateAnswer("WORKING")] });
    renderHub();
    await waitFor(() => expect(screen.getByText("WhatsApp (Atendimento)")).toBeTruthy());
    const scope = whatsappScope();
    await waitFor(() => expect(scope.getByText("Conectada")).toBeTruthy());
    expect(scope.getByText("Nenhuma mensagem recebida ainda nesta linha.")).toBeTruthy();
  });

  it("sem sessão conectada o botão de teste fica indisponível", async () => {
    installWhatsappFetch({ sessionScript: [stateAnswer("STARTING")] });
    renderHub();
    await waitFor(() => expect(screen.getByText("WhatsApp (Atendimento)")).toBeTruthy());
    const scope = whatsappScope();
    await waitFor(() => expect(scope.getByText("Iniciando")).toBeTruthy());
    expect(scope.getByRole("button", { name: "Enviar mensagem de teste" })).toBeDisabled();
    expect(scope.getByText(/exige sessão Conectada/)).toBeTruthy();
  });

  it("sem segredo no DOM e QR nunca persistido em storage", async () => {
    installWhatsappFetch({ sessionScript: [NO_SESSION, stateAnswer("SCAN_QR_CODE")] });
    renderHub();
    await waitFor(() => expect(screen.getByText("WhatsApp (Atendimento)")).toBeTruthy());
    const scope = whatsappScope();
    await waitFor(() => expect(scope.getByRole("button", { name: "Conectar WhatsApp" })).toBeTruthy());
    fireEvent.click(scope.getByRole("button", { name: "Conectar WhatsApp" }));
    await waitFor(() => expect(screen.getByAltText("QR Code para parear o WhatsApp")).toBeTruthy());
    const html = document.body.innerHTML;
    expect(html).not.toContain("tok-ops");
    expect(html).not.toContain("infisical://");
    expect(html).not.toContain("secret");
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i) ?? "";
      const value = window.localStorage.getItem(key) ?? "";
      expect(value).not.toContain("blob:");
      expect(value).not.toContain("data:image");
    }
  });
});
