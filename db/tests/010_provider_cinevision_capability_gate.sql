-- 010 Fail-closed `provider.cinevision` capability gate (migration 044).
-- Proves the gate row exists UNAVAILABLE/UNCERTIFIED (so `applyCapabilityGate`
-- forces MANUAL), re-applying the migration 044 statements is a no-op (no
-- duplicate capability row, no drift on either table), and the append-only
-- `platform.capability_events` log records the UNAVAILABLE transition from
-- NULL. No fixtures: every assertion reads migration state, and the re-apply
-- probes run inside this transaction, which ROLLBACKs at the end.
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
    FROM platform.capabilities WHERE key = 'provider.cinevision';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'migration 044 not applied: platform.capabilities row provider.cinevision is missing';
    END IF;
    IF v_availability IS DISTINCT FROM 'UNAVAILABLE' THEN
        RAISE EXCEPTION 'provider.cinevision must be UNAVAILABLE (fail-closed), saw %', v_availability;
    END IF;
    IF v_certification IS DISTINCT FROM 'UNCERTIFIED' THEN
        RAISE EXCEPTION 'provider.cinevision must be UNCERTIFIED, saw %', v_certification;
    END IF;
    RAISE NOTICE 'gate row OK: provider.cinevision UNAVAILABLE/UNCERTIFIED';
END $$;

-- Snapshot both rows before the re-apply probe.
CREATE TEMP TABLE cap_before AS
SELECT key, owner_context, availability, certification_status, risk_level,
       mvp_phase, manual_equivalent, policy_family, degradation
FROM platform.capabilities WHERE key = 'provider.cinevision';

CREATE TEMP TABLE evt_before AS
SELECT capability_key, from_availability, to_availability, reason
FROM platform.capability_events
WHERE capability_key = 'provider.cinevision' AND to_availability = 'UNAVAILABLE';

-- 2) Re-apply: the exact migration 044 statements, verbatim.
INSERT INTO platform.capabilities
    (key, owner_context, availability, certification_status, risk_level, mvp_phase, manual_equivalent, policy_family, degradation)
VALUES
    ('provider.cinevision', 'provider', 'UNAVAILABLE', 'UNCERTIFIED', 'HIGH', 'W0',
     'Provider operator fulfills the operation manually (HITL) via provider.resolve_operation',
     'provider-integration',
     'Forced MANUAL: every operation parks in HUMAN_REQUIRED until durable post-commit dispatch with certified readback')
ON CONFLICT (key) DO NOTHING;

INSERT INTO platform.capability_events
    (capability_key, from_availability, to_availability, reason)
SELECT 'provider.cinevision', NULL, 'UNAVAILABLE',
    'W0 fail-closed gate fixture: CINEVISION integration uncertified; real writes blocked until durable post-commit dispatch + certified readback (SPEC cinevision-runtime-hardening)'
WHERE NOT EXISTS (
    SELECT 1 FROM platform.capability_events
    WHERE capability_key = 'provider.cinevision'
      AND to_availability = 'UNAVAILABLE'
);

DO $$
DECLARE
    n_cap integer;
    n_evt integer;
BEGIN
    SELECT count(*) INTO n_cap
    FROM platform.capabilities WHERE key = 'provider.cinevision';
    IF n_cap <> 1 THEN
        RAISE EXCEPTION 're-apply must not duplicate the capability row, saw % rows', n_cap;
    END IF;
    IF EXISTS (
        (SELECT key, owner_context, availability, certification_status, risk_level,
                mvp_phase, manual_equivalent, policy_family, degradation
         FROM platform.capabilities WHERE key = 'provider.cinevision')
        EXCEPT
        (SELECT key, owner_context, availability, certification_status, risk_level,
                mvp_phase, manual_equivalent, policy_family, degradation
         FROM cap_before)
    ) THEN
        RAISE EXCEPTION 're-apply must not drift the capability row';
    END IF;
    SELECT count(*) INTO n_evt
    FROM platform.capability_events
    WHERE capability_key = 'provider.cinevision' AND to_availability = 'UNAVAILABLE';
    IF n_evt <> 1 THEN
        RAISE EXCEPTION 're-apply must not duplicate the gate event, saw % rows', n_evt;
    END IF;
    IF EXISTS ((SELECT capability_key, from_availability, to_availability, reason FROM evt_before) EXCEPT (SELECT capability_key, from_availability, to_availability, reason FROM platform.capability_events
        WHERE capability_key = 'provider.cinevision' AND to_availability = 'UNAVAILABLE')) THEN
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
    WHERE capability_key = 'provider.cinevision' AND to_availability = 'UNAVAILABLE'
    LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'gate event missing: no UNAVAILABLE capability_events row for provider.cinevision';
    END IF;
    IF v_from IS NOT NULL THEN
        RAISE EXCEPTION 'gate event must transition from NULL (fresh gate), saw %', v_from;
    END IF;
    IF v_reason IS DISTINCT FROM 'W0 fail-closed gate fixture: CINEVISION integration uncertified; real writes blocked until durable post-commit dispatch + certified readback (SPEC cinevision-runtime-hardening)' THEN
        RAISE EXCEPTION 'gate event carries an unexpected reason: %', v_reason;
    END IF;
    RAISE NOTICE 'gate event OK: NULL -> UNAVAILABLE with the W0 fail-closed reason';
END $$;

ROLLBACK;
