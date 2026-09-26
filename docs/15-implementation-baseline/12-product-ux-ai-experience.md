# Product, UX and AI Experience Contract

## Product experience

The UI must feel premium, modern, fast and comprehensible to non-technical operators. Complexity lives behind progressive disclosure.

Navigation baseline:

- Início / Control Center;
- Trabalho: Inbox, Clientes, CRM, Trials, Assinaturas, Suporte;
- Receita: Pedidos, Cobranças, Catálogo/Ofertas, Financeiro, Estoque, Benefícios;
- Growth: Campanhas, Audiências, Conteúdo, Indicações, Parceiros;
- Operações: Provider, Provisionamento, Incidentes, Reconciliação, Aprovações, Atividade IA;
- Inteligência: Analytics, Conhecimento, Insights/Hipóteses/Experimentos;
- Configurações: IA/Automação, Políticas, Integrações, Usuários, Empresa, Auditoria.

Views may repeat domain information but must use the same canonical source.

## Control Center

Focus on `Precisa de Você`, current operation, business summary, alerts/opportunities, integration health, scheduled work and AI activity. Human queue size is a signal of automation health.

## Tenant Copilot

Two surfaces:

- persistent context-aware widget;
- full intelligence workspace for conversations, analyses, tasks, research, reports, history and activity.

The Copilot may query, navigate, prepare drafts and execute authorized commands, but cannot bypass RBAC/policy. UI context provides current route/entity/selection/filter with minimum required data.

## AI response design

Responses may render text, tables, charts, action cards, approvals, evidence or deep links. Do not force every answer into chat text. Important actions use risk-proportional preview/confirmation.

Explainability shows facts used, policy, performed action, result and evidence—not private chain-of-thought.

Use semantic confidence such as `CONFIRMED | OBSERVED | INFERRED | STALE | CONFLICTED`, not fake precision percentages.

## Customer Agent

Natural, concise, tenant-branded and truthful if asked whether it is AI. Text is default. Outbound audio only after explicit customer request/authorization; use hybrid text+audio for credentials, URLs, dates, prices and ordered steps.

Conversation Focus suppresses inappropriate marketing/referral/upsell while support is active.

## Manual fallback

AI is powerful but not a single point of failure. Essential operations have manual frontend equivalents through the same command/policy/audit pipeline.

## Design system

Owned wrappers/tokens define status semantics, tables, filters/Saved Views, timelines, approvals, AI suggestions/results/evidence, empty/loading/error/recovery states and responsive behavior. Do not create module-specific ad-hoc visual systems.
