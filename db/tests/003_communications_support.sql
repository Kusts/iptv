\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
    t uuid;
    p uuid;
    c uuid;
    m uuid;
    ticket uuid;
    mutation_blocked boolean := false;
BEGIN
    INSERT INTO control.tenants (slug, name) VALUES ('test-support-' || gen_random_uuid(), 'Support Test') RETURNING id INTO t;
    INSERT INTO identity.persons (tenant_id) VALUES (t) RETURNING id INTO p;
    INSERT INTO communication.conversations (tenant_id, person_id, channel)
    VALUES (t, p, 'WHATSAPP') RETURNING id INTO c;

    INSERT INTO communication.messages (tenant_id, conversation_id, person_id, direction, channel, sender_type, body_text, occurred_at)
    VALUES (t, c, p, 'INBOUND', 'WHATSAPP', 'PERSON', 'teste', now()) RETURNING id INTO m;

    BEGIN
        UPDATE communication.messages SET body_text = 'mutated' WHERE id = m;
    EXCEPTION WHEN raise_exception THEN
        mutation_blocked := true;
    END;
    IF NOT mutation_blocked THEN
        RAISE EXCEPTION 'expected Message append-only update to fail';
    END IF;

    INSERT INTO support.support_tickets (tenant_id, person_id, conversation_id, summary)
    VALUES (t, p, c, 'Playback failure') RETURNING id INTO ticket;

    UPDATE support.support_tickets SET status = 'TRIAGING' WHERE id = ticket;

    IF (SELECT status FROM support.support_tickets WHERE id = ticket) <> 'TRIAGING' THEN
        RAISE EXCEPTION 'ticket status update failed';
    END IF;
END $$;

ROLLBACK;
