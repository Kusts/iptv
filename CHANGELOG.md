# Changelog

## Unreleased — Added

- W1-01 repo bootstrap: pnpm + Turborepo monorepo (`apps/web` Next.js App Router, `apps/api` NestJS + Fastify with `GET /v1/health`, `packages/domain` pure primitives, `packages/config` Zod env, base TS/eslint/prettier config, local `docker-compose.yml`, CI workflow).
- W1-02 database bootstrap: Kysely bootstrap (snake_case explicit mapping, no CamelCasePlugin) + idempotent SQL migration runner with sha256 bookkeeping in `platform.migration_history`; canonical `db/migrations/*.sql` untouched.

## v1.0.1 — 2026-09-26 — Canonical authority correction + implementation hardening

### Corrected
- Restored canonical-domain authority over pre-implementation SQL/OpenAPI scaffolds (ADR-0025); ADR-0024 is superseded where it promoted older physical states into business rules.
- Restored Conversation lifecycle to `OPEN | AWAITING_CUSTOMER | AWAITING_INTERNAL | RESOLVED | ARCHIVED`, with `AI_CONTROL | HUMAN_CONTROL | PAUSED` kept orthogonal.
- Restored CustomerOrder to economic lifecycle `DRAFT | AWAITING_PAYMENT | SETTLED | CANCELLED | EXPIRED`; fulfillment remains owned by Subscription/Entitlements/Provider Operations.
- Split external `Charge` from confirmed `Payment`, including SQL/OpenAPI/event vocabulary and same-order/idempotency invariants.
- Materialized `RefundRequest` separately from `Refund`, with human-review linkage, unknown-effect reconciliation and runtime-safe execution contract.
- Split HumanReview classification into `review_mode` and `reason`, preserving `MANUAL_EXECUTION`.
- Moved Tenant Copilot dogfooding to Wave 3 and made Wave 14 a maturation stage rather than first delivery.
- Removed stale generic courtesy-extension/cooldown modeling; Trust Renewal remains the fixed CINEVISION +3-day capability for ACTIVE accounts with <=3 days remaining and is not a generic reward.

### Hardened
- Added semantic contract tests that protect Charge/Payment/Refund separation, Conversation/Order states, HumanReview dimensions, Copilot sequencing, same-order billing linkage and Trust Renewal reward boundaries.
- Preserved the previous agent's valid hardening: explicit event registry, provider-operation VERIFYING/RETRY_WAIT/HUMAN_REQUIRED, Trial kind/outcome separation, F16/F17, implementation gates and integration certification improvements.

### Validation
- documentation/contracts/migration static validator: PASS;
- contract tests: 21/21 PASS;
- seed contract tests: 5/5 PASS;
- `git diff --check`: PASS;
- PostgreSQL runtime migration/fixture tests: NOT RUN in this environment (no `psql`, Docker or Podman); remain an explicit Wave 0 gate.
- Full v1.0.1 semantic/cross-file review: `docs/00-meta/auto-review-v1.0.1.md`.

## v1.0 — 2026-09-26 — Implementation-ready planning baseline

### Major consolidation
- Integrated Modules 10–25 and all planning-closure decisions into a canonical implementation baseline.
- Added final architecture, stack, OpenAI Agents SDK harness, Hatchet workflow decision, WAHA/GOWS direction, security baseline, live certification plan, canonical domain reconciliation, MVP freeze, critical path, NFR/DR targets, E2E acceptance, DoD, risk and future-capability registries.
- Added explicit reseller hierarchy with direct-child management, ancestor network visibility, SaaS conversion and future SaaS resale.
- Added SPECs 20–25.
- Superseded Inngest ADR and provisional Evolution API ADR; accepted WAHA and added Hatchet/Agent Harness/Neon/R2/runtime ADRs.
- Defined implementation Waves 0–20 and milestones M0–M12.
- Declared documentation v1.0 ready for implementation; remaining unknowns are live/pilot/legal validation items and not hidden planning gaps.

### Review
- Semantic/cross-file/mechanical auto-review completed in `docs/00-meta/auto-review-v1.0.md`.

## v0.14 — 2026-09-22 — Refinamento funcional Módulos 1–9

