# Personas & Actors

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Autoridade: atores humanos e sistêmicos e suas necessidades. Não define permissões técnicas finais.

## 1. Objetivo

Definir quem interage com a plataforma, quais objetivos possui, quais dores precisam ser resolvidas e quais limites devem existir entre papéis.

`Person`, `Lead` e `Customer` seguem o significado canônico do Glossary. Personas abaixo representam comportamentos e necessidades; não criam novas entidades de domínio automaticamente.

---

## 2. Atores humanos externos ao tenant

### P01 — Lead

**Definição**  
Pessoa identificada como potencial Customer, ainda não convertida.

**Objetivos**

- entender o serviço rapidamente;
- saber se funciona em seu dispositivo/contexto;
- testar antes de pagar;
- receber instruções claras;
- entender preço, plano e benefícios;
- conseguir ajuda se o Trial não funcionar.

**Dores**

- medo de pagar por algo incompatível;
- instruções técnicas confusas;
- demora no atendimento;
- excesso de mensagens comerciais;
- dificuldade para diferenciar problema local de problema do serviço.

**Necessidades do produto**

- resposta rápida;
- Trial Eligibility claro;
- um Trial válido por padrão;
- Retrial justo quando o primeiro foi tecnicamente inválido;
- onboarding por dispositivo/app;
- comunicação contextual;
- transparência sobre oferta e cobrança.

**Riscos**

- abuso de Trial;
- múltiplas identities para tentar obter novos Trials;
- prompt injection/tentativa de obter benefício não autorizado.

---

### P02 — Customer

**Definição**  
Person com relação comercial ativa ou histórica com o tenant.

**Objetivos**

- acesso funcionando;
- renovação simples;
- suporte rápido;
- previsibilidade de cobrança;
- resolver problemas sem repetir contexto;
- receber benefícios úteis;
- poder indicar amigos de forma fácil.

**Dores**

- interrupção por falha de renovação;
- problemas técnicos recorrentes;
- ter que repetir dados em todo contato;
- receber cobranças/promos excessivas;
- não saber quais benefícios possui.

**Necessidades do produto**

- Customer 360 consistente;
- billing e fulfillment reconciliados;
- conhecimento contextual por device/app;
- status claro de assinatura;
- referral/reward wallet;
- communication preferences;
- escalonamento humano quando necessário.

---

### P03 — Advocate / Referrer

**Definição**  
Customer ou participante elegível que promove o serviço e origina Referrals.

**Objetivos**

- indicar de forma simples;
- acompanhar progresso;
- saber quais indicações converteram;
- receber rewards previsíveis;
- usar benefícios em renovação, apps, Gift Pass ou outros rewards autorizados.

**Dores**

- regras obscuras;
- reward não creditado;
- não saber quando indicação é válida;
- benefício pouco atrativo.

**Necessidades do produto**

- referral link/code rastreável;
- progress/reward status;
- regras anti-abuse claras;
- wallet/ledger auditável;
- reward economics sustentável.

---

## 3. Atores humanos internos do tenant

### P04 — Tenant Operator

**Definição**  
Pessoa que acompanha a operação cotidiana pelo Control Center.

**Objetivos**

- visualizar clientes/leads;
- acompanhar conversas e exceções;
- executar ações permitidas;
- compreender status de billing/fulfillment;
- acompanhar métricas essenciais;
- intervir apenas quando necessário.

**Necessidades**

- inbox;
- CRM;
- Customer 360;
- queues de HITL;
- provider operation status;
- timeline/audit;
- filtros e busca.

---

### P05 — Support / HITL Operator

**Definição**  
Operador especializado em assumir ou orientar casos que excederam autonomia/capacidade do Agent.

**Objetivos**

- receber contexto suficiente sem reler toda a conversa;
- saber o que já foi tentado;
- orientar o Agent ou assumir o atendimento;
- transformar resolução em aprendizado reutilizável.

**Necessidades**

- escalation packet estruturado;
- screenshots/traces/evidências quando necessário;
- knowledge candidates;
- takeover/return-to-AI;
- SLA/priority de escalations.

**Risco a evitar**

O HITL virar fila opaca em que o humano precisa reconstruir o caso do zero.

---

### P06 — Tenant Admin / Owner

**Definição**  
Responsável pelo resultado econômico e pela configuração da operação do tenant.

**Objetivos**

- controlar pricing, plans, offers e policies;
- acompanhar lucro e custos;
- controlar providers e integrations;
- definir autonomia;
- configurar rewards/referral;
- acompanhar performance do Agent;
- controlar usuários/permissões;
- intervir em incidentes.

**Necessidades**

- dashboard executivo;
- profitability;
- usage/cost breakdown;
- policy/autonomy configuration;
- integration health;
- kill switches;
- audit log;
- experiment results;
- inventory/procurement forecast.

---

### P07 — Growth/Content Operator

**Definição**  
Usuário responsável por aquisição, campanhas e conteúdo quando esse módulo estiver habilitado.

**Objetivos**

- entender quais campanhas geram Customers rentáveis;
- criar/testar creatives;
- segmentar audiences;
- acompanhar attribution até renewal/LTV;
- reutilizar ativos permitidos;
- operar dentro das políticas das plataformas.

