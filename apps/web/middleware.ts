import { NextResponse, type NextRequest } from "next/server";

// Passo 2 do SCOPE-CSP-TTL: nonce por request em modo Report-Only.
//
// Gera um nonce único por request, propaga via `x-nonce` (request headers,
// lido pelo `RootLayout` via `next/headers`) e emite `script-src` com
// `'nonce-<valor>' 'strict-dynamic'` SOMENTE em
// `Content-Security-Policy-Report-Only` — nada bloqueante.
//
// Fora desta fatia de propósito (migração futura):
// - sem `unsafe-eval` / `unsafe-inline` (`style-src 'self'` já observa
//   estilos externos; inline segue fora até decisão de nonce/hash);
// - sem hash de script (muda a cada build);
// - sem CSP bloqueante (`Content-Security-Policy` continua só com
//   `frame-ancestors 'none'` vindo do `next.config.mjs`).

/** Request header que carrega o nonce até os Server Components. */
export const NONCE_HEADER = "x-nonce";

/** Nome do header Report-Only emitido por este middleware. */
export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";

function apiOriginForCsp(): string {
  const raw =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
  try {
    return new URL(raw).origin;
  } catch {
    return "http://localhost:3001";
  }
}

/**
 * Nonce base64 de 128 bits via Web Crypto (disponível no Edge runtime e
 * no Node 19+). Sem `Buffer` de propósito: `Buffer` não é garantido no
 * Edge runtime do middleware.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Política Report-Only completa do passo 2: diretivas observadas do
 * passo 1 (inclui `style-src 'self'` — style= migrado para classes em
 * EXEC-STYLE-SRC) + `script-src` com nonce por-request e `strict-dynamic`
 * (fallback `'self'` para browsers sem suporte a nonce). Nunca inclui
 * `unsafe-*` ou diretiva de framing (framing bloqueante
 * continua no `Content-Security-Policy` estático do `next.config.mjs`).
 */
export function buildCspReportOnly(nonce: string): string {
  const apiOrigin = apiOriginForCsp();
  return [
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `connect-src 'self' ${apiOrigin}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "style-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "report-uri /api/csp-report",
  ].join("; ");
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = generateNonce();

  // Propaga o nonce para os Server Components (layout lê via headers()).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // Só Report-Only: o browser observa violações de script sem bloquear.
  response.headers.set(CSP_REPORT_ONLY_HEADER, buildCspReportOnly(nonce));
  return response;
}

// Roda em páginas e APIs, pulando só assets internos do Next.
// Rotas de API passam pelo middleware sem efeito colateral: só recebem
// os headers de observação acima (nenhum bloqueio, nenhum rewrite).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
