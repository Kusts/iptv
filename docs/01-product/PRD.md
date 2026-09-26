# PRD Mestre — AI Revenue & Operations Platform

> Status: **FINAL v1.0 — READY FOR IMPLEMENTATION**  
> Date: 2026-09-26  
> Canonical cross-domain baseline: `docs/15-implementation-baseline/`

The product is an automation-first, multi-tenant AI Revenue & Operations Platform. The internal streaming/subscription operation is the first normal tenant and pilot. The current final scope, architecture, canonical domain, agent harness, security model, partner network and readiness gates are authoritative in the implementation baseline.

## 1. Resumo executivo

A AI Revenue & Operations Platform é uma plataforma SaaS multi-tenant para operar negócios de assinatura com IA, automação, CRM, billing, fulfillment, suporte, fidelidade, growth e aprendizado contínuo em uma única fonte de verdade.

A primeira implementação será validada na operação própria do fundador, em uma vertical de assinatura digital/streaming. Essa operação servirá como tenant piloto, ambiente de aprendizagem e futuro case comercial do SaaS.

A plataforma deverá centralizar dados e decisões do negócio, mantendo sistemas externos — provider de fulfillment, gateway de pagamento, canais de comunicação e plataformas de mídia — como integrações substituíveis.

O primeiro ciclo que o produto precisa provar é:

```text
Lead
→ Trial elegível
→ Trial tecnicamente válido
→ Compra
→ Pagamento
→ Fulfillment
→ Suporte
→ Renovação
→ Referral / Retenção
```

O produto deve medir o resultado econômico e operacional desse ciclo e utilizar evidência acumulada para melhorar decisões futuras, sem permitir que correlação isolada altere políticas críticas automaticamente.

---

## 2. Problema

Operações pequenas e médias de assinatura normalmente funcionam com dados fragmentados entre mensageria, gateway, painéis de fornecedor, planilhas e memória dos operadores. Isso produz:

- perda de contexto entre canais;
- baixa consistência de follow-up;
- suporte repetitivo e pouco reutilizável;
- ausência de visão confiável de CAC, LTV, COGS e lucro;
- dificuldade de saber quais campanhas geram clientes rentáveis;
- abuso de trials, cupons e benefícios;
- dependência excessiva de interfaces externas instáveis;
- pouca rastreabilidade sobre o que agentes e automações fizeram;
- conhecimento operacional que envelhece sem validação;
- intervenções humanas que resolvem casos individuais, mas não melhoram o sistema;
- dificuldade de transformar referral em canal previsível de aquisição;
- ausência de estrutura para evoluir de automação assistida para autonomia controlada.

---

## 3. Objetivos do produto

### O1 — Centralizar a operação

Manter em uma fonte autoritativa própria:

- identidade;
- CRM;
- conversas;
- trial/retrial;
- orders;
- pagamentos;
- subscriptions;
- entitlements;
- fulfillment state;
- suporte;
- conhecimento;
- referral/rewards;
- custos, receita e lucro;
- atribuição de aquisição;
- auditoria e decisões do agente.

### O2 — Automatizar o ciclo comercial com segurança

O agente deve vender, qualificar, orientar, dar suporte, fazer follow-up, cobrar, renovar, reter e recuperar clientes dentro de políticas explícitas e com HITL quando necessário.

### O3 — Usar Trial como qualificação técnica e comercial

O Trial deve validar se o serviço funciona no contexto do lead antes da cobrança.

Por padrão, cada `Person` possui direito a apenas **um Trial válido**. Novo acesso gratuito após um Trial válido é bloqueado. `Retrial` é uma exceção rastreada para casos legítimos em que o Trial anterior não cumpriu sua finalidade técnica.

### O4 — Maximizar valor econômico, não apenas conversão

O produto deve mensurar e otimizar:

- receita;
- COGS;
- margem;
- CAC;
- LTV;
- payback;
- retenção;
- referral economics;
- custos de suporte;
- custos de IA e infraestrutura.

### O5 — Transformar suporte em conhecimento reutilizável

Soluções, falhas, tentativas e orientações humanas devem alimentar um Knowledge Intelligence com validade, freshness, confiança e ranking baseado em evidência operacional.