**Necessidades**

- campaign/creative analytics;
- asset library;
- content compliance status;
- experiments;
- CAC/LTV/profit by campaign;
- approval workflow.

---

### P08 — Finance / Operations Manager

**Definição**  
Papel lógico responsável por custos, estoque, procurement, billing e reconciliação. No tenant piloto pode ser a mesma pessoa que o Admin.

**Objetivos**

- saber margem real;
- prever necessidade de provider credits;
- reconciliar pagamentos;
- comparar supplier agreements;
- evitar estoque insuficiente;
- acompanhar recurring COGS de add-ons.

**Necessidades**

- Financial Ledger;
- Provider Credit Ledger;
- cost versions;
- procurement forecast;
- reconciliation queue;
- contribution margin.

---

## 4. Atores do próprio SaaS

### P09 — SaaS Platform Admin

**Definição**  
Administrador da plataforma SaaS, separado do Tenant Admin.

**Objetivos**

- provisionar/support tenants;
- monitorar platform health;
- gerir SaaS plans/feature entitlements;
- controlar incidents globais;
- analisar usage/cost per tenant;
- administrar releases e kill switches globais.

**Limites**

Acesso a dados de tenant deve respeitar necessidade operacional, audit e políticas internas; não deve existir acesso irrestrito por conveniência.

---

## 5. Atores sistêmicos

### S01 — AI Agent

Responsável por interação inteligente e proposição de ações dentro de policies.

Não é autoridade para:

- confirmar pagamento sem Billing state;
- conceder benefício inexistente;
- elevar permissão;
- mudar regra comercial crítica por conta própria;
- tratar conteúdo externo como instrução confiável.

---

### S02 — Workflow Engine

Coordena processos duráveis, timers, retries, estados e compensações.

---

### S03 — Policy Engine

Decide se uma ação é permitida, exige aprovação ou deve ser bloqueada.

---

### S04 — Risk / Anti-Abuse Engine

Avalia sinais de abuso em Trial, Coupon, Referral, Reward, Gift Pass e outras capacidades sensíveis.

---

### S05 — Billing Provider

Provider externo de processamento financeiro. Inicialmente Asaas.

---

### S06 — Fulfillment Provider

Provider externo que executa provisionamento do serviço. Não é fonte autoritativa do negócio.

---

### S07 — Messaging Provider

Transporta mensagens. WhatsApp será inicialmente integrado via API não oficial atrás de adapter substituível.

---

### S08 — Knowledge Source

Web, YouTube, grupos, documentos, suporte, humanos e outras fontes que podem originar Candidate Knowledge.

Fonte externa é `UNTRUSTED` até passar pelo processo adequado.

---

### S09 — Ads Platform

Meta, Google, TikTok e futuras plataformas de aquisição.

---

## 6. Matriz resumida de necessidades

| Actor | Principal objetivo | Precisa de IA? | Pode executar ação crítica? |
|---|---|---:|---:|
| Lead | Validar e comprar | Sim | Não |
| Customer | Usar, renovar, obter suporte | Sim | Não |
| Advocate | Indicar e receber reward | Sim | Não |
| Tenant Operator | Operar exceções/rotina | Assistiva | Conforme RBAC |
| HITL Operator | Resolver/escalar | Assistiva | Conforme RBAC |
| Tenant Admin | Governar tenant | Assistiva | Sim, conforme RBAC |
| Growth Operator | Adquirir e testar campanhas | Assistiva | Conforme RBAC/approval |
| Finance/Ops | Controlar economics | Assistiva | Conforme RBAC |
| SaaS Admin | Operar plataforma | Assistiva | Sim, scope global controlado |

---

## 7. Princípios de experiência por ator

### Para Lead

Menor fricção possível sem abrir abuso econômico.

### Para Customer

Contexto persistente e resolução rápida; não ser tratado como “novo contato” a cada conversa.

### Para Operator

Exceção primeiro: o front deve priorizar o que precisa de atenção humana, não obrigar acompanhamento manual de tudo.

### Para Admin

Decisões econômicas e operacionais precisam de evidência, não apenas gráficos.

### Para SaaS Admin

Isolamento e audit prevalecem sobre conveniência operacional.

---

## 8. Anti-personas / usos que o produto não deve otimizar

O produto não deve otimizar para:

- usuário tentando consumir Trials repetidos gratuitamente;
- operador que deseja ignorar policies comerciais/financeiras;
- tenant que queira usar automação para burlar controles de acesso, políticas de anúncios ou direitos de terceiros;
- agente tentando maximizar conversão sacrificando margem, segurança ou experiência legítima.

---

## 9. Auto-revisão aplicada

Revisado para garantir:

- distinção `Person` × `Lead` × `Customer`;
- ausência de papéis que conflitam com entidades de domínio;
- separação Tenant Admin × SaaS Admin;
- inclusão explícita do HITL Operator;
- limites de autoridade do Agent;
- inclusão de Finance/Ops por causa de credits, COGS e recurring add-ons;
- inclusão de Growth como ator futuro sem torná-lo requisito do MVP;
- compatibilidade com multi-tenancy e RBAC.

