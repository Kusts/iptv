# Development Agent Handbook — v1.0

## Mandatory behavior

- Work inside the bounded context and allowed files declared by the task.
- Use canonical vocabulary; never collapse Order/Payment/Subscription, Trial/TechnicalAccess/TrustRenewal, Provider/Supplier, Referral/Reseller/Affiliate or User/Person.
- Frontend, Agent and workflows call the same application commands. No direct DB writes from UI/tools.
- Do not place business policy in prompts, React components, browser selectors or external-provider adapters.
- Never make an external provider the source of truth for business state.
- Preserve tenant context in DB, cache, search, knowledge, analytics, background workflows and Agent tools.
- Unknown external write effect → verify/reconcile before retry.
- Refund execution is always human-required.
- Reseller ancestor visibility does not imply descendant management.
- Security failures/degradation should isolate the smallest affected capability whenever safe.

## Before coding

Load the v1.0 documentation order in `agent-documentation-loading-order.md`. Confirm owning context, state transition, command/event, policy, capability/tool and acceptance scenario.

## Before declaring done

Run feature tests, integration/evals where applicable, E2E scenario(s), lint/typecheck and documentation validation. Update the canonical doc instead of creating a competing description.