- consolidou CRM operacional com pipelines especializados, Next Action, Attention Score, Customer Health, Saved Views e Customer 360 técnico;
- consolidou comunicação omnicanal AI-first com múltiplas contas, follow-up contextual, Central de Atividade da IA e sinais operacionais vindos de canais autorizados;
- refinou Trial/Retrial, Acesso Técnico Temporário, preferência de conteúdo adulto e Compatibility/App Provisioning;
- refinou Catálogo/Planos/Ofertas/Pedidos, negociação dentro de policy, referral bilateral e apps pagos/gratuitos/parceiros;
- registrou snapshot da MK Ativador: catálogo público com 175 apps em 2026-09-22, maioria anual R$15/R$20/R$25, além de licença vitalícia observada; compra somente depois do teste gratuito e do pagamento do cliente;
- definiu PIX como pagamento principal, cartão como alternativa e boleto como exceção; pagamento parcial externo ficou fora do MVP;
- tornou reembolso obrigatoriamente HITL e separou recuperação econômica de acesso residual da decisão de reembolsar;
- corrigiu a regra real da Renovação em Confiança CINEVISION: +3 dias fixos, apenas conta ativa com <=3 dias para vencer; sem extensão arbitrária em dias;
- definiu conexão adicional como recorrente, opcional por renovação e com o mesmo vencimento da assinatura principal; remoção durante ciclo somente efetiva na próxima renovação;
- separou dispositivos cadastrados de conexões simultâneas; o provider aplica o limite simultâneo;
- adicionou importação/sincronização da base legada do painel do provider, preview, idempotência, desired-vs-actual e modo observação;
- expandiu Inventory/Procurement com créditos pré-pagos, modelo mensalista futuro com expiração mensal a validar, saldo MK, FEFO, forecast, residual inventory e futuro canal de revendedores;
- expandiu Support/Incident/Problem com confirmação de contexto volátil, Operational Signals, Web/communities research, YouTube/yt-dlp e pipeline de conhecimento global sanitizado;
- marcou Evolution API como superseded para seleção inicial e abriu ADR-0018 com spike WAHA-first sem bloquear gateway provider-neutral;
- adicionou regra transversal: automação por padrão, mas toda ação operacional relevante deve possuir controle manual equivalente no front, usando os mesmos commands/policies/audit.

## 0.13 — Product Identity, UX and Stack Baseline

- added `docs/13-product-design/` with positioning, proposed naming `Synkroo Flow`, brand voice/personality, default agent persona, visual direction, logo brief, IA/navigation, screen inventory, flows, wireframes, design system and critical screen specs;
- added draft operator/user manuals under `docs/14-user-docs/`;
- added `stack-baseline.md` and ADR-0010..0015 covering web/API stack, PostgreSQL/Kysely, Inngest, Better Auth, pilot deployment and provisional Evolution API;
- added live-evidence validation plans for CINEVISION, WhatsApp, PostgreSQL and SLO calibration;
- added legal/accounting validation register;
- preserved unresolved external facts as explicit gates rather than implementation assumptions.

> Review: Auto-reviewed v0.13 — checked against snapshot contents and auto-review report.

## v0.12 — 2026-09-20

- Added Development Agent Handbook and documentation change protocol.
- Added application, repository-boundary, API/error, event and feature-flag conventions.
- Added API versioning and webhook ingress conventions.
- Added semantic CINEVISION/WhatsApp operation catalogs without fabricating live provider details.
- Added model routing, prompt/agent release governance and typed tool failure taxonomy.
- Added secrets/access, audit/evidence and data-retention/DSR baselines.
- Added CI/CD quality gates, dependency failure matrix, operational dashboard catalog, cost governance and production-readiness checklist.
- Added seven operational runbooks for DB, outbox/workflow, reconciliation, provider credits, browser drift, migration failure and HITL backlog.
- Added Definition of Ready/Done and canonical Task template.
- Updated documentation completeness matrix: remaining gaps are now primarily live-environment evidence.
- Added/expanded auto-review enforcement for all v0.12 files.


## v0.11 — 2026-09-20