### O6 — Tornar Referral um canal prioritário de aquisição

O produto deve estimular indicação em momentos de satisfação e medir referral como canal comparável a mídia paga e aquisição orgânica.

### O7 — Permitir evolução segura da autonomia

O sistema deve suportar progressão de `Shadow Mode` até execução autônoma de ações permitidas, usando risco, confiança, políticas, tenant autonomy e resultados de evals.

### O8 — Nascer preparado para SaaS

Mesmo no tenant piloto, o sistema deve ser multi-tenant em identidade, autorização, dados, configuração, usage metering, auditoria e integração.

---

## 4. Não objetivos iniciais

O produto não precisa, no MVP:

- suportar todas as plataformas sociais;
- substituir todos os serviços externos por tecnologia própria;
- possuir multi-agent swarm complexo;
- utilizar machine learning próprio para churn, fraude ou recomendação;
- gerenciar anúncios de forma totalmente autônoma;
- publicar conteúdo sem revisão humana por padrão;
- possuir data lake ou infraestrutura analítica de grande escala;
- suportar múltiplos providers de fulfillment desde o primeiro release;
- construir microserviços para cada domínio;
- automatizar bypass de CAPTCHA, controles de acesso ou políticas de terceiros;
- oferecer mecanismos para anunciar ou distribuir conteúdo sem direitos/autorização aplicáveis.

O MVP deve priorizar a prova do ciclo operacional principal.

---

## 5. Atores principais

Os atores canônicos são detalhados em `personas-actors.md`.

### Atores humanos

- Lead;
- Customer;
- Referrer / Advocate;
- Tenant Operator;
- Tenant Admin;
- Support/HITL Operator;
- SaaS Platform Admin.

### Atores sistêmicos

- AI Agent;
- Workflow Engine;
- Risk Engine;
- Policy Engine;
- Billing Provider;
- Fulfillment Provider;
- Messaging Provider;
- Ads Platforms;
- Knowledge Sources.

---

## 6. Jornada de produto prioritária

A jornada completa é detalhada em `journeys.md`.

```text
Acquisition
↓
Identity Resolution
↓
Lead
↓
Trial Eligibility
↓
Trial / Retrial
↓
Technical Validation
↓
Offer
↓
Order
↓
Payment
↓
Entitlements
↓
Fulfillment
↓
Active Customer
↓
Support / Engagement
↓
Renewal
↓
Referral / Loyalty
↓
Retention / Winback
↓
Learning
```

---

## 7. Requisitos funcionais — Identity & CRM

### FR-CRM-001 — Person canônica

O sistema deve representar uma pessoa independentemente de canal.

### FR-CRM-002 — Múltiplas identidades

Uma `Person` pode possuir múltiplas identities, incluindo WhatsApp, Instagram, TikTok, YouTube, e-mail, website e identifiers de integrações externas.

### FR-CRM-003 — Merge reversível

O sistema deve permitir merge, revisão e unmerge de identities com auditoria.

### FR-CRM-004 — Customer Timeline

Toda interação relevante deve aparecer em uma timeline única e ordenada.

### FR-CRM-005 — Customer 360

O Control Center deve exibir em uma visão integrada:

- estado comercial;
- assinatura;
- entitlements;
- pagamentos;
- trial;
- dispositivo/app/rede conhecidos;
- suporte;
- memória;
- referral/rewards;
- aquisição;
- custos e valor econômico;
- próxima ação relevante.

### FR-CRM-006 — Pipeline

Leads devem possuir estágios e movimentações rastreáveis, sem misturar estágio comercial com estados técnicos de Trial ou Payment.

---

## 8. Requisitos funcionais — Communications

### FR-COM-001 — Inbox omnichannel

O sistema deve normalizar conversas de canais conectados em uma inbox única.

### FR-COM-002 — Continuidade de contexto

Ao identificar a mesma `Person` em outro canal, o agente deve acessar contexto permitido da jornada anterior.

### FR-COM-003 — Communication Policy

Envios proativos devem respeitar:

- opt-out;
- canal permitido;
- frequency caps;
- quiet hours;
- suppression rules;
- estado de suporte/HITL;
- políticas do tenant e do canal.

