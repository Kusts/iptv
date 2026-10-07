# RLS inventory (2026-10-07T19:33:55Z)

Heuristic P1.1-v1. Database: `iptv_rls_inventory`. Source of truth for behavior: migrations 001-051 + live catalog.

## Summary

- schemas: 26; tables: 149; RLS-enabled: 21
- suggested-class breakdown: TENANT_SCOPED 123; GLOBAL 11; UNKNOWN 5; PRE_CONTEXT 4; CROSS_TENANT_SYSTEM 4; AUDIT_ONLY 2; 
- app sources scanned (190 files):
  - `apps/api/src`
  - `apps/browser-worker/src`
  - `apps/outbox-worker/src`
  - `apps/web/app`
  - `apps/web/lib`
  - `apps/web/components`

## Tables by schema

| Table | Owner | tenant_id | RLS | Policies | iptv_app | outbox_worker | outbox_executor | tenant_id idx | Suggestion |
|---|---|---|---|---|---|---|---|---|---|
| agent.agent_releases | iptv | n | n | (none) | NONE | NONE | NONE | agent_releases_tenant_id_id_unique | UNKNOWN |
| agent.agent_runs | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | agent_runs_conversation_idx, agent_runs_tenant_id_id_unique | TENANT_SCOPED |
| agent.agent_tasks | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | agent_tasks_run_idx, agent_tasks_tenant_id_id_unique | TENANT_SCOPED |
| agent.copilot_review_consumptions | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | copilot_consumptions_request_idx, copilot_consumptions_single_use, copilot_consumptions_tenant_id_id_unique | TENANT_SCOPED |
| agent.human_review_actions | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | human_review_actions_tenant_id_id_unique | TENANT_SCOPED |
| agent.human_review_requests | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | human_review_queue_idx, human_review_tenant_id_id_unique | TENANT_SCOPED |
| analytics.metric_definitions | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | metric_definitions_tenant_id_id_unique, metric_definitions_tenant_key_unique | TENANT_SCOPED |
| analytics.metric_snapshots | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | metric_snapshots_tenant_computed_idx, metric_snapshots_tenant_id_id_unique, metric_snapshots_tenant_key_bucket_idx, metric_snapshots_tenant_key_bucket_unique | TENANT_SCOPED |
| billing.charge_attempts | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | charge_attempts_tenant_id_id_unique, charge_attempts_unique | TENANT_SCOPED |
| billing.charge_provider_bindings | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | charge_provider_bindings_external_unique, charge_provider_bindings_tenant_id_id_unique | TENANT_SCOPED |
| billing.charges | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | charges_idempotency_unique, charges_order_idx, charges_status_due_idx, charges_tenant_id_id_order_unique, charges_tenant_id_id_unique | TENANT_SCOPED |
| billing.exceptions | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | billing_exceptions_open_idx, billing_exceptions_tenant_id_id_unique | TENANT_SCOPED |
| billing.payments | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | payments_charge_unique, payments_order_idx, payments_tenant_id_id_unique | TENANT_SCOPED |
| billing.refund_requests | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | refund_requests_human_review_unique, refund_requests_idempotency_unique, refund_requests_payment_idx, refund_requests_review_idx, refund_requests_tenant_id_id_unique | TENANT_SCOPED |
| billing.refunds | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | refunds_payment_idx, refunds_request_unique, refunds_tenant_id_id_unique | TENANT_SCOPED |
| billing.tenant_channels | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | billing_tenant_channels_tenant_id_id_unique, billing_tenant_channels_tenant_idx | PRE_CONTEXT |
| catalog.addons | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | addons_tenant_id_id_unique, addons_tenant_key_unique | TENANT_SCOPED |
| catalog.coupon_redemptions | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | coupon_redemptions_coupon_idx, coupon_redemptions_person_idx, coupon_redemptions_tenant_id_id_unique | TENANT_SCOPED |
| catalog.coupons | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | coupons_tenant_code_unique, coupons_tenant_id_id_unique | TENANT_SCOPED |
| catalog.offer_items | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | offer_items_tenant_id_id_unique | TENANT_SCOPED |
| catalog.offers | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | offers_customer_idx, offers_person_idx, offers_tenant_id_id_unique | TENANT_SCOPED |
| catalog.plans | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | plans_tenant_id_id_unique, plans_tenant_key_unique | TENANT_SCOPED |
| catalog.prices | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | prices_lookup_idx, prices_tenant_id_id_unique | TENANT_SCOPED |
| catalog.products | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | products_tenant_id_id_unique, products_tenant_key_unique | TENANT_SCOPED |
| commerce.order_items | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | order_items_order_idx, order_items_tenant_id_id_unique | TENANT_SCOPED |
| commerce.orders | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | orders_customer_idx, orders_person_idx, orders_status_idx, orders_tenant_id_id_unique | TENANT_SCOPED |
| commerce.price_snapshots | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | price_snapshots_one_per_item, price_snapshots_tenant_id_id_unique | TENANT_SCOPED |
| communication.communication_preferences | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | communication_preferences_tenant_id_id_unique, communication_preferences_unique | TENANT_SCOPED |
| communication.communication_suppressions | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | communication_suppressions_lookup_idx, communication_suppressions_tenant_id_id_unique | TENANT_SCOPED |
| communication.conversation_control_events | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | conversation_control_events_history_idx, conversation_control_events_tenant_id_id_unique | TENANT_SCOPED |
| communication.conversations | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | conversations_active_idx, conversations_external_thread_unique, conversations_person_idx, conversations_tenant_id_id_unique | TENANT_SCOPED |
| communication.exceptions | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | communication_exceptions_open_idx, communication_exceptions_tenant_id_id_unique | TENANT_SCOPED |
| communication.message_deliveries | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | message_deliveries_attempt_unique, message_deliveries_message_idx, message_deliveries_tenant_id_id_unique | TENANT_SCOPED |
| communication.message_intents | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | message_intents_idempotency_unique, message_intents_tenant_id_id_unique | TENANT_SCOPED |
| communication.messages | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | messages_conversation_time_idx, messages_external_id_unique, messages_idempotency_unique, messages_tenant_id_id_unique | TENANT_SCOPED |
| communication.scheduled_contacts | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | scheduled_contacts_intent_idx, scheduled_contacts_intent_person_unique, scheduled_contacts_tenant_id_id_unique | TENANT_SCOPED |
| communication.tenant_channels | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | tenant_channels_tenant_id_id_unique, tenant_channels_tenant_idx | PRE_CONTEXT |
| control.auth_credentials | iptv | n | n | (none) | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | (none) | GLOBAL |
| control.auth_sessions | iptv | n | n | (none) | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | (none) | GLOBAL |
| control.feature_flags | iptv | y (nullable y) | y | feature_flags_delete:DELETE, feature_flags_insert:INSERT, feature_flags_select:SELECT, feature_flags_update:UPDATE | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | feature_flags_scope_key_unique | GLOBAL |
| control.membership_roles | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | membership_roles_tenant_id_id_unique, membership_roles_tenant_membership_idx, membership_roles_tenant_role_idx | PRE_CONTEXT |
| control.permissions | iptv | n | n | (none) | SELECT | NONE | NONE | (none) | GLOBAL |
| control.role_permissions | iptv | n | n | (none) | SELECT | NONE | NONE | (none) | GLOBAL |
| control.roles | iptv | n | n | (none) | SELECT | NONE | NONE | (none) | GLOBAL |
| control.tenant_memberships | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | tenant_memberships_unique | PRE_CONTEXT |
| control.tenants | iptv | n | n | (none) | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | (none) | GLOBAL |
| control.users | iptv | n | n | (none) | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | (none) | GLOBAL |
| crm.customer_health_snapshots | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | customer_health_latest_idx | TENANT_SCOPED |
| crm.customers | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | customers_status_idx, customers_tenant_id_id_unique, customers_tenant_person_unique | TENANT_SCOPED |
| crm.leads | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | leads_person_history_idx, leads_status_idx, leads_tenant_id_id_unique | TENANT_SCOPED |
| entitlement.entitlement_grants | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | entitlement_grants_tenant_id_id_unique | TENANT_SCOPED |
| entitlement.entitlements | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | entitlements_customer_active_idx, entitlements_tenant_id_id_unique | TENANT_SCOPED |
| experiments.experiment_assignments | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | experiment_assignments_experiment_variant_idx, experiment_assignments_tenant_id_id_unique, experiment_assignments_unique | TENANT_SCOPED |
| experiments.experiment_exposures | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | experiment_exposures_assignment_idx, experiment_exposures_idempotent_unique, experiment_exposures_tenant_id_id_unique | TENANT_SCOPED |
| experiments.experiments | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | experiments_key_unique, experiments_tenant_id_id_unique, experiments_tenant_status_idx | TENANT_SCOPED |
| finance.cost_allocations | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | cost_allocations_fact_dedupe_uidx, cost_allocations_source_dedupe_unique, cost_allocations_target_idx, cost_allocations_tenant_id_id_unique | TENANT_SCOPED |
| finance.financial_accounts | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | financial_accounts_tenant_code_currency_unique, financial_accounts_tenant_id_id_currency_unique, financial_accounts_tenant_id_id_unique | TENANT_SCOPED |
| finance.financial_ledger_entries | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | financial_ledger_account_idx, financial_ledger_tenant_id_id_unique, financial_ledger_transaction_idx | TENANT_SCOPED |
| finance.financial_transactions | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | financial_transactions_idempotency_unique, financial_transactions_reference_idx, financial_transactions_tenant_id_id_unique | TENANT_SCOPED |
| growth.attribution_touches | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | attribution_touches_first_touch_unique, attribution_touches_person_idx, attribution_touches_tenant_id_id_unique | TENANT_SCOPED |
| growth.audience_definitions | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | audience_definitions_campaign_idx, audience_definitions_tenant_id_id_unique | TENANT_SCOPED |
| growth.audience_members | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | audience_members_tenant_id_id_unique, audience_members_unique | TENANT_SCOPED |
| growth.campaign_versions | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | campaign_versions_number_unique, campaign_versions_tenant_id_id_unique | TENANT_SCOPED |
| growth.campaigns | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | campaigns_key_unique, campaigns_tenant_id_id_unique | TENANT_SCOPED |
| growth.conversion_events | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | conversion_events_idempotency_unique, conversion_events_person_idx, conversion_events_tenant_id_id_unique | TENANT_SCOPED |
| growth.creatives | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | creatives_campaign_idx, creatives_tenant_id_id_unique | TENANT_SCOPED |
| identity.identities | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | identities_active_normalized_unique, identities_person_idx, identities_tenant_id_id_unique | TENANT_SCOPED |
| identity.identity_merge_reviews | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | identity_merge_reviews_open_idx, identity_merge_reviews_tenant_id_id_unique | TENANT_SCOPED |
| identity.persons | iptv | y (nullable n) | y | tenant_isolation:* | DELETE,INSERT,SELECT,UPDATE | NONE | NONE | persons_tenant_created_idx, persons_tenant_id_id_unique, persons_tenant_status_idx | TENANT_SCOPED |
| inventory.app_trials | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | app_trials_expiry_idx, app_trials_one_open_per_person_supplier, app_trials_person_idx, app_trials_tenant_id_id_unique | TENANT_SCOPED |
| inventory.credit_reservations | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | credit_reservations_active_idx, credit_reservations_idempotency_unique, credit_reservations_tenant_id_id_unique | TENANT_SCOPED |
| inventory.license_assets | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | license_assets_one_provisioning_per_procurement, license_assets_procurement_idx, license_assets_tenant_id_id_unique | TENANT_SCOPED |
| inventory.procurement_orders | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | procurement_orders_one_active_per_app_trial, procurement_orders_one_active_per_commerce_order, procurement_orders_order_idx, procurement_orders_tenant_id_id_unique | TENANT_SCOPED |
| inventory.provider_credit_batches | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | provider_credit_batches_remaining_idx, provider_credit_batches_tenant_id_id_unique | TENANT_SCOPED |
| inventory.provider_credit_entries | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | provider_credit_entries_account_idx, provider_credit_entries_idempotency_unique, provider_credit_entries_tenant_id_id_unique | TENANT_SCOPED |
| inventory.reconciliation_findings | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | reconciliation_findings_open_idx, reconciliation_findings_tenant_id_id_unique | TENANT_SCOPED |
| inventory.supplier_app_items | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | supplier_app_items_identity_unique, supplier_app_items_snapshot_idx, supplier_app_items_tenant_id_id_unique | TENANT_SCOPED |
| inventory.supplier_app_snapshots | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | supplier_app_snapshots_idempotent, supplier_app_snapshots_supplier_idx, supplier_app_snapshots_tenant_id_id_supplier_unique, supplier_app_snapshots_tenant_id_id_unique | TENANT_SCOPED |
| inventory.supplier_balance_snapshots | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | supplier_balance_snapshots_latest_idx, supplier_balance_snapshots_tenant_id_id_unique | TENANT_SCOPED |
| inventory.supplier_offers | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | supplier_offers_tenant_id_id_unique | TENANT_SCOPED |
| inventory.suppliers | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | suppliers_tenant_id_id_unique | TENANT_SCOPED |
| knowledge.knowledge_corrections | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | knowledge_corrections_item_idx, knowledge_corrections_queue_idx, knowledge_corrections_tenant_id_id_unique | TENANT_SCOPED |
| knowledge.knowledge_gaps | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | knowledge_gaps_queue_idx, knowledge_gaps_tenant_id_id_unique | TENANT_SCOPED |
| knowledge.knowledge_items | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | knowledge_items_canonical_unique, knowledge_items_tenant_id_id_unique | TENANT_SCOPED |
| knowledge.knowledge_research_candidates | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | knowledge_research_candidates_gap_idx, knowledge_research_candidates_tenant_id_id_unique, knowledge_research_candidates_unique | TENANT_SCOPED |
| knowledge.knowledge_source_links | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | knowledge_source_links_unique | TENANT_SCOPED |
| knowledge.knowledge_sources | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | knowledge_sources_tenant_id_id_unique | TENANT_SCOPED |
| knowledge.knowledge_versions | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | knowledge_versions_tenant_id_id_unique, knowledge_versions_unique | TENANT_SCOPED |
| knowledge.solution_outcomes | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | solution_outcomes_solution_idx, solution_outcomes_tenant_id_id_unique | TENANT_SCOPED |
| knowledge.solutions | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | solutions_tenant_id_id_unique | TENANT_SCOPED |
| loyalty.gift_passes | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | gift_passes_code_unique, gift_passes_redeemed_person_idx, gift_passes_tenant_id_id_unique | TENANT_SCOPED |
| loyalty.reward_definitions | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | reward_definitions_key_unique, reward_definitions_tenant_id_id_unique | TENANT_SCOPED |
| loyalty.reward_ledger_entries | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | reward_ledger_customer_idx, reward_ledger_idempotency_unique, reward_ledger_tenant_id_id_unique | TENANT_SCOPED |
| loyalty.rewards | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | rewards_customer_idx, rewards_tenant_id_id_unique | TENANT_SCOPED |
| partners.learning_content | iptv | n | n | (none) | NONE | NONE | NONE | (none) | UNKNOWN |
| partners.learning_content_versions | iptv | n | n | (none) | NONE | NONE | NONE | (none) | UNKNOWN |
| partners.learning_progress | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | learning_progress_partner_content_unique, learning_progress_tenant_id_id_unique | TENANT_SCOPED |
| partners.partner_accounts | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | partner_accounts_tenant_id_id_unique | TENANT_SCOPED |
| partners.partner_capabilities | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | partner_capabilities_account_key_unique, partner_capabilities_tenant_id_id_unique | TENANT_SCOPED |
| partners.partner_memberships | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | partner_memberships_tenant_id_id_unique, partner_memberships_tenant_partner_user_unique, partner_memberships_user_idx | TENANT_SCOPED |
| partners.partner_relationships | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | partner_relationships_children_idx, partner_relationships_direct_parent_unique, partner_relationships_tenant_id_id_unique | TENANT_SCOPED |
| partners.reseller_credit_entries | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | reseller_credit_entries_idempotency_unique, reseller_credit_entries_partner_idx, reseller_credit_entries_tenant_id_id_unique | TENANT_SCOPED |
| partners.reseller_credit_reservations | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | reseller_credit_reservations_active_idx, reseller_credit_reservations_idempotency_unique, reseller_credit_reservations_tenant_id_id_unique | TENANT_SCOPED |
| partners.reseller_orders | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | reseller_orders_idempotency_unique, reseller_orders_partner_idx, reseller_orders_tenant_id_id_unique | TENANT_SCOPED |
| partners.reseller_price_books | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | reseller_price_books_tenant_id_id_unique, reseller_price_books_version_unique | TENANT_SCOPED |
| platform.audit_log | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | audit_log_correlation_idx, audit_log_resource_idx | AUDIT_ONLY |
| platform.capabilities | iptv | n | n | (none) | NONE | NONE | NONE | (none) | GLOBAL |
| platform.capability_events | iptv | n | n | (none) | NONE | NONE | NONE | (none) | GLOBAL |
| platform.domain_events | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | domain_events_aggregate_version_unique, domain_events_correlation_idx, domain_events_type_time_idx | AUDIT_ONLY |
| platform.idempotency_keys | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | idempotency_keys_scope_key_unique | TENANT_SCOPED |
| platform.inbox_messages | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | inbox_external_event_unique, inbox_processing_idx | TENANT_SCOPED |
| platform.outbox_messages | iptv | y (nullable n) | y | outbox_executor_isolation:* | NONE | NONE | SELECT,UPDATE | outbox_one_per_event_topic | CROSS_TENANT_SYSTEM |
| platform.outbox_runtime_control | outbox_executor | n | n | (none) | NONE | NONE | DELETE,INSERT,SELECT,TRUNCATE,UPDATE | (none) | CROSS_TENANT_SYSTEM |
| platform.outbox_runtime_transitions | outbox_executor | n | n | (none) | NONE | NONE | DELETE,INSERT,SELECT,TRUNCATE,UPDATE | (none) | CROSS_TENANT_SYSTEM |
| platform.outbox_transitions | iptv | y (nullable n) | y | outbox_executor_isolation:* | NONE | NONE | INSERT,SELECT | (none) | CROSS_TENANT_SYSTEM |
| platform.policy_documents | iptv | y (nullable y) | n | (none) | NONE | NONE | NONE | policy_documents_platform_family_version_unique, policy_documents_tenant_family_version_unique | GLOBAL |
| provider.provider_accounts | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | provider_accounts_provider_idx, provider_accounts_tenant_id_id_unique | TENANT_SCOPED |
| provider.provider_bindings | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | provider_bindings_entity_unique, provider_bindings_external_unique, provider_bindings_tenant_id_id_unique | TENANT_SCOPED |
| provider.provider_evidence | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | provider_evidence_operation_idx, provider_evidence_tenant_id_id_unique | TENANT_SCOPED |
| provider.provider_health_snapshots | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | provider_health_latest_idx | TENANT_SCOPED |
| provider.provider_operation_attempts | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | provider_operation_attempts_tenant_id_id_unique, provider_operation_attempts_unique | TENANT_SCOPED |
| provider.provider_operations | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | provider_operations_entity_idx, provider_operations_idempotency_unique, provider_operations_queue_idx, provider_operations_tenant_id_id_unique | TENANT_SCOPED |
| provider.providers | iptv | n | n | (none) | NONE | NONE | NONE | (none) | UNKNOWN |
| referral.referral_programs | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | referral_programs_tenant_id_id_unique | TENANT_SCOPED |
| referral.referral_qualifications | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | referral_qualification_open_unique, referral_qualifications_tenant_id_id_unique | TENANT_SCOPED |
| referral.referral_reward_links | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | referral_reward_links_unique | TENANT_SCOPED |
| referral.referrals | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | referrals_active_person_per_program_unique, referrals_advocate_idx, referrals_referred_idx, referrals_tenant_id_id_unique | TENANT_SCOPED |
| renewal.recovery_tasks | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | recovery_tasks_open_idx, recovery_tasks_tenant_id_id_unique | TENANT_SCOPED |
| security.risk_assessments | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | risk_assessments_subject_idx, risk_assessments_tenant_id_id_unique | TENANT_SCOPED |
| subscription.subscription_addon_cycle_charges | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | addon_cycle_charges_tenant_id_id_unique, addon_cycle_charges_unique | TENANT_SCOPED |
| subscription.subscription_addons | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | subscription_addons_active_idx, subscription_addons_tenant_id_id_unique | TENANT_SCOPED |
| subscription.subscription_cycles | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | subscription_cycles_one_open_per_subscription, subscription_cycles_tenant_id_id_unique, subscription_cycles_unique | TENANT_SCOPED |
| subscription.subscriptions | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | subscriptions_customer_idx, subscriptions_status_period_idx, subscriptions_tenant_id_id_unique | TENANT_SCOPED |
| subscription.trust_renewal_grants | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | trust_renewal_grants_one_per_cycle, trust_renewal_grants_tenant_id_id_unique | TENANT_SCOPED |
| support.incidents | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | incidents_active_idx, incidents_tenant_id_id_unique | TENANT_SCOPED |
| support.problems | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | problems_tenant_id_id_unique | TENANT_SCOPED |
| support.solution_attempts | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | solution_attempts_tenant_id_id_unique, solution_attempts_unique | TENANT_SCOPED |
| support.support_tickets | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | support_tickets_assignee_idx, support_tickets_person_idx, support_tickets_queue_idx, support_tickets_tenant_id_id_unique | TENANT_SCOPED |
| support.technical_access_grants | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | technical_access_grants_active_expiry_idx, technical_access_grants_person_idx, technical_access_grants_tenant_id_id_unique, technical_access_grants_ticket_idx | TENANT_SCOPED |
| support.ticket_incident_links | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | ticket_incident_links_unique | TENANT_SCOPED |
| support.ticket_problem_links | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | ticket_problem_links_unique | TENANT_SCOPED |
| trial.app_profiles | iptv | y (nullable y) | n | (none) | NONE | NONE | NONE | app_profiles_lookup_idx | UNKNOWN |
| trial.compatibility_observations | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | compatibility_trial_idx | TENANT_SCOPED |
| trial.device_profiles | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | device_profiles_person_idx, device_profiles_tenant_id_id_unique | TENANT_SCOPED |
| trial.network_observations | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | network_observations_trial_idx | TENANT_SCOPED |
| trial.trial_attempts | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | trial_attempts_tenant_id_id_unique, trial_attempts_trial_idx | TENANT_SCOPED |
| trial.trial_eligibility_decisions | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | trial_eligibility_person_idx, trial_eligibility_tenant_id_id_unique | TENANT_SCOPED |
| trial.trial_technical_results | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | trial_technical_one_per_trial | TENANT_SCOPED |
| trial.trials | iptv | y (nullable n) | n | (none) | NONE | NONE | NONE | trials_active_expiry_idx, trials_one_open_access_per_person, trials_one_primary_per_person, trials_person_history_idx, trials_tenant_id_id_unique | TENANT_SCOPED |

