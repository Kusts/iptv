/** @type {import('next').NextConfig} */

// Passo 1 do SCOPE-CSP-TTL (Report-Only, sem bloqueio): observa
// connect/img/font/object/base sem tocar em style-src/script-src
// (style= pervasivo). O `script-src` com nonce por-request vive no passo 2
// (`middleware.ts`, também Report-Only) — este valor estático segue como
// base observada; o middleware acrescenta a política dinâmica com nonce.
// O report vai para o endpoint local `/api/csp-report` (204, só loga).
function apiOriginForCsp() {
  const raw =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
  try {
    return new URL(raw).origin;
  } catch {
    return "http://localhost:3001";
  }
}

const apiOrigin = apiOriginForCsp();

// Report-Only: nunca bloqueia nada — só reporta. Sem style-src/script-src
// (fora desta fatia), sem 'unsafe-*', sem nonce. O `script-src` com nonce
// + `strict-dynamic` é emitido por-request pelo `middleware.ts` (passo 2,
// também Report-Only) — este valor estático não duplica o nonce.
const cspReportOnlyValue = [
  `connect-src 'self' ${apiOrigin}`,
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "report-uri /api/csp-report",
].join("; ");

const nextConfig = {
  // Container image boundary: `standalone` emits a self-contained server
  // bundle under `.next/standalone` (server.js + only the traced node_modules),
  // which is what `apps/web/Dockerfile` copies into its runtime stage.
  // `next build` / `next dev` / `pnpm --filter @iptv/web test` are unchanged.
  output: "standalone",
  // Anti-framing / anti-clickjacking for every web response (issue #44, subfatia
  // de baixo risco). `source: '/:path*'` é o catch-all global do Next.js: cobre
  // todas as rotas (raiz, rotas dinâmicas, route groups) e os assets servidos
  // pelo próprio servidor. `headers` é incondicional (sem `has`/`missing`).
  //
  // Escopo desta fatia (Golden Workflow 3, ETAPA 2): os dois headers de
  // framing + Referrer-Policy + X-Content-Type-Options, mais a CSP
  // Report-Only base do passo 1 do SCOPE-CSP-TTL (observa sem bloquear;
  // o passo 2 em `middleware.ts` acrescenta por-request o `script-src`
  // com nonce + `strict-dynamic`, também Report-Only).
  // NÃO é uma CSP geral bloqueante (sem default-src/script-src/style-src/
  // nonce) — CSP ampla exigiria inventariar os recursos inline do App
  // Router e poderia quebrar a UI; fica como follow-up. Rate limiting,
  // security headers da API e exposição pública seguem pendentes,
  // registrados em docs/16-pilot-closure/P6-SECURITY.md §8.
  //
  // Contrato coberto pelo teste de regressão `test/frame-policy.test.ts`
  // (chama `headers()` e verifica matcher + valores).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            // Só a diretiva de framing: quem pode nos emoldurar. Sem
            // 'unsafe-inline'/'unsafe-eval' porque não há outro recurso aqui.
            value: "frame-ancestors 'none'",
          },
          {
            // Legado para navegadores sem suporte a `frame-ancestors`.
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            // Limita o Referer enviado em navegações cross-origin.
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            // Impede MIME-sniffing: o browser respeita o Content-Type declarado.
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            // Passo 1 do SCOPE-CSP-TTL: CSP em modo Report-Only — o browser
            // NÃO bloqueia nada, só envia violações para report-uri local.
            // Framing bloqueante continua só no `Content-Security-Policy`
            // acima (frame-ancestors 'none').
            key: "Content-Security-Policy-Report-Only",
            value: cspReportOnlyValue,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