### FR-COM-004 — Messaging Adapter

A implementação inicial de WhatsApp poderá utilizar API não oficial, mas o domínio deve depender de contrato interno substituível.

### FR-COM-005 — Delivery lifecycle

O sistema deve registrar tentativa, envio, entrega, leitura quando disponível e falha.

---

## 9. Requisitos funcionais — Trial & Compatibility

### FR-TRIAL-001 — Trial único

Por padrão, uma `Person` pode receber somente um Trial tecnicamente válido.

### FR-TRIAL-002 — Retrial controlado

Retrial somente pode ser concedido mediante razão estruturada e rastreada, como:

- falha de instalação comprovada;
- erro de credenciais/provisionamento;
- indisponibilidade relevante do provider;
- incompatibilidade técnica que inviabilizou o teste;
- incidente confirmado;
- exceção administrativa aprovada.

### FR-TRIAL-003 — Eligibility

Antes de criar Trial/Retrial, o sistema deve produzir uma decisão `ALLOW`, `ALLOW_RETRIAL`, `REVIEW` ou `DENY`.

### FR-TRIAL-004 — Anti-abuse

A eligibility deve considerar histórico e sinais de abuso sem depender de um único identificador.

### FR-TRIAL-005 — Technical profile

O sistema deve coletar, quando possível e pertinente:

- device;
- model;
- OS;
- app;
- app version;
- ISP;
- network type;
- provider server;
- playback mode;
- resultado de instalação/autenticação/playback.

### FR-TRIAL-006 — Technical outcome

Um Trial deve possuir outcome técnico distinto de outcome comercial.

### FR-TRIAL-007 — Follow-up condicionado

Follow-ups devem reagir ao estado real do Trial, e não apenas a timers fixos.

### FR-TRIAL-008 — Não vender após falha não resolvida

Quando o Trial falhar tecnicamente por causa ainda não resolvida, o fluxo de venda deve ser suspenso ou condicionado à resolução.

### FR-COMP-001 — Compatibility evidence

O sistema deve acumular outcomes por combinação técnica para permitir ranking e recomendação futura.

---

## 10. Requisitos funcionais — Catalog, Pricing, Offers & Commerce

### FR-CAT-001 — Catálogo próprio

O catálogo do produto pertence ao sistema e deve representar:

- products;
- plans;
- recurring add-ons;
- app licenses;
- bundles.

### FR-CAT-002 — Conexão adicional recorrente

Tela/conexão adicional deve ser modelada como `Subscription Add-on` recorrente.

Ela possui:

- cobrança recorrente ao Customer;
- possibilidade de desconto recorrente/promocional;
- entitlement de conexão adicional;
- custo recorrente do provider em cada ciclo enquanto ativa.

### FR-CAT-003 — Apps pagos

Licenças de apps podem ser vendidas como produto/add-on ou concedidas como reward, preservando supplier cost, retail price e margem.

### FR-OFFER-001 — Oferta autorizada

O Agent não pode inventar preços, descontos ou benefícios. Deve consultar ofertas elegíveis.

### FR-COUPON-001 — Coupon Engine

Cupons devem suportar regras de validade, uso, público, plano, combinação, orçamento e primeira compra/winback quando aplicável.

### FR-ORDER-001 — Order

Toda transação comercial aceita deve gerar Order/Order Items.

### FR-ORDER-002 — Price Snapshot

Valores usados no momento da transação devem ser congelados para preservação histórica.

### FR-ORDER-003 — Settlement

O sistema deve distinguir `Order Settlement` de `Payment`.

Uma Order pode ser liquidada por combinação autorizada de:

- pagamentos externos;
- créditos internos;
- rewards;
- descontos/promotions.

Uma Order com valor externo a pagar igual a zero pode ficar `SETTLED` sem criar um Payment fictício.

---

## 11. Requisitos funcionais — Billing, Subscription & Entitlements

### FR-BILL-001 — Billing próprio

O sistema deve manter estado interno de cobrança independentemente do gateway externo.

### FR-BILL-002 — Asaas inicial

Asaas será o primeiro Billing Provider, atrás de adapter substituível.

