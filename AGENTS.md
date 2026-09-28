# IPTV Platform

## Projeto

Monorepo TypeScript (`pnpm` + Turborepo) para uma plataforma IPTV multi-tenant,
com API NestJS/Fastify, Next.js, PostgreSQL/Kysely e integrações atrás de ports.
O contrato canônico atual está em `docs/15-implementation-baseline/`;
consulte-o antes de alterar comportamento de domínio ou integrações.

## Desenvolvimento local

- Requisitos: Node.js 22+ e pnpm 10.
- Instalar dependências: `pnpm install`.
- PostgreSQL local: `docker compose up -d postgres`.
- Subir aplicações: `pnpm dev`.
- Checks estáticos/documentais: `python scripts/validate_docs.py`,
  `python tests/contracts/test_contracts.py` e
  `python tests/contracts/test_seed_contract.py`.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` e `pnpm build` são os checks de
  runtime e podem depender de `TEST_DATABASE_URL` descartável.
- Migrations são append-only; nunca apague ou recrie volumes/bancos para obter
  um estado conveniente.

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
- As credenciais CINEVISION e MK Ativador ainda não são lidas pelo runtime.
  O ADR-0014 de Infisical está proposto, não implantado. Até haver um gerenciador
  de segredos aprovado e integração do Browser Worker, mantenha essas credenciais
  no cofre seguro do operador; não as adicione ao `.env` deste repositório.
- Hatchet é opcional: fornece execução durável de workflows/jobs. O modo local
  em memória continua sendo o default; `HATCHET_API_TOKEN` só é necessário se
  Hatchet for adotado e certificado.
- O webhook Asaas é `POST /v1/webhooks/asaas/:tenantKey`. Só configure após haver
  URL HTTPS pública, canal/tenant ativo e compatibilidade entre o cabeçalho de
  autenticação enviado pelo Asaas e o esperado pela API.

## Referências locais de credenciais de deploy

Use estas fontes apenas quando a tarefa pedir uma operação de deploy para um
alvo explicitamente autorizado. A referência não autoriza deploy, alteração de
DNS ou mutação de produção; confirme o alvo e a autorização na tarefa atual.

- Cloudflare: `D:\projetos\cloudflare\.env`; token identificado pela variável
  `CLOUDFLARE_API_TOKEN`.
- VPS: `D:\projetos\vps-hostinger\.env`; referências de conexão incluem
  `VPS_IP`, `VPS_SSH_USER` e `VPS_SSH_KEY_PATH`. Prefira a chave SSH e o usuário
  de menor privilégio; `VPS_ROOT_PASSWORD` existe como alternativa sensível e
  só deve ser usado quando indispensável e explicitamente autorizado.
- Token DNS restrito, quando a operação exigir DNS: `CF_DNS_API_TOKEN` na mesma
  fonte VPS. Prefira-o ao token de conta mais amplo quando suficiente.
- Leia somente a variável necessária para a tarefa, mantenha o valor no processo
  local e não o imprima, copie para este projeto ou exponha em logs.

## Limites operacionais

- Sandbox não é produção. Não crie cobranças, envie mensagens ou execute ações
  externas só para testar configuração; use fixtures/testes locais ou peça
  autorização explícita para a ação externa específica.
- Operações de produção, compras, alterações de DNS e ações destrutivas precisam
  de autorização explícita para o ambiente e recurso exatos.
