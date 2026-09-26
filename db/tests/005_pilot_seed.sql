-- Runtime fixture assertions. Run only after db/seeds/001_pilot_baseline.sql.
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_count integer;
  v_amount bigint;
  v_billing_type text;
BEGIN
  SELECT count(*) INTO v_count FROM control.tenants WHERE id = '00000000-0000-4000-8000-000000000001';
  IF v_count <> 1 THEN RAISE EXCEPTION 'pilot tenant fixture missing'; END IF;

  SELECT p.amount_minor INTO v_amount
  FROM catalog.prices p
  WHERE p.id = '00000000-0000-4000-8000-000000000321';
  IF v_amount <> 3000 THEN RAISE EXCEPTION 'monthly confirmed price fixture drift: %', v_amount; END IF;

  SELECT a.billing_type INTO v_billing_type
  FROM catalog.addons a
  WHERE a.id = '00000000-0000-4000-8000-000000000331';
  IF v_billing_type <> 'RECURRING' THEN RAISE EXCEPTION 'additional connection must remain recurring'; END IF;

  SELECT count(*) INTO v_count
  FROM trial.trials
  WHERE tenant_id='00000000-0000-4000-8000-000000000001'
    AND person_id='00000000-0000-4000-8000-000000000501'
    AND trial_kind='TRIAL';
  IF v_count <> 1 THEN RAISE EXCEPTION 'lead fixture must have exactly one primary Trial'; END IF;

  SELECT count(*) INTO v_count
  FROM referral.referrals r
  JOIN crm.customers c ON c.tenant_id=r.tenant_id AND c.id=r.advocate_customer_id
  WHERE r.id='00000000-0000-4000-8000-000000000711'
    AND c.person_id=r.referred_person_id;
  IF v_count <> 0 THEN RAISE EXCEPTION 'seed referral accidentally self-refers'; END IF;
END $$;

SELECT 'OK: pilot seed assertions passed' AS result;
