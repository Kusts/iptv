\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
    t uuid;
    p uuid;
    primary_trial uuid;
BEGIN
    INSERT INTO control.tenants (slug, name) VALUES ('test-trial-' || gen_random_uuid(), 'Trial Test') RETURNING id INTO t;
    INSERT INTO identity.persons (tenant_id) VALUES (t) RETURNING id INTO p;

    INSERT INTO trial.trials (tenant_id, person_id, trial_kind, requested_duration_minutes, lifecycle_status)
    VALUES (t, p, 'TRIAL', 60, 'ACTIVE') RETURNING id INTO primary_trial;

    BEGIN
        INSERT INTO trial.trials (tenant_id, person_id, trial_kind, requested_duration_minutes)
        VALUES (t, p, 'TRIAL', 60);
        RAISE EXCEPTION 'expected second primary Trial to fail';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO trial.trials (tenant_id, person_id, trial_kind, previous_trial_id, retrial_reason, requested_duration_minutes)
        VALUES (t, p, 'RETRIAL', primary_trial, 'provider incident', 60);
        RAISE EXCEPTION 'expected concurrent free-access window to fail';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    UPDATE trial.trials SET lifecycle_status = 'ENDED', ended_at = now() WHERE id = primary_trial;

    INSERT INTO trial.trials (tenant_id, person_id, trial_kind, previous_trial_id, retrial_reason, requested_duration_minutes)
    VALUES (t, p, 'RETRIAL', primary_trial, 'provider incident', 60);
END $$;

ROLLBACK;
