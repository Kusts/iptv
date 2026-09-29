import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KnowledgeQueues } from "../components/KnowledgeQueues";
import { ToastProvider } from "../components/ui/Toast";
import { clearApiCache } from "../lib/useApi";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  clearApiCache();
  window.localStorage.setItem("iptv.session_token", "tok-abc");
});

function stubQueues(posts: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        posts.push(url);
        if (url.includes("/verify")) return jsonResponse(200, { id: "item-1", status: "VERIFIED" });
        if (url.includes("/apply")) return jsonResponse(200, { id: "corr-1", status: "APPLIED" });
        if (url.includes("/reject")) return jsonResponse(200, { id: "corr-1", status: "REJECTED" });
        if (url.includes("/close")) return jsonResponse(200, { id: "gap-1", status: "CLOSED" });
        if (url.includes("/freshness/refresh")) return jsonResponse(200, { refreshed: 3, degraded: [] });
        return jsonResponse(200, {});
      }
      if (url.includes("/v1/knowledge/items?status=CANDIDATE")) {
        return jsonResponse(200, {
          items: [{ id: "item-1", status: "CANDIDATE", knowledgeType: "FAQ", contentText: "Como emitir reembolso?" }],
        });
      }
      if (url.includes("/v1/knowledge/items?status=DEGRADED")) {
        return jsonResponse(200, { items: [] });
      }
      if (url.includes("/v1/knowledge/corrections")) {
        return jsonResponse(200, {
          corrections: [{ id: "corr-1", itemId: "item-1", proposedText: "Texto corrigido do FAQ", status: "OPEN" }],
        });
      }
      if (url.includes("/v1/knowledge/gaps")) {
        return jsonResponse(200, {
          gaps: [{ id: "gap-1", question: "Como configurar o app na TV?", supportTicketId: null, status: "OPEN" }],
        });
      }
      return jsonResponse(404, { code: "NOT_FOUND" });
    }),
  );
}

describe("filas de conhecimento (Wave 15)", () => {
  it("renderiza candidatos, correções e gaps", async () => {
    stubQueues([]);
    render(
      <ToastProvider>
        <KnowledgeQueues />
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByText("Como emitir reembolso?")).toBeTruthy());
    expect(screen.getByText("Texto corrigido do FAQ")).toBeTruthy();
    expect(screen.getByText("Como configurar o app na TV?")).toBeTruthy();
  });

  it("ação Verificar chama a API mockada", async () => {
    const posts: string[] = [];
    stubQueues(posts);
    render(
      <ToastProvider>
        <KnowledgeQueues />
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Verificar" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    await waitFor(() =>
      expect(posts.some((u) => u.endsWith("/v1/knowledge/items/item-1/verify"))).toBe(true),
    );
  });

  it("ação Aplicar chama a API mockada e exibe erro amigável em falha", async () => {
    const posts: string[] = [];
    stubQueues(posts);
    render(
      <ToastProvider>
        <KnowledgeQueues />
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Aplicar" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    await waitFor(() =>
      expect(posts.some((u) => u.endsWith("/v1/knowledge/corrections/corr-1/apply"))).toBe(true),
    );
  });
});
