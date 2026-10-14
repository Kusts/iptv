import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "../next.config.mjs";

// Regressão da subfatia de baixo risco do issue #44: impedir
// framing/clickjacking em TODAS as respostas web.
//
// Este teste chama o `headers()` real da config (não uma cópia) e trava o
// contrato: matcher global + exatamente os quatro headers de segurança
// (framing + referrer-policy + nosniff).
// Escopo fora daqui (não travado aqui de propósito): CSP geral, rate limiting,
// headers de segurança da API, exposição pública — ver
// docs/16-pilot-closure/P6-SECURITY.md §8.

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

  it("declares exactly the four security headers — no CSP geral", () => {
    const [rule] = rules ?? [];
    expect(rule?.headers).toHaveLength(4);

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

    // Guarda de escopo: esta fatia NÃO introduz CSP geral, nonce, HSTS —
    // cada um tem sua própria fatia/gate.
    expect(byKey.has("strict-transport-security")).toBe(false);
    expect(
      (rule?.headers ?? []).some((header) =>
        /default-src|script-src|nonce|strict-dynamic/i.test(header.value),
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
      "Referrer-Policy",
      "X-Content-Type-Options",
      "X-Frame-Options",
    ]);
  });
});
