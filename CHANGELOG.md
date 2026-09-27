# Changelog

## Unreleased — Added

- Wave 8 Support + HITL center: `apps/api/src/support/` (owning context for Ticket/Incident/Problem — `support.ticket.open|assign|transition|add_solution_attempt|resolve|close|reopen` over the explicit canonical map mirroring the 010 CHECK sets, resolve gated on a `SUCCEEDED`/`PARTIAL` attempt with optional `solution_outcomes` linkage, assignment restricted to active same-tenant members with first-response stamping; `support.incident.open|update_status|resolve`, `support.problem.open`, idempotent `link_incident|link_problem`; registry-listed entry events only, assignment/attempts/problem-links audit-only on the known gaps; reads `GET /v1/tickets[/:id|/my-work]` with read-only diagnostics joins, `/v1/incidents`, `/v1/problems`) + `apps/api/src/knowledge/` (tenant-scoped `knowledge.item.create|update|archive` with append-only versions + `CANDIDATE→…→DEPRECATED`, `solutions` rows for `SOLUTION` types; ILIKE/tag reads, labeled token-overlap `suggest-for-ticket`, pg_trgm/FTS deferred) + HITL center extensions (`GET /v1/human-reviews/center` read-model aggregation of the four existing queues with `hitl.sla` warn/breach flags, `human_review.claim` with same-user idempotency and no stealing; no queue table restructured); migration `202609262100_021_support_hitl_center.sql` (`support_tickets.assignee_user_id` + membership FK and `support.ticket.read`/`support.incident.write`/`knowledge.read|write` seeds, mirrored in `packages/auth`; `support.ticket.write` predates from 012); typed Kysely rows for the 010 Wave-8 tables. Tests: pure units (ticket/incident maps vs CHECK sets, entry-event coverage, resolve gate, boundary-exact SLA incl. `sla_due_at`, center normalization, suggest ranking) + `TEST_DATABASE_URL` integration (full ticket lifecycle with solution evidence and event assertions, incident linkage incl. idempotent relink, four-queue center with WARN/BREACH + claim + source filter + zero cross-tenant leakage, knowledge versioning/search/suggest/archive, unique-per-run keys, repeat runs green).

- Wave 9 Renewal + Retention: `apps/api/src/renewal/` (`renewal.quote` ACTIVE-only inside `[cycle_end - window_days, cycle_end]` — early only when `early_allowed` — creating one OPEN subscription-shaped RENEWAL order per subscription priced from the CURRENT catalog price with an immutable snapshot, idempotent via the existing `subscription_cycles.renewal_order_id` link; `subscription.renew` requires the SETTLED RENEWAL order, closing the prior cycle at period end and opening the NEXT cycle of the SAME subscription (close-then-open under the 019 one-OPEN-cycle index, exact minor-unit money from the order net, never webhook amounts) + entitlement window refresh with RENEWAL grants + registry-listed `subscription.renewed.v1`; `renewal.reminders_due` worker seam writing one INTERNAL/SYSTEM reminder record per cycle behind the manual gateway, idempotent via `renewal-reminder:{subscription}:{cycle}`; `subscription.trust_renew` policy-gated (`subscription.trust_renewal`: +3d, remaining≤3, reviewed by default) bounded paymentless extension with requester≠approver enforcement and a single grant per cycle (replay-first precondition); `renewal.expire_overdue_due` worker seam ending past-grace ACTIVE subscriptions at cycle end by default (SUSPENDED only under an explicit `subscription.suspension` policy, `cancel_at_period_end` rows left to the Wave 6 worker, SETTLED-renewal-pending rows never stolen) + `renewal.recovery_tasks` winback row per expiry; `recovery.resolve` human outcome WON_BACK/LOST/DISMISSED with bus audit, no campaign automation; reads `GET /v1/renewals?subscriptionId=` + `GET /v1/recovery-tasks`; no new permissions, no new projection states, no invented events); migration `202609262000_020_renewal_recovery.sql` (`renewal.recovery_tasks` with OPEN→RESOLVED shape CHECK, `subscription.trust_renewal_grants` with one-per-cycle unique); typed Kysely rows. Tests: pure policy units (boundary-exact window/trust gates, RENEWAL_DUE↔quotable interplay, extension capping, reminder keys) + `TEST_DATABASE_URL` integration (full quote→charge→webhook→SETTLED→renew→new OPEN cycle + entitlements + prior COMPLETED + projection reset, idempotent quote/renew, settle-before-renew rejection, early-denied-then-allowed, trust forbidden/self-approval-rejected/approved-once, reminder idempotency + INTERNAL/QUEUED shape, overdue→ENDED+task→resolve, suspension-policy branch, cancel_at_period_end Wave 6 ownership, tenant isolation, repeat-run green).

