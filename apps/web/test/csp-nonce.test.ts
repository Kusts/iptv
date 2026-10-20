import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  CSP_REPORT_ONLY_HEADER,
  NONCE_HEADER,
  buildCspReportOnly,
  config as middlewareConfig,
  generateNonce,
  middleware,
} from "../middleware";

// Regressão do passo 2 do SCOPE-CSP-TTL: nonce por request em modo
// Report-Only (nada bloqueante). Trava o contrato: nonce único por
// request, propagado via `x-nonce`, `script-src` com nonce +
// `strict-dynamic` só no Report-Only, `style-src 'self'` observado
// (style= migrado para classes), framing bloqueante intacto e
// sem `unsafe-*`/hash (fora desta fatia).

function callMiddleware(path = "/"): NextResponse {
  const request = new NextRequest(`http://localhost${path}`);
  return middleware(request);
}

function nonceFromPolicy(policy: string): string | null {
  const match = /'nonce-([^']+)'/.exec(policy);
  return match?.[1] ?? null;
}

describe("csp nonce middleware (passo 2 do SCOPE-CSP-TTL)", () => {
  it("gera nonces únicos de 128 bits em base64", () => {
    const nonces = new Set(Array.from({ length: 10 }, () => generateNonce()));
    expect(nonces.size).toBe(10);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(atob(nonce)).toHaveLength(16);
    }
  });

  it("emite nonce único por request no Report-Only", () => {
    const first = callMiddleware();
    const second = callMiddleware();
    const firstPolicy = first.headers.get(CSP_REPORT_ONLY_HEADER) ?? "";
    const secondPolicy = second.headers.get(CSP_REPORT_ONLY_HEADER) ?? "";

    const firstNonce = nonceFromPolicy(firstPolicy);
    const secondNonce = nonceFromPolicy(secondPolicy);
    expect(firstNonce).toBeTruthy();
    expect(secondNonce).toBeTruthy();
    expect(firstNonce).not.toBe(secondNonce);

    // O nonce propagado para os Server Components é o mesmo da política.
    expect(first.headers.get(`x-middleware-request-${NONCE_HEADER}`)).toBe(
      firstNonce,
    );
  });

  it("propaga o nonce via x-nonce para o downstream (layout)", () => {
    const response = callMiddleware();
    const overridden =
      response.headers.get("x-middleware-override-headers") ?? "";
    expect(overridden.split(",")).toContain(NONCE_HEADER);
  });

  it("report-only carrega script-src com nonce + strict-dynamic e a base do passo 1", () => {
    const policy = buildCspReportOnly("nonce-de-teste");
    expect(policy).toContain(
      "script-src 'self' 'nonce-nonce-de-teste' 'strict-dynamic'",
    );
    // Base observada do passo 1, intacta (+ style-src do EXEC-STYLE-SRC).
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("img-src 'self' data:");
    expect(policy).toContain("font-src 'self'");
    expect(policy).toContain("style-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("report-uri /api/csp-report");
  });

  it("nunca emite CSP bloqueante, unsafe-* ou framing no Report-Only (style-src só observado)", () => {
    const response = callMiddleware();
    // Nada bloqueante: o middleware só observa.
    expect(response.headers.get("Content-Security-Policy")).toBeNull();

    const policy = (
      response.headers.get(CSP_REPORT_ONLY_HEADER) ?? ""
    ).toLowerCase();
    // `style-src 'self'` presente SÓ no Report-Only, sem inline.
    expect(policy).toContain("style-src 'self'");
    expect(policy).not.toContain("unsafe-");
    expect(policy).not.toContain("frame-ancestors");
    expect(policy).not.toContain("default-src");
  });

  it("cobre páginas e pula assets internos do Next", () => {
    expect(middlewareConfig.matcher).toHaveLength(1);
    const [pattern] = middlewareConfig.matcher;
    expect(pattern).toContain("_next/static");
    expect(pattern).toContain("_next/image");
  });

  it("layout lê o nonce via next/headers (plumbing pronta, sem markup novo)", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/layout.tsx"),
      "utf8",
    );
    expect(source).toContain('from "next/headers"');
    expect(source).toContain(NONCE_HEADER);
  });
});
