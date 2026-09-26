# SPEC — Trial & Retrial Engine

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Versão: 1.0  
> Slice: MVP-02  
> Dependências: Identity & CRM, Risk/Policy baseline, Provider Fulfillment interface

## 1. Objetivo

Garantir que Trial seja instrumento de qualificação técnica/comercial e não acesso gratuito recorrente, preservando exceções legítimas por falha comprovada.

## 2. Princípio central

> Uma `Person` recebe, por padrão, **um único Trial válido**. Novo Trial gratuito exige `ALLOW_RETRIAL` por motivo estruturado e evidência compatível.

## 3. Máquinas separadas

### Trial Access Lifecycle

```text
REQUESTED
PROVISIONING
ACTIVE
ENDED
INVALIDATED
CANCELLED
```

### Technical Assessment

```text
PENDING
PASSED
FAILED
INCONCLUSIVE
```

`PASSED` não encerra o acesso. Um Trial pode permanecer `ACTIVE` após o technical pass até o término da janela.

## 4. Eligibility

Resultado canônico:

```text
ALLOW
ALLOW_RETRIAL
REVIEW
DENY
```

### ALLOW

Somente quando não existe Trial válido anterior para a Person, salvo migração de legado explicitamente autorizada.

### ALLOW_RETRIAL

Exige referência ao Trial original, motivo e evidência suficiente.

Razões iniciais:

```text
INSTALLATION_FAILURE_VERIFIED
PROVIDER_INCIDENT
SERVER_FAILURE
INVALID_CREDENTIALS
PROVISIONING_ERROR
APP_INCOMPATIBILITY
NETWORK_DIAGNOSTIC_REQUIRED
ADMIN_EXCEPTION
OTHER_VERIFIED_REASON
```

`OTHER_VERIFIED_REASON` exige descrição e auditoria.

## 5. API

```text
POST /v1/trials/eligibility
POST /v1/trials
GET  /v1/trials/{trialId}
```

Fluxo esperado:

```text
Eligibility
↓
ALLOW / ALLOW_RETRIAL
↓
Create Trial
↓
Provider provisioning operation
↓
ACTIVE only after provider postcondition verified
```

`createTrial` deve revalidar elegibilidade ou consumir uma decisão ainda válida; não confiar apenas em decisão antiga enviada pelo cliente.

## 6. Persistência

Entidades principais:

- `trial_eligibility_decisions`;
- `trials`;
- `trial_attempts`;
- `trial_technical_results`;
- `device_profiles`;
- `app_profiles`;
- `network_observations`;
- `compatibility_observations`.

## 7. Eventos

```text
trial.requested.v1
trial.eligibility_allowed.v1
trial.retrial_allowed.v1
trial.eligibility_review_required.v1
trial.eligibility_denied.v1
trial.provisioning_started.v1
trial.provisioning_failed.v1
trial.activated.v1
trial.technical_passed.v1
trial.technical_failed.v1
trial.technical_inconclusive.v1
trial.expired.v1
trial.invalidated.v1
trial.cancelled.v1
trial.first_playback_observed.v1
trial.followup_due.v1
```

## 8. O que torna um Trial válido

A regra exata pertence ao domínio, mas para o MVP um Trial só deve consumir a oportunidade gratuita quando houve acesso tecnicamente utilizável ou evidência suficiente de que a oportunidade foi efetivamente entregue.

Não considerar Trial válido apenas porque uma linha foi criada no banco.

Exemplos que podem invalidar/retrial:

- credencial nunca funcionou;
- provider ficou indisponível durante janela relevante;
- provisionamento não completou;
- instalação exigida não pôde ser concluída por falha comprovada;
- erro interno reduziu materialmente a janela útil.

## 9. Anti-abuse

Risk Engine avalia sinais como:

- mesma identity/contact;
- tentativas repetidas;
- vínculos já confirmados com customer anterior;
- padrões de referral/gift abuse;
- sinais técnicos permitidos pela política de privacidade.

O MVP deve preferir `REVIEW` a `DENY` quando a evidência for ambígua.

## 10. Follow-up

Não usar apenas timers cegos.

Exemplos:

```text
trial.activated
+ no first_playback after threshold
→ installation check

first_playback
→ usage check later

support issue active
→ suppress sales pressure

technical_passed
→ offer eligible
```

## 11. Provider failure

Trial não vira `ACTIVE` antes de pós-condição confirmada.

Se provider operation falhar:

```text
Trial = PROVISIONING
ProviderOperation = FAILED/HUMAN_REQUIRED
```

Após esgotar política de retry:

- invalidar Trial se necessário;
- não consumir direito de trial válido indevidamente;
- registrar causa para retrial.

## 12. Métricas essenciais

- unique leads requesting trial;
- eligibility ALLOW/REVIEW/DENY;
- retrial rate;
- provider-caused retrial rate;
- technical pass rate;
- time to first playback;
- Trial → Settled Order/Customer;
- abuse blocked/reviewed;
- Trial cost per converted customer.

## 13. Critérios de aceitação

- CA-01: Person com Trial válido anterior recebe `DENY` por padrão.
- CA-02: falha comprovada pode gerar `ALLOW_RETRIAL` com link ao original.
- CA-03: segundo Trial nunca é criado apenas por texto livre do lead.
- CA-04: Trial somente fica `ACTIVE` após provider verification.
- CA-05: technical pass não encerra o Trial.
- CA-06: corrida simultânea não cria dois Trials primários nem dois acessos gratuitos abertos para a mesma Person.
- CA-07: decisão e motivo são auditáveis.
- CA-08: provider failure não pune indevidamente a elegibilidade futura.

## 14. Testes mínimos

- first trial allowed;
- repeated valid trial denied;
- verified retrial allowed;
- ambiguous retrial review;
- concurrent create race;
- provider failure before activation;
- active + technical passed coexistence;
- tenant isolation;
- replay/idempotency.

## 15. Refinamentos Trial/Technical Access v0.14

- Durações CINEVISION observadas: **1h, 3h, 6h**; são capability do provider, não constante universal.
- Trial e Renovação em Confiança não apresentaram COGS direto no provider inicial; antiabuso continua obrigatório porque concedem acesso de valor.
- `Technical Access` é fluxo separado para diagnóstico de cliente/ex-cliente e não consome o Trial comercial primário. Deve vincular Ticket/DiagnosticSession e usar apenas capabilities reais do provider.
- Preferência de conteúdo adulto pertence ao Customer/Subscription; quando relevante ao Trial pode ser confirmada, mas não define uma categoria diferente de Trial.
- Technical result `PASSED/FAILED/INCONCLUSIVE/PENDING` continua ortogonal ao lifecycle de acesso.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — Trial/Technical Access/provider-cost semantics checked.

