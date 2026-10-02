# Screen Inventory

> Status: Canonical planning baseline — annotated with the current build state
> Versão: 1.0
> Data: 2026-10-02
> Review: Auto-reviewed v1.0 — each screen annotated as **Built** (a matching
> route exists under `apps/web/app`) or **Planned** (no route yet).

## Como ler as marcações

- **Built** — existe uma rota correspondente em `apps/web/app`. A rota citada é
  a evidência; quando a tela é parcial, isso está explícito na anotação.
- **Planned** — sem rota em `apps/web/app` até `2026-10-02`.

## P0 — build first

| Screen | Purpose | Status |
|---|---|---|
| Tenant onboarding | configure pilot tenant/integrations safely | Planned — no dedicated route; `/` (`apps/web/app/page.tsx`) only switches the active tenant from the session list |
| Login / recovery / MFA | secure access | Built (partial) — `apps/web/app/login/page.tsx`; login only, no recovery/MFA screen |
| Overview | attention-first operating summary | Built — `apps/web/app/page.tsx` (API health + needs-attention + operational shortcuts) |
| Inbox | omnichannel conversations + AI/human control | Built — `apps/web/app/conversations/page.tsx` |
| CRM list/pipeline | lead/customer work queue | Planned — no route |
| Customer 360 | complete customer operational context | Planned — no route |
| Trial workspace | eligibility, provisioning, technical validation | Planned — no route |
| Subscription detail | lifecycle, entitlements, add-ons, renewal | Built (partial) — `apps/web/app/subscriptions/page.tsx`; list plus an inline detail panel, no dedicated `/subscriptions/[id]` route |
| Billing/order detail | money state and evidence | Built (partial) — `apps/web/app/orders/page.tsx`; list plus an inline detail panel, no dedicated `/orders/[id]` route |
| Support ticket | structured troubleshooting | Built — `apps/web/app/support/page.tsx` (list, `Todos`/`Meu trabalho` tabs and inline detail) |
| Human Review queue/detail | HITL decisions | Built — `apps/web/app/hitl/page.tsx` |
| Provider Operations | external fulfillment, desired-vs-actual, manual semantic actions and health | Planned — no route (backend dispatch exists; no web surface) |
| Provider Import | preview/import existing provider customer base | Planned — no route |
| Scheduled contacts / Programadas | inspect/cancel/postpone/run eligible future contacts | Planned — no route |
| AI Activity Center | what AI is doing, scheduled, blocked and completed | Planned — no route (the Tenant Copilot workspace in `apps/web/app/copilot/page.tsx` covers the chat/drafts surface, not this operational view) |
| Integration settings | credentials/status without exposing secrets | Planned — no route |
| Audit view | inspect important actions | Planned — no route |

## P1

- Finance dashboard — Planned (no route)
- Inventory/credits + supplier balances/monthly batches — Planned (no route)
- Knowledge browser/editor — Built (partial) — `apps/web/app/conhecimento/page.tsx` covers the knowledge maturation queues (candidates, degraded items, open corrections, gaps, freshness recalibration), not a full browser/editor
- Referral dashboard — Planned (no route)
- Reward wallet/customer rewards — Planned (no route)
- Incident management + Operational Signals — Planned (no route)
- Reconciliation queue — Planned (no route)
- Agent traces/evals — Planned (no route)
- Analytics overview — Planned (no route)

## P2

- Growth campaign workspace — Planned (no route)
- Content studio — Planned (no route)
- Experiment workspace — Planned (no route)
- SaaS control plane — Planned (no route)
- Advanced procurement — Planned (no route)
- Business Learning insights — Planned (no route)
- Next Best Action configuration — Planned (no route)

## Rotas fora do inventário

Rotas existentes em `apps/web/app` sem item correspondente neste inventário:

- `/copilot` (`apps/web/app/copilot/page.tsx`) — workspace do Tenant Copilot:
  conversa, drafts isolados por sessão, revisões pendentes (HITL) e navegação
  cross-domain. Executar ação sempre passa por `POST /v1/agent/copilot/execute`.
