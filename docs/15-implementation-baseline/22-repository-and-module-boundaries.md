# Repository Layout and Module Boundaries

## Monorepo

```text
apps/
  web/                # Next.js Control Center
  api/                # NestJS/Fastify public/internal API
  worker/             # domain/background Hatchet workers
  browser-worker/     # isolated Playwright semantic adapters

packages/
  domain/             # pure/shared domain primitives only where truly cross-context
  contracts/          # generated/shared OpenAPI/event/schema client artifacts
  database/           # Kysely database bootstrap + migration runner, no business services
  auth/               # Better Auth adapter + platform identity/session integration
  workflows/          # Hatchet runtime adapter and workflow composition
  ai-runtime/         # AgentHarnessPort, Context Builder, Tool/Skill registries, ModelGateway
  integrations/       # provider-neutral adapter interfaces + concrete non-browser adapters
  observability/      # OTel/logging/correlation helpers
  config/             # typed platform configuration definitions/resolver infrastructure
  ui/                 # owned design-system components/tokens
  testkit/            # fixtures/builders/assertions used across test suites
```

Bounded-context application code should primarily live under `apps/api/src/modules/<context>` or an equivalent explicit context package structure. Do not create dozens of tiny packages before independent version/deployment boundaries are justified.

## API module layout

Recommended per bounded context:

```text
modules/<context>/
  domain/
    entities|aggregates/
    value-objects/
    policies/
    events/
    ports/
  application/
    commands/
    queries/
    handlers/
    dto/
  infrastructure/
    repositories/
    adapters/
    persistence/
  interfaces/
    http/
    events/
  tests/
```

Direction: `domain <- application <- infrastructure/interfaces`. Domain code never imports NestJS, Fastify, Hatchet, WAHA, Asaas, Playwright, Next.js or provider SDKs.

## Context dependency rules

- contexts communicate through application contracts/events, not another context's tables;
- `billing` cannot directly mutate `subscription` tables; it emits/calls a canonical settlement command/workflow;
- `agent` never imports provider browser details;
- `web` never imports database packages;
- `browser-worker` does not own Customer/Order/Subscription state;
- analytics/read models may read canonical facts through defined projections but cannot become transaction authority.

## Browser Worker

```text
apps/browser-worker/src/adapters/
  cinevision/
    operations/
    selectors-or-semantic-locators/
    readback/
    fixtures/
  mk-ativador/
    operations/
    readback/
    fixtures/
```

Every operation is semantic (`renewSubscription`, `activateLicense`) and has precondition/postcondition/error mapping. Arbitrary browser-control tools are not exposed to the Agent.

## AI Runtime boundaries

`packages/ai-runtime` owns harness orchestration abstractions only. Domain tools are registered from bounded contexts through capability contracts; the runtime does not reimplement business rules.

## Architectural enforcement

CI should add dependency-boundary checks as the repo matures. At minimum forbid:

- frontend → database;
- domain → framework/integration packages;
- Agent runtime → provider secrets/browser selectors;
- cross-context infrastructure repository imports.
