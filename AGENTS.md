# IPTV Platform

## Projeto

Monorepo TypeScript (`pnpm` + Turborepo) para uma plataforma IPTV multi-tenant,
com API NestJS/Fastify, Next.js, PostgreSQL/Kysely e integrações atrás de ports.
O contrato canônico atual está em `docs/15-implementation-baseline/`;
consulte-o antes de alterar comportamento de domínio ou integrações.
O registro autoritativo de entrega é o `CHANGELOG.md` (anexe toda entrega em
`## Unreleased`).

## Desenvolvimento local

- Requisitos: Node.js 22+ e pnpm 10.15.0; Python 3 + PyYAML para os gates de
  docs/contratos.
- Instalar dependências: `pnpm install`.
- PostgreSQL local: `docker compose up -d postgres`.
- Subir aplicações: `pnpm dev` (web em :3000, API em :3001).
- Para workers de vencimento (outbox/webhook/renewal drains) em dev:
  `API_SCHEDULER_ENABLED=1` no `.env`.
- Seed de dados piloto: após aplicar TODAS as migrations, seguir
  `db/seeds/README.md`.
- Checks, na ordem da CI (`.github/workflows/ci.yml`): `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, `pnpm build` e os gates Python
  (`python scripts/validate_docs.py`,
  `python tests/contracts/test_contracts.py`,
  `python tests/contracts/test_seed_contract.py`).
- `TEST_DATABASE_URL` deve apontar para um banco PostgreSQL **descartável e
  VAZIO**: os testes de integração aplicam todas as migrations eles mesmos via
  `applyMigrations` no `beforeAll`. Turbo NÃO carrega o `.env` — exporte a
  variável no shell antes de `pnpm test`.
- Runs com escopo: `pnpm --filter @iptv/<pkg> <script>` — o nome sempre tem o
  scope `@iptv/` (ex.: `@iptv/api`, `@iptv/web`, `@iptv/browser-worker`).
- No Windows, `scripts/*.sh` exigem bash + psql (Git Bash/WSL).
- Migrations são append-only; nunca apague ou recrie volumes/bancos para obter
  um estado conveniente. Alterar `POSTGRES_*` no `.env` não reconfigura um
  volume já inicializado.

## Convenções de commit

- Conventional Commits: `<type>: <descrição lowercase, sem ponto final>`
  com os IDs de tarefa entre parênteses quando aplicável —
  `feat: tenant copilot widget, workspace and approved command execution (W14-COPILOT, G18)`.
- Types em uso: `feat`, `fix`, `docs`, `chore`, `test`.
- Scope opcional, quando localizar o pacote ajuda: `fix(api):`,
  `fix(browser-worker):`.

## Armadilhas conhecidas

- Valor de env opcional vazio (`KEY=`) é tratado como AUSENTE pelo loader
  (`packages/config`); prefira omitir a linha a deixá-la vazia.
- `noUncheckedIndexedAccess` está estrito: indexação de array/registro exige
  narrowing explícito.
- Fixtures com `newId().slice(0,8)` colidem: a cabeça do UUIDv7 é timestamp.
  Use contadores/refs determinísticas.
- O scheduler em dev pode convergir em múltiplos ticks; flaky tests de outbox
  costumam ser causa de convergência, não timing arbitrário.
- Chaves de API do Asaas começam com `$` (ex.: Sandbox `$aact_...`): no
  `.env`, envolver o valor em aspas simples, senão a interpolação do
  docker compose corrói o valor e emite warnings.
- `scripts/validate_doc_reviews.py` é não-gate e vermelho de propósito
  (marcadores históricos v0.14); não o "conserte" nem adicione claims de
  review para ficá-lo verde.
- Mudanças em `docs/`, contratos (`docs/05-contracts/`) ou `db/migrations/`
  exigem os 3 gates Python verdes; o bloco de registry de eventos existe em
  duas cópias que precisam permanecer idênticas
  (`docs/02-domain/event-model.md` e
  `docs/15-implementation-baseline/04-event-catalog.md`).

## Documentação viva

- `CHANGELOG.md` — anexe toda entrega em `## Unreleased`.
- `docs/15-implementation-baseline/` — contrato canônico de implementação.
- `docs/02-domain/event-model.md` — registry canônico de eventos; novos
  eventos precisam de entrada no registry + canal AsyncAPI + SPEC.
- `README.md` — descreve o repositório como está hoje; status cronológico
  mora no CHANGELOG, não no README.

## Orquestração OpenCode

- Use obrigatoriamente a orquestração V3 do OpenCode e faça o preflight em todo
  pedido antes de executar o trabalho.
- Trabalho não trivial exige pelo menos um subagent útil, com escopo delimitado;
  integre suas evidências antes de concluir.
- Só execute diretamente tarefas triviais/localizadas quando o preflight permitir
  `TRIVIAL_DIRECT`; não crie fan-out ritual para essas tarefas.

## Segredos e integrações

- `.env` é local e ignorado pelo Git; `.env.example` contém apenas defaults e
  placeholders. Nunca copie valores secretos para código, documentação, logs,
  prompts ou respostas.
- O `.env` raiz é carregado pelo processo da API. Não coloque nele credenciais
  administrativas de VPS/Cloudflare nem credenciais do Browser Worker.
- Localmente, WAHA, Asaas Sandbox e OpenCode Go são configurados pelo `.env`.
  `OPENAI_API_KEY` recebe a chave do OpenCode Go; `OPENAI_BASE_URL` e
  `AGENT_MODEL` selecionam endpoint/modelo. Não troque Sandbox por produção sem
  autorização explícita.
- Infisical está implementado (ADR-0014 aceito): `packages/secrets` resolve
  refs `infisical://` em runtime (API via `INFISICAL_*`, Browser Worker via
  `BROWSER_INFISICAL_*`; ver `packages/secrets/README.md`). Credenciais
  CINEVISION/MK Ativador vivem como referências de segredo no Infisical —
  mantenha os valores crus no cofre do operador e fora do `.env` deste
  repositório.
- Hatchet é opcional: fornece execução durável de workflows/jobs. O modo local
  em memória continua sendo o default; `HATCHET_API_TOKEN` só é necessário se
  Hatchet for adotado e certificado.
- O webhook Asaas é `POST /v1/webhooks/asaas/:tenantKey`; autenticação por
  canal (`billing.tenant_channels`), sem fallback global — detalhes em
  `apps/api/README.md`. Só configure com URL HTTPS pública, canal/tenant
  ativo e compatibilidade de cabeçalho com a API.

## Referências locais de credenciais de deploy

Use estas fontes apenas quando a tarefa pedir uma operação de deploy para um
alvo explicitamente autorizado. A referência não autoriza deploy, alteração de
DNS ou mutação de produção; confirme o alvo e a autorização na tarefa atual.

- Cloudflare: `D:\projetos\cloudflare\.env`; token identificado pela variável
  `CLOUDFLARE_API_TOKEN`.
- Não existe fonte genérica de conexão VPS autorizada para IPTV. `VPS_*` da
  Hostinger está desativado/proibido (ver `## Staging Contabo`); sem fallback
  por senha de root. Credenciais Contabo de env de outro projeto não são fonte
  de IPTV, exceto acesso pontual autorizado pelo usuário após verificação de
  identidade/marcador de caminho (rege a seção Staging Contabo).
- Token DNS restrito, somente para tarefa DNS explícita: `CF_DNS_API_TOKEN`
  (referência local, separada — não é fonte VPS). Prefira-o ao token de conta
  mais amplo quando suficiente.
- Leia somente a variável necessária para a tarefa, mantenha o valor no processo
  local e não o imprima, copie para este projeto ou exponha em logs.

## Staging Contabo (único provedor ativo)

- Hostinger VPS desativada (confirmado pelo usuário em 2026-11-02): Contabo é
  o único provedor em uso para o staging IPTV.
- Alvo canônico verificado em sessão SSH Contabo: `/home/deploy/iptv-staging`
  (marcador atualizado para `main@76515c3` após smoke em 2026-11-03);
  `/home/deploy/iptv` não existe nesse host.
- O ponteiro local `VPS_*` refere-se à Hostinger desativada: obsoleto e
  proibido para IPTV.
- `CONTABO_VPS_*` pertence a outra configuração: usar somente para acesso
  pontual explicitamente autorizado pelo usuário nesta tarefa, após checagem
  de identidade — nunca como ponteiro durável de IPTV.
- Nunca tocar serviços vizinhos (ai-memory, Infisical prod, traefik,
  `synkroo-prod-*`).
- Deploy executado em 2026-11-03: volume de teste resetado com autorização
  explícita do usuário, fresh 67/67, stack API/web/outbox/túnel saudável com
  smoke (health/ready e web 200, registro público 403, login do owner 200).
- HOLD restante é integrações/segurança/entrega (Asaas, Infisical, CINEVISION)
  — não mais drift de migrations (ver runbook de staging e
  `docs/16-pilot-closure/MVP-OPERATIONAL-CLOSURE.md`).

## Limites operacionais

- Sandbox não é produção. Não crie cobranças, envie mensagens ou execute ações
  externas só para testar configuração; use fixtures/testes locais ou peça
  autorização explícita para a ação externa específica.
- Operações de produção, compras, alterações de DNS e ações destrutivas precisam
  de autorização explícita para o ambiente e recurso exatos.