### FR-BILL-003 — Idempotência de webhooks

Eventos repetidos do gateway não podem duplicar efeitos.

### FR-SUB-001 — Subscription lifecycle

O sistema deve controlar ciclo recorrente, renovação, overdue, cancellation, reactivation e add-ons recorrentes.

### FR-SUB-002 — Add-on recurring cost

O custo de conexões adicionais deve ser lançado em cada ciclo em que estiverem ativas.

### FR-ENT-001 — Entitlements

Direitos concedidos devem ser representados separadamente do Order e do Provider.

### FR-ENT-002 — Entitlements esperados

O sistema deve ser capaz de representar, entre outros:

- service access;
- connections;
- adult content permission;
- app license;
- courtesy extension;
- subscription/referral credits;
- gift pass;
- temporary upgrade.

---

## 12. Requisitos funcionais — Provider Fulfillment

### FR-PROV-001 — Provider externo

O provider inicial é uma integração de fulfillment, não fonte de verdade do negócio.

### FR-PROV-002 — Provider Adapter

O domínio deve utilizar ferramentas semânticas, como:

- create trial;
- create/renew account;
- migrate server;
- change connections;
- block/unblock;
- synchronize;
- read fulfillment state.

### FR-PROV-003 — API quando suportada

API oficial/autorizada deve ser preferida quando adequada.

### FR-PROV-004 — Browser Worker

Operações sem integração suportada devem ser executadas por Browser Worker com sessão autorizada, evidência e pós-condição.

### FR-PROV-005 — Security challenge

CAPTCHA, 2FA e desafios inesperados devem gerar `HUMAN_REQUIRED`, não bypass automatizado.

### FR-PROV-006 — Provider Operation Ledger

Toda operação externa relevante deve registrar estado, tentativas, inputs, outputs, evidências e resultado.

### FR-PROV-007 — Drift detection

Mudanças inesperadas da interface devem colocar operações afetadas em estado degradado até validação segura.

### FR-PROV-008 — Reconciliation

Divergências entre estado interno e provider devem ser detectadas e tratadas.

---

## 13. Requisitos funcionais — Support, Incident & Knowledge

### FR-SUP-001 — Support case

O sistema deve registrar problema, contexto, tentativas e resolução por cliente.

### FR-SUP-002 — Ticket, Incident e Problem

O produto deve distinguir:

- Ticket: caso individual;
- Incident: impacto coletivo atual;
- Problem: causa recorrente/estrutural.

### FR-SUP-003 — Troubleshooting estruturado

Procedimentos de suporte devem produzir evidência de tentativa e resultado.

### FR-KNOW-001 — Knowledge lifecycle

Conhecimento deve possuir status, origem, confidence, freshness, success/failure evidence e histórico.

### FR-KNOW-002 — Ranking de soluções

Soluções devem ser priorizadas por contexto e evidência operacional, não apenas por similaridade textual.

### FR-KNOW-003 — External source quarantine

Conteúdo externo deve entrar como não confiável/candidato antes de se tornar conhecimento canônico.

### FR-KNOW-004 — YouTube ingestion

O sistema deve permitir pipeline de ingestão de vídeos/transcrições usando `yt-dlp` quando aplicável e permitido, preservando fonte, timestamps e segmentos relevantes.

### FR-KNOW-005 — Human guidance reuse

Orientação humana que resolver um caso deve poder se tornar Candidate Knowledge.

---

## 14. Requisitos funcionais — Agent, Policy & HITL

### FR-AI-001 — Agente operacional

O Agent deve poder atuar em vendas, suporte, billing communication, retention, referral e follow-up conforme permissões.

### FR-AI-002 — Policy before action

Tool calls devem ser avaliadas por Policy/Business Rules antes da execução.

### FR-AI-003 — Action risk

Ações devem possuir classe de risco; requirement de aprovação combina risco, autonomia, confiança e contexto.

### FR-AI-004 — HITL

O agente deve conseguir escalar para humano com resumo estruturado e manter o Customer em estado apropriado de espera.

### FR-AI-005 — Human takeover

Operador pode assumir e devolver a conversa ao Agent sem perda de contexto.

### FR-AI-006 — Agent release