- Added agent documentation loading protocol and authority hierarchy.
- Added detailed task packs for Waves 02–08.
- Added integration SPECs for Asaas, CINEVISION and provider-agnostic unofficial WhatsApp gateway.
- Added Agent Runtime, Context Engineering, Memory and Policy architecture.
- Added RBAC/permission baseline.
- Added Observability, Testing Strategy, Deployment baseline and critical outage runbooks.
- Added explicit auto-review marker to every new v0.11 document.
- Added secondary/future SPECs for Compatibility, Inventory, Finance, Communication Policy, Knowledge Ingestion, SaaS Control Plane, Growth, Content, Experimentation, Business Learning and Next Best Action.
- Added SLO/Error Budget, Backup/DR, Incident/Problem, Privacy Operations and Release Management baselines.
- Added `scripts/validate_doc_reviews.py` to enforce the per-file auto-review requirement.

## v0.10 — 2026-09-20

### Added

- OpenAPI v0.2 expanded to full MVP surfaces for Communications, Support, Incident/Problem, HITL, Knowledge, Referral, Rewards and Gift Pass redemption;
- AsyncAPI v0.2 expanded to operational-learning lifecycle events;
- deterministic synthetic pilot seed with tenant, catalog, known provider-credit packages, Trial, Support and Referral fixtures;
- seed safety/economics contract tests;
- PostgreSQL fixture runner with double seed application;
- Execution Wave 01 task pack for PF-01…PF-05 + CRM-01;
- Wave 01 acceptance scenarios;
- auto-review v0.10.

### Improved

- contract tests now compare additional API state enums with PostgreSQL constraints;
- static validator detects duplicate OpenAPI operation IDs and seed invariant drift;
- EPIC-00 PF-03 now targets migrations 001–011 plus synthetic fixture gate;
- contracts README documents Knowledge-as-data and redemption-code handling.

### Review findings fixed

- ambiguous `Message.status` renamed to `deliveryStatus`;
- Gift Pass redemption code moved out of URL path and into request body;
- no unresolved additional-connection or long-plan prices are invented in fixtures;
- outbound AI/browser/messaging default OFF in pilot fixture.

### Runtime validation status

- documentation/schema static checks: passed;
- executable contract tests: passed;
- seed contract tests: passed;
- PostgreSQL migration/fixture integration tests: prepared but cannot run in the current environment because PostgreSQL/psql/Docker/Podman are unavailable.


## v0.9 — 2026-09-20

### Added

- migration 009: Communications, Messages, delivery history, preferences/suppressions and Conversation Control history;
- migration 010: Support, Incident/Problem, HITL HumanReview and Knowledge Intelligence;
- migration 011: Referral qualification, Rewards, append-only Reward Ledger and Gift Passes;
- executable OpenAPI↔PostgreSQL contract tests;
- PostgreSQL integration-test suite and runner;
- migration batch documentation v0.9.

### Improved

- HumanReview assignee/action actor now requires tenant membership, not only a global user ID;
- exact self-referral is blocked for active Referral states;
- closed/archived conversations require a close timestamp;
- static validator now checks Support/HITL/Referral/Reward lifecycle constraints and new append-only histories.

### Review findings fixed

- SQL integration tests were rewritten to avoid false positives when the expected trigger/error did not occur;
- communications partial-index design was corrected to avoid non-immutable `now()` in an index predicate;
- Reward/Knowledge/HITL histories preserve append-only evidence.

### Runtime validation status

- documentation/schema static checks: passed;
- executable Python contract tests: passed;
- PostgreSQL integration tests: prepared but not executed here because PostgreSQL/psql is unavailable.

## v0.8 — 2026-09-20

### Added

- migration 004: Catalog, Offers, Orders e Price Snapshots;
- migration 005: Billing + immutable double-entry Financial Ledger;
- migration 006: Subscription cycles, recurring add-ons e Entitlements;
- migration 007: Provider Fulfillment, evidence e health;
- migration 008: Supplier/Procurement + provider credit inventory ledger;
- migration batch documentation v0.8;
- MVP Epics + 56 Stories executáveis;
- MVP Backlog Matrix;
- stronger static migration validator for FK targets, ordering, canonical states and critical invariants.

### Improved

- Physical Database Schema now records implementation coverage through migration 008;
- roadmap now links vertical slices to executable Epics;
- recurring additional connection is protected by DB trigger requiring recurring add-on plus per-cycle economics table;
- provider credit consumption can be attributed to subscription cycle/add-on/provider operation.