- Wave 6 Subscriptions + Fulfillment: `apps/api/src/subscription/` (`subscription.activate_from_order` requires a SETTLED order with a PLAN line — CONFIRMED payments alone never activate — creating PENDING_ACTIVATION + first PENDING cycle + PENDING `plan:<key>` entitlements; `subscription.activate` requires the SUCCEEDED fulfillment postcondition → ACTIVE + cycle OPEN + entitlement grants + `ACTIVATION_POSTCONDITION` provider_evidence + system-originated INTERNAL credential notification with QUEUED manual delivery, idempotent; `cancel_at_period_end` flag with ENDED only via the `expire_cycles_due` worker seam — no renewal (Wave 9); policy-gated `suspend` (`subscription.suspension`, default DENY, explicit reason, never a late webhook) + `reinstate`; reads with computed RENEWAL_DUE/GRACE/OVERDUE projections, never stored; no invented events — `subscription.*` stays audit-only on the known registry gaps); `apps/api/src/fulfillment/` (`fulfillment.request_for_subscription` over the Wave 4 ProviderOpsPort with capability gate, UNKNOWN→VERIFYING→reconcile, FAILED→MANUAL_EXECUTION review; binding reuses `provider_bindings`, written only with a real external ref; Wave 4 resolve/reconcile resume hooks extended to `entity_type=subscription`); migration `202609261900_019_subscription_cycle_guard.sql` (one-OPEN-cycle partial index + `subscription.read|write` seeds); `GET /v1/subscriptions[/:id]` + `/v1/fulfillment/subscriptions/:id` surface. Tests: pure policy units (4-state map vs CHECK set, projections, cycle integrity, cancel semantics, suspension gate, interval math) + `TEST_DATABASE_URL` integration (full trial→order→payment→subscription→fulfillment loop, UNKNOWN reconcile, FAILED review, cancel→expire→ENDED, suspension gate, double-activation idempotency, tenant isolation, payment-alone creates nothing).