Versões do Agent devem ser rastreáveis por model, prompt, policies, tools, knowledge/retrieval config e eval result.

### FR-AI-007 — Shadow Mode

A plataforma deve permitir avaliar decisões do Agent sem executar ações.

### FR-AI-008 — Kill switch

Admin deve conseguir suspender capacidades críticas sem deploy.

---

## 15. Requisitos funcionais — Referral, Loyalty & Rewards

### FR-REF-001 — Referral tracking

Indicações devem ser rastreadas da origem à conversão e retenção.

### FR-REF-002 — Referral moments

O produto deve permitir gatilhos de referral após:

- compra/ativação bem-sucedida;
- renovação;
- feedback positivo;
- resolução satisfatória;
- marco de fidelidade;
- campanha de winback.

### FR-REF-003 — Referral as acquisition channel

Referral deve possuir CAC, LTV, margin e conversion próprias.

### FR-LOY-001 — Reward catalog

Rewards podem incluir:

- courtesy days;
- internal credits;
- app license;
- free renewal;
- gift pass;
- temporary additional connection;
- discount;
- upgrade.

### FR-LOY-002 — Recurring reward economics

Rewards recorrentes ou de duração prolongada devem considerar custo futuro esperado.

Uma conexão adicional permanente nunca deve ser tratada como reward de custo único.

### FR-LOY-003 — Courtesy extension

O recurso externo de aproximadamente três dias de confiança deve ser tratado como capability/benefit condicionado às regras vigentes do provider, com cooldown rastreado.

### FR-LOY-004 — Gift Pass

Benefícios presenteáveis devem permitir medir redemption e conversão do destinatário.

### FR-LOY-005 — Reward Wallet

Créditos internos e rewards devem possuir ledger/auditoria e regras de expiração/uso.

### FR-RISK-001 — Referral/reward anti-abuse

Self-referral, loops, trial abuse, coupon abuse e gift self-redemption devem poder gerar revisão ou bloqueio.

---

## 16. Requisitos funcionais — Financial, Inventory & Procurement

### FR-FIN-001 — Financial Ledger

Movimentações financeiras devem ser append-only/auditáveis.

### FR-FIN-002 — Profitability

O produto deve calcular, quando os dados existirem:

- revenue;
- provider COGS;
- app cost;
- payment fees;
- paid acquisition;
- discounts;
- referral/reward cost;
- AI/messaging/infrastructure allocation;
- gross/contribution profit.

### FR-FIN-003 — Profit dimensions

A análise deve suportar dimensões como Customer, Plan, Channel, Campaign, Creative, Coupon, Referral, Cohort, Device e Provider Server.

### FR-INV-001 — Provider Credit Inventory

Provider credits devem ser tratados como estoque com purchase, batch, unit cost, consumption e balance.

### FR-INV-002 — Recurring connection COGS

Cada ciclo com conexão adicional ativa deve registrar custo correspondente de provider credits/capacity.

### FR-INV-003 — Forecast

O sistema deve calcular burn rate, days of inventory, safety stock e reorder recommendation.

### FR-PROC-001 — Supplier economics

O produto deve suportar suppliers, cost versions, volume discounts e commercial agreements para análise de procurement.

---

## 17. Requisitos funcionais — Growth, Content & Experimentation

### FR-GROW-001 — Attribution

A aquisição deve ser rastreável de Campaign/Creative até Trial, Customer, Renewal, LTV e Profit quando os identificadores permitirem.

### FR-GROW-002 — Paid platforms

Meta Ads, Google Ads e TikTok Ads são integrações-alvo, mas não são requisitos do MVP core.

### FR-GROW-003 — Profit-based optimization

O objetivo de Growth deve priorizar contribuição econômica e qualidade do Customer, não somente CPL/ROAS superficial.

### FR-CONT-001 — Asset library

Ativos de conteúdo devem possuir fonte, tags, status de direito/uso e derivados.

### FR-CONT-002 — Content compliance

Conteúdo com direito desconhecido/restrito não pode entrar em publicação automática.

### FR-EXP-001 — Experiment

Alterações comerciais relevantes devem poder ser avaliadas por experimento com hipótese, população, controle/tratamento, exposição, métrica primária e guardrails.

