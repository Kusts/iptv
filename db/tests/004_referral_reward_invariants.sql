\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
    t uuid;
    advocate_person uuid;
    advocate_customer uuid;
    referred_person uuid;
    program uuid;
    ref1 uuid;
    self_referral_blocked boolean := false;
BEGIN
    INSERT INTO control.tenants (slug, name) VALUES ('test-ref-' || gen_random_uuid(), 'Referral Test') RETURNING id INTO t;
    INSERT INTO identity.persons (tenant_id) VALUES (t) RETURNING id INTO advocate_person;
    INSERT INTO crm.customers (tenant_id, person_id) VALUES (t, advocate_person) RETURNING id INTO advocate_customer;
    INSERT INTO identity.persons (tenant_id) VALUES (t) RETURNING id INTO referred_person;
    INSERT INTO referral.referral_programs (tenant_id, name, rules_version, starts_at)
    VALUES (t, 'Default', 'v1', now()) RETURNING id INTO program;

    INSERT INTO referral.referrals (tenant_id, program_id, advocate_customer_id, referred_person_id, referral_code, status)
    VALUES (t, program, advocate_customer, referred_person, 'CODE-A', 'ATTRIBUTED') RETURNING id INTO ref1;

    BEGIN
        INSERT INTO referral.referrals (tenant_id, program_id, advocate_customer_id, referred_person_id, referral_code, status)
        VALUES (t, program, advocate_customer, advocate_person, 'SELF', 'ATTRIBUTED');
    EXCEPTION WHEN raise_exception THEN
        self_referral_blocked := true;
    END;
    IF NOT self_referral_blocked THEN
        RAISE EXCEPTION 'expected active self-referral to fail';
    END IF;

    BEGIN
        INSERT INTO referral.referrals (tenant_id, program_id, advocate_customer_id, referred_person_id, referral_code, status)
        VALUES (t, program, advocate_customer, referred_person, 'CODE-B', 'ENGAGED');
        RAISE EXCEPTION 'expected duplicate active attribution to fail';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
END $$;

ROLLBACK;