## Policy detail (USING / WITH CHECK, truncated to 180 chars)

| Table | Policy | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|---|
| communication.communication_preferences | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| communication.communication_suppressions | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| communication.conversation_control_events | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| communication.conversations | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| communication.exceptions | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| communication.message_deliveries | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| communication.message_intents | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| communication.messages | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| communication.scheduled_contacts | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| communication.tenant_channels | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| control.feature_flags | feature_flags_delete | DELETE | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (none) |
| control.feature_flags | feature_flags_insert | INSERT | public | (none) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| control.feature_flags | feature_flags_select | SELECT | public | ((tenant_id IS NULL) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) | (none) |
| control.feature_flags | feature_flags_update | UPDATE | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| control.membership_roles | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| control.tenant_memberships | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| crm.customer_health_snapshots | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| crm.customers | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| crm.leads | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| identity.identities | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| identity.identity_merge_reviews | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| identity.persons | tenant_isolation | ALL | public | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) | (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) |
| platform.outbox_messages | outbox_executor_isolation | ALL | outbox_executor | true | true |
| platform.outbox_transitions | outbox_executor_isolation | ALL | outbox_executor | true | true |

## Application references (documented approximation)

Two full-tree scans over `*.ts`/`*.tsx` under the roots above.
qualified = mentions of the schema-qualified name (precise); bare = whole-word
mentions of the bare table name counted ONLY for tables with zero qualified
mentions (bare names collide with ordinary words, e.g. `orders`, so treat bare
counts as upper bounds, not proof of use).

