import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";
import { Shell } from "../components/Shell";
import { CopilotWidget, clearCopilotSessionMemory, loadDrafts } from "../components/CopilotWidget";
import { ToastProvider } from "../components/ui/Toast";
import { getApiGeneration, readScopedCache } from "../lib/api-cache";
import { clearApiCache, useApi } from "../lib/useApi";
import { LoginForm } from "../components/LoginForm";
import { ConversationsPanel } from "../components/ConversationsPanel";
import { HitlCenter } from "../components/HitlCenter";
import { NeedsAttention } from "../components/NeedsAttention";

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

describe("fluxo de login", () => {
  it("sucesso guarda o token e chama onSuccess", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/login")) {
          return jsonResponse(200, {
            token: "tok-abc",
            activeTenantId: "t1",
            user: { id: "u1", email: "op@tenant.com", displayName: null },
          });
        }
        if (url.endsWith("/v1/auth/session")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "op@tenant.com", displayName: null },
            activeTenantId: "t1",
            memberships: [],
          });
        }
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "op@tenant.com" },
            activeTenant: { id: "t1" },
            roleKeys: [],
            permissions: [],
          });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    const onSuccess = vi.fn();
    render(
      <AuthProvider>
        <LoginForm onSuccess={onSuccess} />
      </AuthProvider>,
    );
    fireEvent.change(screen.getByPlaceholderText("voce@empresa.com.br"), { target: { value: "op@tenant.com" } });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-abc");
  });

  it("falha exibe erro em pt-BR e não guarda token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { code: "UNAUTHENTICATED" })));
    const onSuccess = vi.fn();
    render(
      <AuthProvider>
        <LoginForm onSuccess={onSuccess} />
      </AuthProvider>,
    );
    fireEvent.change(screen.getByPlaceholderText("voce@empresa.com.br"), { target: { value: "op@tenant.com" } });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await waitFor(() => expect(screen.getByText(/sessão expirou|Algo deu errado/i)).toBeTruthy());
    expect(onSuccess).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
  });
});

describe("lista de conversas", () => {
  it("renderiza linhas com badges de status", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/communications/conversations")) {
          return jsonResponse(200, {
            conversations: [
              {
                id: "c1",
                personId: "p1",
                channel: "whatsapp",
                status: "OPEN",
                controlMode: "HUMAN_CONTROL",
                lastMessageAt: null,
                createdAt: new Date().toISOString(),
              },
            ],
          });
        }
        return jsonResponse(200, { messages: [] });
      }),
    );
    render(<ConversationsPanel />);
    await waitFor(() => expect(screen.getByText("whatsapp")).toBeTruthy());
    expect(screen.getByText("OPEN")).toBeTruthy();
    expect(screen.getByText("HUMAN_CONTROL")).toBeTruthy();
  });
});

describe("detalhe da conversa com entrega cancelada", () => {
  it("mensagem interna cancelada exibe estado não acionável sem ocultar o texto", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/communications/conversations")) {
          return jsonResponse(200, {
            conversations: [
              {
                id: "c1",
                personId: "p1",
                channel: "whatsapp",
                status: "OPEN",
                controlMode: "HUMAN_CONTROL",
                lastMessageAt: null,
                createdAt: new Date().toISOString(),
              },
            ],
          });
        }
        if (url.endsWith("/v1/communications/conversations/c1/messages")) {
          return jsonResponse(200, {
            messages: [
              {
                id: "m-cancelled",
                direction: "OUTBOUND",
                senderType: "SYSTEM",
                bodyText: "Lembrete de renovação vencido",
                deliveryStatus: "CANCELLED",
                occurredAt: new Date().toISOString(),
              },
              {
                id: "m-queued",
                direction: "OUTBOUND",
                senderType: "SYSTEM",
                bodyText: "Lembrete ativo",
                deliveryStatus: "QUEUED",
                occurredAt: new Date().toISOString(),
              },
            ],
          });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(<ConversationsPanel />);
    await waitFor(() => expect(screen.getByText("whatsapp")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    const cancelledNotice = await screen.findByText(/Entrega cancelada — não execute/);
    expect(cancelledNotice.getAttribute("role")).toBe("status");
    // Mensagem imutável permanece visível para auditoria.
    expect(screen.getByText("Lembrete de renovação vencido")).toBeTruthy();
    // Outro status permanece legível sem aviso enganoso de cancelamento.
    expect(screen.getByText("Lembrete ativo")).toBeTruthy();
    expect(screen.getByText("QUEUED")).toBeTruthy();
    expect(screen.getAllByText(/entrega cancelada/i)).toHaveLength(1);
  });
});

describe("HITL sem permissão de decisão", () => {
  it("aprovar/rejeitar desabilitados com tooltip explicativo", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/human-reviews/center")) {
          return jsonResponse(200, {
            items: [
              {
                source: "human_review",
                id: "r1",
                kind: "APPROVAL/refund",
                summary: "revisar reembolso",
                priority: "HIGH",
                ageMinutes: 300,
                sla: "WARN",
                deepLink: "/v1/human-reviews/r1",
                createdAt: new Date().toISOString(),
              },
            ],
            slaPolicy: { warnAfterHours: 4, breachAfterHours: 24, ref: "default-v1" },
          });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <HitlCenter />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("revisar reembolso")).toBeTruthy());
    const approve = screen.getByRole("button", { name: "Aprovar" });
    const reject = screen.getByRole("button", { name: "Rejeitar" });
    expect(approve).toBeDisabled();
    expect(reject).toBeDisabled();
    expect(screen.getAllByTitle(/agent\.review\.decide/)).toHaveLength(2);
  });
});

describe("Precisa de você (home)", () => {
  const centerBody = {
    items: [
      {
        source: "human_review",
        id: "r1",
        kind: "APPROVAL/refund",
        summary: "revisar reembolso",
        priority: "HIGH",
        ageMinutes: 300,
        sla: "WARN",
        deepLink: "/v1/human-reviews/r1",
        createdAt: new Date().toISOString(),
      },
      {
        source: "billing_exception",
        id: "b7",
        kind: "CHARGE/failed",
        summary: "cobrança com falha",
        priority: null,
        ageMinutes: 1500,
        sla: "BREACH",
        deepLink: "/v1/billing/b7",
        createdAt: new Date().toISOString(),
      },
    ],
    slaPolicy: { warnAfterHours: 4, breachAfterHours: 24, ref: "default-v1" },
  };

  it("fila populada exibe contagem, itens e link para /hitl sem expor deepLink", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/human-reviews/center")) return jsonResponse(200, centerBody);
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(<NeedsAttention />);
    await waitFor(() => expect(screen.getByText("Precisa de você (2)")).toBeTruthy());
    expect(screen.getByText("revisar reembolso")).toBeTruthy();
    expect(screen.getByText("cobrança com falha")).toBeTruthy();
    expect(screen.getByText("Atenção ao SLA")).toBeTruthy();
    expect(screen.getByText("SLA estourado")).toBeTruthy();
    const queueLink = screen.getByRole("link", { name: "Abrir fila do Centro HITL" });
    expect(queueLink.getAttribute("href")).toBe("/hitl");
    // deepLink da API nunca vira href.
    for (const anchor of screen.getAllByRole("link")) {
      expect(anchor.getAttribute("href")).not.toContain("/v1/");
    }
    expect(screen.queryByText("/v1/human-reviews/r1")).toBeNull();
  });

  it("fila vazia exibe estado vazio em pt-BR", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/human-reviews/center")) {
          return jsonResponse(200, {
            items: [],
            slaPolicy: { warnAfterHours: 4, breachAfterHours: 24, ref: "default-v1" },
          });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(<NeedsAttention />);
    await waitFor(() => expect(screen.getByText("Nada pendente")).toBeTruthy());
    expect(screen.getByText(/Nenhum trabalho aguardando/i)).toBeTruthy();
  });

  it("erro exibe retry sem esconder o conteúdo", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { code: "INTERNAL" })));
    render(<NeedsAttention />);
    await waitFor(() => expect(screen.getByText("Precisa de você")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });

  it("preview prioriza SLA (BREACH > WARN > OK), desempata por createdAt/id e informa breaches ocultos", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    const item = (
      id: string,
      summary: string,
      sla: string,
      createdAt: string,
      priority: string | null = null,
    ) => ({
      source: "human_review",
      id,
      kind: "APPROVAL/manual",
      summary,
      priority,
      ageMinutes: 10,
      sla,
      deepLink: `/v1/human-reviews/${id}`,
      createdAt,
    });
    // Ordem da API colocaria os OKs antigos primeiro (slice puro os
    // exibiria e esconderia breaches recentes). Empate proposital de
    // createdAt entre r-b5/r-b6 com ordem invertida no array.
    const body = {
      items: [
        item("ok-1", "OK antigo 1", "OK", "2026-01-01T10:00:00.000Z"),
        item("ok-2", "OK antigo 2", "OK", "2026-01-02T10:00:00.000Z"),
        item("r-b1", "Breach B1", "BREACH", "2026-02-01T10:00:00.000Z"),
        item("r-b2", "Breach B2", "BREACH", "2026-02-01T10:05:00.000Z"),
        item("r-b3", "Breach B3", "BREACH", "2026-02-01T10:10:00.000Z"),
        item("r-b6", "Breach B6", "BREACH", "2026-02-01T10:15:00.000Z"),
        item("r-b5", "Breach B5", "BREACH", "2026-02-01T10:15:00.000Z"),
        item("r-b9", "Breach B9", "BREACH", "2026-02-01T10:20:00.000Z"),
      ],
      slaPolicy: { warnAfterHours: 4, breachAfterHours: 24, ref: "default-v1" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/human-reviews/center")) return jsonResponse(200, body);
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(<NeedsAttention />);
    await waitFor(() => expect(screen.getByText("Precisa de você (8)")).toBeTruthy());
    // Preview = 5 breaches mais antigos; OKs antigos e o breach mais
    // recente ficam fora, e a contagem de breach oculto é veraz (1).
    for (const summary of ["Breach B1", "Breach B2", "Breach B3", "Breach B5", "Breach B6"]) {
      expect(screen.getByText(summary)).toBeTruthy();
    }
    expect(screen.queryByText("OK antigo 1")).toBeNull();
    expect(screen.queryByText("OK antigo 2")).toBeNull();
    expect(screen.queryByText("Breach B9")).toBeNull();
    // Ordem determinística no DOM: createdAt asc, empate por id asc
    // (B5 antes de B6 apesar da ordem invertida na API).
    const order = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    const indexOf = (s: string): number => order.findIndex((t) => t.includes(s));
    expect(indexOf("Breach B1")).toBeLessThan(indexOf("Breach B2"));
    expect(indexOf("Breach B3")).toBeLessThan(indexOf("Breach B5"));
    expect(indexOf("Breach B5")).toBeLessThan(indexOf("Breach B6"));
    expect(screen.getByText(/e mais 3 itens.*1 com SLA estourado/)).toBeTruthy();
    const queueLink = screen.getByRole("link", { name: "Abrir fila do Centro HITL" });
    expect(queueLink.getAttribute("href")).toBe("/hitl");
  });
});

describe("isolamento do cache de leitura por identidade", () => {
  const PROBE_PATH = "/v1/lookup-probe";

  function ScopeProbe({ path }: { path: string }): React.JSX.Element {
    const { data, loading, reload } = useApi<{ tag: string }>(path);
    return (
      <div>
        <span data-testid="probe-tag">{loading ? "loading" : data ? data.tag : "empty"}</span>
        <button onClick={() => reload()}>recarregar</button>
      </div>
    );
  }

  function IdentityControls(): React.JSX.Element {
    const { switchTenant, logout, login } = useAuth();
    return (
      <div>
        {/* O mock deste bloco mantém a sessão em t1 após o POST 200: a troca
            agora rejeita com TENANT_SWITCH_CONFLICT (comportamento exigido) —
            o catch evita rejection não tratada; o foco aqui é o cache. */}
        <button onClick={() => void switchTenant("t2").catch(() => {})}>trocar-t2</button>
        <button onClick={() => void logout()}>sair</button>
        <button onClick={() => void login("u2@tenant.com", "secret")}>entrar-u2</button>
      </div>
    );
  }

  function sessionBody(userId: string, email: string, tenantId: string): Record<string, unknown> {
    return {
      user: { id: userId, email, displayName: null },
      activeTenantId: tenantId,
      memberships: [
        { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
        { tenantId: "t2", tenantSlug: "t2", tenantName: "Tenant 2", roleKey: "owner", status: "ACTIVE" },
      ],
    };
  }

  it("troca t1→t2 esconde o dado antigo no mesmo render e descarta resposta tardia", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-t1");
    let probeCalls = 0;
    let resolveStale!: (res: Response) => void;
    const staleGate = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/session")) return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "u1@tenant.com" },
            activeTenant: { id: "t1" },
            roleKeys: [],
            permissions: [],
          });
        }
        if (url.endsWith("/v1/tenants/t2/switch")) return jsonResponse(200, { activeTenantId: "t2" });
        if (url.endsWith(PROBE_PATH)) {
          probeCalls += 1;
          if (probeCalls === 1) return jsonResponse(200, { tag: "TAG-PUBLIC" });
          if (probeCalls === 2) return jsonResponse(200, { tag: "TAG-T1" });
          if (probeCalls === 3) return staleGate;
          return jsonResponse(200, { tag: "TAG-T2" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <ScopeProbe path={PROBE_PATH} />
        <IdentityControls />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-T1"));
    // Dispara uma releitura do escopo t1 que fica pendente (resposta tardia).
    fireEvent.click(screen.getByRole("button", { name: "recarregar" }));
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("loading"));
    // Troca de tenant: o dado de t1 deve sumir antes do fetch de t2.
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    await waitFor(() => expect(screen.queryByText("TAG-T1")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-T2"));
    // A resposta tardia do escopo antigo chega depois e deve ser descartada.
    resolveStale(jsonResponse(200, { tag: "TAG-T1-STALE" }));
    await waitFor(() => expect(probeCalls).toBeGreaterThanOrEqual(4));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-T2");
    expect(screen.queryByText("TAG-T1-STALE")).toBeNull();
    expect(screen.queryByText("TAG-T1")).toBeNull();
  });

  it("logout/login como outro usuário no mesmo tenant não exibe dados antigos", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-u1");
    let resolveAnon!: (res: Response) => void;
    const anonGate = new Promise<Response>((resolve) => {
      resolveAnon = resolve;
    });
    const tokenOf = (init?: RequestInit): string | null => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers.authorization ?? "";
      return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/auth/session")) {
        const token = tokenOf(init);
        return token === "tok-u2"
          ? jsonResponse(200, sessionBody("u2", "u2@tenant.com", "t1"))
          : jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
      }
      if (url.endsWith("/v1/auth/login")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
        return body.email === "u2@tenant.com"
          ? jsonResponse(200, {
              token: "tok-u2",
              activeTenantId: "t1",
              user: { id: "u2", email: "u2@tenant.com", displayName: null },
            })
          : jsonResponse(200, {
              token: "tok-u1",
              activeTenantId: "t1",
              user: { id: "u1", email: "u1@tenant.com", displayName: null },
            });
      }
      if (url.endsWith("/v1/auth/logout")) return jsonResponse(200, {});
      if (url.endsWith("/v1/me")) {
        const token = tokenOf(init);
        // Snapshot consistente: `/me` acompanha o usuário do token (u2 após
        // login como u2); mock fixo em u1 geraria mismatch espúrio.
        if (token === "tok-u2") {
          return jsonResponse(200, {
            user: { id: "u2", email: "u2@tenant.com" },
            activeTenant: { id: "t1" },
            roleKeys: [],
            permissions: [],
          });
        }
        return jsonResponse(200, {
          user: { id: "u1", email: "u1@tenant.com" },
          activeTenant: { id: "t1" },
          roleKeys: [],
          permissions: [],
        });
      }
      if (url.endsWith(PROBE_PATH)) {
        const token = tokenOf(init);
        if (token === "tok-u1") return jsonResponse(200, { tag: "TAG-U1" });
        if (token === "tok-u2") return jsonResponse(200, { tag: "TAG-U2" });
        return anonGate;
      }
      return jsonResponse(404, { code: "NOT_FOUND" });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AuthProvider>
        <ScopeProbe path={PROBE_PATH} />
        <IdentityControls />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1"));
    fireEvent.click(screen.getByRole("button", { name: "sair" }));
    // Logout esconde o dado antigo de forma síncrona; o fetch anônimo
    // fica pendente (loading), sem exibir TAG-U1.
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("loading"));
    expect(screen.queryByText("TAG-U1")).toBeNull();
    resolveAnon(jsonResponse(200, { tag: "TAG-ANON" }));
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON"));
    fireEvent.click(screen.getByRole("button", { name: "entrar-u2" }));
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U2"));
    expect(screen.queryByText("TAG-U1")).toBeNull();
    expect(screen.queryByText("TAG-ANON")).toBeNull();
  });
});