- Wave 5 Commerce + Billing: `apps/api/src/commerce/` (`offer.quote` builds a DRAFT order from ACTIVE catalog prices with an immutable `price_snapshots` copy per line, integer quantities, exact minor-unit `bigint` money; `order.submit` DRAFT→AWAITING_PAYMENT audit-only — `commerce.order.awaiting_payment` has no public v1; `order.cancel` + `order.expire_due` worker seam with registry-listed `order.created|cancelled|expired.v1`; reads `GET /v1/orders[/:id]`); `apps/api/src/billing/` (`AsaasPort` with deterministic `EchoAsaasAdapter` default + env-gated `RealAsaasAdapter` stub behind `ASAAS_API_KEY`/`ASAAS_BASE_URL` mapping timeouts to UNKNOWN_EFFECT with no create auto-retry; `charge.create` PENDING→provider→PROCESSING with binding + attempt and `charge.created|processing.v1`; `POST /v1/webhooks/asaas/:tenantKey` mirroring the WAHA ingress discipline — tenant from `billing.tenant_channels`, timing-safe secret, inbox insert-once dedupe, 202 fast ack, inline normalize with `?defer=1` + `drainPending` — where PAID deliveries validate amount+currency against the internal charge row (mismatch → `billing.exceptions`, never a confirmation) and confirm idempotently (charge PAID + CONFIRMED payment + balanced Dr-cash/Cr-receivable posting + all-or-nothing settlement → order SETTLED + idempotent `crm.customers` conversion + `charge.paid|payment.confirmed|order.settled(+customer.created).v1`); `charge.reconcile|expire_due|cancel`; human-gated refund contract — `refund.request` (tenant-scoped row + HumanReview, never executes) → `human_review.approve|reject` wired through a refund revalidator (requester cannot approve, stale revalidation) + in-tx resolve hook propagating APPROVED/REJECTED → `refund.execute_approved` (per-payment `pg_advisory_xact_lock`, TTL-guarded approval, reserve-first insert, KNOWN_APPLIED posts the contra-revenue reversal + PARTIALLY_REFUNDED/REFUNDED, KNOWN_NOT_APPLIED releases, UNKNOWN parks RECONCILING + exception for `refund.reconcile`) — no `refund.*` public v1 exists so refund steps are audit + `hitl.*` only; `payment.record_chargeback` distinct path (CHARGEBACK + loss posting + review exception + `payment.chargeback.v1`); `billing.exception_resolve`); shared `money-math.ts` pure exact-money/transition/coverage/balance helpers, `ledger.ts` append-only balanced postings, `settlement.ts` conversion service; `HumanReview` extended with an optional decision-aware revalidator third arg + in-tx `onResolved` hook (backwards compatible); migration `202609261800_018_billing_webhook_exceptions.sql` (`billing.tenant_channels`, `billing.exceptions`, Wave 5 permission seeds mirrored in `packages/auth`); typed Kysely rows for catalog/commerce/billing/finance; `ASAAS_*`/`REFUND_APPROVAL_TTL_HOURS` placeholders in `.env.example`. Tests: 20 pure unit (exact math, threshold settlement, reservation arithmetic, transition legality, ledger balance, webhook validation, normalizer, echo adapter) + `TEST_DATABASE_URL` integration (happy charge→webhook→payment→balanced ledger→SETTLED→idempotent customer, duplicate webhook no-op, tamper→exception, unknown-charge→exception, 401/404 auth, concurrent partial refunds + over-refund rejection, duplicate idempotency key, self-approval + unapproved-execute rejection, stale approval, cross-customer rejection, UNKNOWN→reconcile→applied, chargeback path, order/charge expiry, tenant isolation).