| Table | Qualified mentions | Bare mentions | Basis |
|---|---|---|---|
| agent.agent_releases | 2 | 0 | qualified |
| agent.agent_runs | 8 | 0 | qualified |
| agent.agent_tasks | 1 | 0 | qualified |
| agent.copilot_review_consumptions | 3 | 0 | qualified |
| agent.human_review_actions | 6 | 0 | qualified |
| agent.human_review_requests | 17 | 0 | qualified |
| analytics.metric_definitions | 3 | 0 | qualified |
| analytics.metric_snapshots | 8 | 0 | qualified |
| billing.charge_attempts | 4 | 0 | qualified |
| billing.charge_provider_bindings | 6 | 0 | qualified |
| billing.charges | 10 | 0 | qualified |
| billing.exceptions | 9 | 0 | qualified |
| billing.payments | 25 | 0 | qualified |
| billing.refund_requests | 11 | 0 | qualified |
| billing.refunds | 26 | 0 | qualified |
| billing.tenant_channels | 3 | 0 | qualified |
| catalog.addons | 5 | 0 | qualified |
| catalog.coupon_redemptions | 0 | 0 | none |
| catalog.coupons | 0 | 0 | none |
| catalog.offer_items | 0 | 0 | none |
| catalog.offers | 0 | 0 | none |
| catalog.plans | 5 | 0 | qualified |
| catalog.prices | 4 | 0 | qualified |
| catalog.products | 1 | 0 | qualified |
| commerce.order_items | 9 | 0 | qualified |
| commerce.orders | 50 | 0 | qualified |
| commerce.price_snapshots | 8 | 0 | qualified |
| communication.communication_preferences | 3 | 0 | qualified |
| communication.communication_suppressions | 4 | 0 | qualified |
| communication.conversation_control_events | 1 | 0 | qualified |
| communication.conversations | 25 | 0 | qualified |
| communication.exceptions | 9 | 0 | qualified |
| communication.message_deliveries | 22 | 0 | qualified |
| communication.message_intents | 6 | 0 | qualified |
| communication.messages | 22 | 0 | qualified |
| communication.scheduled_contacts | 6 | 0 | qualified |
| communication.tenant_channels | 2 | 0 | qualified |
| control.auth_credentials | 0 | 0 | none |
| control.auth_sessions | 0 | 0 | none |
| control.feature_flags | 2 | 0 | qualified |
| control.membership_roles | 0 | 0 | none |
| control.permissions | 0 | 141 | bare-approx |
| control.role_permissions | 0 | 0 | none |
| control.roles | 0 | 3 | bare-approx |
| control.tenant_memberships | 4 | 0 | qualified |
| control.tenants | 6 | 0 | qualified |
| control.users | 0 | 1 | bare-approx |
| crm.customer_health_snapshots | 0 | 0 | none |
| crm.customers | 12 | 0 | qualified |
| crm.leads | 5 | 0 | qualified |
| entitlement.entitlement_grants | 1 | 0 | qualified |
| entitlement.entitlements | 6 | 0 | qualified |
| experiments.experiment_assignments | 16 | 0 | qualified |
| experiments.experiment_exposures | 8 | 0 | qualified |
| experiments.experiments | 8 | 0 | qualified |
| finance.cost_allocations | 40 | 0 | qualified |
| finance.financial_accounts | 3 | 0 | qualified |
| finance.financial_ledger_entries | 1 | 0 | qualified |
| finance.financial_transactions | 4 | 0 | qualified |
| growth.attribution_touches | 17 | 0 | qualified |
| growth.audience_definitions | 4 | 0 | qualified |
| growth.audience_members | 2 | 0 | qualified |
| growth.campaign_versions | 10 | 0 | qualified |
| growth.campaigns | 8 | 0 | qualified |
| growth.conversion_events | 6 | 0 | qualified |
| growth.creatives | 2 | 0 | qualified |
| identity.identities | 8 | 0 | qualified |
| identity.identity_merge_reviews | 0 | 0 | none |
| identity.persons | 14 | 0 | qualified |
| inventory.app_trials | 9 | 0 | qualified |
| inventory.credit_reservations | 9 | 0 | qualified |
| inventory.license_assets | 3 | 0 | qualified |
| inventory.procurement_orders | 7 | 0 | qualified |
| inventory.provider_credit_batches | 0 | 0 | none |
| inventory.provider_credit_entries | 0 | 0 | none |
| inventory.reconciliation_findings | 6 | 0 | qualified |
| inventory.supplier_app_items | 3 | 0 | qualified |
| inventory.supplier_app_snapshots | 5 | 0 | qualified |
| inventory.supplier_balance_snapshots | 3 | 0 | qualified |
| inventory.supplier_offers | 0 | 0 | none |
| inventory.suppliers | 4 | 0 | qualified |
| knowledge.knowledge_corrections | 4 | 0 | qualified |
| knowledge.knowledge_gaps | 4 | 0 | qualified |
| knowledge.knowledge_items | 48 | 0 | qualified |
| knowledge.knowledge_research_candidates | 4 | 0 | qualified |
| knowledge.knowledge_source_links | 0 | 0 | none |
| knowledge.knowledge_sources | 0 | 0 | none |
| knowledge.knowledge_versions | 26 | 0 | qualified |
| knowledge.solution_outcomes | 2 | 0 | qualified |
| knowledge.solutions | 3 | 0 | qualified |
| loyalty.gift_passes | 5 | 0 | qualified |
| loyalty.reward_definitions | 4 | 0 | qualified |
| loyalty.reward_ledger_entries | 3 | 0 | qualified |
| loyalty.rewards | 48 | 0 | qualified |
| partners.learning_content | 4 | 0 | qualified |
| partners.learning_content_versions | 0 | 0 | none |
| partners.learning_progress | 6 | 0 | qualified |
| partners.partner_accounts | 8 | 0 | qualified |
| partners.partner_capabilities | 4 | 0 | qualified |
| partners.partner_memberships | 4 | 0 | qualified |
| partners.partner_relationships | 4 | 0 | qualified |
| partners.reseller_credit_entries | 4 | 0 | qualified |
| partners.reseller_credit_reservations | 6 | 0 | qualified |
| partners.reseller_orders | 8 | 0 | qualified |
| partners.reseller_price_books | 4 | 0 | qualified |
| platform.audit_log | 3 | 0 | qualified |
| platform.capabilities | 11 | 0 | qualified |
| platform.capability_events | 2 | 0 | qualified |
| platform.domain_events | 2 | 0 | qualified |
| platform.idempotency_keys | 4 | 0 | qualified |
| platform.inbox_messages | 6 | 0 | qualified |
| platform.outbox_messages | 9 | 0 | qualified |
| platform.outbox_runtime_control | 0 | 0 | none |
| platform.outbox_runtime_transitions | 0 | 0 | none |
| platform.outbox_transitions | 3 | 0 | qualified |
| platform.policy_documents | 5 | 0 | qualified |
| provider.provider_accounts | 14 | 0 | qualified |
| provider.provider_bindings | 7 | 0 | qualified |
| provider.provider_evidence | 3 | 0 | qualified |
| provider.provider_health_snapshots | 0 | 0 | none |
| provider.provider_operation_attempts | 6 | 0 | qualified |
| provider.provider_operations | 29 | 0 | qualified |
| provider.providers | 6 | 0 | qualified |
| referral.referral_programs | 2 | 0 | qualified |
| referral.referral_qualifications | 4 | 0 | qualified |
| referral.referral_reward_links | 12 | 0 | qualified |
| referral.referrals | 9 | 0 | qualified |
| renewal.recovery_tasks | 9 | 0 | qualified |
| security.risk_assessments | 0 | 0 | none |
| subscription.subscription_addon_cycle_charges | 0 | 0 | none |
| subscription.subscription_addons | 8 | 0 | qualified |
| subscription.subscription_cycles | 53 | 0 | qualified |
| subscription.subscriptions | 40 | 0 | qualified |
| subscription.trust_renewal_grants | 4 | 0 | qualified |
| support.incidents | 11 | 0 | qualified |
| support.problems | 13 | 0 | qualified |
| support.solution_attempts | 7 | 0 | qualified |
| support.support_tickets | 14 | 0 | qualified |
| support.technical_access_grants | 6 | 0 | qualified |
| support.ticket_incident_links | 5 | 0 | qualified |
| support.ticket_problem_links | 9 | 0 | qualified |
| trial.app_profiles | 2 | 0 | qualified |
| trial.compatibility_observations | 2 | 0 | qualified |
| trial.device_profiles | 3 | 0 | qualified |
| trial.network_observations | 2 | 0 | qualified |
| trial.trial_attempts | 3 | 0 | qualified |
| trial.trial_eligibility_decisions | 2 | 0 | qualified |
| trial.trial_technical_results | 9 | 0 | qualified |
| trial.trials | 16 | 0 | qualified |

