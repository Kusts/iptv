-- AI Revenue & Operations Platform
-- Seed 001: synthetic pilot baseline
-- Safe for local/CI/staging only. Contains no production credentials or real customer data.

BEGIN;

-- Deterministic IDs make integration tests and demos reproducible.
INSERT INTO control.tenants (id, slug, name, status, default_currency, timezone)
VALUES ('00000000-0000-4000-8000-000000000001', 'pilot-synthetic', 'Pilot Synthetic Operations', 'ACTIVE', 'BRL', 'America/Sao_Paulo')
ON CONFLICT (id) DO NOTHING;

INSERT INTO control.users (id, auth_subject, display_name, status)
VALUES ('00000000-0000-4000-8000-000000000101', 'seed:admin:pilot', 'Admin Exemplo', 'ACTIVE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO control.tenant_memberships (id, tenant_id, user_id, role_key, status)
VALUES (
  '00000000-0000-4000-8000-000000000111',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000101',
  'OWNER',
  'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

-- High-risk outbound/automation capabilities default OFF in the synthetic seed.
INSERT INTO control.feature_flags (id, tenant_id, flag_key, enabled, config_json, updated_by_user_id)
VALUES
  ('00000000-0000-4000-8000-000000000121','00000000-0000-4000-8000-000000000001','trial.core.enabled',true,'{}','00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000000122','00000000-0000-4000-8000-000000000001','referral.core.enabled',true,'{}','00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000000123','00000000-0000-4000-8000-000000000001','ai.outbound.enabled',false,'{}','00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000000124','00000000-0000-4000-8000-000000000001','browser.provider.enabled',false,'{}','00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000000125','00000000-0000-4000-8000-000000000001','messaging.outbound.enabled',false,'{}','00000000-0000-4000-8000-000000000101')
ON CONFLICT (id) DO NOTHING;

-- Provider registry/account: placeholder only; never a live credential.
INSERT INTO provider.providers (id, provider_key, name, provider_type, status)
VALUES ('00000000-0000-4000-8000-000000000201','cinevision','CINEVISION','FULFILLMENT','ACTIVE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO provider.provider_accounts (id, tenant_id, provider_id, name, status, secret_ref, settings_json, last_recharge_at)
VALUES (
  '00000000-0000-4000-8000-000000000211',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000201',
  'CINEVISION Pilot Placeholder',
  'ACTIVE',
  'seed://not-a-real-secret/cinevision',
  '{"synthetic":true,"servers":["ONE","XTREAM"]}',
  '2026-09-20T12:00:00-03:00'
)
ON CONFLICT (id) DO NOTHING;

-- Catalog: only the currently confirmed monthly price is seeded. Other commercial prices stay intentionally undefined.
INSERT INTO catalog.products (id, tenant_id, product_key, name, product_type, status, metadata_json)
VALUES ('00000000-0000-4000-8000-000000000301','00000000-0000-4000-8000-000000000001','streaming-service','Serviço de Assinatura','SERVICE','ACTIVE','{"synthetic":true}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO catalog.plans (id, tenant_id, product_id, plan_key, name, billing_interval_unit, billing_interval_count, status, metadata_json)
VALUES ('00000000-0000-4000-8000-000000000311','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000301','monthly','Mensal','MONTH',1,'ACTIVE','{"synthetic":true}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO catalog.prices (id, tenant_id, sellable_type, sellable_id, amount_minor, currency, starts_at, status, metadata_json)
VALUES ('00000000-0000-4000-8000-000000000321','00000000-0000-4000-8000-000000000001','PLAN','00000000-0000-4000-8000-000000000311',3000,'BRL','2026-09-20T00:00:00-03:00','ACTIVE','{"synthetic":true,"source":"confirmed-project-rule"}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO catalog.addons (id, tenant_id, addon_key, name, billing_type, entitlement_feature_key, status, metadata_json)
VALUES ('00000000-0000-4000-8000-000000000331','00000000-0000-4000-8000-000000000001','additional-connection','Tela / conexão adicional','RECURRING','CONNECTIONS','ACTIVE','{"synthetic":true,"pricing":"TBD","provider_cost":"RECURRING_PER_CYCLE"}')
ON CONFLICT (id) DO NOTHING;

-- Supplier and provider-credit packages supplied during discovery.
INSERT INTO inventory.suppliers (id, tenant_id, name, supplier_type, status, metadata_json)
VALUES ('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000001','CINEVISION','FULFILLMENT_CREDITS','ACTIVE','{"synthetic":true}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO inventory.supplier_offers (id, tenant_id, supplier_id, offer_type, quantity, total_cost_minor, unit_cost_minor, currency, starts_at, terms_json)
VALUES
 ('00000000-0000-4000-8000-000000000411','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','CREDIT_PACKAGE',1,1000,1000,'BRL','2026-09-20T00:00:00-03:00','{"source":"discovery"}'),
 ('00000000-0000-4000-8000-000000000412','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','CREDIT_PACKAGE',5,4000,800,'BRL','2026-09-20T00:00:00-03:00','{"source":"discovery"}'),
 ('00000000-0000-4000-8000-000000000413','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','CREDIT_PACKAGE',10,7000,700,'BRL','2026-09-20T00:00:00-03:00','{"source":"discovery"}'),
 ('00000000-0000-4000-8000-000000000414','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','CREDIT_PACKAGE',25,17500,700,'BRL','2026-09-20T00:00:00-03:00','{"source":"discovery"}'),
 ('00000000-0000-4000-8000-000000000415','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','CREDIT_PACKAGE',50,32500,650,'BRL','2026-09-20T00:00:00-03:00','{"source":"discovery"}'),
 ('00000000-0000-4000-8000-000000000416','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','CREDIT_PACKAGE',75,48750,650,'BRL','2026-09-20T00:00:00-03:00','{"source":"discovery"}'),
 ('00000000-0000-4000-8000-000000000417','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','CREDIT_PACKAGE',100,60000,600,'BRL','2026-09-20T00:00:00-03:00','{"source":"discovery"}'),
 ('00000000-0000-4000-8000-000000000418','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','CREDIT_PACKAGE',150,90000,600,'BRL','2026-09-20T00:00:00-03:00','{"source":"discovery"}'),
 ('00000000-0000-4000-8000-000000000419','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','CREDIT_PACKAGE',200,110000,550,'BRL','2026-09-20T00:00:00-03:00','{"source":"discovery"}'),
 ('00000000-0000-4000-8000-000000000420','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','CREDIT_PACKAGE',250,137500,550,'BRL','2026-09-20T00:00:00-03:00','{"source":"discovery"}'),
 ('00000000-0000-4000-8000-000000000421','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','CREDIT_PACKAGE',500,250000,500,'BRL','2026-09-20T00:00:00-03:00','{"source":"discovery"}'),
 ('00000000-0000-4000-8000-000000000422','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','CREDIT_PACKAGE',750,375000,500,'BRL','2026-09-20T00:00:00-03:00','{"source":"discovery"}'),
 ('00000000-0000-4000-8000-000000000423','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000401','CREDIT_PACKAGE',1000,450000,450,'BRL','2026-09-20T00:00:00-03:00','{"source":"discovery"}')
ON CONFLICT (id) DO NOTHING;

-- Synthetic Person/Lead used for Trial eligibility demonstrations.
INSERT INTO identity.persons (id, tenant_id, status, canonical_name, locale, timezone)
VALUES ('00000000-0000-4000-8000-000000000501','00000000-0000-4000-8000-000000000001','ACTIVE','Lead Exemplo','pt-BR','America/Sao_Paulo')
ON CONFLICT (id) DO NOTHING;

INSERT INTO identity.identities (id, tenant_id, person_id, identity_type, normalized_value, verification_status, link_confidence, metadata_json)
VALUES ('00000000-0000-4000-8000-000000000511','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000501','WHATSAPP','seed-whatsapp-lead-001','VERIFIED',1.0000,'{"synthetic":true}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO crm.leads (id, tenant_id, person_id, status, stage)
VALUES ('00000000-0000-4000-8000-000000000521','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000501','ENGAGED','TRIAL_READY')
ON CONFLICT (id) DO NOTHING;

INSERT INTO trial.trial_eligibility_decisions (id, tenant_id, person_id, outcome, policy_version, reason_codes, evidence_json, actor_type, actor_id)
VALUES ('00000000-0000-4000-8000-000000000531','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000501','ALLOW','trial-eligibility-v1',ARRAY['FIRST_PRIMARY_TRIAL'],'{"synthetic":true}','system','seed')
ON CONFLICT (id) DO NOTHING;

INSERT INTO trial.trials (id, tenant_id, person_id, lead_id, trial_kind, lifecycle_status, technical_outcome, requested_duration_minutes, adult_content_enabled, activated_at, expires_at)
VALUES ('00000000-0000-4000-8000-000000000541','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000501','00000000-0000-4000-8000-000000000521','TRIAL','ACTIVE','PENDING',360,false,'2026-09-20T13:00:00-03:00','2026-09-20T19:00:00-03:00')
ON CONFLICT (id) DO NOTHING;

-- Synthetic active customer used for Support/Referral demos.
INSERT INTO identity.persons (id, tenant_id, status, canonical_name, locale, timezone)
VALUES ('00000000-0000-4000-8000-000000000601','00000000-0000-4000-8000-000000000001','ACTIVE','Cliente Exemplo','pt-BR','America/Sao_Paulo')
ON CONFLICT (id) DO NOTHING;

INSERT INTO identity.identities (id, tenant_id, person_id, identity_type, normalized_value, verification_status, link_confidence, metadata_json)
VALUES ('00000000-0000-4000-8000-000000000611','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000601','WHATSAPP','seed-whatsapp-customer-001','VERIFIED',1.0000,'{"synthetic":true}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO crm.customers (id, tenant_id, person_id, status, customer_since)
VALUES ('00000000-0000-4000-8000-000000000621','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000601','ACTIVE','2026-06-20T12:00:00-03:00')
ON CONFLICT (id) DO NOTHING;

INSERT INTO communication.conversations (id, tenant_id, person_id, channel, external_thread_id, status, control_mode, last_message_at)
VALUES ('00000000-0000-4000-8000-000000000631','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000601','WHATSAPP','seed-thread-customer-001','OPEN','AI_CONTROL','2026-09-20T14:00:00-03:00')
ON CONFLICT (id) DO NOTHING;

INSERT INTO support.support_tickets (id, tenant_id, person_id, customer_id, conversation_id, status, priority, category, summary)
VALUES ('00000000-0000-4000-8000-000000000641','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000601','00000000-0000-4000-8000-000000000621','00000000-0000-4000-8000-000000000631','NEW','NORMAL','PLAYBACK','Ticket sintético para validar triagem e knowledge loop')
ON CONFLICT (id) DO NOTHING;

INSERT INTO referral.referral_programs (id, tenant_id, name, status, rules_version, rules_json, starts_at)
VALUES ('00000000-0000-4000-8000-000000000701','00000000-0000-4000-8000-000000000001','Referral Pilot','ACTIVE','pilot-v1','{"qualification_policy":"configured-by-domain-policy","reward_policy":"configured-by-domain-policy","synthetic":true}','2026-09-20T00:00:00-03:00')
ON CONFLICT (id) DO NOTHING;

INSERT INTO referral.referrals (id, tenant_id, program_id, advocate_customer_id, referred_person_id, referral_code, status, source_context)
VALUES ('00000000-0000-4000-8000-000000000711','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000701','00000000-0000-4000-8000-000000000621','00000000-0000-4000-8000-000000000501','SEED-REF-001','CREATED','synthetic-fixture')
ON CONFLICT (id) DO NOTHING;

INSERT INTO loyalty.reward_definitions (id, tenant_id, reward_key, reward_type, status, perceived_value_minor, estimated_cost_minor, currency, recurring_cost_policy, rules_json)
VALUES
 ('00000000-0000-4000-8000-000000000722','00000000-0000-4000-8000-000000000001','gift-pass','GIFT_PASS','ACTIVE',NULL,NULL,'BRL',NULL,'{"economic_values":"TBD","synthetic":true}'),
 ('00000000-0000-4000-8000-000000000723','00000000-0000-4000-8000-000000000001','temporary-extra-connection','CONNECTION_ENTITLEMENT','ACTIVE',NULL,NULL,'BRL','REQUIRES_PROVIDER_COGS_PER_ACTIVE_CYCLE','{"permanent_reward":false,"synthetic":true}')
ON CONFLICT (id) DO NOTHING;

COMMIT;
