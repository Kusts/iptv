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
