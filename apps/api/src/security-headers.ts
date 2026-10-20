import type { NestFastifyApplication } from "@nestjs/platform-fastify";

/**
 * API-only security headers (SEC44 slice, api-only — não é helmet geral).
 *
 * Escopo deliberado desta fatia: apenas os 3 headers faltantes na API.
 * SEM `Content-Security-Policy` geral/nonce (que exigiria inventariar os
 * recursos inline e tem fatia própria), SEM helmet amplo, SEM rate-limit
 * novo, SEM mudança de CORS/auth/sessão.
 *
 * Valores alinhados com a frame policy web (`apps/web/next.config.mjs`)
 * onde o header existe lá (`nosniff`, `strict-origin-when-cross-origin`).
 * `Strict-Transport-Security` segue o piso comum de 1 ano com
 * `includeSubDomains`, sem `preload` (promoção a preload list é decisão
 * operacional separada).
 */

/** Valor exato de `Strict-Transport-Security` emitido pela API. */
export const API_HSTS_VALUE = "max-age=31536000; includeSubDomains";

/** Valor exato de `X-Content-Type-Options` emitido pela API. */
export const API_NOSNIFF_VALUE = "nosniff";

/** Valor exato de `Referrer-Policy` emitido pela API. */
export const API_REFERRER_POLICY_VALUE = "strict-origin-when-cross-origin";

/** Registra os 3 headers em TODAS as respostas da API via `onRequest`. */
export function registerApiSecurityHeaders(app: NestFastifyApplication): void {
  const instance = app.getHttpAdapter().getInstance();
  instance.addHook("onRequest", (req, reply, done) => {
    reply.header("strict-transport-security", API_HSTS_VALUE);
    reply.header("x-content-type-options", API_NOSNIFF_VALUE);
    reply.header("referrer-policy", API_REFERRER_POLICY_VALUE);
    done();
  });
}
