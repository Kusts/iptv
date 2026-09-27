import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider } from "../lib/auth";
import { clearApiCache } from "../lib/useApi";
import { LoginForm } from "../components/LoginForm";
import { ConversationsPanel } from "../components/ConversationsPanel";
import { HitlCenter } from "../components/HitlCenter";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

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
