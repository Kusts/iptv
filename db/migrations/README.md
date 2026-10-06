# Database Migrations — MVP Core

> Status: static-reviewed; PostgreSQL runtime gate pending  
> Versão: 0.9  
> Banco alvo: PostgreSQL

## Order

1. `202609201530_001_platform.sql`
2. `202609201531_002_identity_crm.sql`
3. `202609201532_003_trial.sql`
4. `202609201600_004_catalog_commerce.sql`
5. `202609201601_005_billing_finance.sql`
6. `202609201602_006_subscriptions_entitlements.sql`
7. `202609201603_007_provider_fulfillment.sql`
8. `202609201604_008_inventory_procurement.sql`
9. `202609201640_009_communications.sql`
10. `202609201641_010_support_hitl_knowledge.sql`
11. `202609201642_011_referral_rewards.sql`
12. `202609261200_012_identity_rbac.sql`
13. `202609261300_013_command_permissions.sql`
14. `202609261400_014_policy_capability.sql`
15. `202609261500_015_comm_channels_exceptions.sql`
16. `202609261600_016_agent_runtime.sql`
17. `202609261700_017_trial_provider_effect.sql`
18. `202609261800_018_billing_webhook_exceptions.sql`
19. `202609261900_019_subscription_cycle_guard.sql`
20. `202609262000_020_renewal_recovery.sql`
21. `202609262100_021_support_hitl_center.sql`
22. `202609262200_022_supplier_app_catalog.sql`
23. `202609281800_023_auth_session_tenant_context_revision.sql`
24. `202609282331_024_app_trials.sql`
25. `202609282332_025_supplier_balance_reservations.sql`
26. `202609282333_026_license_assets_reconciliation.sql`
27. `202609290000_027_procurement_identity_unique.sql`
28. `202609291400_028_growth_campaigns.sql`
29. `202609291401_029_message_intents_attribution.sql`
30. `202609291402_030_growth_unit_cost.sql`
31. `202609291403_031_finance_cost_allocation_dedupe.sql`
32. `202609291404_032_partners_core.sql`
33. `202609291405_033_reseller_credit_orders.sql`
34. `202609291406_034_academy.sql`
35. `202609291407_035_partners_membership_idempotency.sql`
36. `202609291408_036_analytics_metric_catalog.sql`
37. `202609291409_037_copilot_review_consumptions.sql`
38. `202609291410_038_knowledge_maturation.sql`
39. `202609291411_039_experiments.sql`
40. `202609300000_040_support_technical_access.sql`
41. `202609300001_041_rls_app_role_pilot.sql`
42. `202609300002_042_rls_crm_communications_rollout.sql`
43. `202609300003_043_waha_channel_resolver.sql`
44. `202610010000_044_provider_cinevision_capability_gate.sql`
45. `202610010001_045_provider_dispatch_lease.sql`
46. `202610010002_046_provider_cinevision_trial_capability_gate.sql`
47. `202610050000_047_rls_control_identity_rollout.sql`
48. `202610050001_048_rls_feature_flags_policy_split.sql`
49. `202610060000_049_control_membership_resolvers.sql`

## Coverage by batch

### 001–003 — Platform → Identity/CRM → Trial

- tenant/control-plane baseline;
- idempotency, audit, event/outbox/inbox primitives;
- Person/Identity/Lead/Customer;
- one primary Trial per Person;
- Retrial with previous Trial + reason;
- no concurrent open free-access window;
- technical outcome separated from Trial lifecycle.

### 004–008 — Commerce → Fulfillment

- Catalog, Offers, Orders and immutable price snapshots;
- Payment/Refund and double-entry financial ledger;
- Subscription cycles and recurring add-ons;
- per-cycle additional-connection revenue + provider COGS;
- Entitlements;
- Provider accounts/bindings/operations/evidence/health;
- supplier offers and provider credit inventory ledger.

### 009–011 — Communications → Learning → Referral

- omnichannel conversation/message persistence;
- communication preferences/suppressions and control history;
- Support Ticket + Incident + Problem;
- HITL HumanReview lifecycle;
- Knowledge source/item/version/solution/outcome lifecycle;
- Referral qualification;
- Reward definitions/rewards;
- append-only Reward Wallet ledger;
- Gift Pass baseline.

### 012–049 — Append-only increments after MVP Core

- Applied in filename order after 011; each file is self-describing (RLS
  policy rollout — CRM/communications, then control+identity with the 048
  feature-flags policy split and the 049 control-membership resolvers +
  enrollment —, WAHA channel resolver, provider CINEVISION
  capability gates, provider dispatch lease, and other baseline increments).
- The canonical list above is generated from `db/migrations/*.sql` —
  append new migrations there; never edit or reorder existing files.

## Critical physical invariants

- active Identity uniqueness is tenant-scoped;
- all critical cross-aggregate references use tenant-aware composite FKs where the target is tenant-owned;
- one primary `TRIAL` per Person; exceptions are explicit `RETRIAL`;
- Order `SETTLED` does not imply external Payment `PAID`;
- financial and provider/reward ledgers are append-only;
- additional connection is a recurring add-on and records economics every active cycle;
- ProviderOperation only uses the canonical lifecycle ending in `SUCCEEDED`, never implicit success;
- Messages and conversation-control history are append-only;
- Knowledge versions/outcomes and HumanReview actions preserve history;
- active referral attribution is unique per Person/program.

## Testing

Static checks:

```bash
python scripts/validate_docs.py
python tests/contracts/test_contracts.py
```

PostgreSQL integration tests, against a disposable DB:

```bash
export DATABASE_URL='postgresql://...'
./scripts/run_pg_tests.sh
```

See `db/tests/README.md` and `docs/03-architecture/migrations/runtime-test-plan-v0.8.md`.

## Rollback

The migration strategy remains roll-forward oriented. Automatic down migrations are intentionally not provided for these domain batches; disposable CI databases should be recreated from zero.