describe("resposta tardia do mesmo escopo com troca de path", () => {
  const PATH_A = "/v1/stale-probe-a";
  const PATH_B = "/v1/stale-probe-b";

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  // Mesmo escopo anônimo da sessão (sem AuthProvider): a troca é só de path.
  function PathSwitchProbe(): React.JSX.Element {
    const [path, setPath] = useState(PATH_A);
    const { data, error, loading } = useApi<{ tag: string }>(path);
    return (
      <div>
        <span data-testid="path-probe-tag">{loading ? "loading" : data ? data.tag : "empty"}</span>
        <span data-testid="path-probe-error">{error ?? "no-error"}</span>
        <button onClick={() => setPath(PATH_B)}>ir-para-b</button>
      </div>
    );
  }

  // Drena continuações de microtask (fetch → res.json → then do hook) de
  // forma explícita e determinística, sem timers/polling.
  async function flushMicrotasks(rounds = 16): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
    }
  }

  it("sucesso tardio do path antigo não substitui o path atual nem o cache dele", async () => {
    const gateA = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(PATH_A)) return gateA.promise;
        if (url.endsWith(PATH_B)) return jsonResponse(200, { tag: "TAG-B" });
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(<PathSwitchProbe />);
    // Path A segue pendente; a troca para B esconde o estado anterior.
    await waitFor(() => expect(screen.getByTestId("path-probe-tag").textContent).toBe("loading"));
    fireEvent.click(screen.getByRole("button", { name: "ir-para-b" }));
    await waitFor(() => expect(screen.getByTestId("path-probe-tag").textContent).toBe("TAG-B"));
    const scope = `public:anonymous:${getApiGeneration()}`;
    // A resolve tarde, depois de B exibido: deve ser descartada.
    await act(async () => {
      gateA.resolve(jsonResponse(200, { tag: "TAG-A-LATE" }));
      await gateA.promise;
      await flushMicrotasks();
    });
    expect(screen.getByTestId("path-probe-tag").textContent).toBe("TAG-B");
    expect(screen.queryByText("TAG-A-LATE")).toBeNull();
    expect(readScopedCache<{ tag: string }>(scope, PATH_B)).toEqual({ hit: true, value: { tag: "TAG-B" } });
  });

  it("erro tardio do path antigo não substitui o dado do path atual", async () => {
    const gateA = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(PATH_A)) return gateA.promise;
        if (url.endsWith(PATH_B)) return jsonResponse(200, { tag: "TAG-B" });
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(<PathSwitchProbe />);
    await waitFor(() => expect(screen.getByTestId("path-probe-tag").textContent).toBe("loading"));
    fireEvent.click(screen.getByRole("button", { name: "ir-para-b" }));
    await waitFor(() => expect(screen.getByTestId("path-probe-tag").textContent).toBe("TAG-B"));
    await act(async () => {
      gateA.resolve(jsonResponse(500, { code: "INTERNAL" }));
      await gateA.promise;
      await flushMicrotasks();
    });
    expect(screen.getByTestId("path-probe-tag").textContent).toBe("TAG-B");
    expect(screen.getByTestId("path-probe-error").textContent).toBe("no-error");
  });
});

describe("sinal cross-tab de sessão (storage event)", () => {
  const PROBE_PATH = "/v1/lookup-probe";

  function ScopeProbe(): React.JSX.Element {
    const { data, loading, reload } = useApi<{ tag: string }>(PROBE_PATH);
    return (
      <div>
        <span data-testid="probe-tag">{loading ? "loading" : data ? data.tag : "empty"}</span>
        <button onClick={() => reload()}>recarregar</button>
      </div>
    );
  }

  function sessionBody(userId: string, email: string, tenantId: string): Record<string, unknown> {
    return {
      user: { id: userId, email, displayName: null },
      activeTenantId: tenantId,
      memberships: [
        { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
        { tenantId: "t2", tenantSlug: "t2", tenantName: "Tenant 2", roleKey: "owner", status: "ACTIVE" },
      ],
    };
  }

  function dispatchStorage(key: string, newValue: string | null): void {
    let ev: StorageEvent;
    try {
      ev = new StorageEvent("storage", { key, newValue });
    } catch {
      const fallback = new Event("storage") as StorageEvent;
      (fallback as unknown as Record<string, unknown>).key = key;
      (fallback as unknown as Record<string, unknown>).newValue = newValue;
      window.dispatchEvent(fallback);
      return;
    }
    window.dispatchEvent(ev);
  }

  const tokenOf = (init?: RequestInit): string | null => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.authorization ?? "";
    return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  };

  it("troca de tenant com o mesmo token em outra aba esconde o dado antigo e descarta resposta tardia", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let activeTenant = "t1";
    let probeCalls = 0;
    let resolveStale!: (res: Response) => void;
    const staleGate = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) return jsonResponse(200, sessionBody("u1", "u1@tenant.com", activeTenant));
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "u1@tenant.com" },
            activeTenant: { id: activeTenant },
            roleKeys: [],
            permissions: [],
          });
        }
        if (url.endsWith(PROBE_PATH)) {
          probeCalls += 1;
          if (probeCalls === 3) return staleGate;
          return jsonResponse(200, { tag: activeTenant === "t1" ? "TAG-T1" : "TAG-T2" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <ScopeProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-T1"));
    // Releitura pendente do escopo antigo (resposta tardia).
    fireEvent.click(screen.getByRole("button", { name: "recarregar" }));
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("loading"));
    // Outra aba confirmou a troca no servidor com o mesmo token: o
    // marcador não carrega identidade — a sessão recarregada é autoritativa.
    activeTenant = "t2";
    dispatchStorage("iptv.session_signal", `${Date.now()}:t2`);
    await waitFor(() => expect(screen.queryByText("TAG-T1")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-T2"));
    resolveStale(jsonResponse(200, { tag: "TAG-T1-STALE" }));
    await waitFor(() => expect(probeCalls).toBeGreaterThanOrEqual(4));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-T2");
    expect(screen.queryByText("TAG-T1-STALE")).toBeNull();
    expect(screen.queryByText("TAG-T1")).toBeNull();
  });

  it("troca de token para outro usuário em outra aba nunca mantém o dado antigo visível", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-u1");
    let probeCalls = 0;
    let resolveStale!: (res: Response) => void;
    const staleGate = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/auth/session")) {
        const token = tokenOf(init);
        return token === "tok-u2"
          ? jsonResponse(200, sessionBody("u2", "u2@tenant.com", "t1"))
          : jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
      }
      if (url.endsWith("/v1/me")) {
        const token = tokenOf(init);
        // Consistente com `/session`: u2 para tok-u2, u1 caso contrário.
        if (token === "tok-u2") {
          return jsonResponse(200, {
            user: { id: "u2", email: "u2@tenant.com" },
            activeTenant: { id: "t1" },
            roleKeys: [],
            permissions: [],
          });
        }
        return jsonResponse(200, {
          user: { id: "u1", email: "u1@tenant.com" },
          activeTenant: { id: "t1" },
          roleKeys: [],
          permissions: [],
        });
      }
      if (url.endsWith(PROBE_PATH)) {
        probeCalls += 1;
        if (probeCalls === 3) return staleGate;
        const token = tokenOf(init);
        if (token === "tok-u2") return jsonResponse(200, { tag: "TAG-U2" });
        if (token === "tok-u1") return jsonResponse(200, { tag: "TAG-U1" });
        return jsonResponse(401, { code: "UNAUTHENTICATED" });
      }
      return jsonResponse(404, { code: "NOT_FOUND" });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AuthProvider>
        <ScopeProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1"));
    fireEvent.click(screen.getByRole("button", { name: "recarregar" }));
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("loading"));
    // Outra aba fez login como outro usuário: o token compartilhado muda.
    window.localStorage.setItem("iptv.session_token", "tok-u2");
    dispatchStorage("iptv.session_token", "tok-u2");
    await waitFor(() => expect(screen.queryByText("TAG-U1")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U2"));
    resolveStale(jsonResponse(200, { tag: "TAG-U1-STALE" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U2");
    expect(screen.queryByText("TAG-U1-STALE")).toBeNull();
    expect(screen.queryByText("TAG-U1")).toBeNull();
  });
});

describe("logout local-first e restauração com token substituto", () => {
  const PROBE_PATH = "/v1/lookup-probe";

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  async function flushMicrotasks(rounds = 24): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
    }
  }

  function ScopeProbe(): React.JSX.Element {
    const { data, loading } = useApi<{ tag: string }>(PROBE_PATH);
    return <span data-testid="probe-tag">{loading ? "loading" : data ? data.tag : "empty"}</span>;
  }

  function LogoutButton(): React.JSX.Element {
    const { logout } = useAuth();
    return <button onClick={() => void logout()}>sair</button>;
  }

  function AuthStateProbe(): React.JSX.Element {
    const { loading, user } = useAuth();
    return <span data-testid="auth-state">{loading ? "loading" : user ? user.id : "anon"}</span>;
  }

  function sessionBody(userId: string, email: string, tenantId: string): Record<string, unknown> {
    return {
      user: { id: userId, email, displayName: null },
      activeTenantId: tenantId,
      memberships: [
        { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
      ],
    };
  }

  const tokenOf = (init?: RequestInit): string | null => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.authorization ?? "";
    return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  };

  it("logout esconde o dado protegido antes da rede responder", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-u1");
    const logoutGate = deferred<Response>();
    const anonGate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "u1@tenant.com" },
            activeTenant: { id: "t1" },
            roleKeys: [],
            permissions: [],
          });
        }
        if (url.endsWith("/v1/auth/logout")) return logoutGate.promise;
        if (url.endsWith(PROBE_PATH)) {
          if (tokenOf(init) === "tok-u1") return jsonResponse(200, { tag: "TAG-U1" });
          return anonGate.promise;
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <ScopeProbe />
        <LogoutButton />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1"));
    // POST /logout fica pendente; o clique deve limpar o estado local já.
    fireEvent.click(screen.getByRole("button", { name: "sair" }));
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
    expect(screen.queryByText("TAG-U1")).toBeNull();
    // Só então a rede responde — sem restaurar a sessão.
    await act(async () => {
      logoutGate.resolve(jsonResponse(200, {}));
      anonGate.resolve(jsonResponse(200, { tag: "TAG-ANON" }));
      await logoutGate.promise;
      await anonGate.promise;
      await flushMicrotasks();
    });
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON"));
    expect(screen.queryByText("TAG-U1")).toBeNull();
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
  });

  it("falha de restauração do token antigo não limpa o token substituto", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-A");
    const genBefore = getApiGeneration();
    const sessionGate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/session")) return sessionGate.promise;
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "u1@tenant.com" },
            activeTenant: { id: "t1" },
            roleKeys: [],
            permissions: [],
          });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <AuthStateProbe />
      </AuthProvider>,
    );
    // Restauração de A pendente; outra aba grava o token substituto B.
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("loading"));
    window.localStorage.setItem("iptv.session_token", "tok-B");
    await act(async () => {
      sessionGate.resolve(jsonResponse(401, { code: "UNAUTHENTICATED" }));
      await sessionGate.promise;
      await flushMicrotasks();
    });
    // 401 tardio do token antigo (A) após B presente: não limpa o substituto
    // e permanece carregando até a transição de B processar (sem expor dado
    // antigo nem anon com loading=false).
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("loading"));
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-B");
    expect(getApiGeneration()).toBe(genBefore);
  });
});

describe("guardas de commit de transição de sessão", () => {
  const PROBE_PATH = "/v1/lookup-probe";

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  async function flushMicrotasks(rounds = 32): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
    }
  }

  function dispatchStorage(key: string, newValue: string | null): void {
    let ev: StorageEvent;
    try {
      ev = new StorageEvent("storage", { key, newValue });
    } catch {
      const fallback = new Event("storage") as StorageEvent;
      (fallback as unknown as Record<string, unknown>).key = key;
      (fallback as unknown as Record<string, unknown>).newValue = newValue;
      window.dispatchEvent(fallback);
      return;
    }
    window.dispatchEvent(ev);
  }

  function sessionBody(userId: string, email: string, tenantId: string): Record<string, unknown> {
    return {
      user: { id: userId, email, displayName: null },
      activeTenantId: tenantId,
      memberships: [
        { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
        { tenantId: "t2", tenantSlug: "t2", tenantName: "Tenant 2", roleKey: "owner", status: "ACTIVE" },
      ],
    };
  }

  const tokenOf = (init?: RequestInit): string | null => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.authorization ?? "";
    return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  };

  function AuthStateProbe(): React.JSX.Element {
    const { loading, user } = useAuth();
    return <span data-testid="auth-state">{loading ? "loading" : user ? user.id : "anon"}</span>;
  }

  function TenantProbe(): React.JSX.Element {
    const { activeTenantId } = useAuth();
    return <span data-testid="tenant">{activeTenantId ?? "none"}</span>;
  }

  function ScopeProbe(): React.JSX.Element {
    const { data, loading } = useApi<{ tag: string }>(PROBE_PATH);
    return <span data-testid="probe-tag">{loading ? "loading" : data ? data.tag : "empty"}</span>;
  }

  it("refresh cross-tab com 401 remove o token capturado e reseta anônimo sem reter usuário", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-u1");
    let sessionCalls = 0;
    const refreshGate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          if (sessionCalls === 1) return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
          return refreshGate.promise;
        }
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "u1@tenant.com" },
            activeTenant: { id: "t1" },
            roleKeys: [],
            permissions: [],
          });
        }
        if (url.endsWith(PROBE_PATH)) {
          return tokenOf(init) === "tok-u1"
            ? jsonResponse(200, { tag: "TAG-U1" })
            : jsonResponse(200, { tag: "TAG-ANON" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <ScopeProbe />
        <AuthStateProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1"));
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    // Outra aba invalida a sessão no servidor; o refresh local recebe 401 e
    // o `apiFetch` remove o token capturado antes do catch do provider.
    await act(async () => {
      dispatchStorage("iptv.session_signal", "other-tab:expired");
      await flushMicrotasks();
    });
    await act(async () => {
      refreshGate.resolve(jsonResponse(401, { code: "UNAUTHENTICATED" }));
      await refreshGate.promise;
      await flushMicrotasks();
    });
    // Drena o refetch anônimo do probe após o reset.
    await act(async () => {
      await flushMicrotasks();
    });
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
    expect(screen.getByTestId("auth-state").textContent).toBe("anon");
    expect(screen.queryByText("TAG-U1")).toBeNull();
    expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON");
  });

  it("switch pendente resolvido após logout cross-tab não sobrescreve o contexto", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-u1");
    const switchGate = deferred<Response>();
    let meCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/session")) return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
        if (url.endsWith("/v1/me")) {
          meCalls += 1;
          return jsonResponse(200, {
            user: { id: "u1", email: "u1@tenant.com" },
            activeTenant: { id: "t1" },
            roleKeys: [],
            permissions: [],
          });
        }
        if (url.endsWith("/v1/tenants/t2/switch")) return switchGate.promise;
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    function SwitchButton(): React.JSX.Element {
      const { switchTenant } = useAuth();
      return <button onClick={() => void switchTenant("t2")}>trocar-t2</button>;
    }
    const meCallsBefore = (): number => meCalls;
    render(
      <AuthProvider>
        <AuthStateProbe />
        <TenantProbe />
        <SwitchButton />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    const meBaseline = meCallsBefore();
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    await act(async () => {
      await flushMicrotasks();
    });
    // Logout em outra aba enquanto o POST de troca está pendente.
    await act(async () => {
      window.localStorage.removeItem("iptv.session_token");
      dispatchStorage("iptv.session_token", null);
      await flushMicrotasks();
    });
    expect(screen.getByTestId("auth-state").textContent).toBe("anon");
    expect(screen.getByTestId("tenant").textContent).toBe("none");
    // A resposta tardia da troca chega depois e deve ser ignorada por
    // completo — sem tenant parcial, sem /me e sem token restaurado.
    await act(async () => {
      switchGate.resolve(jsonResponse(200, { activeTenantId: "t2" }));
      await switchGate.promise;
      await flushMicrotasks();
    });
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
    expect(screen.getByTestId("auth-state").textContent).toBe("anon");
    expect(screen.getByTestId("tenant").textContent).toBe("none");
    expect(meCalls).toBe(meBaseline);
  });

  it("login resolvido após logout não reautoriza a sessão", async () => {
    const loginGate = deferred<Response>();
    let sessionCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/login")) return loginGate.promise;
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
        }
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "u1@tenant.com" },
            activeTenant: { id: "t1" },
            roleKeys: [],
            permissions: [],
          });
        }
        if (url.endsWith("/v1/auth/logout")) return jsonResponse(200, {});
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    function LoginButton(): React.JSX.Element {
      const { login } = useAuth();
      return <button onClick={() => void login("u1@tenant.com", "secret")}>entrar</button>;
    }
    function LogoutButton(): React.JSX.Element {
      const { logout } = useAuth();
      return <button onClick={() => void logout()}>sair</button>;
    }
    render(
      <AuthProvider>
        <AuthStateProbe />
        <LoginButton />
        <LogoutButton />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("anon"));
    fireEvent.click(screen.getByRole("button", { name: "entrar" }));
    await act(async () => {
      await flushMicrotasks();
    });
    fireEvent.click(screen.getByRole("button", { name: "sair" }));
    await act(async () => {
      await flushMicrotasks();
    });
    await act(async () => {
      loginGate.resolve(
        jsonResponse(200, {
          token: "tok-stale",
          activeTenantId: "t1",
          user: { id: "u1", email: "u1@tenant.com", displayName: null },
        }),
      );
      await loginGate.promise;
      await flushMicrotasks();
    });
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
    expect(screen.getByTestId("auth-state").textContent).toBe("anon");
    expect(sessionCalls).toBe(0);
  });
});

