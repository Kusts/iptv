# @iptv/web — Control Center (Next.js App Router)

Shell autenticado do tenant + superfícies operacionais consumindo **somente HTTP** da API (`/v1`).
Fronteira dura: este app **nunca** importa `packages/database` nem qualquer módulo servidor.

## Rodar

```sh
pnpm install
pnpm --filter web dev      # http://localhost:3000
```

Variáveis:

| Var | Default | Descrição |
| --- | ------- | --------- |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:3001` | Base da API `/v1` |

Comandos: `pnpm --filter web test|typecheck|lint|build`.

## Auth / token (tradeoff documentado)

- `POST /v1/auth/login → { token, activeTenantId, user }`; sessão via `GET /v1/auth/session`;
  tenants via `GET /v1/tenants`; troca via `POST /v1/tenants/:id/switch`; saída via `POST /v1/auth/logout`.
- O token opaco fica em `localStorage` (chave `iptv.session_token`) e sai no header
  `Authorization: Bearer` em **um único wrapper** (`lib/api.ts`).
- **Tradeoff MVP**: `localStorage` é simples e sobrevive a reloads, mas é legível por qualquer
  JS da página — **caveat XSS**: um script injetado rouba a sessão. Mitigações futuras:
  cookie `HttpOnly + SameSite` (a API já aceita cookie `iptv_session`) e CSP estrita.
- 401 → limpa o token e redireciona para `/login` (com `onUnauthorized` injetável em testes).

## Desvios deliberados do stack canônico (com upgrade path)

- **Sem Tailwind/shadcn**: design system próprio e leve em `components/ui/` + `tokens.css`
  (custom properties semânticas). Upgrade: migrar os tokens para o tema do Tailwind sem
  mudar os nomes semânticos.
- **Sem TanStack Query**: `lib/useApi.ts` com cache simples em memória por path.
  Upgrade: trocar `useApi` pelo Query mantendo a mesma assinatura `{ data, error, loading, reload }`.
- **Sem RHF/Zod no cliente**: formulários com estado local + validação mínima (a API valida
  de verdade — o cliente nunca decide regra de negócio).

## Regras do cliente

- Nenhuma política de negócio no frontend: todas as mutações passam pelos mesmos comandos
  da API (assumir/devolver/responder, resolver ticket, aprovar/rejeitar revisão).
- Dinheiro sempre em minor units (string) → pt-BR via manipulação de string (`lib/money.ts`).
  Nunca `float`.
- Toda superfície tem skeleton, empty state e error state com retry — sem falha silenciosa.
- Textos em pt-BR.
