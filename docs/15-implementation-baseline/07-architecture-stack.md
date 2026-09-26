# Final Architecture and Stack

## Architecture style

- **Modular Monolith first**, with explicit bounded-context ownership.
- Ports & Adapters / hexagonal boundaries for external systems.
- Event-driven workflows with Outbox/Inbox and idempotent consumers.
- Specialized workers for browser automation and background work.
- No microservices, Kafka or Kubernetes in the MVP without evidence that they solve a measured problem.

## Stack

| Layer | Decision |
|---|---|
| Language | TypeScript |
| Monorepo | pnpm + Turborepo |
| Web | Next.js App Router + React |
| UI | Tailwind + shadcn primitives + owned Design System |
| Server state | TanStack Query |
| Data tables | TanStack Table + Virtual |
| Forms/schema | React Hook Form + Zod |
| Charts | Apache ECharts |
| Backend | NestJS + Fastify adapter |
| API | REST + OpenAPI |
| Events | AsyncAPI conventions + Outbox/Inbox |
| Database | PostgreSQL, Neon São Paulo recommended for pilot |
| Data access | Kysely + SQL migrations |
| Search/RAG | PostgreSQL FTS + trigram + pgvector |
| Durable workflows | Hatchet, gated by Wave 0 certification spike |
| Auth | Better Auth for identity/session; platform owns Tenant/RBAC domain |
| Messaging | WAHA behind `MessagingGateway`; GOWS preferred pending certification |
| Browser automation | Isolated Playwright Browser Worker |
| Object storage | Cloudflare R2 through S3-compatible interface |
| Secrets | Infisical with separate machine identities |
| Agent harness | OpenAI Agents SDK TypeScript behind owned `AgentHarnessPort` |
| Model abstraction | owned `ModelGateway`; AI SDK/native/custom adapters as needed |
| AI observability | AgentRun + Langfuse |
| General telemetry | OpenTelemetry |
| Tests | Vitest + PostgreSQL integration + Playwright + eval harness |
| Delivery | Docker/Compose + GitHub Actions + GHCR + Cloudflare edge |

## Deployment profile

Pilot uses two logical compute bulkheads:

1. **Core node(s)** — Next.js, API, background/domain workers, workflow workers.
2. **Integration node(s)** — WAHA, CINEVISION browser worker, MK browser worker.

Managed/external: Neon PostgreSQL, R2 and Infisical.

A Chromium or messaging failure must not take down billing/CRM/API.

## Data architecture rules

- PostgreSQL is canonical business storage.
- RLS is defense-in-depth, not the only tenant-isolation mechanism; finalize after pooling/worker spike.
- Relational current state + append-only ledgers/audit + domain events; no universal event sourcing.
- Money uses exact representation, never binary floating point.
- Internal timestamps are UTC; tenant timezone controls business interpretation/display.
- UUIDv7 is the preferred opaque entity-ID strategy; human display IDs are separate.

## External references validated 2026-09-26

- OpenAI Agents SDK TS: agent loop, agents-as-tools/handoffs, guardrails, sessions, HITL and tracing.
- Hatchet TS: durable tasks/events and tenant-scoped shared concurrency.
- Better Auth: sessions, organization/access-control, 2FA and passkey ecosystem.
- Cloudflare R2: S3-compatible API.

These references justify implementation choices but do not replace our adapters and contracts.