- Wave 4 Trials + Compatibility: `apps/api/src/trial/` (`trial.request` with `trial.eligibility` policy-family decisions persisted to `trial_eligibility_decisions` — ALLOW creates a primary TRIAL + registry-listed `trial.requested|eligibility_allowed.v1`, DENY persists + `eligibility_denied.v1`, REVIEW parks in HumanReview + `eligibility_review_required.v1` and materializes only with an approved review; `trial.begin_provisioning` REQUESTED→PROVISIONING through `ProviderOpsPort` + `provisioning_started.v1`; `trial.record_technical_result` in its own table with PASSED/FAILED/INCONCLUSIVE events and zero lifecycle movement; `trial.end` ACTIVE→ENDED with `expired` vs early-`cancelled` events; `trial.cancel` REQUESTED/PROVISIONING→CANCELLED auto-cancelling only provably-unexecuted ops; `trial.invalidate` ACTIVE→INVALIDATED enabling policy-reviewed `trial.request_retrial` — RETRIAL kind with `previous_trial_id` + reason, prior must be ENDED/INVALIDATED, `retrial_allowed.v1` on approval; `trial.apply_trust_renewal` extends `expires_at` by the `trial.trust_renewal` family's `extension_days` (safe default +3) only when ACTIVE and remaining within `max_remaining_days` (default ≤3 days, boundary-exact) — audit-only, no invented event; `trial.expire_due` scheduler seam batching ENDED + `expired.v1`; single-primary and single-open-access invariants enforced pre-check + SQL unique indexes mapped to 409; compatibility `record_device_profile|record_app_profile|record_observation` over the migration-003 tables with read-only `GET /v1/compatibility/summary`); `apps/api/src/provider/` (`ProviderOpsPort` with `EchoProviderOpsAdapter` deterministic success/failed/unknown via per-call flag or env + `ManualProviderOpsAdapter` parking HUMAN_REQUIRED, `StubProviderReadback` answering `provider.reconcile` from env with a safe NOT_APPLIED default, capability `provider.cinevision` UNAVAILABLE forcing MANUAL; failed-with-certain-non-application returns the trial to REQUESTED for retry, UNKNOWN parks the op in VERIFYING and forbids blind retry until reconcile observes the effect, linked-trial resume emits the registry-listed trial events; commands `provider.request_operation|resolve_operation|reconcile`); queries `GET /v1/trials`, `/v1/trials/:id`, `/v1/trials/:id/technical-result`, `GET /v1/provider/operations/:id`; migration `202609261700_017_trial_provider_effect.sql` (orthogonal `effect_certainty` + status/certainty coherence CHECK on `provider_operations`, `trial.*` + `provider.operation.*` permission catalog with operator denied provider writes); `PROVIDER_*` placeholders in `.env.example`. Tests: unit (exhaustive transition map, eligibility matrix, trust-renewal boundary 3-allowed/4-denied, capability gate, memory happy path with 17-event allowlist assertion, second-primary 409, single technical result, tenant isolation, review-gated retrial, manual resolve, UNKNOWN→reconcile both answers, policy-disabled denial, compatibility audit-only) + `TEST_DATABASE_URL` integration (echo happy path, review-gated retrial, HUMAN_REQUIRED→resolve→ACTIVE, UNKNOWN→VERIFYING→reconcile both answers, trust-renewal 4-denied/3-allowed, second-primary 409 + isolation, expire-due + cancel, SQL CHECK incoherence rejection, compatibility summary, seeded-trial isolation).

- Wave 3 Customer Agent v1 + Tenant Copilot foundation: new framework-free `packages/ai-runtime` (`AgentHarnessPort.run` with tenant-scoped `ContextBundle` built outside the model, `ModelGatewayPort` with deterministic `EchoModelGateway` DEFAULT + env-gated `OpenAICompatGateway` behind `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`AGENT_MODEL` that is never called without a key, `ToolRegistry` descriptors with tenant scope + transient/fatal/unknown_effect taxonomy mapping, `AgentRelease` store port + in-memory impl with behavior-only prompts keyed by release id/version, harness validation of untrusted LLM output, single specialist-as-tool step with no recursive chains); `apps/api/src/agent/` (`ContextBuilder` bounded-20 message window + person summary + published `agent` policy family as structured data + suppressions + open-review count, all tenant-scoped; `crm.lookup_person` R0 read-only tool executing through an injected dispatcher over the same tables the CRM API reads; `AgentPipeline` inbound → SHADOW-by-default evaluation → `agent_runs` row + `human_review.request` APPROVAL with the proposed reply, post-ingest webhook hook that never fails ingest, downgrade-only AUTO requiring `ai.reply_autonomous` AVAILABLE + CERTIFIED + gate AUTO + explicit tenant `allow_autonomous`, resume path approve → stale-approval revalidation → `message.send_manual` via the echo/provider gateway / reject → discard logged; shadow runs NEVER send); endpoints `GET /v1/agent/runs?conversationId=`, `POST /v1/agent/evals/run` (`agent.eval.run`, always echo, never live), `POST /v1/agent/reviews/:id/approve|reject` (`agent.review.decide`); eval skeleton `apps/api/test/fixtures/agent-evals/*.json` (7 cases: happy reply, off-scope refusal, suppression respect, unknown-effect tool, EN + PT prompt-injection refusal, takeover no-eval) with an offline echo runner; migration `202609261600_016_agent_runtime.sql` (`agent.agent_releases` with published-immutability trigger + `customer-agent-v1` seed, `agent.agent_runs`, `agent.agent_tasks`, `ai.reply_autonomous` UNCERTIFIED/UNAVAILABLE, `agent.eval.run` permission + owner/admin grants). Auth mirror gains `agent.eval.run` (owner/admin; operator excluded) with the catalog-count tests updated. Tests: `packages/ai-runtime` unit (17: echo default/env gating, injection + secret guards, harness proposals, tool taxonomy, release resolution) + api unit (10: eval gate, offline fixture set green, release fallback, tool descriptor) + `TEST_DATABASE_URL` integration (8: capability defaults, shadow→review with zero outbound, approve→send via echo, reject→discard, takeover suppression, webhook auto-hook, bus denial, evals endpoint green). Only registry-listed events are emitted (`hitl.review_requested|resolved.v1`, `message.sent|received.v1`).

- Wave 2 CRM + Communications vertical slice: `apps/api` CRM (`person.register` with per-tenant natural-key uniqueness, `lead.capture` around an existing person at `NEW`, `lead.transition` over the exact migration-002 status set with an explicit owning-context transition map; `person.created.v1` + `lead.created.v1` emitted — both registry-listed; NO `crm.customers` writes anywhere) with tenant-scoped paginated queries (`GET /v1/crm/persons`, `/persons/:id`, `/leads`, `/leads/:id`); Communications (`MessagingGatewayPort` + `WahaGatewayAdapter` behind `WAHA_BASE_URL`/`WAHA_API_KEY` with taxonomy-mapped outcomes + `LocalEchoGateway` default returning `echo:` ids; `conversation.start_manual` opening `OPEN`/`HUMAN_CONTROL`, HUMAN `message.send_manual` with suppression/`DENIED`-preference gating, UNKNOWN_EFFECT → delivery `QUEUED` + `PAUSED`/`RECONCILE_REQUIRED` with no retry, `conversation.assign|release|close` with append-only control events, `message.ingest` with identity/thread matching and an `UNMATCHED_INBOUND` exception queue `GET /v1/communications/exceptions` + `exception.resolve` map/discard; registry-listed `conversation.started|human_takeover_started|returned_to_ai|paused.v1` + `message.received|sent.v1`); public webhook `POST /v1/webhooks/waha/:tenantKey` (tenant from `communication.tenant_channels` mapping, timing-safe secret check, inbox insert-once dedupe, 202 fast ack, inline in-process normalize with `?defer=1` + `drainPending` for the future worker handoff); migration `202609261500_015_comm_channels_exceptions.sql`; `WAHA_*` placeholders in `.env.example`. Tests: unit (fixture-driven normalizer, gateway selection/FAILED mapping, pure suppression/opt-out decision, bus flows on the memory store incl. unknown-effect and dedupe) + `TEST_DATABASE_URL` integration (CRM chain with invalid-transition 409 and zero customers, webhook 202→message→dedupe, deferred unknown-sender→exception→map resolve, unknown-event 202 without mutation, 401/404 auth paths, send happy/suppressed/unknown-effect, takeover/return append-only, tenant isolation). Drive-by: `vitest.config.ts` `maxWorkers: 1` — integration files share one `TEST_DATABASE_URL` and assert global outbox state, so files run sequentially; `CrmCustomersTable` added to the Kysely schema (read-only guard for the no-Customer rule).

- W1-09/10 policy + capability foundations: `packages/domain` pure policy/autonomy primitives (`PolicyClass` precedence `PLATFORM_INVARIANT > PLATFORM_POLICY > TENANT_POLICY > PARTNER_POLICY`, `ResolutionStep`/`EffectiveDecision` provenance, downgrade-only `downgradeAutonomy`/`clampAutonomyToMax`, higher-class-wins `mergePolicyLayers`, generic `baseAutonomyOf`/`maxAutonomyOf` document reading); `apps/api` `PolicyResolver` (applicable PUBLISHED docs, latest version per class, typed `not_configured` for missing families) + `policy.publish` command (`settings.manage`; scope/class match validated, TENANT by tenant admins, PLATFORM/PARTNER platform-admin-only, version+1 rows, no domain events — families stay generic jsonb); `ActionGate` canonical resolution (availability before permission, policy allow/deny, preconditions callback, invariant-max clamp, `degraded` flag) + `capability.register|set_availability` (platform-admin-only, availability flips append an event row); queries `GET /v1/capabilities` (per-actor overview) and `GET /v1/capabilities/:key/resolve` (dry-run with provenance); migration `202609261400_014_policy_capability.sql` (global `platform.capabilities`, append-only `platform.capability_events`, versioned `platform.policy_documents` with scope/class coherence CHECKs and a published/retired immutability trigger). Unit (downgrade semantics, precedence/merge, mismatch rejection, gate ordering, clamp) + `TEST_DATABASE_URL` integration (publish flow, precedence + clamp over HTTP, UNAVAILABLE→DENY before permission check, DEGRADED flag, append-only rejection).

- W1-06/07/07a commands/events/HITL: `packages/domain` canonical event envelope (Zod, `schema_version: 1`, AsyncAPI `EventEnvelopeBase` parity) + `CommandResult` union/`CommandMeta` primitives; `apps/api` hand-rolled `CommandBus` (authz → Zod parse → `platform.idempotency_keys` claim → ONE Kysely transaction: state + `platform.domain_events` + `platform.outbox_messages` + audit), `OutboxDrainer` (`FOR UPDATE SKIP LOCKED`, `TransportPort` with `LocalTransport` default, `POST /v1/admin/outbox/drain` platform-admin-only), idempotent `InboxProcessor` (`platform.inbox_messages` insert-once dedupe), and the first real commands `human_review.request|approve|reject` (tenant-scoped queue `GET /v1/human-reviews?status=PENDING`, stale-approval revalidation with pluggable target hook, `hitl.review_requested|resolved.v1`); migration `202609261300_013_command_permissions.sql` seeds `agent.review.request|decide` (operator: request only). Unit (fake-db bus paths, envelope roundtrip, inbox dedupe) + `TEST_DATABASE_URL` integration (full chain, idempotency replay, stale approval, parallel-drain disjointness, tenant isolation).
- W1-06 drive-by fix: tenant slug suffix now uses the random UUID tail instead of the UUIDv7 timestamp head (same-name tenants created within a minute no longer collide with `tenants_slug_unique`, which made integration re-runs flaky); applied in `packages/auth` register and `apps/api` tenants controller.

- W1-03 tenant/auth: `packages/auth` email+password sessions via a custom adapter mapped onto the existing `control.users` (`auth_subject = 'email:<…>'`, scrypt hashes in `control.auth_credentials`, sha256-bound opaque tokens in `control.auth_sessions`); API `AuthModule` (`POST /v1/auth/register|login|logout`, `GET /v1/auth/session`), request-scoped tenant from session membership with explicit `POST /v1/tenants/:id/switch`.
- W1-04 authorization RBAC: migration `202609261200_012_identity_rbac.sql` (global role/permission catalog with platform-role separation via `users.is_platform_admin`, tenant-scoped `membership_roles` bindings, seeded `tenant_owner|tenant_admin|tenant_operator` + 8-permission catalog); `requirePermission(actor, tenantId, permission)` with platform-only bypass; per-route `PermissionsGuard` + `@RequirePermission` demo (`GET /v1/settings`).
- W1-05 audit infrastructure: `AuditService` writing append-only `platform.audit_log` (actor, tenant, request id as correlation id, before/after summary metadata) on auth/tenant mutations; `GET /v1/me` proves the session→tenant→role→permission chain.

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
