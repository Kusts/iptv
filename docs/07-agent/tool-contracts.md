# Agent Tool Contracts — MVP

> Status: Draft auto-revisado  
> Versão: 1.0  
> Autoridade: interface semântica inicial entre Agent Runtime e Domain/API.  
> Regra: tools não contornam Policy/Risk/Authorization.

## 1. Padrão de toda tool

Cada execução registra:

```text
tool_execution_id
agent_run_id
tenant_id
actor/context
input schema version
policy decision
risk decision when applicable
idempotency/effect key when mutating
correlation_id
result status
structured output
latency
error classification
```

Statuses genéricos da tool runtime:

```text
SUCCEEDED
DENIED
REVIEW_REQUIRED
FAILED_RETRYABLE
FAILED_TERMINAL
```

Esses statuses são do runtime da tool; não substituem estados do domínio.

## 2. `get_customer_context`

### Propósito

Retornar contexto mínimo autorizado para atendimento.

### Input

```text
person_id | customer_id | conversation-derived identity
requested_sections[]
```

### Output

Resumo estruturado de:

- lifecycle;
- active subscription;
- entitlements;
- trial history;
- open support;
- payment/renewal summary;
- referral eligibility summary;
- communication constraints.

### Restrições

- aplicar tenant isolation;
- respeitar field-level privacy;
- não retornar secrets/provider credentials.

## 3. `evaluate_trial_eligibility`

### Propósito

Consultar decisão canônica antes de oferecer/criar trial.

### Resultado de domínio

```text
ALLOW
ALLOW_RETRIAL
REVIEW
DENY
```

Agent não pode reinterpretar `DENY` como permissão.

## 4. `create_trial`

### Preconditions

- eligibility válida/revalidável;
- Person resolvida;
- policy permite;
- dados técnicos mínimos quando exigidos.

### Efeito

Cria Trial e inicia provisioning workflow.

### Result

Retorna Trial state, provider operation reference e próximos passos; não promete acesso antes de `ACTIVE`.

## 5. `resolve_offer`

### Propósito

Obter oferta comercial permitida para o contexto atual.

Agent pode apresentar somente ofertas retornadas por esta tool ou explicitamente autorizadas por policy.

### Input contextual

- customer/person;
- stage;
- trial result;
- active subscription;
- referral/reward balances;
- campaign attribution when relevant.

### Output

```text
offer_id
items
price
allowed discounts
valid_until
explanatory metadata
```

## 6. `create_order`

Cria Order a partir de offer/selection válida.

Não aceita preço arbitrário inventado pelo LLM.

## 7. `create_payment`

Cria cobrança externa para Order com saldo líquido > 0.

Se Order já pode ser liquidada integralmente por rewards/créditos válidos, Commerce decide; agente não cria Payment fictício.

## 8. `get_payment_status`

Somente leitura do estado canônico + reconciliation metadata apropriada.

Mensagem do usuário “já paguei” nunca altera estado por si só.

## 9. `create_renewal_order`

Gera novo ciclo comercial para Subscription.

Inclui recurring add-ons ativos — especialmente conexão/tela adicional — e price snapshot do novo ciclo.

## 10. `request_provider_operation`

### Uso

Somente para ações autorizadas, por exemplo:

```text
MIGRATE_SERVER
SYNC_CUSTOMER
CHANGE_CONNECTIONS
TRUST_RENEWAL
BLOCK_CUSTOMER
UNBLOCK_CUSTOMER
```

### Guardrails

- action risk class;
- tenant autonomy;
- entitlement/subscription precondition;
- provider capability;
- HITL quando necessário.

Agent não envia selectors ou scripts de browser.

## 11. `create_support_ticket`

Cria Ticket quando atendimento precisa persistência/escalation.

Deve vincular:

- Person/Customer;
- conversation;
- symptoms;
- device/app/network context conhecido;
- attempts já executadas.

## 12. `record_solution_outcome`

Registra que uma solução foi tentada e seu resultado.

Nunca promove automaticamente conhecimento externo a VERIFIED apenas pela opinião do modelo.

## 13. `request_human_guidance`

### Quando usar

- baixa confiança;
- policy exige;
- security challenge;
- ação R3/R4 sem autonomia;
- troubleshooting esgotado;
- conflito de estado.

### Payload

```text
problem
customer context summary
what was tried
observed outcomes
hypotheses
recommended next action
specific question for human
```

## 14. `send_message`

Passa por Communication Policy Engine antes do provider.

Verifica:

- opt-out;
- channel permission;
- frequency cap;
- quiet hours;
- human takeover;
- suppression.

## 15. `ask_for_referral`

Não é simplesmente template de mensagem.

Preconditions:

- customer eligible;
- positive/safe moment;
- no active severe support issue;
- communication policy allows;
- referral campaign/rules active.

## 16. `grant_reward`

MVP: somente rewards já definidos e elegíveis.

Não aceita reward arbitrário criado em linguagem natural.

Passa por:

- reward definition;
- qualification;
- anti-abuse;
- economics/policy;
- ledger.

## 17. `grant_trust_renewal`

Ação provider-specific, não benefício livre. No CINEVISION inicial exige:

- conta `ACTIVE`;
- `remaining_days <= 3`;
- extensão fixa de +3 dias;
- risk/policy/audit;
- postcondition da nova expiração.

Conta vencida ou duração arbitrária retorna `NOT_ELIGIBLE/PROVIDER_CAPABILITY_UNAVAILABLE`.

## 18. Erros estruturados

Tools devem retornar códigos estáveis, por exemplo:

```text
POLICY_DENIED
RISK_REVIEW_REQUIRED
NOT_ELIGIBLE
STATE_CONFLICT
IDEMPOTENCY_CONFLICT
PROVIDER_UNAVAILABLE
PROVIDER_HUMAN_REQUIRED
PAYMENT_NOT_CONFIRMED
TENANT_ACCESS_DENIED
VALIDATION_ERROR
```

LLM recebe mensagem segura para o usuário separada de detalhes internos.

## 19. Tool risk classes — baseline

```text
R0 read/context
R1 create eligible trial / ticket / normal message
R2 create order/payment / apply preapproved offer
R3 provider migration/change connections/courtesy benefit
R4 refund, destructive delete, high-value exception, material ad-budget change
```

Classificação final pertence à policy architecture; esta lista é baseline para SPECs.

## 20. Critérios de aceitação

- nenhuma tool mutante ignora tenant/policy;
- nenhuma tool comercial aceita preço inventado;
- nenhum provider operation expõe browser internals ao agent;
- tool retries são idempotentes;
- tool result diferencia domain state de runtime status;
- sensitive fields são redacted em traces;
- human review fica auditável.

## 18. Refinamentos de tools v0.14

Semantic tools devem usar `grant_trust_renewal` como fixed provider capability, sem courtesy genérica no provider inicial, `import_provider_customers`, `change_adult_content`, `recommend_app`, `start_app_trial`, `purchase_app_license`, `ingest_operational_signal` e `research_support_source`.

`grant_trust_renewal` valida ACTIVE + <=3 dias; `purchase_app_license` exige Order SETTLED e Supplier Balance reservation; `refund` permanece Human Review only. As ações manuais do Control Center chamam os mesmos command handlers.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — semantic tool refinements checked.

