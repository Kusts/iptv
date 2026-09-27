import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, messageForStatus } from "../lib/api";
import { formatMinor, minorToMajorParts } from "../lib/money";
import { slaLabel, toneFor } from "../lib/status";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("apiFetch", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
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

  it("403 sem permissão vira mensagem pt-BR", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { code: "FORBIDDEN" })));
    const err = await apiFetch("/v1/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain("permissão");
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
