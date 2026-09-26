# Technology Review — 2026-09-20

> Status: Research snapshot  
> Autoridade: informativo. Não substitui Technology Decision Matrix nem ADRs.

## Objetivo

Registrar evidências externas que informaram a matriz técnica da documentação v0.5. Recursos de software mudam; portanto este arquivo é um snapshot datado e deve ser revalidado antes de decisões tardias de implementação.

## Durable workflows

### Inngest

Documentação consultada:

- https://www.inngest.com/docs/learn/how-functions-are-executed
- https://www.inngest.com/docs/learn/inngest-steps
- https://www.inngest.com/docs/self-hosting

Achados relevantes:

- steps são checkpointed/retriable;
- resultados de steps concluídos são persistidos e reutilizados;
- suporta waits/events/schedules;
- self-hosting oficial existe na linha 1.0;
- self-host de produção pode usar PostgreSQL + Redis;
- SDK/execução encaixa bem em TypeScript.

### Temporal

Documentação:

- https://docs.temporal.io/

Achados:

- durable/crash-proof execution é o propósito central;
- workflows retomam após crash/outage;
- suporta self-host ou cloud;
- maior robustez, porém maior complexidade operacional para um tenant piloto/time pequeno.

### Trigger.dev

Documentação/blog:

- https://trigger.dev/
- https://trigger.dev/blog/self-hosting-trigger-dev-v4-docker
- https://trigger.dev/launchweek/2/trigger-v4-ga

Achados:

- ótimo DX para long-running tasks, retries, waits e callbacks;
- cloud possui durable/checkpointing forte;
- self-hosting v4 é suportado, mas a documentação de self-host revisada indica diferenças atuais, incluindo ausência de checkpoints no modo self-host descrito;
- por isso não foi colocado como primeira recomendação self-host para nossos long waits críticos.

### n8n

Uso recomendado permanece integration automation/bordas. O sistema próprio continua autoridade de estado.

## Database

### PostgreSQL

Mantido como decisão arquitetural, independentemente do provider.

### Neon

Docs:

- https://neon.com/docs/get-started-with-neon/workflow-primer
- https://neon.com/docs/connect/connection-pooling

Achados:

- branching isolado e rápido;
- scale-to-zero/autoscaling;
- pooling via PgBouncer;
- interessante para velocidade de desenvolvimento e ambientes de branch.

### Supabase

Docs:

- https://supabase.com/docs/guides/database/overview
- https://supabase.com/docs/guides/auth
- https://supabase.com/docs/guides/self-hosting

Achados:

- Postgres real como base;
- Auth/RLS/Storage úteis se escolhidos conscientemente;
- self-hosting é suportado, mas transfere ao operador responsabilidades de manutenção, segurança, backups, HA e DR;
- não usar o stack completo apenas porque já existe.

## API stack

### Next.js

Docs:

- https://nextjs.org/docs
- https://nextjs.org/docs/app/guides/backend-for-frontend

Achados:

- App Router é adequado ao Control Center;
- Route Handlers servem como BFF, mas não devem ser nossa única camada para workflows/processos longos.

### NestJS + Fastify

Docs:

- https://docs.nestjs.com/techniques/performance
- https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/

Achados:

- Nest suporta Fastify adapter;
- Fastify oferece schema-based validation/serialization;
- combinação favorece estrutura de Modular Monolith + contratos claros.

## Data access

### Kysely

Docs:

- https://kysely.dev/

Achados:

- type-safe SQL query builder;
- baixo nível de abstração/magic;
- bom fit para queries financeiras/CTEs/ledgers;
- MIT e runtime pequeno.

### Drizzle / Prisma

Também avaliados. Ambos são candidatos viáveis, porém para este projeto a preferência atual é SQL-first explícito devido à quantidade de ledger/reporting/reconciliation.

## Browser

### Playwright

Docs:

- https://playwright.dev/docs/api/class-browsercontext
- https://playwright.dev/docs/api/class-browsertype
- https://playwright.dev/docs/trace-viewer

Achados:

- BrowserContext permite isolamento de sessões;
- tracing captura actions, screenshots, DOM snapshots, console/rede;
- `connectOverCDP` existe para Chromium, mas a documentação alerta que tem fidelidade inferior ao protocolo Playwright;
- base adequada ao Browser Worker com postcondition verification.

## Secrets

### Infisical

Docs:

- https://infisical.com/platform/secrets-management
- https://infisical.com/docs/

Achados:

- open source/self-hostable;
- centralized secrets;
- RBAC/audit;
- machine identities e rotations;
- adequado para `secret_ref` no banco sem secret value no Domain Core.

## AI observability/evals

### Langfuse

Docs:

- https://langfuse.com/docs/evaluation/experiments/datasets
- https://langfuse.com/docs/evaluation/get-started/offline

Achados:

- datasets e experiment runs;
- produção pode alimentar casos futuros de avaliação;
- OpenTelemetry-based tracing nas SDKs atuais;
- encaixa na estratégia Production Failure → Eval Case.

## Decisões que esta pesquisa NÃO toma

Este arquivo não decide:

- Neon versus self-hosted Postgres;
- Auth provider;
- Inngest definitivamente;
- cloud provider;
- deployment topology final.

Essas escolhas permanecem em Technology Matrix/ADRs e exigem spike quando marcado.