describe("SLA desconhecido no preview", () => {
  const item = (id: string, summary: string, sla: string, createdAt: string) => ({
    source: "human_review",
    id,
    kind: "APPROVAL/manual",
    summary,
    priority: null,
    ageMinutes: 10,
    sla,
    deepLink: `/v1/human-reviews/${id}`,
    createdAt,
  });

  it("BREACH recente passa à frente de OK antigo e banda desconhecida é neutra, sem verde", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    const body = {
      items: [
        item("ok-old", "OK antigo", "OK", "2026-01-01T10:00:00.000Z"),
        item("warn-old", "Warn antigo", "WARN", "2026-01-02T10:00:00.000Z"),
        item("unk-1", "Item futuro", "FUTURE", "2026-02-01T10:00:00.000Z"),
        item("breach-recent", "Breach recente", "BREACH", "2026-03-01T10:00:00.000Z"),
      ],
      slaPolicy: { warnAfterHours: 4, breachAfterHours: 24, ref: "default-v1" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/human-reviews/center")) return jsonResponse(200, body);
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(<NeedsAttention />);
    await waitFor(() => expect(screen.getByText("Precisa de você (4)")).toBeTruthy());
    // Ordem do preview: BREACH > WARN > OK > desconhecido.
    const order = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    const indexOf = (s: string): number => order.findIndex((t) => t.includes(s));
    expect(indexOf("Breach recente")).toBeLessThan(indexOf("Warn antigo"));
    expect(indexOf("Warn antigo")).toBeLessThan(indexOf("OK antigo"));
    expect(indexOf("OK antigo")).toBeLessThan(indexOf("Item futuro"));
    // Banda desconhecida: rótulo neutro, tom info — nunca verde de sucesso.
    const unknownBadge = screen.getByText("SLA desconhecido");
    expect(unknownBadge).toBeTruthy();
    const badgeClass = unknownBadge.closest("span")?.className ?? "";
    expect(badgeClass).toContain("cc-badge-info");
    expect(badgeClass).not.toContain("cc-badge-success");
  });
});

describe("refresh autoritativo 401 e corridas de token/troca", () => {
  const PROBE_PATH = "/v1/lookup-probe";

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  async function flushMicrotasks(rounds = 32): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
    }
  }

  function dispatchStorage(key: string, newValue: string | null): void {
    let ev: StorageEvent;
    try {
      ev = new StorageEvent("storage", { key, newValue });
    } catch {
      const fallback = new Event("storage") as StorageEvent;
      (fallback as unknown as Record<string, unknown>).key = key;
      (fallback as unknown as Record<string, unknown>).newValue = newValue;
      window.dispatchEvent(fallback);
      return;
    }
    window.dispatchEvent(ev);
  }

  function sessionBody(userId: string, email: string, tenantId: string): Record<string, unknown> {
    return {
      user: { id: userId, email, displayName: null },
      activeTenantId: tenantId,
      memberships: [
        { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
        { tenantId: "t2", tenantSlug: "t2", tenantName: "Tenant 2", roleKey: "owner", status: "ACTIVE" },
        { tenantId: "t3", tenantSlug: "t3", tenantName: "Tenant 3", roleKey: "owner", status: "ACTIVE" },
      ],
    };
  }

  const tokenOf = (init?: RequestInit): string | null => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.authorization ?? "";
    return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  };

  function AuthStateProbe(): React.JSX.Element {
    const { loading, user } = useAuth();
    return <span data-testid="auth-state">{loading ? "loading" : user ? user.id : "anon"}</span>;
  }

  function TenantProbe(): React.JSX.Element {
    const { activeTenantId } = useAuth();
    return <span data-testid="tenant">{activeTenantId ?? "none"}</span>;
  }

  function ScopeProbe(): React.JSX.Element {
    const { data, loading } = useApi<{ tag: string }>(PROBE_PATH);
    return <span data-testid="probe-tag">{loading ? "loading" : data ? data.tag : "empty"}</span>;
  }

  function meBody(userId: string, email: string, tenantId: string): Record<string, unknown> {
    return {
      user: { id: userId, email },
      activeTenant: { id: tenantId },
      roleKeys: [],
      permissions: [],
    };
  }

  it("cross-tab onde /auth/session sucede mas /me retorna 401 reseta anônimo sem reter identidade", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-u1");
    let meCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
        if (url.endsWith("/v1/me")) {
          meCalls += 1;
          // Restauração inicial ok; refresh cross-tab recebe 401 autoritativo.
          if (meCalls === 1) return jsonResponse(200, meBody("u1", "u1@tenant.com", "t1"));
          return jsonResponse(401, { code: "UNAUTHENTICATED" });
        }
        if (url.endsWith(PROBE_PATH)) {
          return tokenOf(init) === "tok-u1"
            ? jsonResponse(200, { tag: "TAG-U1" })
            : jsonResponse(200, { tag: "TAG-ANON" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <ScopeProbe />
        <AuthStateProbe />
        <TenantProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1"));
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    // Outra aba invalida o token no servidor; o refresh local recebe sessão
    // ok mas `/me` 401 corrente — o `apiFetch` limpa o token e o provider
    // deve resetar toda a identidade, sem cometer sessão sem credencial.
    await act(async () => {
      dispatchStorage("iptv.session_signal", "other-tab:me-expired");
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
    expect(screen.getByTestId("auth-state").textContent).toBe("anon");
    expect(screen.getByTestId("tenant").textContent).toBe("none");
    expect(screen.queryByText("TAG-U1")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON"));
  });

  it("cross-tab onde /auth/session sucede mas /me falha não-401 termina fail-closed sem restaurar dado antigo", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-u1");
    let sessionCalls = 0;
    let meCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          // Restauração inicial em t1/revisão 1; o refresh cross-tab observa
          // outro tenant/revisão (t2/2) — sem `/me` coerente nada pode cometer.
          if (sessionCalls === 1) {
            return jsonResponse(200, { ...sessionBody("u1", "u1@tenant.com", "t1"), tenantContextRevision: "1" });
          }
          return jsonResponse(200, { ...sessionBody("u1", "u1@tenant.com", "t2"), tenantContextRevision: "2" });
        }
        if (url.endsWith("/v1/me")) {
          meCalls += 1;
          // Restauração inicial ok; refresh cross-tab falha não-401 nas duas
          // tentativas limitadas (retries do `refreshSession`).
          if (meCalls === 1) return jsonResponse(200, meBody("u1", "u1@tenant.com", "t1"));
          return jsonResponse(500, { code: "INTERNAL" });
        }
        if (url.endsWith(PROBE_PATH)) {
          return tokenOf(init) === "tok-u1"
            ? jsonResponse(200, { tag: "TAG-U1" })
            : jsonResponse(200, { tag: "TAG-ANON" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <ScopeProbe />
        <AuthStateProbe />
        <TenantProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1"));
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    const sessionBaseline = sessionCalls;
    const meBaseline = meCalls;
    // Outra aba sinaliza reconciliação: `/session` confirma outro tenant mas
    // `/me` nunca confirma permissões — o hold cross-tab deve falhar fechado.
    await act(async () => {
      dispatchStorage("iptv.session_signal", "other-tab:me-unavailable");
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    // Retries limitados: 2 snapshots no refresh (sem loop), sem commit parcial.
    expect(sessionCalls).toBe(sessionBaseline + 2);
    expect(meCalls).toBe(meBaseline + 2);
    // Fail-closed só do token capturado ainda corrente: removido, sem reter
    // usuário/tenant, sem restaurar o dado protegido antigo.
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
    expect(screen.getByTestId("auth-state").textContent).toBe("anon");
    expect(screen.getByTestId("tenant").textContent).toBe("none");
    expect(screen.queryByText("TAG-U1")).toBeNull();
    expect(screen.queryByText("TAG-T2")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON"));
  });

  it("sucesso tardio da sessão do token antigo após token novo não comete identidade velha", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-A");
    const sessionGateA = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) {
          const token = tokenOf(init);
          if (token === "tok-A") return sessionGateA.promise;
          if (token === "tok-B") return jsonResponse(200, sessionBody("u2", "u2@tenant.com", "t1"));
          return jsonResponse(401, { code: "UNAUTHENTICATED" });
        }
        if (url.endsWith("/v1/me")) {
          const token = tokenOf(init);
          if (token === "tok-A") return jsonResponse(200, meBody("u1", "u1@tenant.com", "t1"));
          if (token === "tok-B") return jsonResponse(200, meBody("u2", "u2@tenant.com", "t1"));
          return jsonResponse(401, { code: "UNAUTHENTICATED" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <AuthStateProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("loading"));
    // Token substituto B gravado antes do evento processar, com a sessão de
    // A ainda pendente.
    window.localStorage.setItem("iptv.session_token", "tok-B");
    await act(async () => {
      sessionGateA.resolve(jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1")));
      await sessionGateA.promise;
      await flushMicrotasks();
    });
    // Identidade velha (u1/A) não pode cometer depois de B presente; o
    // substituto ainda não processou, então permanece carregando.
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-B");
    expect(screen.getByTestId("auth-state").textContent).not.toBe("u1");
    expect(screen.getByTestId("auth-state").textContent).toBe("loading");
    // A transição de B processa e comete a identidade nova.
    await act(async () => {
      dispatchStorage("iptv.session_token", "tok-B");
      await flushMicrotasks();
    });
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u2"));
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-B");
  });

  it("trocas concorrentes em ordem adversa seguem a sessão final, não o POST tardio", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    const switchGateT2 = deferred<Response>();
    const switchGateT3 = deferred<Response>();
    let sessionCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          // Restauração inicial em t1; após as trocas, o servidor confirma
          // t3 como tenant autoritativo final.
          if (sessionCalls === 1) return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
          return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t3"));
        }
        // Consistente com a restauração: t1 no primeiro `/me`, t3 depois.
        // Mock fixo em t3 geraria mismatch espúrio no par inicial.
        if (url.endsWith("/v1/me")) {
          return jsonResponse(
            200,
            sessionCalls <= 1
              ? meBody("u1", "u1@tenant.com", "t1")
              : meBody("u1", "u1@tenant.com", "t3"),
          );
        }
        if (url.endsWith("/v1/tenants/t2/switch")) return switchGateT2.promise;
        if (url.endsWith("/v1/tenants/t3/switch")) return switchGateT3.promise;
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    function DoubleSwitchButton(): React.JSX.Element {
      const { switchTenant } = useAuth();
      return (
        <button
          onClick={() => {
            void switchTenant("t2");
            void switchTenant("t3");
          }}
        >
          trocar-duplo
        </button>
      );
    }
    render(
      <AuthProvider>
        <AuthStateProbe />
        <TenantProbe />
        <DoubleSwitchButton />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    fireEvent.click(screen.getByRole("button", { name: "trocar-duplo" }));
    await act(async () => {
      await flushMicrotasks();
    });
    // Ordem adversa: o POST final (t3) resolve primeiro e confirma a sessão;
    // o POST tardio (t2) chega depois e não pode sobrescrever.
    await act(async () => {
      switchGateT3.resolve(jsonResponse(200, { activeTenantId: "t3" }));
      await switchGateT3.promise;
      await flushMicrotasks();
    });
    await act(async () => {
      switchGateT2.resolve(jsonResponse(200, { activeTenantId: "t2" }));
      await switchGateT2.promise;
      await flushMicrotasks();
    });
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t3"));
    expect(screen.getByTestId("auth-state").textContent).toBe("u1");
    expect(screen.getByTestId("tenant").textContent).not.toBe("t2");
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-shared");
  });

  it("switch POST com 401 do token corrente reseta anônimo, esconde dado antigo e rejeita", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-u1");
    let switchStatus: number | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
        if (url.endsWith("/v1/me")) return jsonResponse(200, meBody("u1", "u1@tenant.com", "t1"));
        if (url.endsWith("/v1/tenants/t2/switch")) return jsonResponse(401, { code: "UNAUTHENTICATED" });
        if (url.endsWith(PROBE_PATH)) {
          return tokenOf(init) === "tok-u1"
            ? jsonResponse(200, { tag: "TAG-U1" })
            : jsonResponse(200, { tag: "TAG-ANON" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    function SwitchWithError(): React.JSX.Element {
      const { switchTenant } = useAuth();
      return (
        <button
          onClick={() => {
            void switchTenant("t2").catch((err: unknown) => {
              switchStatus = (err as { status?: number }).status ?? -1;
            });
          }}
        >
          trocar-t2
        </button>
      );
    }
    render(
      <AuthProvider>
        <ScopeProbe />
        <AuthStateProbe />
        <TenantProbe />
        <SwitchWithError />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1"));
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    // 401 corrente do POST: token removido pelo `apiFetch`, provider reseta
    // anônimo de imediato, dado protegido antigo some e o erro é propagado.
    await waitFor(() => expect(window.localStorage.getItem("iptv.session_token")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("anon"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("none"));
    expect(screen.queryByText("TAG-U1")).toBeNull();
    await waitFor(() => expect(switchStatus).toBe(401));
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON"));
  });

  it("switch 401 tardio após token substituto não limpa a identidade nova", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-A");
    const switchGate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) {
          const token = tokenOf(init);
          if (token === "tok-A") return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
          if (token === "tok-B") return jsonResponse(200, sessionBody("u2", "u2@tenant.com", "t1"));
          return jsonResponse(401, { code: "UNAUTHENTICATED" });
        }
        if (url.endsWith("/v1/me")) {
          const token = tokenOf(init);
          if (token === "tok-A") return jsonResponse(200, meBody("u1", "u1@tenant.com", "t1"));
          if (token === "tok-B") return jsonResponse(200, meBody("u2", "u2@tenant.com", "t1"));
          return jsonResponse(401, { code: "UNAUTHENTICATED" });
        }
        if (url.endsWith("/v1/tenants/t2/switch")) return switchGate.promise;
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    function StaleSwitchButton(): React.JSX.Element {
      const { switchTenant } = useAuth();
      return <button onClick={() => void switchTenant("t2")}>trocar-t2</button>;
    }
    render(
      <AuthProvider>
        <AuthStateProbe />
        <TenantProbe />
        <StaleSwitchButton />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    await act(async () => {
      await flushMicrotasks();
    });
    // Token substituto B gravado enquanto o POST do token A segue pendente.
    window.localStorage.setItem("iptv.session_token", "tok-B");
    await act(async () => {
      dispatchStorage("iptv.session_token", "tok-B");
      await flushMicrotasks();
    });
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u2"));
    // 401 tardio do token antigo (A): `apiFetch` não limpa (não-corrente) e
    // o provider ignora sem tocar na identidade nova — sem throw observável.
    await act(async () => {
      switchGate.resolve(jsonResponse(401, { code: "UNAUTHENTICATED" }));
      await switchGate.promise;
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-B");
    expect(screen.getByTestId("auth-state").textContent).toBe("u2");
    expect(screen.getByTestId("tenant").textContent).toBe("t1");
  });

  it("401 da troca antiga com seq stale reseta anônimo e sucesso tardio não restaura", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    const switchGateA = deferred<Response>();
    const switchGateB = deferred<Response>();
    let switchStatusA: number | null = null;
    let switchStatusB: number | null = null;
    let sessionCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
        }
        if (url.endsWith("/v1/me")) return jsonResponse(200, meBody("u1", "u1@tenant.com", "t1"));
        if (url.endsWith("/v1/tenants/t2/switch")) return switchGateA.promise;
        if (url.endsWith("/v1/tenants/t3/switch")) return switchGateB.promise;
        if (url.endsWith(PROBE_PATH)) {
          return tokenOf(init) === "tok-shared"
            ? jsonResponse(200, { tag: "TAG-U1" })
            : jsonResponse(200, { tag: "TAG-ANON" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    function DoubleSwitchWithErrors(): React.JSX.Element {
      const { switchTenant } = useAuth();
      return (
        <button
          onClick={() => {
            void switchTenant("t2").catch((err: unknown) => {
              switchStatusA = (err as { status?: number }).status ?? -1;
            });
            void switchTenant("t3").catch((err: unknown) => {
              switchStatusB = (err as { status?: number }).status ?? -1;
            });
          }}
        >
          trocar-duplo
        </button>
      );
    }
    render(
      <AuthProvider>
        <ScopeProbe />
        <AuthStateProbe />
        <TenantProbe />
        <DoubleSwitchWithErrors />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1"));
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    const genBefore = getApiGeneration();
    const sessionBaseline = sessionCalls;
    // Duas trocas com o mesmo token corrente: A fica stale quando B inicia.
    fireEvent.click(screen.getByRole("button", { name: "trocar-duplo" }));
    await act(async () => {
      await flushMicrotasks();
    });
    // O POST antigo (A) invalida o token ainda corrente: `apiFetch` limpa o
    // storage e o catch stale deve resetar o provider mesmo com seq avançada.
    await act(async () => {
      switchGateA.resolve(jsonResponse(401, { code: "UNAUTHENTICATED" }));
      await switchGateA.promise;
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
    expect(screen.getByTestId("auth-state").textContent).toBe("anon");
    expect(screen.getByTestId("tenant").textContent).toBe("none");
    expect(screen.queryByText("TAG-U1")).toBeNull();
    expect(switchStatusA).toBe(401);
    // `apiFetch` avançou uma vez; o reset stale não avança de novo.
    expect(getApiGeneration()).toBe(genBefore + 1);
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON"));
    // O POST tardio (B) resolve com sucesso depois: token ausente impede o
    // commit e o contexto antigo não pode ser restaurado.
    await act(async () => {
      switchGateB.resolve(jsonResponse(200, { activeTenantId: "t3" }));
      await switchGateB.promise;
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
    expect(screen.getByTestId("auth-state").textContent).toBe("anon");
    expect(screen.getByTestId("tenant").textContent).toBe("none");
    expect(screen.queryByText("TAG-U1")).toBeNull();
    expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON");
    expect(switchStatusB).toBeNull();
    expect(sessionCalls).toBe(sessionBaseline);
  });

  it("401 do /me do switch antigo com seq stale reseta anônimo e sucesso tardio não restaura", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    const postGateA = deferred<Response>();
    const meGateA = deferred<Response>();
    const postGateB = deferred<Response>();
    let switchStatusA: number | null = null;
    let switchStatusB: number | null = null;
    let sessionCalls = 0;
    let meCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
        }
        if (url.endsWith("/v1/me")) {
          meCalls += 1;
          if (meCalls === 1) return jsonResponse(200, meBody("u1", "u1@tenant.com", "t1"));
          if (meCalls === 2) return meGateA.promise;
          return jsonResponse(200, meBody("u1", "u1@tenant.com", "t1"));
        }
        if (url.endsWith("/v1/tenants/t2/switch")) return postGateA.promise;
        if (url.endsWith("/v1/tenants/t3/switch")) return postGateB.promise;
        if (url.endsWith(PROBE_PATH)) {
          return tokenOf(init) === "tok-shared"
            ? jsonResponse(200, { tag: "TAG-U1" })
            : jsonResponse(200, { tag: "TAG-ANON" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    function TwoSwitchButtons(): React.JSX.Element {
      const { switchTenant } = useAuth();
      return (
        <div>
          <button
            onClick={() => {
              void switchTenant("t2").catch((err: unknown) => {
                switchStatusA = (err as { status?: number }).status ?? -1;
              });
            }}
          >
            trocar-t2
          </button>
          <button
            onClick={() => {
              void switchTenant("t3").catch((err: unknown) => {
                switchStatusB = (err as { status?: number }).status ?? -1;
              });
            }}
          >
            trocar-t3
          </button>
        </div>
      );
    }
    render(
      <AuthProvider>
        <ScopeProbe />
        <AuthStateProbe />
        <TenantProbe />
        <TwoSwitchButtons />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1"));
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    const genBefore = getApiGeneration();
    const sessionBaseline = sessionCalls;
    const meBaseline = meCalls;
    // Primeira troca: POST sucede e o refresh fica pendente no `/me`.
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    await act(async () => {
      await flushMicrotasks();
    });
    await act(async () => {
      postGateA.resolve(jsonResponse(200, { activeTenantId: "t2" }));
      await postGateA.promise;
      await flushMicrotasks();
    });
    expect(meCalls).toBe(meBaseline + 1);
    // Segunda troca avança o sessionSeq enquanto o `/me` da primeira segue
    // pendente.
    fireEvent.click(screen.getByRole("button", { name: "trocar-t3" }));
    await act(async () => {
      await flushMicrotasks();
    });
    // O `/me` da primeira troca invalida o token ainda corrente: `apiFetch`
    // limpa o storage e o catch stale do refresh deve resetar anônimo mesmo
    // com a seq avançada, sem reter usuário/tenant/dado antigo.
    await act(async () => {
      meGateA.resolve(jsonResponse(401, { code: "UNAUTHENTICATED" }));
      await meGateA.promise;
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
    expect(screen.getByTestId("auth-state").textContent).toBe("anon");
    expect(screen.getByTestId("tenant").textContent).toBe("none");
    expect(screen.queryByText("TAG-U1")).toBeNull();
    expect(switchStatusA).toBe(401);
    // `apiFetch` avançou uma vez; o reset stale do refresh não avança de novo.
    expect(getApiGeneration()).toBe(genBefore + 1);
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON"));
    // O POST tardio da segunda troca resolve com sucesso depois: token
    // ausente impede o commit e a identidade antiga não pode ser restaurada.
    await act(async () => {
      postGateB.resolve(jsonResponse(200, { activeTenantId: "t3" }));
      await postGateB.promise;
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
    expect(screen.getByTestId("auth-state").textContent).toBe("anon");
    expect(screen.getByTestId("tenant").textContent).toBe("none");
    expect(screen.queryByText("TAG-U1")).toBeNull();
    expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON");
    expect(switchStatusB).toBeNull();
    expect(sessionCalls).toBe(sessionBaseline + 1);
    expect(meCalls).toBe(meBaseline + 1);
  });

  it("dois refreshes cross-tab concorrentes com 401 de A e sucesso tardio de B terminam anônimos", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    const meGateA = deferred<Response>();
    const meGateB = deferred<Response>();
    let meCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
        if (url.endsWith("/v1/me")) {
          meCalls += 1;
          if (meCalls === 1) return jsonResponse(200, meBody("u1", "u1@tenant.com", "t1"));
          if (meCalls === 2) return meGateA.promise;
          return meGateB.promise;
        }
        if (url.endsWith(PROBE_PATH)) {
          return tokenOf(init) === "tok-shared"
            ? jsonResponse(200, { tag: "TAG-U1" })
            : jsonResponse(200, { tag: "TAG-ANON" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <ScopeProbe />
        <AuthStateProbe />
        <TenantProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1"));
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    const genBefore = getApiGeneration();
    // Dois `SESSION_SIGNAL_KEY` com o mesmo token corrente: refresh A (stale) e B (latest).
    await act(async () => {
      dispatchStorage("iptv.session_signal", "sig-A");
      await flushMicrotasks();
    });
    await act(async () => {
      dispatchStorage("iptv.session_signal", "sig-B");
      await flushMicrotasks();
    });
    expect(meCalls).toBe(3);
    const genAfterSignals = getApiGeneration();
    expect(genAfterSignals).toBe(genBefore + 2);
    // A resolve 401 autoritativo no `/me`: o `apiFetch` limpa token/geração e o
    // catch stale reseta anônimo sem duplo avanço.
    await act(async () => {
      meGateA.resolve(jsonResponse(401, { code: "UNAUTHENTICATED" }));
      await meGateA.promise;
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
    expect(getApiGeneration()).toBe(genAfterSignals + 1);
    // B resolve sucesso tardio com o token capturado após a limpeza: não pode
    // cometer a identidade velha; o estado final permanece anônimo.
    await act(async () => {
      meGateB.resolve(jsonResponse(200, meBody("u1", "u1@tenant.com", "t1")));
      await meGateB.promise;
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
    expect(screen.getByTestId("auth-state").textContent).toBe("anon");
    expect(screen.getByTestId("tenant").textContent).toBe("none");
    expect(screen.queryByText("TAG-U1")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON"));
    expect(getApiGeneration()).toBe(genAfterSignals + 1);
  });
});

describe("geração compartilhada hard-vs-soft do useApi", () => {
  const CENTER_PATH = "/v1/human-reviews/center";
  const REFRESH_PATH = "/v1/refresh-probe";
  const RELOAD_PATH = "/v1/reload-probe";

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  async function flushMicrotasks(rounds = 32): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
    }
  }

  function RefreshProbe({ path }: { path: string }): React.JSX.Element {
    const { data, error, loading, refresh, reload } = useApi<{ tag: string }>(path);
    return (
      <div>
        <span data-testid="gen-tag">{loading ? "loading" : data ? data.tag : "empty"}</span>
        <span data-testid="gen-error">{error ?? "no-error"}</span>
        <button onClick={() => refresh()}>atualizar</button>
        <button onClick={() => reload()}>recarregar</button>
      </div>
    );
  }

  function centerBody(): Record<string, unknown> {
    return {
      items: [
        {
          source: "human_review",
          id: "r1",
          kind: "APPROVAL/refund",
          summary: "revisar reembolso",
          priority: "HIGH",
          ageMinutes: 300,
          sla: "WARN",
          deepLink: "/v1/human-reviews/r1",
          createdAt: "2026-02-01T10:00:00.000Z",
        },
        {
          source: "billing_exception",
          id: "b7",
          kind: "CHARGE/failed",
          summary: "cobrança com falha",
          priority: null,
          ageMinutes: 1500,
          sla: "BREACH",
          deepLink: "/v1/billing/b7",
          createdAt: "2026-02-01T09:00:00.000Z",
        },
      ],
      slaPolicy: { warnAfterHours: 4, breachAfterHours: 24, ref: "default-v1" },
    };
  }

  it("mount sem cache do NeedsAttention faz uma única requisição (hard inicial)", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    let centerCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(CENTER_PATH)) {
          centerCalls += 1;
          return jsonResponse(200, centerBody());
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(<NeedsAttention />);
    await waitFor(() => expect(screen.getByText("Precisa de você (2)")).toBeTruthy());
    // Sem dado em cache o `refresh()` do mount é no-op: só o hard inicial busca.
    expect(centerCalls).toBe(1);
  });

  it("dois refreshes com conclusão invertida: o mais novo vence e o tardio é descartado", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    const gateOld = deferred<Response>();
    const gateNew = deferred<Response>();
    let probeCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith(REFRESH_PATH)) {
        probeCalls += 1;
        if (probeCalls === 1) return jsonResponse(200, { tag: "TAG-V1" });
        if (probeCalls === 2) return gateOld.promise;
        return gateNew.promise;
      }
      return jsonResponse(404, { code: "NOT_FOUND" });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RefreshProbe path={REFRESH_PATH} />);
    await waitFor(() => expect(screen.getByTestId("gen-tag").textContent).toBe("TAG-V1"));
    expect(probeCalls).toBe(1);

    // Dois refreshes em sequência com dado visível: nenhum mostra skeleton.
    fireEvent.click(screen.getByRole("button", { name: "atualizar" }));
    fireEvent.click(screen.getByRole("button", { name: "atualizar" }));
    await waitFor(() => expect(probeCalls).toBe(3));
    // Background preserva o dado visível enquanto ambos estão pendentes.
    expect(screen.getByTestId("gen-tag").textContent).toBe("TAG-V1");

    // O mais novo (gateNew) resolve primeiro e vence.
    await act(async () => {
      gateNew.resolve(jsonResponse(200, { tag: "TAG-NEWER" }));
      await gateNew.promise;
      await flushMicrotasks();
    });
    expect(screen.getByTestId("gen-tag").textContent).toBe("TAG-NEWER");

    // O mais antigo resolve tarde e deve ser descartado (UI + cache seguem newest).
    await act(async () => {
      gateOld.resolve(jsonResponse(200, { tag: "TAG-OLDER-STALE" }));
      await gateOld.promise;
      await flushMicrotasks();
    });
    expect(screen.getByTestId("gen-tag").textContent).toBe("TAG-NEWER");
    expect(screen.queryByText("TAG-OLDER-STALE")).toBeNull();
    const scope = `public:anonymous:${getApiGeneration()}`;
    expect(readScopedCache<{ tag: string }>(scope, REFRESH_PATH)).toEqual({
      hit: true,
      value: { tag: "TAG-NEWER" },
    });
  });

  it("hard tardio (reload) não sobrescreve refresh mais novo; refresh tardio não sobrescreve hard mais novo", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    const gateSoft = deferred<Response>();
    const gateHard = deferred<Response>();
    let probeCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith(RELOAD_PATH)) {
        probeCalls += 1;
        if (probeCalls === 1) return jsonResponse(200, { tag: "TAG-V1" });
        if (probeCalls === 2) return gateSoft.promise;
        return gateHard.promise;
      }
      return jsonResponse(404, { code: "NOT_FOUND" });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RefreshProbe path={RELOAD_PATH} />);
    await waitFor(() => expect(screen.getByTestId("gen-tag").textContent).toBe("TAG-V1"));

    // Soft antigo parte com dado visível; reload parte em seguida (hard novo,
    // esconde o dado e mostra loading — sem skeleton de refresh, mas com
    // loading de reload, que é o comportamento preservado do hard).
    fireEvent.click(screen.getByRole("button", { name: "atualizar" }));
    await waitFor(() => expect(probeCalls).toBe(2));
    expect(screen.getByTestId("gen-tag").textContent).toBe("TAG-V1");
    fireEvent.click(screen.getByRole("button", { name: "recarregar" }));
    await waitFor(() => expect(probeCalls).toBe(3));

    // Conclusão invertida: o hard mais novo resolve primeiro e vence.
    await act(async () => {
      gateHard.resolve(jsonResponse(200, { tag: "TAG-HARD-NEW" }));
      await gateHard.promise;
      await flushMicrotasks();
    });
    expect(screen.getByTestId("gen-tag").textContent).toBe("TAG-HARD-NEW");

    // O soft antigo resolve tarde e deve ser descartado.
    await act(async () => {
      gateSoft.resolve(jsonResponse(200, { tag: "TAG-SOFT-STALE" }));
      await gateSoft.promise;
      await flushMicrotasks();
    });
    expect(screen.getByTestId("gen-tag").textContent).toBe("TAG-HARD-NEW");
    expect(screen.queryByText("TAG-SOFT-STALE")).toBeNull();
    const scope = `public:anonymous:${getApiGeneration()}`;
    expect(readScopedCache<{ tag: string }>(scope, RELOAD_PATH)).toEqual({
      hit: true,
      value: { tag: "TAG-HARD-NEW" },
    });
  });

  it("refresh com 403 não mantém dado não autorizado visível", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    const gate403 = deferred<Response>();
    let probeCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(REFRESH_PATH)) {
          probeCalls += 1;
          if (probeCalls === 1) return jsonResponse(200, { tag: "TAG-V1" });
          return gate403.promise;
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(<RefreshProbe path={REFRESH_PATH} />);
    await waitFor(() => expect(screen.getByTestId("gen-tag").textContent).toBe("TAG-V1"));
    fireEvent.click(screen.getByRole("button", { name: "atualizar" }));
    await waitFor(() => expect(probeCalls).toBe(2));
    await act(async () => {
      gate403.resolve(jsonResponse(403, { code: "FORBIDDEN" }));
      await gate403.promise;
      await flushMicrotasks();
    });
    expect(screen.getByTestId("gen-tag").textContent).toBe("empty");
    expect(screen.getByTestId("gen-error").textContent).toMatch(/permissão|Acesso negado/i);
  });
});

describe("troca de tenant atômica (loading + snapshot consistente)", () => {
  const PROBE_PATH = "/v1/lookup-probe";

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  async function flushMicrotasks(rounds = 32): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
    }
  }

  function sessionBody(userId: string, email: string, tenantId: string): Record<string, unknown> {
    return {
      user: { id: userId, email, displayName: null },
      activeTenantId: tenantId,
      memberships: [
        { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
        { tenantId: "t2", tenantSlug: "t2", tenantName: "Tenant 2", roleKey: "owner", status: "ACTIVE" },
      ],
    };
  }

  function meBody(userId: string, email: string, tenantId: string): Record<string, unknown> {
    return {
      user: { id: userId, email },
      activeTenant: { id: tenantId },
      roleKeys: [],
      permissions: [],
    };
  }

  const tokenOf = (init?: RequestInit): string | null => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.authorization ?? "";
    return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  };

  function AuthStateProbe(): React.JSX.Element {
    const { loading, user } = useAuth();
    return <span data-testid="auth-state">{loading ? "loading" : user ? user.id : "anon"}</span>;
  }

  function TenantProbe(): React.JSX.Element {
    const { activeTenantId } = useAuth();
    return <span data-testid="tenant">{activeTenantId ?? "none"}</span>;
  }

  function ScopeProbe(): React.JSX.Element {
    const { data, loading } = useApi<{ tag: string }>(PROBE_PATH);
    return <span data-testid="probe-tag">{loading ? "loading" : data ? data.tag : "empty"}</span>;
  }

  it("clique na troca esconde o dado antigo enquanto POST e refresh autoritativo seguem diferidos", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-t1");
    const postGate = deferred<Response>();
    const sessionGate = deferred<Response>();
    let sessionCalls = 0;
    let meCalls = 0;
    let probeCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          if (sessionCalls === 1) return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
          return sessionGate.promise;
        }
        if (url.endsWith("/v1/me")) {
          meCalls += 1;
          if (meCalls === 1) return jsonResponse(200, meBody("u1", "u1@tenant.com", "t1"));
          return jsonResponse(200, meBody("u1", "u1@tenant.com", "t2"));
        }
        if (url.endsWith("/v1/tenants/t2/switch")) return postGate.promise;
        if (url.endsWith(PROBE_PATH)) {
          probeCalls += 1;
          if (probeCalls === 1) return jsonResponse(200, { tag: "TAG-PUBLIC" });
          if (probeCalls === 2) return jsonResponse(200, { tag: "TAG-T1" });
          return jsonResponse(200, { tag: "TAG-T2" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    function SwitchButton(): React.JSX.Element {
      const { switchTenant } = useAuth();
      return <button onClick={() => void switchTenant("t2")}>trocar-t2</button>;
    }
    render(
      <AuthProvider>
        <ScopeProbe />
        <AuthStateProbe />
        <TenantProbe />
        <SwitchButton />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-T1"));
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    const sessionBaseline = sessionCalls;
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    await act(async () => {
      await flushMicrotasks();
    });
    // POST ainda pendente: hold do escopo transitório esconde o dado antigo
    // de imediato sem disparar probe no escopo `switching:*`, mesmo com o
    // ScopeProbe fora do Shell (filho direto do AuthProvider).
    expect(screen.getByTestId("auth-state").textContent).toBe("loading");
    expect(screen.getByTestId("probe-tag").textContent).toBe("empty");
    expect(screen.queryByText("TAG-T1")).toBeNull();
    expect(sessionCalls).toBe(sessionBaseline);
    expect(probeCalls).toBe(2);
    // POST resolve, refresh autoritativo segue diferido: continua escondido,
    // sem nenhuma requisição de probe no escopo transitório.
    await act(async () => {
      postGate.resolve(jsonResponse(200, { activeTenantId: "t2" }));
      await postGate.promise;
      await flushMicrotasks();
    });
    expect(screen.getByTestId("auth-state").textContent).toBe("loading");
    expect(screen.getByTestId("probe-tag").textContent).toBe("empty");
    expect(screen.queryByText("TAG-T1")).toBeNull();
    expect(sessionCalls).toBe(sessionBaseline + 1);
    expect(probeCalls).toBe(2);
    // Refresh resolve com snapshot consistente t2/t2: o novo escopo busca o
    // valor do tenant novo normalmente.
    await act(async () => {
      sessionGate.resolve(jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t2")));
      await sessionGate.promise;
      await flushMicrotasks();
    });
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t2"));
    expect(screen.getByTestId("auth-state").textContent).toBe("u1");
    expect(screen.queryByText("TAG-T1")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-T2"));
    expect(screen.queryByText("TAG-SWITCHING")).toBeNull();
    expect(probeCalls).toBe(3);
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-t1");
  });

  it("snapshot misto session/me na primeira tentativa faz retry limitado e comita só o consistente", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let sessionCalls = 0;
    let meCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          if (sessionCalls === 1) return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
          return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t2"));
        }
        if (url.endsWith("/v1/me")) {
          meCalls += 1;
          if (meCalls === 1) return jsonResponse(200, meBody("u1", "u1@tenant.com", "t1"));
          // Primeira tentativa pós-POST: /session já em t2 mas /me ainda em
          // t1 (troca concorrente entre os GETs) — mismatch deve retentar.
          if (meCalls === 2) return jsonResponse(200, meBody("u1", "u1@tenant.com", "t1"));
          return jsonResponse(200, meBody("u1", "u1@tenant.com", "t2"));
        }
        if (url.endsWith("/v1/tenants/t2/switch")) return jsonResponse(200, { activeTenantId: "t2" });
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    function SwitchButton(): React.JSX.Element {
      const { switchTenant } = useAuth();
      return <button onClick={() => void switchTenant("t2")}>trocar-t2</button>;
    }
    render(
      <AuthProvider>
        <AuthStateProbe />
        <TenantProbe />
        <SwitchButton />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    const sessionBaseline = sessionCalls;
    const meBaseline = meCalls;
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t2"));
    expect(screen.getByTestId("auth-state").textContent).toBe("u1");
    // Máx. 2 snapshots: 1 inicial + 2 tentativas (mismatch + match).
    expect(sessionCalls).toBe(sessionBaseline + 2);
    expect(meCalls).toBe(meBaseline + 2);
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-shared");
  });

  it("mismatch persistente após POST ok falha fechado sem reter dado antigo", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let sessionCalls = 0;
    let meCalls = 0;
    let switchStatus: number | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          if (sessionCalls === 1) return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
          return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t2"));
        }
        if (url.endsWith("/v1/me")) {
          meCalls += 1;
          if (meCalls === 1) return jsonResponse(200, meBody("u1", "u1@tenant.com", "t1"));
          return jsonResponse(200, meBody("u1", "u1@tenant.com", "t1"));
        }
        if (url.endsWith("/v1/tenants/t2/switch")) return jsonResponse(200, { activeTenantId: "t2" });
        if (url.endsWith(PROBE_PATH)) {
          return tokenOf(init) === "tok-shared"
            ? jsonResponse(200, { tag: "TAG-U1" })
            : jsonResponse(200, { tag: "TAG-ANON" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    function SwitchWithError(): React.JSX.Element {
      const { switchTenant } = useAuth();
      return (
        <button
          onClick={() => {
            void switchTenant("t2").catch((err: unknown) => {
              switchStatus = (err as { status?: number }).status ?? -1;
            });
          }}
        >
          trocar-t2
        </button>
      );
    }
    render(
      <AuthProvider>
        <ScopeProbe />
        <AuthStateProbe />
        <TenantProbe />
        <SwitchWithError />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    const sessionBaseline = sessionCalls;
    const meBaseline = meCalls;
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    await waitFor(() => expect(window.localStorage.getItem("iptv.session_token")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("anon"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("none"));
    expect(screen.queryByText("TAG-U1")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON"));
    // Retry limitado: 2 snapshots após o POST, sem loop.
    expect(sessionCalls).toBe(sessionBaseline + 2);
    expect(meCalls).toBe(meBaseline + 2);
    await waitFor(() => expect(switchStatus).toBe(409));
  });

  it("/me indisponível após POST ok falha fechado sem cometer sessão parcial", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let sessionCalls = 0;
    let meCalls = 0;
    let switchStatus: number | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          if (sessionCalls === 1) return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t1"));
          return jsonResponse(200, sessionBody("u1", "u1@tenant.com", "t2"));
        }
        if (url.endsWith("/v1/me")) {
          meCalls += 1;
          if (meCalls === 1) return jsonResponse(200, meBody("u1", "u1@tenant.com", "t1"));
          return jsonResponse(500, { code: "INTERNAL" });
        }
        if (url.endsWith("/v1/tenants/t2/switch")) return jsonResponse(200, { activeTenantId: "t2" });
        if (url.endsWith(PROBE_PATH)) {
          return tokenOf(init) === "tok-shared"
            ? jsonResponse(200, { tag: "TAG-U1" })
            : jsonResponse(200, { tag: "TAG-ANON" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    function SwitchWithError(): React.JSX.Element {
      const { switchTenant } = useAuth();
      return (
        <button
          onClick={() => {
            void switchTenant("t2").catch((err: unknown) => {
              switchStatus = (err as { status?: number }).status ?? -1;
            });
          }}
        >
          trocar-t2
        </button>
      );
    }
    render(
      <AuthProvider>
        <ScopeProbe />
        <AuthStateProbe />
        <TenantProbe />
        <SwitchWithError />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    const sessionBaseline = sessionCalls;
    const meBaseline = meCalls;
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    await waitFor(() => expect(window.localStorage.getItem("iptv.session_token")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("anon"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("none"));
    expect(screen.queryByText("TAG-U1")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON"));
    expect(sessionCalls).toBe(sessionBaseline + 2);
    expect(meCalls).toBe(meBaseline + 2);
    await waitFor(() => expect(switchStatus).not.toBeNull());
    expect(switchStatus).toBe(503);
  });
});

describe("troca de tenant com resultado ambíguo ou concorrente", () => {
  const PROBE_PATH = "/v1/lookup-probe";

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  async function flushMicrotasks(rounds = 32): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
    }
  }

  function sessionBody(tenantId: string): Record<string, unknown> {
    return {
      user: { id: "u1", email: "u1@tenant.com", displayName: null },
      activeTenantId: tenantId,
      memberships: [
        { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
        { tenantId: "t2", tenantSlug: "t2", tenantName: "Tenant 2", roleKey: "owner", status: "ACTIVE" },
        { tenantId: "t3", tenantSlug: "t3", tenantName: "Tenant 3", roleKey: "owner", status: "ACTIVE" },
      ],
    };
  }

  function meBody(tenantId: string): Record<string, unknown> {
    return {
      user: { id: "u1", email: "u1@tenant.com" },
      activeTenant: { id: tenantId },
      roleKeys: [],
      permissions: [],
    };
  }

  const tokenOf = (init?: RequestInit): string | null => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.authorization ?? "";
    return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  };

  function AuthStateProbe(): React.JSX.Element {
    const { loading, user } = useAuth();
    return <span data-testid="auth-state">{loading ? "loading" : user ? user.id : "anon"}</span>;
  }

  function TenantProbe(): React.JSX.Element {
    const { activeTenantId } = useAuth();
    return <span data-testid="tenant">{activeTenantId ?? "none"}</span>;
  }

  function ScopeProbe(): React.JSX.Element {
    const { data, loading } = useApi<{ tag: string }>(PROBE_PATH);
    return <span data-testid="probe-tag">{loading ? "loading" : data ? data.tag : "empty"}</span>;
  }

  function SwitchButton({ target, onError }: { target: string; onError: (err: unknown) => void }): React.JSX.Element {
    const { switchTenant } = useAuth();
    return (
      <button
        onClick={() => {
          void switchTenant(target).catch(onError);
        }}
      >
        trocar-{target}
      </button>
    );
  }

  it("POST 5xx com refresh imediato no tenant antigo termina fail-closed sem reexpor dado antigo", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    const postGate = deferred<Response>();
    let probeCalls = 0;
    let switchStatus: number | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        // Reconciliação imediata relata o tenant antigo de forma consistente
        // — isso NÃO prova ausência de efeito do POST ambíguo.
        if (url.endsWith("/v1/auth/session")) return jsonResponse(200, sessionBody("t1"));
        if (url.endsWith("/v1/me")) return jsonResponse(200, meBody("t1"));
        if (url.endsWith("/v1/tenants/t2/switch")) return postGate.promise;
        if (url.endsWith(PROBE_PATH)) {
          probeCalls += 1;
          // Leituras 1–2: restauração (TAG-U1). O hold do escopo transitório
          // `switching` nunca dispara fetch — demais leituras são pós
          // fail-closed sem token (TAG-ANON).
          if (probeCalls <= 2) return jsonResponse(200, { tag: "TAG-U1" });
          return jsonResponse(200, { tag: "TAG-ANON" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <ScopeProbe />
        <AuthStateProbe />
        <TenantProbe />
        <SwitchButton target="t2" onError={(err) => { switchStatus = (err as { status?: number }).status ?? -1; }} />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    await act(async () => {
      await flushMicrotasks();
    });
    // POST pendente: hold do escopo transitório esconde o dado antigo sem
    // disparar probe em `switching:*`, sem commit.
    expect(screen.getByTestId("auth-state").textContent).toBe("loading");
    expect(screen.getByTestId("probe-tag").textContent).toBe("empty");
    expect(screen.queryByText("TAG-U1")).toBeNull();
    expect(probeCalls).toBe(2);
    await act(async () => {
      postGate.resolve(jsonResponse(500, { code: "INTERNAL" }));
      await postGate.promise;
      await flushMicrotasks();
    });
    // Mesmo com o refresh imediato no tenant antigo, o resultado é
    // fail-closed: token invalidado, anônimo, dado antigo some.
    await waitFor(() => expect(window.localStorage.getItem("iptv.session_token")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("anon"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("none"));
    expect(screen.queryByText("TAG-U1")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON"));
    await waitFor(() => expect(switchStatus).toBe(500));
    expect(screen.queryByText("TAG-SWITCHING-STALE")).toBeNull();
  });

  it("erro de rede no POST com refresh imediato no tenant antigo termina fail-closed", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let switchStatus: number | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) return jsonResponse(200, sessionBody("t1"));
        if (url.endsWith("/v1/me")) return jsonResponse(200, meBody("t1"));
        if (url.endsWith("/v1/tenants/t2/switch")) throw new Error("conexão perdida");
        if (url.endsWith(PROBE_PATH)) {
          return tokenOf(init) === "tok-shared"
            ? jsonResponse(200, { tag: "TAG-U1" })
            : jsonResponse(200, { tag: "TAG-ANON" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <ScopeProbe />
        <AuthStateProbe />
        <TenantProbe />
        <SwitchButton target="t2" onError={(err) => { switchStatus = (err as { status?: number }).status ?? -1; }} />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    await waitFor(() => expect(window.localStorage.getItem("iptv.session_token")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("anon"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("none"));
    expect(screen.queryByText("TAG-U1")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON"));
    await waitFor(() => expect(switchStatus).toBe(0));
  });

  it("POST 403 definitivo preserva tenant/identidade corrente e propaga o erro", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let switchStatus: number | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) return jsonResponse(200, sessionBody("t1"));
        if (url.endsWith("/v1/me")) return jsonResponse(200, meBody("t1"));
        if (url.endsWith("/v1/tenants/t2/switch")) return jsonResponse(403, { code: "TENANT_FORBIDDEN" });
        if (url.endsWith(PROBE_PATH)) {
          return tokenOf(init) === "tok-shared"
            ? jsonResponse(200, { tag: "TAG-U1" })
            : jsonResponse(200, { tag: "TAG-ANON" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <ScopeProbe />
        <AuthStateProbe />
        <TenantProbe />
        <SwitchButton target="t2" onError={(err) => { switchStatus = (err as { status?: number }).status ?? -1; }} />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    // 403 é rejeitado antes de `setActiveTenant`: sem efeito no servidor, o
    // auth corrente confirmado é restaurado e o erro original é propagado.
    await waitFor(() => expect(switchStatus).toBe(403));
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-shared");
    expect(screen.getByTestId("auth-state").textContent).toBe("u1");
    expect(screen.getByTestId("tenant").textContent).toBe("t1");
    expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-U1");
  });

  it("POST ok com sessão autoritativa em outro tenant comete o atual e sinaliza conflito", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let sessionCalls = 0;
    let conflict: ApiError | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          // Restauração em t1; outra aba trocou para t3 entre o POST e a leitura.
          return jsonResponse(200, sessionBody(sessionCalls === 1 ? "t1" : "t3"));
        }
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, meBody(sessionCalls <= 1 ? "t1" : "t3"));
        }
        if (url.endsWith("/v1/tenants/t2/switch")) return jsonResponse(200, { activeTenantId: "t2" });
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <AuthStateProbe />
        <TenantProbe />
        <SwitchButton target="t2" onError={(err) => { conflict = err as ApiError; }} />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    // O tenant autoritativo (t3) é cometido, mas o operador recebe o conflito
    // específico em vez do silêncio — nunca apresentado como destino pedido.
    await waitFor(() => expect(conflict).not.toBeNull());
    expect((conflict as unknown as ApiError).code).toBe("TENANT_SWITCH_CONFLICT");
    expect((conflict as unknown as ApiError).message).toMatch(/outra sessão/);
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-shared");
    expect(screen.getByTestId("auth-state").textContent).toBe("u1");
    expect(screen.getByTestId("tenant").textContent).toBe("t3");
  });

  it("POST 409 TENANT_SWITCH_CONFLICT reconcilia o tenant vencedor sem logout", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let sessionCalls = 0;
    let conflict: ApiError | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          // Restauração em t1; o compare-and-set rejeitou o stale t1→t2 e o
          // vencedor t3 permanece ativo no servidor.
          return jsonResponse(200, sessionBody(sessionCalls === 1 ? "t1" : "t3"));
        }
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, meBody(sessionCalls <= 1 ? "t1" : "t3"));
        }
        if (url.endsWith("/v1/tenants/t2/switch")) {
          return jsonResponse(409, { code: "TENANT_SWITCH_CONFLICT" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <AuthStateProbe />
        <TenantProbe />
        <SwitchButton target="t2" onError={(err) => { conflict = err as ApiError; }} />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    // Conflito CAS estável: sem mutação da troca pedida, o tenant
    // autoritativo vencedor (t3) é cometido com o mesmo token — nunca
    // fail-closed/logout — e o erro específico orienta o operador.
    await waitFor(() => expect(conflict).not.toBeNull());
    expect((conflict as unknown as ApiError).code).toBe("TENANT_SWITCH_CONFLICT");
    expect((conflict as unknown as ApiError).message).toMatch(/outra sessão/);
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-shared");
    expect(screen.getByTestId("auth-state").textContent).toBe("u1");
    expect(screen.getByTestId("tenant").textContent).toBe("t3");
  });

  it("POST 409 TENANT_CONTEXT_CONFLICT com vencedor no próprio destino ainda propaga conflito", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let sessionCalls = 0;
    let conflict: ApiError | null = null;
    function sessionRevBody(tenantId: string, rev: string): Record<string, unknown> {
      return {
        user: { id: "u1", email: "u1@tenant.com", displayName: null },
        activeTenantId: tenantId,
        tenantContextRevision: rev,
        memberships: [
          { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
          { tenantId: "t2", tenantSlug: "t2", tenantName: "Tenant 2", roleKey: "owner", status: "ACTIVE" },
        ],
      };
    }
    function RevisionProbe(): React.JSX.Element {
      const { loading, user, tenantContextRevision } = useAuth();
      return (
        <span data-testid="rev">
          {loading ? "loading" : user ? (tenantContextRevision ?? "none") : "anon"}
        </span>
      );
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          // Snapshot pré-troca em t1/rev10; outra aba venceu para o MESMO
          // destino t2/rev11 entre o POST e a releitura.
          return jsonResponse(200, sessionRevBody(sessionCalls === 1 ? "t1" : "t2", sessionCalls === 1 ? "10" : "11"));
        }
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, meBody(sessionCalls <= 1 ? "t1" : "t2"));
        }
        if (url.endsWith("/v1/tenants/t2/switch")) {
          return jsonResponse(409, { code: "TENANT_CONTEXT_CONFLICT" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <AuthStateProbe />
        <TenantProbe />
        <RevisionProbe />
        <SwitchButton target="t2" onError={(err) => { conflict = err as ApiError; }} />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    await waitFor(() => expect(screen.getByTestId("rev").textContent).toBe("10"));
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    // Erro definitivo nunca é engolido pelo atalho "alvo ativo = sucesso":
    // mesmo com o refresh autoritativo no destino pedido, o chamador recebe
    // o conflito específico enquanto t2/rev11 é cometido sem logout.
    await waitFor(() => expect(conflict).not.toBeNull());
    expect((conflict as unknown as ApiError).code).toBe("TENANT_SWITCH_CONFLICT");
    expect((conflict as unknown as ApiError).message).toMatch(/outra sessão/);
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-shared");
    expect(screen.getByTestId("auth-state").textContent).toBe("u1");
    expect(screen.getByTestId("tenant").textContent).toBe("t2");
    expect(screen.getByTestId("rev").textContent).toBe("11");
  });

  it("Shell exibe aviso específico de troca concorrente e mantém o tenant autoritativo visível", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let sessionCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          return jsonResponse(200, sessionBody(sessionCalls === 1 ? "t1" : "t3"));
        }
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, meBody(sessionCalls <= 1 ? "t1" : "t3"));
        }
        if (url.endsWith("/v1/tenants/t2/switch")) return jsonResponse(200, { activeTenantId: "t2" });
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <Shell>
          <div>conteúdo-protegido</div>
        </Shell>
      </AuthProvider>,
    );
    const switcher = await screen.findByLabelText("Trocar de tenant");
    await waitFor(() => expect(screen.getByText("Tenant: Tenant 1")).toBeTruthy());
    fireEvent.change(switcher, { target: { value: "t2" } });
    // Aviso específico (não o genérico) com o tenant autoritativo cometido.
    await waitFor(() => expect(screen.getByText(/alterado em outra sessão/)).toBeTruthy());
    expect(screen.getByText("Tenant: Tenant 3")).toBeTruthy();
    expect(screen.getByText("conteúdo-protegido")).toBeTruthy();
  });
});

describe("frescor da fila HITL (stale refresh)", () => {
  const CENTER_PATH = "/v1/human-reviews/center";

  function centerItem(id: string, summary: string, source = "human_review"): Record<string, unknown> {
    return {
      source,
      id,
      kind: "APPROVAL/manual",
      summary,
      priority: null,
      ageMinutes: 10,
      sla: "OK",
      deepLink: `/v1/human-reviews/${id}`,
      createdAt: "2026-02-01T10:00:00.000Z",
    };
  }

  function centerBody(items: Record<string, unknown>[]): Record<string, unknown> {
    return {
      items,
      slaPolicy: { warnAfterHours: 4, breachAfterHours: 24, ref: "default-v1" },
    };
  }

  it("falha do refresh mantém o dado, expõe retry sem descartar e o sucesso limpa", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    let mode: "v1" | "fail" | "v2" = "v1";
    let centerCalls = 0;
    const bodyV1 = centerBody([centerItem("r1", "resumo fila v1")]);
    const bodyV2 = centerBody([centerItem("r1", "resumo fila v2")]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(CENTER_PATH)) {
          centerCalls += 1;
          if (mode === "fail") return jsonResponse(500, { code: "INTERNAL" });
          return jsonResponse(200, mode === "v1" ? bodyV1 : bodyV2);
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(<NeedsAttention />);
    await waitFor(() => expect(screen.getByText("resumo fila v1")).toBeTruthy());
    expect(centerCalls).toBe(1);

    // Background falha: o dado permanece e o estado stale aparece com retry.
    mode = "fail";
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(screen.getByText(/possivelmente desatualizados/)).toBeTruthy());
    expect(screen.getByText("resumo fila v1")).toBeTruthy();
    expect(screen.queryByText("Não foi possível carregar.")).toBeNull();
    const retry = screen.getByRole("button", { name: "Tentar atualizar" });
    expect(retry).toBeTruthy();
    expect(centerCalls).toBeGreaterThanOrEqual(2);
    const callsAfterFail = centerCalls;

    // Retry (outro refresh) não descarta o cache e o sucesso limpa o aviso.
    mode = "v2";
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByText(/possivelmente desatualizados/)).toBeNull());
    expect(screen.getByText("resumo fila v2")).toBeTruthy();
    expect(screen.queryByText("Não foi possível carregar.")).toBeNull();
    expect(centerCalls).toBeGreaterThan(callsAfterFail);
  });

  it("troca de path e reload não vazam o refreshError anterior", async () => {
    const PATH_A = "/v1/stale-probe-a";
    const PATH_B = "/v1/stale-probe-b";

    function PathProbe(): React.JSX.Element {
      const [path, setPath] = useState(PATH_A);
      const { data, refreshError, refresh, reload } = useApi<{ tag: string }>(path);
      return (
        <div>
          <span data-testid="stale-tag">{data ? data.tag : "empty"}</span>
          <span data-testid="stale-refresh-error">{refreshError ?? "no-stale"}</span>
          <button onClick={() => refresh()}>atualizar</button>
          <button onClick={() => reload()}>recarregar</button>
          <button onClick={() => setPath(PATH_B)}>ir-para-b</button>
        </div>
      );
    }

    let failA = false;
    let failB = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(PATH_A)) {
          if (failA) return jsonResponse(500, { code: "INTERNAL" });
          return jsonResponse(200, { tag: "TAG-A" });
        }
        if (url.endsWith(PATH_B)) {
          if (failB) return jsonResponse(500, { code: "INTERNAL" });
          return jsonResponse(200, { tag: "TAG-B" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(<PathProbe />);
    await waitFor(() => expect(screen.getByTestId("stale-tag").textContent).toBe("TAG-A"));

    // Stale em A.
    failA = true;
    fireEvent.click(screen.getByRole("button", { name: "atualizar" }));
    await waitFor(() => expect(screen.getByTestId("stale-refresh-error").textContent).not.toBe("no-stale"));
    expect(screen.getByTestId("stale-tag").textContent).toBe("TAG-A");

    // Troca de path: o erro de frescor de A não vaza para B.
    fireEvent.click(screen.getByRole("button", { name: "ir-para-b" }));
    await waitFor(() => expect(screen.getByTestId("stale-tag").textContent).toBe("TAG-B"));
    expect(screen.getByTestId("stale-refresh-error").textContent).toBe("no-stale");

    // Stale em B e depois reload: o hard limpa o aviso anterior.
    failB = true;
    fireEvent.click(screen.getByRole("button", { name: "atualizar" }));
    await waitFor(() => expect(screen.getByTestId("stale-refresh-error").textContent).not.toBe("no-stale"));
    failB = false;
    fireEvent.click(screen.getByRole("button", { name: "recarregar" }));
    await waitFor(() => expect(screen.getByTestId("stale-tag").textContent).toBe("TAG-B"));
    expect(screen.getByTestId("stale-refresh-error").textContent).toBe("no-stale");
  });
});

describe("/hitl revalida o cache compartilhado no mount", () => {
  const CENTER_PATH = "/v1/human-reviews/center";

  function centerBody(summary: string): Record<string, unknown> {
    return {
      items: [
        {
          source: "human_review",
          id: "r1",
          kind: "APPROVAL/manual",
          summary,
          priority: null,
          ageMinutes: 10,
          sla: "OK",
          deepLink: "/v1/human-reviews/r1",
          createdAt: "2026-02-01T10:00:00.000Z",
        },
      ],
      slaPolicy: { warnAfterHours: 4, breachAfterHours: 24, ref: "default-v1" },
    };
  }

  it("segundo mount exibe o cache e busca o centro em background", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    let phase: "v1" | "v2" = "v1";
    let centerCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(CENTER_PATH)) {
          centerCalls += 1;
          return jsonResponse(200, centerBody(phase === "v1" ? "resumo-velho" : "resumo-novo"));
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    const first = render(
      <AuthProvider>
        <HitlCenter />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("resumo-velho")).toBeTruthy());
    const callsAfterFirst = centerCalls;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);
    first.unmount();

    phase = "v2";
    render(
      <AuthProvider>
        <HitlCenter />
      </AuthProvider>,
    );
    // Cache imediato do primeiro mount, sem tratar como autoritativo.
    expect(screen.getByText("resumo-velho")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("resumo-novo")).toBeTruthy());
    expect(centerCalls).toBeGreaterThan(callsAfterFirst);
  });
});

describe("identidade cross-source da fila HITL", () => {
  const CENTER_PATH = "/v1/human-reviews/center";

  function item(source: string, id: string, summary: string, sla: string, createdAt: string): Record<string, unknown> {
    return {
      source,
      id,
      kind: "APPROVAL/manual",
      summary,
      priority: null,
      ageMinutes: 10,
      sla,
      deepLink: `/v1/${source}/${id}`,
      createdAt,
    };
  }

  it("preview conta o breach oculto exato mesmo com id repetido entre fontes", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    // Preview ordenado (5): 5 breaches mais antigos, incluindo human_review/dup.
    // Fora do preview: billing_exception/dup (mesmo id, outra fonte) em BREACH.
    // A lógica antiga por conjunto de ids excluiria o oculto (contagem 0).
    const body = {
      items: [
        item("human_review", "b1", "Breach B1", "BREACH", "2026-02-01T10:00:00.000Z"),
        item("human_review", "b2", "Breach B2", "BREACH", "2026-02-01T10:01:00.000Z"),
        item("human_review", "b3", "Breach B3", "BREACH", "2026-02-01T10:02:00.000Z"),
        item("human_review", "b4", "Breach B4", "BREACH", "2026-02-01T10:03:00.000Z"),
        item("human_review", "dup", "Resumo A dup", "BREACH", "2026-02-01T10:04:00.000Z"),
        item("billing_exception", "dup", "Resumo B dup oculto", "BREACH", "2026-02-01T10:05:00.000Z"),
      ],
      slaPolicy: { warnAfterHours: 4, breachAfterHours: 24, ref: "default-v1" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(CENTER_PATH)) return jsonResponse(200, body);
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(<NeedsAttention />);
    await waitFor(() => expect(screen.getByText("Precisa de você (6)")).toBeTruthy());
    expect(screen.getByText("Resumo A dup")).toBeTruthy();
    expect(screen.queryByText("Resumo B dup oculto")).toBeNull();
    expect(screen.getByText(/e mais 1 item.*1 com SLA estourado/)).toBeTruthy();
  });

  it("duas fontes com o mesmo id renderizam ambas sem colidir o estado busy", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    const body = {
      items: [
        item("human_review", "dup", "Resumo humano dup", "WARN", "2026-02-01T10:00:00.000Z"),
        item("billing_exception", "dup", "Resumo cobrança dup", "WARN", "2026-02-01T10:01:00.000Z"),
      ],
      slaPolicy: { warnAfterHours: 4, breachAfterHours: 24, ref: "default-v1" },
    };
    let claimCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/human-reviews/dup/claim")) {
          claimCalls += 1;
          return jsonResponse(200, {});
        }
        if (url.endsWith(CENTER_PATH)) return jsonResponse(200, body);
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <HitlCenter />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("Resumo humano dup")).toBeTruthy());
    expect(screen.getByText("Resumo cobrança dup")).toBeTruthy();
    // Ação na linha human_review/dup não afeta a linha de outra fonte.
    fireEvent.click(screen.getByRole("button", { name: "Assumir" }));
    await waitFor(() => expect(claimCalls).toBe(1));
    await waitFor(() => expect(screen.getByText("Resumo cobrança dup")).toBeTruthy());
    expect(screen.getByText("Resumo humano dup")).toBeTruthy();
  });
});

describe("revisão de contexto sessão→me com retry limitado", () => {
  function sessionRevBody(userId: string, email: string, tenantId: string, rev: string): Record<string, unknown> {
    return {
      user: { id: userId, email, displayName: null },
      activeTenantId: tenantId,
      tenantContextRevision: rev,
      memberships: [
        { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
      ],
    };
  }

  function meBody(tenantId: string): Record<string, unknown> {
    return {
      user: { id: "u1", email: "u1@tenant.com" },
      activeTenant: { id: tenantId },
      roleKeys: [],
      permissions: [],
    };
  }

  function RevisionProbe(): React.JSX.Element {
    const { loading, user, tenantContextRevision } = useAuth();
    return (
      <span data-testid="rev">
        {loading ? "loading" : user ? (tenantContextRevision ?? "none") : "anon"}
      </span>
    );
  }

  const revisionOf = (init?: RequestInit): string | undefined => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return headers["x-tenant-context-revision"];
  };

  it("conflito de revisão no /me retenta com snapshot novo e comete só o par consistente", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let sessionCalls = 0;
    const meRevisions: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          // Primeira tentativa: revisão 5; outra sessão trocou para 6 antes
          // do `/me` — o retry observa o snapshot novo.
          return jsonResponse(200, sessionRevBody("u1", "u1@tenant.com", "t1", sessionCalls === 1 ? "5" : "6"));
        }
        if (url.endsWith("/v1/me")) {
          meRevisions.push(revisionOf(init));
          if (meRevisions.length === 1) return jsonResponse(409, { code: "TENANT_CONTEXT_CONFLICT" });
          return jsonResponse(200, meBody("t1"));
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <RevisionProbe />
      </AuthProvider>,
    );
    // `/v1/me` vinculado exatamente à revisão do snapshot que o originou.
    await waitFor(() => expect(screen.getByTestId("rev").textContent).toBe("6"));
    expect(sessionCalls).toBe(2);
    expect(meRevisions).toEqual(["5", "6"]);
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-shared");
  });
});

describe("conflito de contexto em leitura protegida reconcilia sem logout", () => {
  const PROBE_PATH = "/v1/lookup-probe";

  function sessionRevBody(tenantId: string, rev: string): Record<string, unknown> {
    return {
      user: { id: "u1", email: "u1@tenant.com", displayName: null },
      activeTenantId: tenantId,
      tenantContextRevision: rev,
      memberships: [
        { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
        { tenantId: "t2", tenantSlug: "t2", tenantName: "Tenant 2", roleKey: "owner", status: "ACTIVE" },
      ],
    };
  }

  function meBody(tenantId: string): Record<string, unknown> {
    return {
      user: { id: "u1", email: "u1@tenant.com" },
      activeTenant: { id: tenantId },
      roleKeys: [],
      permissions: [],
    };
  }

  function ScopeProbe(): React.JSX.Element {
    const { data, loading } = useApi<{ tag: string }>(PROBE_PATH);
    return <span data-testid="probe-tag">{loading ? "loading" : data ? data.tag : "empty"}</span>;
  }

  function RevisionProbe(): React.JSX.Element {
    const { loading, user, tenantContextRevision } = useAuth();
    return (
      <span data-testid="rev">
        {loading ? "loading" : user ? (tenantContextRevision ?? "none") : "anon"}
      </span>
    );
  }

  function TenantProbe(): React.JSX.Element {
    const { activeTenantId } = useAuth();
    return <span data-testid="tenant">{activeTenantId ?? "none"}</span>;
  }

  const revisionOf = (init?: RequestInit): string | undefined => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return headers["x-tenant-context-revision"];
  };

  it("requisição stale recebe 409 sem logout e reconcilia a revisão vencedora", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let sessionCalls = 0;
    let sawStaleProbe = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          return jsonResponse(200, sessionRevBody(sessionCalls === 1 ? "t1" : "t2", sessionCalls === 1 ? "10" : "11"));
        }
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, meBody(revisionOf(init) === "11" ? "t2" : "t1"));
        }
        if (url.endsWith(PROBE_PATH)) {
          const rev = revisionOf(init);
          // Revisão vencida: o servidor rejeita sem invalidar o token.
          if (rev === "10") {
            sawStaleProbe = true;
            return jsonResponse(409, { code: "TENANT_CONTEXT_CONFLICT" });
          }
          if (rev === "11") return jsonResponse(200, { tag: "TAG-NEW" });
          return jsonResponse(200, { tag: "TAG-OLD" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <ScopeProbe />
        <RevisionProbe />
        <TenantProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("rev").textContent).toBe("11"));
    expect(sawStaleProbe).toBe(true);
    // Token válido preservado: sem logout por causa do conflito.
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-shared");
    expect(screen.getByTestId("tenant").textContent).toBe("t2");
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-NEW"));
    expect(screen.queryByText("TAG-OLD")).toBeNull();
  });
});

describe("switch stale com revisão original comete só o vencedor", () => {
  function sessionRevBody(tenantId: string, rev: string): Record<string, unknown> {
    return {
      user: { id: "u1", email: "u1@tenant.com", displayName: null },
      activeTenantId: tenantId,
      tenantContextRevision: rev,
      memberships: [
        { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
        { tenantId: "t2", tenantSlug: "t2", tenantName: "Tenant 2", roleKey: "owner", status: "ACTIVE" },
        { tenantId: "t3", tenantSlug: "t3", tenantName: "Tenant 3", roleKey: "owner", status: "ACTIVE" },
      ],
    };
  }

  function meBody(tenantId: string): Record<string, unknown> {
    return {
      user: { id: "u1", email: "u1@tenant.com" },
      activeTenant: { id: tenantId },
      roleKeys: [],
      permissions: [],
    };
  }

  function RevisionProbe(): React.JSX.Element {
    const { loading, user, tenantContextRevision } = useAuth();
    return (
      <span data-testid="rev">
        {loading ? "loading" : user ? (tenantContextRevision ?? "none") : "anon"}
      </span>
    );
  }

  function TenantProbe(): React.JSX.Element {
    const { activeTenantId } = useAuth();
    return <span data-testid="tenant">{activeTenantId ?? "none"}</span>;
  }

  it("POST leva a revisão observada; 409 reconcilia o vencedor sem logout", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let sessionCalls = 0;
    let conflict: ApiError | null = null;
    let switchRevision: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          // Restauração em t1/rev10; o vencedor t3/rev11 permanece ativo.
          return jsonResponse(200, sessionRevBody(sessionCalls === 1 ? "t1" : "t3", sessionCalls === 1 ? "10" : "11"));
        }
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, meBody(sessionCalls <= 1 ? "t1" : "t3"));
        }
        if (url.endsWith("/v1/tenants/t2/switch")) {
          switchRevision = ((init?.headers ?? {}) as Record<string, string>)["x-tenant-context-revision"];
          return jsonResponse(409, { code: "TENANT_CONTEXT_CONFLICT" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    function SwitchButton(): React.JSX.Element {
      const { switchTenant } = useAuth();
      return (
        <button
          onClick={() => {
            void switchTenant("t2").catch((err: unknown) => {
              conflict = err as ApiError;
            });
          }}
        >
          trocar-t2
        </button>
      );
    }
    render(
      <AuthProvider>
        <RevisionProbe />
        <TenantProbe />
        <SwitchButton />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("rev").textContent).toBe("10"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    // O POST consome a revisão observada (stale), não uma releitura tardia.
    await waitFor(() => expect(conflict).not.toBeNull());
    expect(switchRevision).toBe("10");
    // Destino stale nunca cometido em silêncio: o vencedor autoritativo
    // (t3/rev11) é cometido com o mesmo token e o conflito é explicado.
    expect((conflict as unknown as ApiError).code).toBe("TENANT_SWITCH_CONFLICT");
    expect((conflict as unknown as ApiError).message).toMatch(/outra sessão/);
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-shared");
    expect(screen.getByTestId("tenant").textContent).toBe("t3");
    expect(screen.getByTestId("rev").textContent).toBe("11");
  });
});

describe("resposta tardia do escopo antigo nunca aparece sob a revisão nova", () => {
  const PROBE_PATH = "/v1/lookup-probe";

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  async function flushMicrotasks(rounds = 32): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
    }
  }

  function dispatchStorage(key: string, newValue: string | null): void {
    let ev: StorageEvent;
    try {
      ev = new StorageEvent("storage", { key, newValue });
    } catch {
      const fallback = new Event("storage") as StorageEvent;
      (fallback as unknown as Record<string, unknown>).key = key;
      (fallback as unknown as Record<string, unknown>).newValue = newValue;
      window.dispatchEvent(fallback);
      return;
    }
    window.dispatchEvent(ev);
  }

  function sessionRevBody(tenantId: string, rev: string): Record<string, unknown> {
    return {
      user: { id: "u1", email: "u1@tenant.com", displayName: null },
      activeTenantId: tenantId,
      tenantContextRevision: rev,
      memberships: [
        { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
        { tenantId: "t2", tenantSlug: "t2", tenantName: "Tenant 2", roleKey: "owner", status: "ACTIVE" },
      ],
    };
  }

  function ScopeProbe(): React.JSX.Element {
    const { data, loading, reload } = useApi<{ tag: string }>(PROBE_PATH);
    return (
      <div>
        <span data-testid="probe-tag">{loading ? "loading" : data ? data.tag : "empty"}</span>
        <button onClick={() => reload()}>recarregar</button>
      </div>
    );
  }

  function RevisionProbe(): React.JSX.Element {
    const { loading, user, tenantContextRevision } = useAuth();
    return (
      <span data-testid="rev">
        {loading ? "loading" : user ? (tenantContextRevision ?? "none") : "anon"}
      </span>
    );
  }

  const revisionOf = (init?: RequestInit): string | undefined => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return headers["x-tenant-context-revision"];
  };

  it("releitura stale diferida é descartada após reconciliação cross-tab", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let activeTenant = "t1";
    let activeRevision = "20";
    let probeCalls = 0;
    const staleGate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) return jsonResponse(200, sessionRevBody(activeTenant, activeRevision));
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "u1@tenant.com" },
            activeTenant: { id: activeTenant },
            roleKeys: [],
            permissions: [],
          });
        }
        if (url.endsWith(PROBE_PATH)) {
          probeCalls += 1;
          if (probeCalls === 3) return staleGate.promise;
          const rev = revisionOf(init);
          if (rev === "21") return jsonResponse(200, { tag: "TAG-T2" });
          return jsonResponse(200, { tag: "TAG-T1" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <ScopeProbe />
        <RevisionProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("rev").textContent).toBe("20"));
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-T1"));
    // Releitura do escopo antigo fica pendente (resposta tardia).
    fireEvent.click(screen.getByRole("button", { name: "recarregar" }));
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("loading"));
    // Outra aba confirma t2/rev21 no servidor; o sinal reconcilia e comita.
    activeTenant = "t2";
    activeRevision = "21";
    await act(async () => {
      dispatchStorage("iptv.session_signal", `${Date.now()}:t2`);
      await flushMicrotasks();
    });
    await waitFor(() => expect(screen.getByTestId("rev").textContent).toBe("21"));
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-T2"));
    // A resposta tardia do escopo antigo chega depois e é descartada: nem
    // UI nem cache da revisão nova a absorvem.
    await act(async () => {
      staleGate.resolve(jsonResponse(200, { tag: "TAG-T1-STALE" }));
      await staleGate.promise;
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-T2");
    expect(screen.queryByText("TAG-T1-STALE")).toBeNull();
    expect(screen.getByTestId("rev").textContent).toBe("21");
    const scope = `auth:u1:t2:21:${getApiGeneration()}`;
    expect(readScopedCache<{ tag: string }>(scope, PROBE_PATH)).toEqual({ hit: true, value: { tag: "TAG-T2" } });
  });
});

describe("NeedsAttention fila vazia com refresh falho (regressão)", () => {
  const CENTER_PATH = "/v1/human-reviews/center";

  function centerBody(items: Record<string, unknown>[]): Record<string, unknown> {
    return {
      items,
      slaPolicy: { warnAfterHours: 4, breachAfterHours: 24, ref: "default-v1" },
    };
  }

  it("cache vazio + refresh falho exibe aviso stale com retry, nunca 'Nada pendente' sem qualificação", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    let mode: "empty" | "fail" | "one" = "empty";
    const oneItem = {
      source: "human_review",
      id: "r1",
      kind: "APPROVAL/manual",
      summary: "revisar reembolso",
      priority: null,
      ageMinutes: 10,
      sla: "OK",
      deepLink: "/v1/human-reviews/r1",
      createdAt: "2026-02-01T10:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(CENTER_PATH)) {
          if (mode === "fail") return jsonResponse(500, { code: "INTERNAL" });
          return jsonResponse(200, centerBody(mode === "one" ? [oneItem] : []));
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(<NeedsAttention />);
    await waitFor(() => expect(screen.getByText("Nada pendente")).toBeTruthy());
    // Fila vazia autoritativa: nenhum aviso de frescor ainda.
    expect(screen.queryByText(/possivelmente desatualizados/)).toBeNull();
    // O refresh em background falha: o vazio passa a ser apresentado como
    // possivelmente desatualizado, com retry — nunca como certeza.
    mode = "fail";
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(screen.getByText(/possivelmente desatualizados/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Tentar atualizar" })).toBeTruthy();
    // O retry recupera: o aviso some e o item real aparece.
    mode = "one";
    fireEvent.click(screen.getByRole("button", { name: "Tentar atualizar" }));
    await waitFor(() => expect(screen.getByText("revisar reembolso")).toBeTruthy());
    expect(screen.queryByText(/possivelmente desatualizados/)).toBeNull();
    expect(screen.queryByText("Nada pendente")).toBeNull();
  });
});

describe("hold cross-tab durante reconciliação de sessão (regressão)", () => {
  const PROBE_PATH = "/v1/lookup-probe";

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  async function flushMicrotasks(rounds = 32): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
    }
  }

  function dispatchStorage(key: string, newValue: string | null): void {
    let ev: StorageEvent;
    try {
      ev = new StorageEvent("storage", { key, newValue });
    } catch {
      const fallback = new Event("storage") as StorageEvent;
      (fallback as unknown as Record<string, unknown>).key = key;
      (fallback as unknown as Record<string, unknown>).newValue = newValue;
      window.dispatchEvent(fallback);
      return;
    }
    window.dispatchEvent(ev);
  }

  function sessionRevBody(tenantId: string, rev: string): Record<string, unknown> {
    return {
      user: { id: "u1", email: "u1@tenant.com", displayName: null },
      activeTenantId: tenantId,
      tenantContextRevision: rev,
      memberships: [
        { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
        { tenantId: "t2", tenantSlug: "t2", tenantName: "Tenant 2", roleKey: "owner", status: "ACTIVE" },
      ],
    };
  }

  function ScopeProbe(): React.JSX.Element {
    const { data, loading } = useApi<{ tag: string }>(PROBE_PATH);
    return <span data-testid="probe-tag">{loading ? "loading" : data ? data.tag : "empty"}</span>;
  }

  function RevisionProbe(): React.JSX.Element {
    const { loading, user, tenantContextRevision } = useAuth();
    return (
      <span data-testid="rev">
        {loading ? "loading" : user ? (tenantContextRevision ?? "none") : "anon"}
      </span>
    );
  }

  const revisionOf = (init?: RequestInit): string | undefined => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return headers["x-tenant-context-revision"];
  };

  it("sinal cross-tab segura fetch protegido até o commit; stale não libera o hold novo", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let sessionCalls = 0;
    let probeCalls = 0;
    const probeRevisions: (string | undefined)[] = [];
    const gateA = deferred<Response>();
    const gateB = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          if (sessionCalls === 1) return jsonResponse(200, sessionRevBody("t1", "20"));
          if (sessionCalls === 2) return gateA.promise;
          if (sessionCalls === 3) return gateB.promise;
          return jsonResponse(200, sessionRevBody("t2", "21"));
        }
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "u1@tenant.com" },
            activeTenant: { id: sessionCalls <= 1 ? "t1" : "t2" },
            roleKeys: [],
            permissions: [],
          });
        }
        if (url.endsWith(PROBE_PATH)) {
          probeCalls += 1;
          probeRevisions.push(revisionOf(init));
          const rev = revisionOf(init);
          if (rev === "21") return jsonResponse(200, { tag: "TAG-T2" });
          return jsonResponse(200, { tag: "TAG-T1" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <ScopeProbe />
        <RevisionProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("rev").textContent).toBe("20"));
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-T1"));
    const probeBaseline = probeCalls;
    // Dois sinais concorrentes com o refresh deferido: A (stale) e B (latest).
    await act(async () => {
      dispatchStorage("iptv.session_signal", "sig-A");
      await flushMicrotasks();
    });
    await act(async () => {
      dispatchStorage("iptv.session_signal", "sig-B");
      await flushMicrotasks();
    });
    expect(sessionCalls).toBe(3);
    // Hold síncrono: conteúdo antigo some e nenhum fetch protegido parte.
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("empty"));
    expect(screen.queryByText("TAG-T1")).toBeNull();
    expect(screen.getByTestId("rev").textContent).toBe("loading");
    await act(async () => {
      await flushMicrotasks();
    });
    expect(probeCalls).toBe(probeBaseline);
    // Stale (A) resolve primeiro: não pode cometer nem liberar o hold de B.
    await act(async () => {
      gateA.resolve(jsonResponse(200, sessionRevBody("t2", "21")));
      await gateA.promise;
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(screen.getByTestId("probe-tag").textContent).toBe("empty");
    expect(screen.queryByText("TAG-T1")).toBeNull();
    expect(screen.queryByText("TAG-T2")).toBeNull();
    expect(screen.getByTestId("rev").textContent).toBe("loading");
    expect(probeCalls).toBe(probeBaseline);
    // Latest (B) resolve: comete t2/rev21 e as leituras retomam na revisão nova.
    await act(async () => {
      gateB.resolve(jsonResponse(200, sessionRevBody("t2", "21")));
      await gateB.promise;
      await flushMicrotasks();
    });
    await waitFor(() => expect(screen.getByTestId("rev").textContent).toBe("21"));
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-T2"));
    expect(probeRevisions[probeRevisions.length - 1]).toBe("21");
    expect(screen.queryByText("TAG-T1")).toBeNull();
  });

  it("falha do refresh cross-tab mantém o hold até o fail-closed sem reexpor dado antigo", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let sessionCalls = 0;
    let probeCalls = 0;
    const sessionGate = deferred<Response>();
    const tokenOf = (init?: RequestInit): string | null => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers.authorization ?? "";
      return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          if (sessionCalls === 1) return jsonResponse(200, sessionRevBody("t1", "20"));
          return sessionGate.promise;
        }
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "u1@tenant.com" },
            activeTenant: { id: "t1" },
            roleKeys: [],
            permissions: [],
          });
        }
        if (url.endsWith(PROBE_PATH)) {
          probeCalls += 1;
          return tokenOf(init) === "tok-shared"
            ? jsonResponse(200, { tag: "TAG-T1" })
            : jsonResponse(200, { tag: "TAG-ANON" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <ScopeProbe />
        <RevisionProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("rev").textContent).toBe("20"));
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-T1"));
    const probeBaseline = probeCalls;
    await act(async () => {
      dispatchStorage("iptv.session_signal", "other-tab:expired");
      await flushMicrotasks();
    });
    // Hold até a resolução: sem dado antigo visível e sem fetch protegido novo.
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("empty"));
    expect(screen.queryByText("TAG-T1")).toBeNull();
    await act(async () => {
      await flushMicrotasks();
    });
    expect(probeCalls).toBe(probeBaseline);
    // Falha autoritativa: token inválido, sem reter identidade/dado antigo.
    await act(async () => {
      sessionGate.resolve(jsonResponse(401, { code: "UNAUTHENTICATED" }));
      await sessionGate.promise;
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
    expect(screen.getByTestId("rev").textContent).toBe("anon");
    expect(screen.queryByText("TAG-T1")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("probe-tag").textContent).toBe("TAG-ANON"));
  });
});

describe("restauração/login fail-closed sem /me com tenant ativo", () => {
  function sessionRevBody(userId: string, email: string, tenantId: string, rev: string): Record<string, unknown> {
    return {
      user: { id: userId, email, displayName: null },
      activeTenantId: tenantId,
      tenantContextRevision: rev,
      memberships: [
        { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
      ],
    };
  }

  function AuthStateProbe(): React.JSX.Element {
    const { loading, user } = useAuth();
    return <span data-testid="auth-state">{loading ? "loading" : user ? user.id : "anon"}</span>;
  }

  function TenantProbe(): React.JSX.Element {
    const { activeTenantId } = useAuth();
    return <span data-testid="tenant">{activeTenantId ?? "none"}</span>;
  }

  function RevisionProbe(): React.JSX.Element {
    const { loading, user, tenantContextRevision } = useAuth();
    return (
      <span data-testid="rev">
        {loading ? "loading" : user ? (tenantContextRevision ?? "none") : "anon"}
      </span>
    );
  }

  it("restauração com tenant ativo e /me indisponível (não-401 repetido) falha fechado sem cometer sessão", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-u1");
    let sessionCalls = 0;
    let meCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          return jsonResponse(200, sessionRevBody("u1", "u1@tenant.com", "t1", "9"));
        }
        if (url.endsWith("/v1/me")) {
          meCalls += 1;
          return jsonResponse(500, { code: "INTERNAL" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <AuthStateProbe />
        <TenantProbe />
        <RevisionProbe />
      </AuthProvider>,
    );
    // Retries limitados: 2 snapshots, sem commit parcial.
    await waitFor(() => expect(sessionCalls).toBe(2));
    await waitFor(() => expect(meCalls).toBe(2));
    // Fail-closed: só o token capturado ainda corrente é limpo, sem reter
    // usuário/tenant/revisão.
    await waitFor(() => expect(window.localStorage.getItem("iptv.session_token")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("anon"));
    expect(screen.getByTestId("tenant").textContent).toBe("none");
    expect(screen.getByTestId("rev").textContent).toBe("anon");
  });

  it("login com tenant ativo e /me indisponível não persiste o token da resposta e exibe erro", async () => {
    let sessionCalls = 0;
    let meCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/login")) {
          return jsonResponse(200, {
            token: "tok-new",
            activeTenantId: "t1",
            user: { id: "u1", email: "op@tenant.com", displayName: null },
          });
        }
        if (url.endsWith("/v1/auth/session")) {
          sessionCalls += 1;
          return jsonResponse(200, sessionRevBody("u1", "op@tenant.com", "t1", "9"));
        }
        if (url.endsWith("/v1/me")) {
          meCalls += 1;
          return jsonResponse(500, { code: "INTERNAL" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    const onSuccess = vi.fn();
    render(
      <AuthProvider>
        <LoginForm onSuccess={onSuccess} />
      </AuthProvider>,
    );
    fireEvent.change(screen.getByPlaceholderText("voce@empresa.com.br"), { target: { value: "op@tenant.com" } });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    // Erro 503 de contexto indisponível é exibido; o token da resposta nunca
    // é persistido nem o contexto cometido.
    await waitFor(() => expect(screen.getByText(/temporariamente indisponível/i)).toBeTruthy());
    expect(onSuccess).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
    expect(sessionCalls).toBe(2);
    expect(meCalls).toBe(2);
  });

  it("bootstrap sem tenant ativo permanece autenticado com revisão e não chama /me", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-notenant");
    let meCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/session")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "u1@tenant.com", displayName: null },
            activeTenantId: null,
            tenantContextRevision: "7",
            memberships: [
              { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
            ],
          });
        }
        if (url.endsWith("/v1/me")) {
          meCalls += 1;
          return jsonResponse(500, { code: "INTERNAL" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <AuthStateProbe />
        <TenantProbe />
        <RevisionProbe />
      </AuthProvider>,
    );
    // Sessão sem tenant é coerente sem `/me`: autenticada, com revisão, sem
    // logout — pronta para listar/escolher memberships.
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    expect(screen.getByTestId("tenant").textContent).toBe("none");
    expect(screen.getByTestId("rev").textContent).toBe("7");
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-notenant");
    expect(meCalls).toBe(0);
  });
});

describe("rejeição definitiva sem tenant ativo + 5xx com código de conflito", () => {
  function noTenantSessionBody(rev: string): Record<string, unknown> {
    return {
      user: { id: "u1", email: "u1@tenant.com", displayName: null },
      activeTenantId: null,
      tenantContextRevision: rev,
      memberships: [
        { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
      ],
    };
  }

  function tenantSessionBody(tenantId: string): Record<string, unknown> {
    return {
      user: { id: "u1", email: "u1@tenant.com", displayName: null },
      activeTenantId: tenantId,
      memberships: [
        { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
        { tenantId: "t2", tenantSlug: "t2", tenantName: "Tenant 2", roleKey: "owner", status: "ACTIVE" },
      ],
    };
  }

  function meBody(tenantId: string): Record<string, unknown> {
    return {
      user: { id: "u1", email: "u1@tenant.com" },
      activeTenant: { id: tenantId },
      roleKeys: [],
      permissions: [],
    };
  }

  function AuthStateProbe(): React.JSX.Element {
    const { loading, user } = useAuth();
    return <span data-testid="auth-state">{loading ? "loading" : user ? user.id : "anon"}</span>;
  }

  function TenantProbe(): React.JSX.Element {
    const { activeTenantId } = useAuth();
    return <span data-testid="tenant">{activeTenantId ?? "none"}</span>;
  }

  function RevisionProbe(): React.JSX.Element {
    const { loading, user, tenantContextRevision } = useAuth();
    return (
      <span data-testid="rev">
        {loading ? "loading" : user ? (tenantContextRevision ?? "none") : "anon"}
      </span>
    );
  }

  function PermsProbe(): React.JSX.Element {
    const { permissions } = useAuth();
    return <span data-testid="perms">{permissions.length === 0 ? "empty" : permissions.join(",")}</span>;
  }

  it("409 TENANT_CONTEXT_CONFLICT sem tenant ativo preserva a sessão sem tenant e propaga conflito", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-notenant");
    let meCalls = 0;
    let conflict: ApiError | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/auth/session")) return jsonResponse(200, noTenantSessionBody("7"));
        if (url.endsWith("/v1/me")) {
          meCalls += 1;
          return jsonResponse(500, { code: "INTERNAL" });
        }
        if (url.endsWith("/v1/tenants/t2/switch")) {
          return jsonResponse(409, { code: "TENANT_CONTEXT_CONFLICT" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    function SwitchButton(): React.JSX.Element {
      const { switchTenant } = useAuth();
      return (
        <button
          onClick={() => {
            void switchTenant("t2").catch((err: unknown) => {
              conflict = err as ApiError;
            });
          }}
        >
          trocar-t2
        </button>
      );
    }
    render(
      <AuthProvider>
        <AuthStateProbe />
        <TenantProbe />
        <RevisionProbe />
        <PermsProbe />
        <SwitchButton />
      </AuthProvider>,
    );
    // Bootstrap sem tenant: autenticado, sem `/me` legítimo.
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    expect(screen.getByTestId("tenant").textContent).toBe("none");
    expect(screen.getByTestId("rev").textContent).toBe("7");
    expect(meCalls).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    // Rejeição definitiva sem efeito: revalida e preserva a sessão sem
    // tenant — token capturado, revisão/memberships autoritativos,
    // permissões vazias — sai do hold e propaga o conflito específico.
    await waitFor(() => expect(conflict).not.toBeNull());
    expect((conflict as unknown as ApiError).code).toBe("TENANT_SWITCH_CONFLICT");
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-notenant");
    expect(screen.getByTestId("auth-state").textContent).toBe("u1");
    expect(screen.getByTestId("tenant").textContent).toBe("none");
    expect(screen.getByTestId("rev").textContent).toBe("7");
    expect(screen.getByTestId("perms").textContent).toBe("empty");
  });

  it("500 com TENANT_CONTEXT_CONFLICT no corpo é ambíguo e falha fechado sem commit silencioso", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-shared");
    let switchStatus: number | null = null;
    let switchCode: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        // Refresh imediato relata o tenant antigo de forma consistente — isso
        // NÃO prova ausência de efeito do POST ambíguo.
        if (url.endsWith("/v1/auth/session")) return jsonResponse(200, tenantSessionBody("t1"));
        if (url.endsWith("/v1/me")) return jsonResponse(200, meBody("t1"));
        if (url.endsWith("/v1/tenants/t2/switch")) {
          return jsonResponse(500, { code: "TENANT_CONTEXT_CONFLICT" });
        }
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    function SwitchButton(): React.JSX.Element {
      const { switchTenant } = useAuth();
      return (
        <button
          onClick={() => {
            void switchTenant("t2").catch((err: unknown) => {
              const apiErr = err as ApiError;
              switchStatus = apiErr.status ?? -1;
              switchCode = apiErr.code ?? null;
            });
          }}
        >
          trocar-t2
        </button>
      );
    }
    render(
      <AuthProvider>
        <AuthStateProbe />
        <TenantProbe />
        <SwitchButton />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("u1"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("t1"));
    fireEvent.click(screen.getByRole("button", { name: "trocar-t2" }));
    // 5xx com código de conflito no corpo: ambíguo — fail-closed, sem
    // reconciliação silenciosa nem sessão comitada.
    await waitFor(() => expect(window.localStorage.getItem("iptv.session_token")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("auth-state").textContent).toBe("anon"));
    await waitFor(() => expect(screen.getByTestId("tenant").textContent).toBe("none"));
    await waitFor(() => expect(switchStatus).toBe(500));
    expect(switchCode).toBe("TENANT_CONTEXT_CONFLICT");
  });
});

describe("SLA desconhecido no HitlCenter", () => {
  it("banda desconhecida da fila usa tom informativo não-verde e texto neutro", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    const body = {
      items: [
        {
          source: "human_review",
          id: "r-unknown",
          kind: "APPROVAL/manual",
          summary: "revisão com SLA futuro",
          priority: null,
          ageMinutes: 10,
          sla: "FUTURE",
          deepLink: "/v1/human-reviews/r-unknown",
          createdAt: "2026-02-01T10:00:00.000Z",
        },
      ],
      slaPolicy: { warnAfterHours: 4, breachAfterHours: 24, ref: "default-v1" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/human-reviews/center")) return jsonResponse(200, body);
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    render(
      <AuthProvider>
        <HitlCenter />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("revisão com SLA futuro")).toBeTruthy());
    const unknownBadge = screen.getByText("SLA desconhecido");
    expect(unknownBadge).toBeTruthy();
    const badgeClass = unknownBadge.closest("span")?.className ?? "";
    expect(badgeClass).toContain("cc-badge-info");
    expect(badgeClass).not.toContain("cc-badge-success");
  });
});

describe("origem provider_operation condicionada a provider.operation.read", () => {
  const CENTER_PATH = "/v1/human-reviews/center";

  function providerItem(id: string): Record<string, unknown> {
    return {
      source: "provider_operation",
      id,
      kind: "provider_operation/CREATE_TRIAL",
      summary: "provider operation awaiting human resolution",
      priority: null,
      ageMinutes: 400,
      sla: "WARN",
      deepLink: `/v1/provider/operations/${id}`,
      createdAt: "2026-02-01T10:00:00.000Z",
    };
  }

  function reviewItem(id: string): Record<string, unknown> {
    return {
      source: "human_review",
      id,
      kind: "APPROVAL/manual",
      summary: `revisão ${id}`,
      priority: null,
      ageMinutes: 10,
      sla: "OK",
      deepLink: `/v1/human-reviews/${id}`,
      createdAt: "2026-02-01T10:00:00.000Z",
    };
  }

  const centerBody = {
    items: [providerItem("op-1"), reviewItem("r1")],
    slaPolicy: { warnAfterHours: 4, breachAfterHours: 24, ref: "default-v1" },
  };

  /** Sessão autenticada com o conjunto de permissões informado. */
  function stubFetch(permissions: string[]): { urls: string[] } {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.endsWith("/v1/auth/session")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "u1@tenant.com", displayName: null },
            activeTenantId: "t1",
            memberships: [],
            tenantContextRevision: "0",
          });
        }
        if (url.endsWith("/v1/me")) {
          return jsonResponse(200, {
            user: { id: "u1", email: "u1@tenant.com" },
            activeTenant: { id: "t1" },
            roleKeys: [],
            permissions,
          });
        }
        if (url.includes(CENTER_PATH)) return jsonResponse(200, centerBody);
        return jsonResponse(404, { code: "NOT_FOUND" });
      }),
    );
    return { urls };
  }

  it("sem a permissão a opção some e linhas provider_operation não são renderizadas", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    // A resposta traz linhas de provider_operation (payload velho/cachê): a UI
    // não pode renderizá-las sem `provider.operation.read`.
    stubFetch(["support.ticket.read"]);
    render(
      <AuthProvider>
        <HitlCenter />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("revisão r1")).toBeTruthy());
    expect(screen.queryByText("provider operation awaiting human resolution")).toBeNull();
    const select = screen.getByLabelText("Origem:") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(["", "human_review", "comm_exception", "billing_exception", "recovery_task"]);
    expect(screen.queryByText(/Operações de provedor/)).toBeNull();
  });

  it("com a permissão a opção aparece, filtra por source=provider_operation e não oferece claim/decidir", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    const { urls } = stubFetch(["support.ticket.read", "provider.operation.read"]);
    render(
      <AuthProvider>
        <HitlCenter />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("provider operation awaiting human resolution")).toBeTruthy());
    const select = screen.getByLabelText("Origem:") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toContain("provider_operation");
    fireEvent.change(select, { target: { value: "provider_operation" } });
    await waitFor(() =>
      expect(urls.some((u) => u.includes("/v1/human-reviews/center?source=provider_operation"))).toBe(true),
    );
    // Deep link do endpoint IMPLEMENTADO de leitura da operação.
    expect(screen.getByText(/deep link: \/v1\/provider\/operations\/op-1/)).toBeTruthy();
    // Read-model only: sem controles de claim/aprovar/rejeitar na origem.
    expect(screen.queryByRole("button", { name: "Assumir" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rejeitar" })).toBeNull();
  });

  it("o preview da home também esconde provider_operation sem a permissão", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    stubFetch(["support.ticket.read"]);
    render(
      <AuthProvider>
        <NeedsAttention />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("Precisa de você (1)")).toBeTruthy());
    expect(screen.queryByText("provider operation awaiting human resolution")).toBeNull();
    expect(screen.getByText("revisão r1")).toBeTruthy();
  });
});

describe("Tenant Copilot (widget)", () => {
  beforeEach(() => {
    clearCopilotSessionMemory();
  });

  const askAnswer = {
    summary: "Você está em /. 2 ticket(s) aberto(s) neste tenant.",
    confidence: "OBSERVED",
    sectionsUsed: ["tickets"],
    data: {},
    suggestions: [
      {
        kind: "draft",
        label: "Preparar abertura de ticket",
        draftCommand: "support.ticket.open",
        draftInput: { priority: "NORMAL", summary: "ajuda" },
        needsInput: ["personId"],
        reason: "Informe a pessoa (cliente) para concluir o draft.",
      },
      { kind: "navigate", label: "Abrir visão filtrada: /support", deepLink: "/support" },
    ],
    deepLinks: [{ label: "Suporte", href: "/support" }],
  };

  function stubCopilot(fetchFn: (url: string, init?: RequestInit) => Promise<Response>): void {
    vi.stubGlobal("fetch", vi.fn(fetchFn));
  }

  it("abre, envia o contexto da tela e renderiza a resposta estruturada", async () => {
    const seen: string[] = [];
    stubCopilot(async (url: string, init?: RequestInit) => {
      seen.push(url);
      if (url.endsWith("/v1/agent/copilot/ask")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { screen?: { route?: string } };
        expect(body.screen?.route).toBe("/");
        return jsonResponse(200, askAnswer);
      }
      return jsonResponse(404, { code: "NOT_FOUND" });
    });
    render(<CopilotWidget />);
    fireEvent.click(screen.getByRole("button", { name: "Copilot" }));
    expect(screen.getByText("Pergunte sobre esta tela")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Ex.: explique esta tela"), { target: { value: "ajuda" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(screen.getByText(/Você está em \//)).toBeTruthy());
    expect(screen.getByText("OBSERVED")).toBeTruthy();
    expect(screen.getByText(/Preparar abertura de ticket/)).toBeTruthy();
    expect(screen.getByText(/Abrir visão filtrada: \/support/)).toBeTruthy();
    expect(seen.some((u) => u.endsWith("/v1/agent/copilot/ask"))).toBe(true);
  });

  it("action-card executa via pipeline mockado e confirma sem executar draft", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    stubCopilot(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body !== undefined ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/v1/agent/copilot/ask")) return jsonResponse(200, askAnswer);
      if (url.endsWith("/v1/agent/copilot/execute")) {
        return jsonResponse(200, { status: "executed", message: "ok", command: "support.ticket.open" });
      }
      return jsonResponse(404, { code: "NOT_FOUND" });
    });
    render(<CopilotWidget />);
    fireEvent.click(screen.getByRole("button", { name: "Copilot" }));
    fireEvent.change(screen.getByPlaceholderText("Ex.: explique esta tela"), { target: { value: "ajuda" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(screen.getByText(/Preparar abertura de ticket/)).toBeTruthy());
    // O draft exige personId: o botão Executar fica desabilitado e nada chama o execute.
    expect(screen.getByRole("button", { name: "Executar" })).toBeDisabled();
    expect(calls.some((c) => c.url.endsWith("/v1/agent/copilot/execute"))).toBe(false);
    // Salvar draft não executa: só persiste na memória da sessão, isolada por escopo.
    fireEvent.click(screen.getByRole("button", { name: "Salvar draft" }));
    await waitFor(() =>
      expect(loadDrafts("public:anonymous").map((d) => d.command)).toContain("support.ticket.open"),
    );
    expect(calls.some((c) => c.url.endsWith("/v1/agent/copilot/execute"))).toBe(false);
    // Outro escopo não enxerga o draft (isolamento por identidade).
    expect(loadDrafts("auth:u9:t9:0:0")).toEqual([]);
  });

  it("action-card executável chama o execute e exibe o estado de aprovação", async () => {
    const readyAnswer = {
      ...askAnswer,
      suggestions: [
        {
          kind: "draft",
          label: "Preparar resolução do ticket em foco",
          draftCommand: "support.ticket.resolve",
          draftInput: { ticketId: "11111111-1111-4111-8111-111111111111" },
          reason: "Ação sensível: exige aprovação humana (HITL) antes de executar.",
        },
      ],
    };
    const calls: string[] = [];
    stubCopilot(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/v1/agent/copilot/ask")) return jsonResponse(200, readyAnswer);
      if (url.endsWith("/v1/agent/copilot/execute")) {
        return jsonResponse(201, { status: "pending_review", message: "aguarda aprovação", command: "support.ticket.resolve", reviewId: "r1" });
      }
      return jsonResponse(404, { code: "NOT_FOUND" });
    });
    render(
      <ToastProvider>
        <CopilotWidget />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copilot" }));
    fireEvent.change(screen.getByPlaceholderText("Ex.: explique esta tela"), { target: { value: "resolver" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(screen.getByText(/Preparar resolução do ticket em foco/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Executar" }));
    await waitFor(() => expect(calls.some((u) => u.endsWith("/v1/agent/copilot/execute"))).toBe(true));
    await waitFor(() => expect(screen.getByText(/Enviado para aprovação humana/)).toBeTruthy());
  });

  it("erro do ask exibe estado de erro com retry", async () => {
    stubCopilot(async (url: string) => {
      if (url.endsWith("/v1/agent/copilot/ask")) return jsonResponse(403, { code: "FORBIDDEN" });
      return jsonResponse(404, { code: "NOT_FOUND" });
    });
    render(<CopilotWidget />);
    fireEvent.click(screen.getByRole("button", { name: "Copilot" }));
    fireEvent.change(screen.getByPlaceholderText("Ex.: explique esta tela"), { target: { value: "ajuda" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(screen.getByText("Não foi possível carregar.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });

  it("resposta de ask em voo é descartada quando a identidade muda (dado de A nunca aparece em B)", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-u1");
    let resolveAsk!: (res: Response) => void;
    const askGate = new Promise<Response>((resolve) => {
      resolveAsk = resolve;
    });
    let askCalls = 0;
    stubCopilot(async (url: string) => {
      if (url.endsWith("/v1/auth/session")) {
        return jsonResponse(200, {
          user: { id: "u1", email: "u1@tenant.com", displayName: null },
          activeTenantId: "t1",
          memberships: [
            { tenantId: "t1", tenantSlug: "t1", tenantName: "Tenant 1", roleKey: "owner", status: "ACTIVE" },
          ],
        });
      }
      if (url.endsWith("/v1/me")) {
        return jsonResponse(200, {
          user: { id: "u1", email: "u1@tenant.com" },
          activeTenant: { id: "t1" },
          roleKeys: [],
          permissions: [],
        });
      }
      if (url.endsWith("/v1/auth/logout")) return jsonResponse(200, {});
      if (url.endsWith("/v1/agent/copilot/ask")) {
        askCalls += 1;
        return askGate;
      }
      return jsonResponse(404, { code: "NOT_FOUND" });
    });
    function LogoutProbe(): React.JSX.Element {
      const { logout } = useAuth();
      return <button onClick={() => void logout()}>sair-probe</button>;
    }
    render(
      <AuthProvider>
        <CopilotWidget />
        <LogoutProbe />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copilot" }));
    fireEvent.change(screen.getByPlaceholderText("Ex.: explique esta tela"), { target: { value: "ajuda" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(askCalls).toBe(1));
    // Troca de identidade com o ask ainda pendente: o estado visível reseta.
    fireEvent.click(screen.getByRole("button", { name: "sair-probe" }));
    await waitFor(() => expect(screen.getByText("Pergunte sobre esta tela")).toBeTruthy());
    // A resposta tardia do escopo antigo chega e deve ser descartada.
    await act(async () => {
      resolveAsk(jsonResponse(200, askAnswer));
    });
    await waitFor(() => expect(askCalls).toBe(1));
    expect(screen.queryByText(/Você está em \//)).toBeNull();
    expect(screen.getByText("Pergunte sobre esta tela")).toBeTruthy();
  });

  it("histórico e drafts vivem só em memória: nada persiste e o reload evapora tudo", async () => {
    stubCopilot(async (url: string) => {
      if (url.endsWith("/v1/agent/copilot/ask")) return jsonResponse(200, askAnswer);
      return jsonResponse(404, { code: "NOT_FOUND" });
    });
    const view = render(<CopilotWidget />);
    fireEvent.click(screen.getByRole("button", { name: "Copilot" }));
    fireEvent.change(screen.getByPlaceholderText("Ex.: explique esta tela"), { target: { value: "ajuda" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(screen.getByText(/Preparar abertura de ticket/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Salvar draft" }));
    await waitFor(() => expect(loadDrafts("public:anonymous")).toHaveLength(1));
    // Nenhuma chave do Copilot com dado de cliente toca o armazenamento persistente.
    for (let i = 0; i < window.localStorage.length; i += 1) {
      expect(window.localStorage.key(i)?.startsWith("iptv.copilot.")).toBe(false);
    }
    // Reload simulado: registry novo, memória evaporada, conversa vazia.
    clearCopilotSessionMemory();
    expect(loadDrafts("public:anonymous")).toEqual([]);
    view.unmount();
    render(<CopilotWidget />);
    fireEvent.click(screen.getByRole("button", { name: "Copilot" }));
    expect(screen.getByText("Pergunte sobre esta tela")).toBeTruthy();
    expect(screen.queryByText(/Você está em \//)).toBeNull();
  });
});