### Review findings fixed

- Financial Ledger now has deferred balance enforcement at transaction commit;
- provider Trial FKs are completed with tenant-safe composite references;
- provider and financial ledgers are append-only;
- migration validator now detects missing FK target tables and canonical lifecycle drift.

### Runtime validation status

- static checks: passed;
- PostgreSQL runtime migration execution: pending because PostgreSQL/Docker runtime is not available in the current environment.

## v0.7 — 2026-09-20

### Added

- SPEC de Support, HITL & Knowledge Loop.
- SPEC de Referral Core & Rewards Baseline.
- migrations SQL reais para Platform, Identity/CRM e Trial.
- documentação do batch de migrations.
- processo formal de auto-revisão e `scripts/validate_docs.py`.

### Improved

- regra física de Trial refinada: uma Person possui um único `TRIAL` primário; exceções são `RETRIAL`.
- bloqueio de duas janelas gratuitas simultâneas por Person.
- FK de RiskAssessment do Trial tornou-se tenant-aware.
- OpenAPI passou a expor enums canônicos para SupportTicket, HumanReview e Referral.
- Logical/Physical Data Model alinhados ao novo enforcement de Trial.

### Review findings fixed

- evitado merge conceitual entre Ticket state e ConversationControl.
- knowledge humano bem-sucedido gera Candidate, não VERIFIED automático.
- renovação grátis de referral continua usando Order `SETTLED` sem Payment fictício.
- reward de tela/conexão adicional preserva COGS recorrente.

## v0.6 — 2026-09-20

### Added

- MVP vertical-slice SPEC index;
- Identity & CRM SPEC;
- Trial & Retrial SPEC;
- Commerce & Billing SPEC;
- Subscription & Entitlements SPEC;
- Provider Fulfillment SPEC;
- Reconciliation & Reliability SPEC;
- Agent Tool Contracts;
- Agent Evaluation Plan;
- Physical Database Schema baseline;
- Database Migration Strategy;
- MVP Implementation Sequence.

### Improved

- documentation index now distinguishes implementable SPECs from domain/architecture sources;
- implementation order follows end-to-end vertical slices instead of layer-first construction;
- recurring additional connection economics are explicit in Commerce, Subscription and physical data design;
- agent tools now separate runtime status from domain state.

### Guardrails reinforced

- Trial `DENY` cannot be reinterpreted by the agent;
- Order `SETTLED` remains distinct from Payment `PAID`;
- ProviderOperation requires verified postcondition for `SUCCEEDED`;
- provider timeout triggers observation before retry;
- external/RAG content cannot directly authorize tools;
- cross-tenant repair/provider actions are forbidden.

## v0.5 — 2026-09-20

### Added

- Technology Decision Matrix;
- Threat Model;
- Data Classification Standard;
- Privacy & Data Lifecycle;
- Logical Data Model;
- OpenAPI MVP contract;
- AsyncAPI MVP contract;
- ADR-0010 TypeScript application stack — Proposed;
- ADR-0011 Kysely/SQL-first — Proposed;
- ADR-0012 Inngest workflow runtime — Proposed;
- ADR-0013 Playwright Browser Worker — Proposed;
- ADR-0014 Infisical secrets — Proposed;
- Technology research snapshot;
- formal auto-review report.

### Improved

- Glossary with reliability/security/privacy terms;
- Architecture index;
- Decision index;
- root Documentation Index.

### Corrected

- API state names aligned with canonical state machines;
- residual `ProviderOperation SUCCESS` → `SUCCEEDED`;
- residual `trial.passed` → `trial.technical_passed.v1`;
- conceptual Order↔Payment relation no longer implies every Order is paid externally.

## v0.4 — 2026-09-20

- Data & Analytics Governance;
- architecture baseline/C4;
- ADR-0001 to ADR-0009.

## v0.3 — 2026-09-20

- state machines;
- conceptual data model;
- canonical Event Model.

## v0.2 — 2026-09-20

- PRD;
- personas/actors;
- journeys;
- scope;
- success metrics.

## v0.1 — 2026-09-20

- Product Vision;
- Principles;
- Glossary;
- Domain Map.

> Review: Auto-reviewed v0.14 — release changes cross-checked against canonical files.
