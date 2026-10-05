# @iptv/web — Control Center (Next.js App Router)

Shell autenticado do tenant + superfícies operacionais consumindo **somente HTTP** da API (`/v1`).
Fronteira dura: este app **nunca** importa `packages/database` nem qualquer módulo servidor.

## Rodar

```sh
pnpm install
pnpm --filter @iptv/web dev      # http://localhost:3000
```

Variáveis:

| Var | Default | Descrição |
| --- | ------- | --------- |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:3001` | Base da API `/v1` |

CORS local: o navegador só enxerga as respostas da API quando a origem da web
(`http://localhost:3000` por padrão) está na allowlist `CORS_ALLOWED_ORIGINS`
da API. São dois ajustes distintos: `NEXT_PUBLIC_API_BASE_URL` diz **para onde**
a web chama, e `CORS_ALLOWED_ORIGINS` (lado servidor da API) diz **quais origens**
o navegador pode ler. Em produção, configure na API a(s) origem(ns) pública(s)
explícita(s) da web (separadas por vírgula, sem wildcard); sem isso, o
cross-origin é negado. CORS não substitui autenticação Bearer/sessão nem as
guards de tenant/revisão.

Comandos: `pnpm --filter @iptv/web test|typecheck|lint|build`.

## Rotas (App Router em `app/`)

Uma página por diretório; a navegação do `components/Shell.tsx` usa exatamente
esta lista.

| Rota | Tela | Superfície da API |
| --- | ---- | ----------------- |
| `/login` | Login (fora do shell autenticado) | `POST /v1/auth/login` |
| `/` | Painel + "Needs attention" | `GET /v1/health`, `GET /v1/human-reviews/center` |
| `/conversations` | Conversas | `GET /v1/communications/conversations`, mensagens + `assign`/`release`/`send-manual` |
| `/subscriptions` | Assinaturas | `GET /v1/subscriptions[/:id]`, `resume`, `cancel-at-period-end` |
| `/orders` | Pedidos | `GET /v1/orders`, `GET /v1/orders/:id` |
| `/support` | Suporte (tickets) | `GET /v1/tickets`, `/v1/tickets/my-work`, `/v1/tickets/:id`, `resolve` |
| `/conhecimento` | Conhecimento (filas de itens) | `GET /v1/knowledge/items`, `/corrections`, `/gaps`, `freshness/refresh`, `verify`/`apply`/`reject`/`close` |
| `/hitl` | Centro HITL | `GET /v1/human-reviews/center[?source=]`, `POST /v1/human-reviews/:id/claim` + decisão |
| `/provider-operations` | Operações de Provider (fila + detalhe sanitizado, reconciliação e resolução) | `GET /v1/provider/operations[?status=&limit=&offset=]`, `GET /v1/provider/operations/:id`, `POST .../reconcile`, `POST .../resolve` |
| `/copilot` | Copilot | `POST /v1/agent/copilot/ask`, `/execute`, contexto via `lib/api.ts` |

`app/layout.tsx` monta `AuthProvider` + `ToastProvider`; `app/lib.ts` e
`app/page.tsx` são a raiz do App Router.

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
