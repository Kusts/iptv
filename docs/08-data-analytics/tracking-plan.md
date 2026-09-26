# Tracking Plan

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Autoridade: quais fatos entram na camada analítica, suas propriedades mínimas, classificação e qualidade.

## 1. Objetivo

Definir uma coleta consistente e verificável sem criar eventos duplicados ou significados ambíguos.

O `Event Model` continua sendo a autoridade semântica dos domain events. Este Tracking Plan define como esses fatos são disponibilizados para analytics e quais observações adicionais podem existir.

## 2. Envelope analítico mínimo

Todo registro analítico deve carregar, quando aplicável:

```text
event_id
event_type
event_version
occurred_at
recorded_at
tenant_id
person_id/customer_id quando permitido
session/conversation/workflow correlation_id
source_system
source_channel
schema_version
```

Campos de PII devem ser omitidos sempre que um ID estável interno for suficiente.

## 3. Regras de qualidade

- `event_id` único;
- timestamps em UTC, com timezone de apresentação tratado na consulta;
- reprocessamento não cria duplicidade;
- propriedades obrigatórias são validadas antes da camada analítica;
- eventos inválidos vão para quarantine/data-quality queue;
- late-arriving events são aceitos e marcados pela diferença `recorded_at - occurred_at`;
- nenhuma propriedade financeira é inferida a partir de texto de conversa;
- IDs externos são armazenados em bindings apropriados, não substituem IDs internos.

## 4. Eventos críticos e propriedades analíticas

### Identity & Acquisition

#### `person.created.v1`

Obrigatório:

- `tenant_id`;
- `person_id`;
- `created_source`.

Uso:

- volume de Persons;
- deduplicação;
- formação de Lead.

#### `lead.created.v1`

Obrigatório:

- `lead_id`;
- `person_id`;
- `primary_acquisition_touch_id` quando atribuível;
- `source_channel`.

Uso:

- Leads;
- CPL;
- funnel.

#### `acquisition.touch_recorded.v1`

Obrigatório:

- `touch_id`;
- `person_id` ou anonymous identity resolvível;
- `channel`;
- `source`;
- `campaign_id` quando conhecido;
- `creative_id` quando conhecido;
- `referral_id` quando aplicável;
- `touch_at`;
- `landing/session_id` quando aplicável.

Uso:

- first touch;
- last non-direct;
- assists;
- raw attribution history.

### Trial

#### `trial.requested.v1`

Obrigatório:

- `trial_id`;
- `person_id`;
- `requested_duration`;
- `adult_content_requested` quando aplicável;
- `device_profile_id` quando conhecido.

#### `trial.eligibility_allowed.v1`

Obrigatório:

- `trial_id`;
- `decision_id`;
- `decision = ALLOW`.

#### `trial.retrial_allowed.v1`

Obrigatório:

- `trial_id`;
- `original_trial_id`;
- `reason_code`;
- `approval_source`.

#### `trial.eligibility_denied.v1`

Obrigatório:

- `trial_id`/request id;
- `reason_code`;
- `risk_assessment_id` quando houve Risk Engine.

#### `trial.activated.v1`

Obrigatório:

- `trial_id`;
- `provider_binding_id`;
- `activated_at`;
- `expires_at`;
- `server_id`;
- `duration_minutes`.

#### `trial.first_playback_observed.v1`

Obrigatório:

- `trial_id`;
- `observed_at`;
- `device_profile_id` quando conhecido;
- `app_profile_id` quando conhecido.

#### `trial.technical_passed.v1` / `trial.technical_failed.v1` / `trial.technical_inconclusive.v1`

Obrigatório:

- `trial_id`;
- `technical_result_id`;
- `device_profile_id`;
- `app_profile_id` quando conhecido;
- `server_id`;
- `reason_codes[]`;
- `provider_incident_id` quando relevante.

### Commerce

#### `offer.presented.v1`

Obrigatório:

- `offer_id`;
- `person_id/customer_id`;
- `offer_version`;
- `gross_value`;
- `currency`;
- `presentation_channel`.

#### `order.created.v1`

Obrigatório:

- `order_id`;
- `customer_id/person_id`;
- `currency`;
- `gross_amount`;
- `discount_amount`;
- `reward_credit_amount`;
- `net_amount`;
- `price_snapshot_version`.

#### `order.settled.v1`

Obrigatório:

- `order_id`;
- `settled_amount`;
- `external_payment_amount`;
- `internal_credit_amount`;
- `settled_at`.

Importante: `order.settled.v1` pode ocorrer com `external_payment_amount = 0` quando a obrigação foi integralmente coberta por reward/credit autorizado.

### Billing

#### `payment.confirmed.v1`

Obrigatório:

- `payment_id`;
- `order_id`;
- `amount`;
- `currency`;
- `payment_method`;
- `gateway`;
- `gateway_event_id` quando aplicável;
- `paid_at`.

#### `payment.refunded.v1` / `payment.partially_refunded.v1`

Obrigatório:

- `payment_id`;
- `refund_id`;
- `amount`;
- `reason_code`;
- `occurred_at`.

### Subscription & Add-ons

#### `subscription.activated.v1`

Obrigatório:

- `subscription_id`;
- `customer_id`;
- `plan_id`;
- `billing_interval`;
- `started_at`;
- `current_period_end`.

#### `subscription.renewed.v1`

Obrigatório:

- `subscription_id`;
- `renewal_order_id`;
- `period_start`;
- `period_end`;
- `renewal_sequence`.

#### `subscription.addon_activated.v1`

Obrigatório:

- `subscription_id`;
- `addon_id`;
- `addon_type`;
- `recurring = true|false`;
- `quantity`;
- `billing_interval` quando recorrente;
- `effective_from`.

Para `ADDITIONAL_CONNECTION`, `recurring` deve ser `true` salvo produto explicitamente temporário/reward com período definido.

### Provider Fulfillment

#### `provider.operation_requested.v1`

Obrigatório:

- `provider_operation_id`;
- `provider`;
- `operation_type`;
- `entity_type`;
- `entity_id`;
- `risk_class`;
- `requested_by`.

#### `provider.operation_succeeded.v1`

Obrigatório:

- `provider_operation_id`;
- `operation_type`;
- `provider`;
- `attempt_count`;
- `duration_ms`;
- `postcondition_verified = true`.

#### `provider.operation_human_required.v1`

Obrigatório:

- `provider_operation_id`;
- `reason_code`;
- `security_challenge = true|false`;
- `attempt_count`.

#### `fulfillment.drift_detected.v1`

Obrigatório:

- `entity_type`;
- `entity_id`;
- `expected_state`;
- `observed_state`;
- `provider`;
- `detected_at`.

### Support / Knowledge

#### `support.ticket_created.v1`

Obrigatório:

- `ticket_id`;
- `customer_id`;
- `category`;
- `priority`;
- `source_channel`.

#### `support.resolved.v1`

Obrigatório:

- `ticket_id`;
- `resolution_code`;
- `resolved_by = AI|HUMAN|MIXED`;
- `knowledge_item_ids[]` quando utilizados;
- `resolution_confirmed`.

#### `knowledge.solution_outcome_recorded.v1`

Obrigatório:

- `knowledge_item_id/solution_id`;
- `ticket_id/troubleshooting_run_id`;
- `outcome = SUCCESS|FAILURE|INCONCLUSIVE`;
- `context_signature`;
- `recorded_at`.

### Referral & Rewards

#### `referral.created.v1`

Obrigatório:

- `referral_id`;
- `advocate_customer_id`;
- `created_at`;
- `program_version`.

#### `referral.attributed.v1`

Obrigatório:

- `referral_id`;
- `referred_person_id`;
- `attribution_method`;
- `attributed_at`.

