BEGIN;

CREATE TABLE support.technical_access_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    person_id uuid NOT NULL,
    support_ticket_id uuid NOT NULL,
    reason text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    granted_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoked_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT technical_access_grants_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT technical_access_grants_ticket_fk FOREIGN KEY (tenant_id, support_ticket_id)
        REFERENCES support.support_tickets (tenant_id, id),
    CONSTRAINT technical_access_grants_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT technical_access_grants_status_check CHECK (status IN ('ACTIVE','EXPIRED','REVOKED')),
    CONSTRAINT technical_access_grants_reason_not_blank CHECK (btrim(reason) <> ''),
    CONSTRAINT technical_access_grants_expiry_check CHECK (expires_at > granted_at),
    CONSTRAINT technical_access_grants_revoked_shape_check CHECK (
        (status = 'REVOKED' AND revoked_at IS NOT NULL)
        OR
        (status <> 'REVOKED' AND revoked_at IS NULL)
    ),
    CONSTRAINT technical_access_grants_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX technical_access_grants_person_idx
    ON support.technical_access_grants (tenant_id, person_id, created_at DESC);

CREATE INDEX technical_access_grants_ticket_idx
    ON support.technical_access_grants (tenant_id, support_ticket_id);

CREATE INDEX technical_access_grants_active_expiry_idx
    ON support.technical_access_grants (tenant_id, expires_at)
    WHERE status = 'ACTIVE';

COMMIT;