### FR-EXP-002 — Learning vs policy

Insights do sistema podem recomendar mudança, mas correlação isolada não altera automaticamente pricing, rewards, budgets ou eligibility.

---

## 18. Requisitos funcionais — Analytics & Metrics Governance

### FR-DATA-001 — Tracking Plan

Eventos de produto devem possuir definição canônica e schema versionado.

### FR-DATA-002 — Metric Catalog

Métricas críticas devem possuir fórmula, população, janela, exclusões e source events canônicos.

### FR-DATA-003 — Cohorts

Retention, conversion, LTV e profit devem ser analisáveis por coorte relevante.

### FR-DATA-004 — Baseline

Antes da automação ampla no tenant piloto, o sistema/projeto deve registrar baseline operacional suficiente para comparação before/after.

---

## 19. Requisitos funcionais — Workflow Reliability

### FR-WF-001 — Durable state

Processos longos devem sobreviver a reinício/deploy/falha de worker.

### FR-WF-002 — Idempotency

Comandos/eventos repetidos não devem duplicar efeitos econômicos ou operacionais.

### FR-WF-003 — Retry/backoff

Integrações externas devem possuir retries limitados e backoff apropriado.

### FR-WF-004 — Dead-letter / human recovery

Falhas persistentes devem ficar visíveis e recuperáveis, nunca simplesmente desaparecer.

### FR-WF-005 — Compensation

Workflows multi-etapa devem definir estado e estratégia quando uma etapa intermediária falha.

### FR-WF-006 — Reconciliation

O sistema deve reconciliar periodicamente integrações que representam estado financeiro ou fulfillment relevante.

---

## 20. Requisitos funcionais — SaaS Control Plane

### FR-SAAS-001 — Tenant isolation

Dados, jobs, events, storage, analytics e knowledge devem respeitar contexto do tenant.

### FR-SAAS-002 — Tenant RBAC

Usuários devem possuir permissões conforme papel e tenant.

### FR-SAAS-003 — Usage metering

O sistema deve medir consumo relevante por tenant, mesmo durante o piloto.

### FR-SAAS-004 — Tenant configuration

Cada tenant poderá futuramente configurar brand, products, policies, channels, providers, billing, agent, autonomy, benefits e communication rules.

### FR-SAAS-005 — SaaS feature entitlements

Capacidades disponíveis ao próprio tenant devem ser controláveis por plano/feature entitlement do SaaS.

---

## 21. Requisitos não funcionais

### NFR-001 — Auditoria

Ações críticas devem ser atribuíveis a human, agent, workflow ou integration.

### NFR-002 — Segurança

Aplicar least privilege, tenant isolation, authorization por recurso e secrets management.

### NFR-003 — Privacidade

O sistema deve permitir políticas de retenção, preferências, export/correction/deletion workflows quando aplicáveis e registro de bases/consentimentos quando necessários.

### NFR-004 — Observabilidade

Features críticas devem emitir logs estruturados, metrics e traces adequados.

### NFR-005 — Degradação controlada

Falha de um provider não deve corromper o estado autoritativo do negócio.

### NFR-006 — Recuperabilidade

Backups, restore e requisitos de RPO/RTO deverão ser definidos antes de produção real.

### NFR-007 — Evolução modular

Novos providers devem poder ser adicionados sem alterar regras centrais de negócio.

### NFR-008 — Documentação versionada

Mudanças relevantes de comportamento devem atualizar documentação e contratos canônicos.

### NFR-009 — Compliance

A plataforma não deve ser desenhada para evasão de políticas, controles de acesso ou direitos de terceiros.

---

## 22. Escopo do MVP

O recorte canônico é detalhado em `scope.md`.

O MVP deve provar:

```text
WhatsApp
+ Identity/CRM
+ Agent
+ Trial/Eligibility
+ Compatibility básica
+ Commerce/Order
+ Asaas
+ Subscription/Entitlements
+ Provider Fulfillment
+ Browser Worker
+ Follow-up
+ Support
+ HITL
+ Knowledge básico
+ Financial/Inventory básico
+ Referral Core
+ Events/Audit
+ Main Dashboard
```