#### `referral.confirmed.v1`

Obrigatório:

- `referral_id`;
- `referred_customer_id`;
- `qualification_rule_version`;
- `confirmed_at`.

#### `reward.issued.v1`

Obrigatório:

- `reward_id`;
- `customer_id`;
- `reward_type`;
- `economic_cost_estimate`;
- `perceived_value` quando definido;
- `expires_at` quando aplicável;
- `source_reason`.

### Financial & Inventory

#### `finance.transaction_posted.v1`

Obrigatório:

- `financial_transaction_id`;
- `ledger_account`/classification;
- `amount`;
- `currency`;
- `direction`;
- `source_entity_type`;
- `source_entity_id`.

Analytics deve preferir o ledger para valor financeiro realizado.

#### `inventory.credit_batch_purchased.v1`

Obrigatório:

- `credit_batch_id`;
- `provider`;
- `quantity`;
- `total_cost`;
- `unit_cost`;
- `purchased_at`.

#### `inventory.provider_credit_consumed.v1`

Obrigatório:

- `consumption_id`;
- `credit_batch_id` quando alocável;
- `subscription_id/customer_id`;
- `reason = BASE_PLAN|ADDITIONAL_CONNECTION|OTHER`;
- `quantity`;
- `effective_cost`;
- `period_reference`.

Uma conexão/tela adicional deve gerar consumo em cada ciclo aplicável, não apenas no momento de ativação.

### Growth

#### `campaign.spend_synced.v1`

Obrigatório:

- `platform`;
- `campaign_id`;
- `adset/adgroup_id` quando aplicável;
- `creative_id` quando aplicável;
- `period_start`;
- `period_end`;
- `spend`;
- `currency`;
- `source_snapshot_id`.

#### `conversion.signal_recorded.v1`

Obrigatório:

- `conversion_type`;
- `person/customer_id`;
- `source_event_id`;
- `platform` quando exportado;
- `occurred_at`.

### Experimentation

#### `experiment.assigned.v1`

Obrigatório:

- `experiment_id`;
- `subject_type`;
- `subject_id`;
- `variant`;
- `assignment_version`;
- `assigned_at`.

#### `experiment.exposed.v1`

Obrigatório:

- `experiment_id`;
- `subject_id`;
- `variant`;
- `exposure_point`;
- `exposed_at`.

Assignment sem exposure não entra automaticamente na análise principal.

## 5. Analytics-only events permitidos

Devem ser poucos e intencionais.

Exemplos possíveis:

```text
landing.offer_viewed.v1
landing.cta_clicked.v1
referral.share_action.v1
reward.catalog_viewed.v1
```

Antes de criar novo analytics-only event, responder:

1. Qual decisão ou métrica exige esse dado?
2. Já existe domain event equivalente?
3. O evento representa algo estável ou apenas detalhe de UI?
4. Pode ser derivado de uma fonte mais confiável?

Eventos de UI sem uso claro não devem ser coletados.

## 6. Data quality checks

No mínimo:

- uniqueness por `event_id`;
- nullability conforme contrato;
- enum válido;
- `occurred_at <= recorded_at + tolerância`;
- tenant presente;
- entity ID consistente;
- valores monetários com moeda;
- `order.settled` não pode ter settlement negativo;
- `trial.retrial_allowed` exige `original_trial_id`;
- `referral.confirmed` exige referred customer válido;
- consumo de conexão adicional recorrente deve conter `period_reference`.

## 7. Auto-revisão aplicada

Revisado contra `event-model.md` para:

- garantir que todas as referências a **domain events** existam no `event-model.md`; analytics-only events ficam explicitamente sob autoridade deste Tracking Plan;
- manter Trial lifecycle separado de technical outcome;
- usar `order.settled.v1`, não `order.paid`;
- manter additional connection como custo recorrente;
- evitar PII desnecessária;
- separar assignment de experiment exposure.