## Classification heuristic (P1.1-v1)

  | Code | Suggestion | Meaning |
  |---|---|---|
  | ENROLLED | TENANT_SCOPED | `tenant_isolation` policy present (already RLS-enrolled) |
  | RESOLVER | PRE_CONTEXT | read pre-context via SECURITY DEFINER resolver (memberships, channel routing) |
  | WORKER-SYSTEM | CROSS_TENANT_SYSTEM | outbox publisher spine, migrations 050/051 (cross-tenant by design) |
  | AUTH-SURFACE | GLOBAL | pre-context auth tables, no tenant data |
  | RBAC-CATALOG | GLOBAL | owner-seeded RBAC catalogs |
  | GLOBAL-CATALOG | GLOBAL | hybrid/nullable-tenant catalogs with global rows, or migration bookkeeping |
  | AUDIT-APPEND | AUDIT_ONLY | append-only audit/event trail |
  | TENANT-ID-NOTNULL | TENANT_SCOPED | `tenant_id NOT NULL` but unenrolled: candidate for P1.2+ |
  | NULLABLE-TENANT-ID | UNKNOWN | nullable `tenant_id`, needs per-table review |
  | NO-TENANT-ID | UNKNOWN | no `tenant_id` and no allow-list entry: needs review (must be zero at cutover) |

  ## Re-run

  ```bash
  DATABASE_URL=postgresql://... bash scripts/rls-inventory.sh [out-dir]
  ```

  Read-only: SELECT-only statements plus `default_transaction_read_only=on`;
  fails closed without DATABASE_URL / psql / connectivity; never prints the
  URL and never selects secrets; psql stderr (which can echo connection-string
  fragments) is captured to a private temp file removed on exit, never relayed
  to the terminal. Idempotent: re-running overwrites the same
  dated directory. Hermetic regression proof (no database):
  `bash scripts/rls-inventory.sh --self-test`.