O MVP não precisa entregar Growth/Content/Gamification completos, mas a modelagem não pode impedir sua evolução posterior.

---

## 23. Métricas de sucesso

As métricas e critérios de maturidade são detalhados em `success-metrics.md`.

Categorias prioritárias:

- Lead → Trial;
- Trial technical pass;
- Trial → Paid;
- First Response Time;
- AI Resolution Rate;
- Human Escalation Rate;
- Renewal Rate;
- Churn;
- Referral Share;
- CAC;
- LTV;
- Gross/Contribution Margin;
- Provider Operation Success Rate;
- Billing/Reconciliation drift;
- Trial abuse/retrial rate;
- Human hours saved.

---

## 24. Dependências e premissas

- existe provider externo capaz de cumprir fulfillment;
- o tenant possui acesso autorizado às contas e sistemas integrados;
- o serviço operado pelo tenant possui as autorizações/direitos necessários para comercialização e promoção aplicáveis;
- o gateway financeiro oferece mecanismo confiável de confirmação/reconciliação;
- a mensageria inicial pode sofrer limitações por usar provider não oficial e, portanto, precisa ser substituível;
- algumas operações do provider exigirão browser automation;
- preços, custos, policies e limites do provider podem mudar e devem ser configuráveis/versionados.

---

## 25. Riscos principais do produto

### R1 — Dependência operacional de provider externo

Mitigação: source of truth próprio, adapter, reconciliation, retries e provider health.

### R2 — Browser drift

Mitigação: semantic operations, evidence, trace, versioning, drift detection e HITL.

### R3 — Abuse econômico

Mitigação: Trial Eligibility, Risk Engine, reward/coupon/referral controls.

### R4 — Agente executar ação errada

Mitigação: policies, action risk, evals, shadow mode, approval, kill switches e audit.

### R5 — Otimização por métrica errada

Mitigação: Tracking Plan, Metric Catalog, experiments e guardrails.

### R6 — Margem corroída por benefícios recorrentes

Mitigação: reward economics, expected future cost e profitability by entitlement/add-on.

### R7 — Falha de integração após confirmação financeira

Mitigação: durable workflows, fulfillment pending state, reconciliation e compensation.

### R8 — Vazamento cross-tenant

Mitigação: tenant-aware authorization, isolation, testing e audit.

---

## 26. Critérios para considerar o MVP validado

O MVP não será considerado validado apenas por estar funcional.

Precisará demonstrar no tenant piloto que:

1. o ciclo Lead → Trial → Paid → Fulfillment funciona ponta a ponta;
2. o sistema mantém estado correto mesmo quando integrações falham;
3. Trial abuse pode ser limitado sem bloquear excessivamente leads legítimos;
4. o Agent resolve uma parcela mensurável do atendimento com qualidade aceitável;
5. HITL permite recuperar exceções sem perda de contexto;
6. pagamentos e renewals são rastreáveis e reconciliáveis;
7. COGS e margem por Customer/Subscription podem ser calculados;
8. conexão adicional recorrente é corretamente cobrada e custeada em cada ciclo;
9. baseline e métricas after automation são comparáveis;
10. Referral Core consegue atribuir e medir indicações desde o piloto;
11. logs/auditoria permitem explicar ações críticas.

Metas numéricas iniciais serão definidas após captura de baseline real, evitando metas arbitrárias sem histórico.

---

## 27. Critérios de evolução para V1 comercializável

Antes de vender amplamente como SaaS, além do MVP validado, será necessário comprovar:

- tenant provisioning e isolamento;
- RBAC;
- usage metering;
- onboarding repetível;
- observabilidade operacional;
- backups/restore testados;
- provider/message/billing adapters configuráveis;
- documentação operacional;
- política de suporte do SaaS;
- métricas de custo por tenant;
- controles mínimos de privacidade/compliance;
- processo de release/eval do Agent.

---

## 28. Relação com documentos canônicos

Este PRD define **o que** o produto deve entregar.

As seguintes informações não devem ser duplicadas aqui em detalhe:

