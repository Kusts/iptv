# AI Revenue & Operations Platform

Multi-tenant IPTV SaaS: sales, fulfillment, billing, renewal and support
operations automated around a human-in-the-loop agent runtime.

> **Status: in active development.** Implementation baseline v1.0.1 is the
> canonical contract; Waves 1–16 plus W0 CINEVISION runtime hardening
> (Fases 0–5, migration 046) are implemented and covered by the test suite.
> `CHANGELOG.md` is the authoritative delivery record — this README describes
> the repository as it is today, not a wave-by-wave history.

## What this is

- TypeScript monorepo (`pnpm` + Turborepo): a **modular monolith** API, a
  Next.js tenant console, and an isolated browser worker for private provider
  operations — all behind explicit ports/adapters.
- **PostgreSQL is the source of truth** (Kysely, append-only SQL migrations,
  double-entry ledgers, RLS tenant isolation with a dedicated app role).
- Domain communication flows through tenant-scoped **commands** that commit
  state + domain event + outbox + audit in ONE transaction; events follow a
  canonical registry (`docs/02-domain/event-model.md`) mirrored into
  OpenAPI/AsyncAPI contracts enforced by CI gates.
- Safety posture: echo/manual adapters by default, capability gates with
  downgrade-only autonomy, human review for refunds and sensitive operations,
  Asaas Sandbox only unless explicitly authorized.

## Stack

pnpm 10.15.0 · Turborepo · Node 22+ · TypeScript 5.9 · NestJS + Fastify ·
Next.js (App Router) · Kysely · PostgreSQL 17 · Zod · Vitest · Playwright
(browser worker) · OTel (optional, noop default) · Hatchet (optional, local
in-memory default) · Infisical (secrets, ADR-0014) · Python 3 + PyYAML (doc
gates).

## Repository layout

```
apps/
  api/             NestJS + Fastify API (/v1, port 3001)
  web/             Next.js tenant console (port 3000)
  browser-worker/  isolated Playwright CLI worker (read-only provider ops)
packages/
  domain/          pure primitives: UUIDv7 ids, exact minor-unit money, UTC time, event envelope
  database/        Kysely bootstrap + migration runner (advisory lock + history table)
  config/          Zod-validated env (all keys optional with defaults; empty value = absent)
  auth/            auth/session primitives (custom adapter; BETTER_AUTH_* env)
  secrets/         Infisical secrets port (universal auth; infisical:// refs)
  ai-runtime/      OpenAI-compatible model gateway + deterministic echo fallback
  observability/   OTel tracing/metrics (noop by default)
  workflows/       Hatchet durable workflows adapter (optional)
db/                migrations (append-only, apply all in filename order), seeds, SQL integration tests
deploy/            Infisical self-host stack, PgBouncer (opt-in compose profile)
docs/              canonical documentation (authority map below)
scripts/           validation and test scripts
tests/contracts/   contract gates (Python)
```

Each app and package has its own `README.md` with specifics.

## Quick start

Prerequisites: Node.js 22+, pnpm 10.15.0, Docker. For the doc/contract gates:
Python 3 with PyYAML. `scripts/*.sh` additionally need bash + psql (Git
Bash/WSL on Windows).

1. `pnpm install`
2. Copy `.env.example` to `.env` and adjust locally (never commit secrets).
   The API loads it via `node --env-file-if-exists` (repo root or
   `apps/api/.env`). Do this BEFORE starting Postgres: compose reads
   `POSTGRES_*` from `.env` on first init, and an already-initialized volume
   is not reconfigured by later edits. Caution: values starting with `$`
   (e.g. Asaas Sandbox API keys) must be single-quoted in `.env`, or docker
   compose interpolation mangles them.
3. `docker compose up -d postgres` (local-dev defaults `iptv`/`iptv`; keep
   `DATABASE_URL` in sync with any `POSTGRES_*` override)
4. Provision the schema — the API does NOT apply migrations at boot. Apply
   all migrations in filename order, e.g. with psql:
   `for f in db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done`
   (`packages/database` also exposes the programmatic runner
   `applyMigrations`; the test suite always applies migrations itself on a
   disposable database). Then optionally seed pilot data
   (`db/seeds/README.md`).
