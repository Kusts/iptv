import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "../next.config.mjs";

// Regressão da subfatia de baixo risco do issue #44: impedir
// framing/clickjacking em TODAS as respostas web.
//
// Este teste chama o `headers()` real da config (não uma cópia) e trava o
// contrato: matcher global + os quatro headers de segurança (framing +
// referrer-policy + nosniff) + a CSP Report-Only do passo 1 do SCOPE-CSP-TTL.
// Escopo fora daqui (não travado aqui de propósito): CSP bloqueante geral,
// nonce, HSTS, rate limiting, headers de segurança da API, exposição
// pública — ver docs/16-pilot-closure/P6-SECURITY.md §8.

const FRAME_POLICY_SOURCE = "/:path*";

type HeaderRule = {
  source: string;
  headers: Array<{ key: string; value: string }>;
  has?: unknown;
  missing?: unknown;
};

// Preenchido em beforeAll: `headers()` é async na API do Next.
let rules: HeaderRule[] | undefined;

beforeAll(async () => {
  rules = (await nextConfig.headers?.()) as HeaderRule[] | undefined;
});

describe("web frame policy (issue #44)", () => {
  it("exposes headers() on the next config", () => {
    expect(typeof nextConfig.headers).toBe("function");
  });

  it("returns header rules", () => {
    expect(Array.isArray(rules)).toBe(true);
    expect(rules?.length).toBeGreaterThan(0);
  });

  it("keeps a single global rule with the catch-all matcher", () => {
    // Um único conjunto de regras: a frame policy não precisa de sobreposição
    // e várias regras aumentam a chance de override acidental entre elas.
    expect(rules).toHaveLength(1);
    const [rule] = rules ?? [];
    expect(rule?.source).toBe(FRAME_POLICY_SOURCE);
  });

  it("applies unconditionally (no has/missing gates)", () => {
    const [rule] = rules ?? [];
    // Sem condição, toda resposta web recebe os headers — inclusive as rotas
    // não autenticadas (login), que são justamente o alvo de clickjacking.
    expect(rule?.has).toBeUndefined();
    expect(rule?.missing).toBeUndefined();
  });

  it("matches every top-level web route and nested paths using Next's matcher", () => {
    const [rule] = rules ?? [];
    expect(rule).toBeDefined();

    // Use the path matcher Next itself uses for configured headers, rather than
    // asserting the route pattern string a second time. Discover route roots
    // from the App Router so adding a route automatically expands this check.
    const matches = getPathMatch(rule!.source);
    const appDirectory = resolve(process.cwd(), "app");
    const routes = [
      "/",
      ...readdirSync(appDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("("))
        .map((entry) => `/${entry.name}`),
    ];

    expect(routes.length).toBeGreaterThan(1);
    for (const route of routes) {
      expect(matches(route), `expected frame policy matcher to cover ${route}`).toBeTruthy();
    }
    expect(matches("/growth/campaign-123")).toBeTruthy();
    expect(matches("/_next/static/chunks/app.js")).toBeTruthy();
  });

  it("declares exactly the five security headers — framing + Report-Only", () => {
    const [rule] = rules ?? [];
    expect(rule?.headers).toHaveLength(5);

    const byKey = new Map(
      (rule?.headers ?? []).map((header) => [
        header.key.toLowerCase(),
        header.value,
      ]),
    );

    expect(byKey.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(byKey.get("x-frame-options")).toBe("DENY");
    expect(byKey.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(byKey.get("x-content-type-options")).toBe("nosniff");
    expect(typeof byKey.get("content-security-policy-report-only")).toBe(
      "string",
    );

    // Guarda de escopo: esta fatia NÃO introduz CSP bloqueante geral, nonce,
    // HSTS — cada um tem sua própria fatia/gate. `style-src 'self'` vive
    // SÓ no Report-Only (style= migrado para classes); o bloqueante
    // continua só com frame-ancestors.
    expect(byKey.has("strict-transport-security")).toBe(false);
    expect(byKey.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(
      (rule?.headers ?? [])
        .filter((header) => header.key !== "Content-Security-Policy-Report-Only")
        .some((header) =>
          /default-src|script-src|style-src|nonce|strict-dynamic/i.test(
            header.value,
          ),
        ),
    ).toBe(false);
  });

  it("uses exact casing for the header keys browsers expect", () => {
    const [rule] = rules ?? [];
    const keys = (rule?.headers ?? []).map((header) => header.key).sort();
    // HTTP é case-insensitive, mas emitimos a forma canônica para inspeção
    // humana e para o smoke contra o servidor real.
    expect(keys).toEqual([
      "Content-Security-Policy",
      "Content-Security-Policy-Report-Only",
      "Referrer-Policy",
      "X-Content-Type-Options",
      "X-Frame-Options",
    ]);
  });

  it("report-only carries the step-1 directives and a local report-uri", () => {
    const [rule] = rules ?? [];
    const byKey = new Map(
      (rule?.headers ?? []).map((header) => [
        header.key.toLowerCase(),
        header.value,
      ]),
    );
    const reportOnly =
      byKey.get("content-security-policy-report-only") ?? "";

    // Passo 1 do SCOPE-CSP-TTL (+ style-src do EXEC-STYLE-SRC): as seis
    // diretivas observadas + report local.
    expect(reportOnly).toContain("connect-src 'self'");
    expect(reportOnly).toContain("img-src 'self' data:");
    expect(reportOnly).toContain("font-src 'self'");
    expect(reportOnly).toContain("style-src 'self'");
    expect(reportOnly).toContain("object-src 'none'");
    expect(reportOnly).toContain("base-uri 'self'");
    expect(reportOnly).toContain("report-uri /api/csp-report");

    // connect-src cobre a API real (único connect do web, lib/api.ts).
    const raw =
      process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
    let apiOrigin = "http://localhost:3001";
    try {
      apiOrigin = new URL(raw).origin;
    } catch {
      // fallback acima
    }
    expect(reportOnly).toContain(apiOrigin);
  });

  it("report-only never blocks: no blocking-only directives, framing stays put", () => {
    const [rule] = rules ?? [];
    const byKey = new Map(
      (rule?.headers ?? []).map((header) => [
        header.key.toLowerCase(),
        header.value,
      ]),
    );
    const reportOnly =
      byKey.get("content-security-policy-report-only") ?? "";

    // Sem diretivas bloqueantes fora da fatia: nada de script,
    // frame-ancestors (fica no CSP bloqueante), unsafe-* ou nonce.
    // `style-src 'self'` é a exceção observada (só Report-Only, sem inline).
    expect(reportOnly).toContain("style-src 'self'");
    expect(reportOnly).not.toContain("unsafe-");
    expect(reportOnly).not.toMatch(
      /script-src|default-src|frame-ancestors|nonce/i,
    );
    // O framing bloqueante continua intacto e separado do Report-Only.
    expect(byKey.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
  });
});
