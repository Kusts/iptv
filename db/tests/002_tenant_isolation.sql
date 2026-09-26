\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
    ta uuid;
    tb uuid;
    pa uuid;
BEGIN
    INSERT INTO control.tenants (slug, name) VALUES ('test-a-' || gen_random_uuid(), 'Tenant A') RETURNING id INTO ta;
    INSERT INTO control.tenants (slug, name) VALUES ('test-b-' || gen_random_uuid(), 'Tenant B') RETURNING id INTO tb;
    INSERT INTO identity.persons (tenant_id) VALUES (ta) RETURNING id INTO pa;

    BEGIN
        INSERT INTO crm.leads (tenant_id, person_id) VALUES (tb, pa);
        RAISE EXCEPTION 'expected cross-tenant Person/Lead link to fail';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO communication.conversations (tenant_id, person_id, channel)
        VALUES (tb, pa, 'WHATSAPP');
        RAISE EXCEPTION 'expected cross-tenant Conversation/Person link to fail';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
END $$;

ROLLBACK;
