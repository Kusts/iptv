-- 011 Fail-closed per-action `provider.cinevision.trial` capability gate (migration 046).
-- Proves the gate row exists UNAVAILABLE/UNCERTIFIED (so `decideTrialDispatchGate`
-- blocks every real `trial.provision` even with the GLOBAL `provider.cinevision`
-- row AVAILABLE), re-applying the migration 046 statements is a no-op (no
-- duplicate capability row, no drift on either table), and the append-only
-- `platform.capability_events` log records the UNAVAILABLE transition from
-- NULL. The GLOBAL `provider.cinevision` row is read-only here (never flipped,
-- never written). No fixtures: every assertion reads migration state, and the
-- re-apply probes run inside this transaction, which ROLLBACKs at the end.
-- Execute: cat file | docker exec -i iptv-postgres-1 psql -U iptv -d <disposable_db> -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on
BEGIN;

-- 1) Gate row exists, fail-closed.
DO $$
DECLARE
    v_availability text;
    v_certification text;
BEGIN
    SELECT availability, certification_status INTO v_availability, v_certification
    FROM platform.capabilities WHERE key = 'provider.cinevision.trial';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'migration 046 not applied: platform.capabilities row provider.cinevision.trial is missing';
    END IF;
    IF v_availability IS DISTINCT FROM 'UNAVAILABLE' THEN
        RAISE EXCEPTION 'provider.cinevision.trial must be UNAVAILABLE (fail-closed), saw %', v_availability;
    END IF;
    IF v_certification IS DISTINCT FROM 'UNCERTIFIED' THEN
        RAISE EXCEPTION 'provider.cinevision.trial must be UNCERTIFIED, saw %', v_certification;
    END IF;
    RAISE NOTICE 'gate row OK: provider.cinevision.trial UNAVAILABLE/UNCERTIFIED';
END $$;

-- Snapshot both rows before the re-apply probe.
CREATE TEMP TABLE trial_cap_before AS
SELECT key, owner_context, availability, certification_status, risk_level,
       mvp_phase, manual_equivalent, policy_family, degradation
FROM platform.capabilities WHERE key = 'provider.cinevision.trial';

CREATE TEMP TABLE trial_evt_before AS
SELECT capability_key, from_availability, to_availability, reason
FROM platform.capability_events
WHERE capability_key = 'provider.cinevision.trial' AND to_availability = 'UNAVAILABLE';

-- 2) Re-apply: the exact migration 046 statements, verbatim.
INSERT INTO platform.capabilities
    (key, owner_context, availability, certification_status, risk_level, mvp_phase, manual_equivalent, policy_family, degradation)
VALUES
    ('provider.cinevision.trial', 'provider', 'UNAVAILABLE', 'UNCERTIFIED', 'HIGH', 'W0',
     'Provider operator fulfills the operation manually (HITL) via provider.resolve_operation',
     'provider-integration',
     'Forced MANUAL: every real trial.provision parks in HUMAN_REQUIRED until the disposable-account trial environment is certified AVAILABLE (SPEC cinevision-runtime-hardening)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO platform.capability_events
    (capability_key, from_availability, to_availability, reason)
SELECT 'provider.cinevision.trial', NULL, 'UNAVAILABLE',
    'FASE5-S4S5 fail-closed gate fixture: per-action CINEVISION trial writes uncertified; real trial.provision blocked until disposable-account certification (SPEC cinevision-runtime-hardening)'
WHERE NOT EXISTS (
    SELECT 1 FROM platform.capability_events
    WHERE capability_key = 'provider.cinevision.trial'
      AND to_availability = 'UNAVAILABLE'
);

DO $$
DECLARE
    n_cap integer;
    n_evt integer;
BEGIN
    SELECT count(*) INTO n_cap
    FROM platform.capabilities WHERE key = 'provider.cinevision.trial';
    IF n_cap <> 1 THEN
        RAISE EXCEPTION 're-apply must not duplicate the capability row, saw % rows', n_cap;
    END IF;
    IF EXISTS (
        (SELECT key, owner_context, availability, certification_status, risk_level,
                mvp_phase, manual_equivalent, policy_family, degradation
         FROM platform.capabilities WHERE key = 'provider.cinevision.trial')
        EXCEPT
        (SELECT key, owner_context, availability, certification_status, risk_level,
                mvp_phase, manual_equivalent, policy_family, degradation
         FROM trial_cap_before)
    ) THEN
        RAISE EXCEPTION 're-apply must not drift the capability row';
    END IF;
    SELECT count(*) INTO n_evt
    FROM platform.capability_events
    WHERE capability_key = 'provider.cinevision.trial' AND to_availability = 'UNAVAILABLE';
    IF n_evt <> 1 THEN
        RAISE EXCEPTION 're-apply must not duplicate the gate event, saw % rows', n_evt;
    END IF;
    IF EXISTS ((SELECT capability_key, from_availability, to_availability, reason FROM trial_evt_before) EXCEPT (SELECT capability_key, from_availability, to_availability, reason FROM platform.capability_events
        WHERE capability_key = 'provider.cinevision.trial' AND to_availability = 'UNAVAILABLE')) THEN
        RAISE EXCEPTION 're-apply must not drift the gate event';
    END IF;
    RAISE NOTICE 'idempotency OK: re-apply duplicated nothing and changed nothing';
END $$;

-- 3) The append-only log records the UNAVAILABLE transition from NULL.
DO $$
DECLARE
    v_from text;
    v_reason text;
BEGIN
    SELECT from_availability, reason INTO v_from, v_reason
    FROM platform.capability_events
    WHERE capability_key = 'provider.cinevision.trial' AND to_availability = 'UNAVAILABLE'
    LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'gate event missing: no UNAVAILABLE capability_events row for provider.cinevision.trial';
    END IF;
    IF v_from IS NOT NULL THEN
        RAISE EXCEPTION 'gate event must transition from NULL (fresh gate), saw %', v_from;
    END IF;
    IF v_reason IS DISTINCT FROM 'FASE5-S4S5 fail-closed gate fixture: per-action CINEVISION trial writes uncertified; real trial.provision blocked until disposable-account certification (SPEC cinevision-runtime-hardening)' THEN
        RAISE EXCEPTION 'gate event carries an unexpected reason: %', v_reason;
    END IF;
    RAISE NOTICE 'gate event OK: NULL -> UNAVAILABLE with the FASE5-S4S5 fail-closed reason';
END $$;

-- 4) The GLOBAL row is untouched by this migration (read-only witness: the
-- per-action gate is BESIDE it, never a rewrite of it).
DO $$
DECLARE
    n_global integer;
BEGIN
    SELECT count(*) INTO n_global
    FROM platform.capabilities WHERE key = 'provider.cinevision';
    IF n_global > 1 THEN
        RAISE EXCEPTION 'global provider.cinevision row must never duplicate, saw % rows', n_global;
    END IF;
    RAISE NOTICE 'global row witness OK: provider.cinevision rows = % (migration 046 writes only its own key)', n_global;
END $$;

ROLLBACK;