5. `pnpm dev` — web on <http://localhost:3000>, API on
   <http://localhost:3001>. Set `API_SCHEDULER_ENABLED=1` in `.env` when you
   need due-workers (webhook/outbox/subscription/renewal drains) in dev.

## Checks (CI order)

| Check | Command | Requires |
|---|---|---|
| Lint | `pnpm lint` | — |
| Typecheck | `pnpm typecheck` | — |
| Tests | `pnpm test` | `TEST_DATABASE_URL` pointing to a **disposable, EMPTY** database (integration tests apply all migrations themselves via `applyMigrations`; turbo does **not** load `.env` — export the variable in the shell) |
| Build | `pnpm build` | — |
| Docs gate | `python scripts/validate_docs.py` | PyYAML |
| Contract gates | `python tests/contracts/test_contracts.py` · `python tests/contracts/test_seed_contract.py` | PyYAML |

`scripts/validate_doc_reviews.py` checks historical v0.14 review markers on a
fixed file list; it is **not** a gate and is expected to stay red — do not
"fix" it by adding review claims.

Scoped runs: `pnpm --filter @iptv/api test`, `pnpm --filter @iptv/web lint`,
etc. (always with the `@iptv/` scope).

RLS note: local development runs with the owner `DATABASE_URL`. The
restricted app role connects via `APP_DATABASE_URL` only after the cutover
checklist (`docs/10-operations/runbooks/rls-role-split-cutover.md`).

## Documentation

Authority hierarchy: Vision/Principles → v1.0 Implementation Baseline →
Domain → Architecture/Accepted ADRs → SPECs → Contracts → Roadmap/Tasks →
Code/Tests/Evals → Runbooks/User Docs. The v1.0.1 baseline supersedes
conflicting pre-v1.0 planning text.

Start here:

1. [`docs/15-implementation-baseline/README.md`](docs/15-implementation-baseline/README.md) — final authority map.
2. [`docs/15-implementation-baseline/18-implementation-plan.md`](docs/15-implementation-baseline/18-implementation-plan.md) — execution order.
3. [`docs/15-implementation-baseline/15-definition-of-done.md`](docs/15-implementation-baseline/15-definition-of-done.md) — completion criteria.
4. [`docs/00-meta/development-agent-handbook.md`](docs/00-meta/development-agent-handbook.md) — development-agent behavior.
5. [`docs/00-meta/agent-documentation-loading-order.md`](docs/00-meta/agent-documentation-loading-order.md) — what an agent reads, in order.
6. [`docs/06-decisions/README.md`](docs/06-decisions/README.md) — ADR index.

Areas under `docs/`: `00-vision`, `01-product`, `02-domain` (canonical event
registry), `03-architecture`, `04-specs` (25 capability SPECs +
`integrations/`), `05-contracts` (OpenAPI/AsyncAPI), `06-decisions` (ADRs),
`07-agent`, `08-data-analytics`, `09-security-compliance`, `10-operations`
(runbooks), `11-research` (non-authoritative), `12-roadmap`, `13-product-design`,
`14-user-docs`, `15-implementation-baseline` (canonical implementation
contract), `00-meta` (doc governance), `spikes`.

Agents: read [`AGENTS.md`](AGENTS.md) before working in this repository.

## Key decisions

- multi-tenant modular monolith, ports/adapters, PostgreSQL source of truth;
- Next.js + NestJS/Fastify + Kysely;
- WAHA messaging gateway (GOWS preferred, certification-gated);
- CINEVISION and MK private operations through authenticated isolated
  Playwright workers;
- Asaas official Sandbox → production canary;
- provider credentials resolved at runtime via `infisical://` secret
  references (ADR-0014) — never raw values in `.env`;
- Hatchet durable workflows subject to certification, local in-memory mode by
  default;
- OpenAI Agents SDK TypeScript as harness inside an owned Agent Runtime;
- hierarchical reseller network: ancestor visibility, direct-child management
  only; resellers may become SaaS tenants and later SaaS resellers;
- automation-first operation with capability-scoped safety/degradation and
  human exception handling.

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md) — one entry per delivered work package,
newest under `## Unreleased`.