- vocabulário: `../00-vision/glossary.md`;
- princípios: `../00-vision/principles.md`;
- fronteiras e ownership: `../02-domain/domain-map.md`;
- atores: `personas-actors.md`;
- jornadas: `journeys.md`;
- escopo NOW/NEXT/LATER: `scope.md`;
- definições de sucesso: `success-metrics.md`.

Specs posteriores definirão **como** capacidades específicas serão implementadas.

---

## 29. Auto-revisão aplicada

Este arquivo foi revisado contra Vision, Principles, Glossary e Domain Map para verificar:

- separação entre requisito de produto e decisão técnica;
- Trial único + Retrial excepcional;
- conexão/tela adicional como add-on recorrente e COGS recorrente;
- separação Commerce → Entitlements → Fulfillment;
- tratamento de falhas externas e reconciliação;
- multi-tenancy desde a base;
- governança de IA e HITL;
- métricas econômicas, não apenas operacionais;
- ausência de dependência estrutural do painel/provider;
- compliance como restrição, não mecanismo de evasão.

## 24. Refinamentos funcionais consolidados v0.14

Os requisitos abaixo refinam os Módulos 1–9 e prevalecem sobre formulações genéricas anteriores quando houver conflito.

### CRM e operação

- CRM é workspace/projeção operacional; estados canônicos continuam pertencendo aos domínios.
- Pipelines especializados: Comercial, Ativação, Renovação e Recuperação; estágio de pipeline não substitui estado de domínio.
- `Next Action`, `Attention Score`, Customer Health, filtros e Saved Views são requisitos centrais.
- Customer é criado no fato comercial de settlement/pagamento confirmado, mesmo que fulfillment esteja pendente.
- Customer 360 inclui dispositivos, app atual, MAC, Device ID/App Key e `last_verified_at` quando aplicável.

### Comunicação

- IA atende Inbox por padrão; humano entra por Review/Takeover/Policy.
- Múltiplas Channel Accounts por tenant.
- Follow-up é intenção reavaliada no momento da execução e deve respeitar `Conversation Focus`.
- Central de Notificações, Programadas e Central de Atividade da IA são requisitos de Control Center.

### Comercial e pagamentos

- preço mensal inicial confirmado: R$30; demais períodos/preços são configuração versionada.
- Agent negocia somente dentro de policy/faixa autorizada.
- PIX é default; cartão alternativo; boleto exceção.
- pagamento parcial externo não faz parte do MVP; créditos/rewards reduzem o net antes da cobrança.
- renovação antecipada pode receber desconto imediato configurável.
- reembolso sempre exige Human Review.

### Assinatura/provider

- conexão adicional é recorrente e opcional por renovação, mas herda o vencimento da assinatura atual quando adicionada no meio do ciclo.
- redução de conexão já paga só entra na próxima renovação.
- dispositivos configurados são independentes de conexões simultâneas; o provider aplica simultaneidade.
- conteúdo adulto é preferência confirmada no início, default configurável inicialmente ON e alterável a qualquer momento.
- Renovação em Confiança: +3 dias fixos, conta ativa, <=3 dias até vencer.

### Fornecedor e onboarding

- toda operação automatizada relevante deve possuir interface manual equivalente no front, usando o mesmo command/policy/audit.
- onboarding deve suportar importação automática da base existente do provider com preview, dedupe/idempotência e reconciliation.
- modo Observação → Recomendar → Aprovação → Automático é a progressão padrão de autonomia.

### Estoque/procurement

- suportar créditos pré-pagos, saldo de fornecedor de apps e future monthly credit batches com expiry/FEFO.
- app pago só é comprado após teste gratuito, aceite e pagamento do cliente.
- futuro canal de Revendedores pode vender créditos do mesmo pool econômico; escopo de implementação permanece LATER.

### Suporte/inteligência

- suporte confirma dados voláteis conhecidos, sem repetir perguntas desnecessárias.
- Operational Signals podem ser ingeridos de canais autorizados e correlacionados com tickets.
- suporte pode pesquisar web/comunidades/YouTube e usar `yt-dlp` quando permitido; conteúdo externo nasce UNTRUSTED.
- knowledge global exige sanitização, provenance e validação antes de promoção.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — modules 1–9 requirements reconciled.
