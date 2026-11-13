# Product Contract and MVP Freeze

## Product definition

The product is a multi-tenant **AI Revenue & Operations Platform** for recurring businesses. It combines CRM, conversations, commerce, billing, subscriptions, fulfillment, support, growth, finance, analytics, knowledge and autonomous operations around an authoritative backend.

The first vertical is the owner's streaming/IPTV operation. The architecture must remain generic enough to support other recurring businesses without pretending all domain rules are generic.

## Core flywheel

`Acquisition → Activation/Trial → Sale → Fulfillment → Retention → Expansion → Referral → Recovery → Acquisition`

The economic objective is **lifetime contribution**, not first-order margin alone. Acquisition may be subsidized when cohort payback and retention justify it.

## MVP gates

### First-value checkpoint (M5; not a release gate)

Validate the core operating loop before the growth/productization scope: WhatsApp conversation → eligible Trial → offer/order → PIX settlement with ledger → verified provider fulfillment, with a human exception path. Check G01–G06 and F01–F04/F10/F12/F16/F17, baseline handling time/cost and manual fallback. The first real renewal in Wave 9 extends that evidence. This checkpoint does not waive any required MVP-PILOT item below.

### MVP_STREAMMAX_OPERATIONAL

Escopo operacional interno single-tenant original do StreamMax (staging
Contabo, alvo `/home/deploy/iptv-staging`): gerenciar cliente; criar
pedidos/vender planos IPTV; cobrar via Asaas; confirmar/conciliar pagamento;
criar/gerenciar assinatura; ativação manual supervisionada; status; renovar;
suporte; recuperar operações interrompidas sem efeitos financeiros duplicados.

Exclusões originais (fora do escopo): escrita automatizada CINEVISION; MK;
Tenant Copilot completo; campanhas sofisticadas/rede de revenda/recompensas
de indicação; billing SaaS/multi-tenancy comercial externa; Hatchet
definitivo salvo alternativa aprovada; Infisical Enterprise; white-label;
novos canais; analytics avançado; otimização de performance não provada.

MVP-PILOT e G01–G18 mantêm o significado existente e NÃO são marcados como
concluídos por este escopo. Aceite completo por gate (somente PASS conta;
status válidos: `PASS`/`FAIL`/`BLOCKED_EXTERNAL`/`NOT_RUN`, sem percentuais;
atestação manual sozinha nunca é PASS):

- `MVP_CODE_INTEGRATED` — PR merged + testes de regressão/DB-gated + CI verde
  no novo HEAD da `main` + candidato deployado no staging correto via
  PINNED-COPY, com baseline/rollback/migrations verificados e smoke
  obrigatório (API/frontend healthy, signup fechado, auth, leitura controlada
  dos segredos cifrados no PostgreSQL, Asaas Sandbox CONNECTED/webhook ativo,
  assinatura/fulfillment sem regressão, scheduler/outbox coerente com
  exatamente um processador).
- `MVP_OPERATIONAL_SECURITY` — trocar credenciais temporárias de operador
  comprometidas via recuperação suportada/externa aprovada; invalidar sessões
  antigas; antigas falham/novas funcionam; remover privilégios admin
  temporários; backup externo, criptografado e verificável do PostgreSQL, com
  chave de backup independente das chaves de runtime, restore isolado e
  leitura sintética de segredo. `SECRETS_ENCRYPTION_KEY` e
  `BETTER_AUTH_SECRET` ficam fora do banco/dump e sob custódia separada. Não
  editar hashes diretamente; os critérios de recuperação e integridade
  permanecem. O runtime do MVP usa segredos PostgreSQL cifrados conforme PR
  #123 (migration 068), sem exigir Infisical.
- `MVP_SERVICE_DELIVERY` — reutilizar o rehearsal P8.5 existente, verificar o
  estado atual de pedido/cobrança/pagamento/assinatura/fulfillment; sem
  pagamento duplicado; ativar somente via recurso de teste CINEVISION
  autorizado, registrar externalRef seguro, depois ler de volta o serviço no
  provedor de forma independente; auditoria/vínculo/pedido/pagamento/ledger
  consistentes.
- `MVP_RENEWAL_AND_OPERATIONS` — renovação controlada (ciclo ativo, reter dias
  pagos, nova expiração/ciclo, sem sub/cobrança/extensão duplicada),
  retries/recuperação de webhook/idempotência, suporte (busca de
  cliente/ticket/atendimento), ledger/fila/isolamento de tenant finais.
  Renovação mensal comercial real é diferida ao piloto, não deste gate de
  software.

### MVP-PILOT

Required to operate the internal tenant end-to-end:

- multi-tenancy, identity, RBAC and audit;
- CRM, Inbox and WAHA/GOWS;
- Customer Agent and Tenant Copilot;
- Service Trial, Retrial and Technical Access;
- Product/Plan/Offer/PriceBook/Order;
- Asaas PIX, payment webhooks and reconciliation;
- Subscription, cycles and entitlements;
- CINEVISION browser adapter and reconciliation;
- Support/Diagnostics/HITL;
- configurable campaigns, referral and rewards core;
- reseller core including hierarchical network;
- finance/unit economics and core analytics;
- operational ledger posting and reversal is required from the first real sale, not deferred to unit-economics reporting;
- knowledge/memory core;
- Control Center, Design System and critical mobile flows;
- observability, backup/restore, kill switches and manual fallback.

### MVP-SAAS

Adds what is required before external paying tenants:

- Platform Admin and tenant lifecycle;
- SaaS Plan/PlanVersion and PlatformSubscription;
- SaaS billing and usage dashboard;
- external onboarding/import/Observation Mode/Go-Live Review;
- final product naming and brand system;
- user documentation and platform support flow;
- commercial pricing/package defined from pilot telemetry;
- data export/cancellation/retention process required for external customers.

## Explicitly not required for MVP-PILOT

- Affiliate engine;
- own streaming application;
- advanced reseller portal/certification;
- white-label/custom domains;
- enterprise SSO/SCIM;
- Kafka/Kubernetes/microservices;
- dedicated warehouse/ClickHouse;
- full experimentation suite;
- cross-tenant benchmarks;
- CINEVISION monthly-credit model;
- MK Ativador automatic integration (deferred post-MVP per ADR-0027; manual fallback only).

## MVP readiness statement

The pilot is ready only when the Golden Loop, renewal loop, recovery loop and failure journeys in the E2E matrix are passing with real integrations or certified test equivalents.
The first-value checkpoint is an earlier learning milestone; it is not permission to claim the full pilot ready or to skip real-operation validation gates.
