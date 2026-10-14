/** @type {import('next').NextConfig} */
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
  // framing + Referrer-Policy + X-Content-Type-Options. NÃO é uma CSP geral
  // (sem default-src/script-src/nonce) — CSP ampla exigiria inventariar os
  // recursos inline do App Router e poderia quebrar a UI; fica como
  // follow-up. Rate limiting, security headers da API e exposição pública
  // seguem pendentes, registrados em docs/16-pilot-closure/P6-SECURITY.md §8.
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
        ],
      },
    ];
  },
};

export default nextConfig;
