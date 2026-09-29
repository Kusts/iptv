import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiFetch,
  messageForStatus,
  setTenantContextConflictHandler,
  setTenantContextRevision,
} from "../lib/api";
import { getApiGeneration } from "../lib/api-cache";
import { formatMinor, minorToMajorParts } from "../lib/money";
import { slaLabel, toneFor } from "../lib/status";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("apiFetch", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    setTenantContextRevision(null);
    setTenantContextConflictHandler(null);
  });

  it("anexa o Bearer token do localStorage", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-123");
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/v1/health");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
  });

  it("401 limpa o token e chama onUnauthorized com mensagem pt-BR", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-123");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { code: "UNAUTHENTICATED" })));
    const onUnauthorized = vi.fn();
    await expect(apiFetch("/v1/health", { onUnauthorized })).rejects.toBeInstanceOf(ApiError);
    expect(window.localStorage.getItem("iptv.session_token")).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("401 tardio do token antigo não revoga o token novo nem avança geração", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-A");
    let resolveFetch!: (res: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => gate),
    );
    const genBefore = getApiGeneration();
    const onUnauthorized = vi.fn();
    const pending = apiFetch("/v1/health", { onUnauthorized });
    // Sessão mais nova (B) gravada antes da resposta 401 de A chegar.
    window.localStorage.setItem("iptv.session_token", "tok-B");
    resolveFetch(jsonResponse(401, { code: "UNAUTHENTICATED" }));
    await expect(pending).rejects.toBeInstanceOf(ApiError);
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-B");
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(getApiGeneration()).toBe(genBefore);
  });

  it("403 sem permissão vira mensagem pt-BR", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { code: "FORBIDDEN" })));
    const err = await apiFetch("/v1/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain("permissão");
  });
});

describe("tenant context revision (x-tenant-context-revision)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    setTenantContextRevision(null);
    setTenantContextConflictHandler(null);
  });

  function revisionOf(init?: RequestInit): string | undefined {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return headers["x-tenant-context-revision"];
  }

  it("anexa a revisão corrente em chamadas protegidas, incluindo ações POST", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    setTenantContextRevision("7");
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/v1/me");
    await apiFetch("/v1/human-reviews/r1/claim", { method: "POST", body: {} });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(revisionOf(init)).toBe("7");
    }
  });

  it("bootstrap de sessão e logout omitem o precondicionante mesmo com revisão", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    setTenantContextRevision("7");
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/v1/auth/session");
    await apiFetch("/v1/auth/logout", { method: "POST", body: {} });
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(revisionOf(init)).toBeUndefined();
    }
  });

  it("override explícito vence a corrente; null omite; sem token nunca envia", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    setTenantContextRevision("7");
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/v1/me", { tenantContextRevision: "99" });
    await apiFetch("/v1/me", { tenantContextRevision: null });
    window.localStorage.removeItem("iptv.session_token");
    await apiFetch("/v1/me");
    const [, overrideInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [, nullInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const [, anonInit] = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    expect(revisionOf(overrideInit)).toBe("99");
    expect(revisionOf(nullInit)).toBeUndefined();
    expect(revisionOf(anonInit)).toBeUndefined();
  });

  it("captura síncrona: troca da revisão após a invocação não afeta a requisição", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    setTenantContextRevision("1");
    let resolveFetch!: (res: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(async () => gate);
    vi.stubGlobal("fetch", fetchMock);
    const pending = apiFetch("/v1/me");
    // A revisão corrente muda enquanto a requisição está em voo.
    setTenantContextRevision("2");
    resolveFetch(jsonResponse(200, { ok: true }));
    await pending;
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(revisionOf(init)).toBe("1");
  });

  it("409 TENANT_CONTEXT_CONFLICT preserva token/revisão/geração e notifica uma vez", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-abc");
    setTenantContextRevision("7");
    const handler = vi.fn();
    setTenantContextConflictHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(409, { code: "TENANT_CONTEXT_CONFLICT" })));
    const genBefore = getApiGeneration();
    const err = await apiFetch("/v1/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("TENANT_CONTEXT_CONFLICT");
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-abc");
    expect(getApiGeneration()).toBe(genBefore);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("sem notify em switch, com token stale ou com notify suprimido", async () => {
    window.localStorage.setItem("iptv.session_token", "tok-new");
    setTenantContextRevision("7");
    const handler = vi.fn();
    setTenantContextConflictHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(409, { code: "TENANT_CONTEXT_CONFLICT" })));
    // Troca tem fluxo próprio de reconciliação.
    await expect(apiFetch("/v1/tenants/t2/switch", { method: "POST", body: {} })).rejects.toBeInstanceOf(ApiError);
    // Resposta tardia de token antigo não reconcilia o contexto novo.
    await expect(apiFetch("/v1/me", { token: "tok-old" })).rejects.toBeInstanceOf(ApiError);
    // Leituras internas do refreshSession são donas do próprio retry.
    await expect(apiFetch("/v1/me", { notifyContextConflict: false })).rejects.toBeInstanceOf(ApiError);
    expect(handler).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("iptv.session_token")).toBe("tok-new");
  });
});

describe("messageForStatus", () => {
  it("cobre os principais status em pt-BR", () => {
    expect(messageForStatus(401)).toContain("sessão");
    expect(messageForStatus(404)).toContain("tenant");
    expect(messageForStatus(503)).toContain("indisponível");
  });
});

describe("money (minor units, sem float)", () => {
  it("converte via string: 19990 → R$ 199,90", () => {
    expect(minorToMajorParts("19990")).toEqual({ reais: "199", cents: "90", negative: false });
    expect(formatMinor("19990", "BRL")).toBe("R$ 199,90");
  });

  it("centavos com zero à esquerda: 5 → R$ 0,05", () => {
    expect(formatMinor(5, "BRL")).toBe("R$ 0,05");
  });

  it("agrupa milhares em pt-BR", () => {
    expect(formatMinor("123456789", "BRL")).toBe("R$ 1.234.567,89");
  });
});

describe("status canônico", () => {
  it("mapeia os grupos principais", () => {
    expect(toneFor("ACTIVE")).toBe("success");
    expect(toneFor("PENDING")).toBe("warn");
    expect(toneFor("PROCESSING")).toBe("warn");
    expect(toneFor("FAILED")).toBe("danger");
    expect(toneFor("CANCELLED")).toBe("danger");
    expect(toneFor("ENDED")).toBe("neutral");
  });

  it("rotula SLA em pt-BR", () => {
    expect(slaLabel("BREACH")).toBe("SLA estourado");
    expect(slaLabel("WARN")).toBe("Atenção ao SLA");
  });
});
