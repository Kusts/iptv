-- AI Revenue & Operations Platform
-- Migration 021: Wave 8 Support + HITL center surface
--
-- Justification (only genuinely missing pieces; 010 remains the storage
-- truth for incidents/problems/tickets/links/attempts, knowledge and
-- human reviews — untouched below):
-- - `support.support_tickets.assignee_user_id`: the 010 ticket table has NO
--   assignee column, but Wave 8 needs `ticket.assign` + the `my-work` queue
--   + center ownership. Nullable UUID FK to the tenant membership (mirrors
--   the 010 `human_review_assignee_membership_fk` discipline), so only
--   active members of the SAME tenant can own a ticket.
-- - Permission catalog extension for the new command surface
--   (`support.ticket.read`, `support.incident.write`, `knowledge.read`,
--   `knowledge.write`; `support.ticket.write` already exists since 012).
--   Mirrors `packages/auth/src/permissions.ts` ROLE_PERMISSIONS.
-- The HITL "center" itself is a read-model aggregation over the EXISTING
-- queue tables (`agent.human_review_requests`, `communication.exceptions`,
-- `billing.exceptions`, `renewal.recovery_tasks`) — no new table, no
-- restructuring. The `hitl.sla` policy family needs no storage: it reads
-- the generic `platform.policy_documents` rows like every other family.

BEGIN;

ALTER TABLE support.support_tickets
    ADD COLUMN assignee_user_id uuid;

ALTER TABLE support.support_tickets
    ADD CONSTRAINT support_tickets_assignee_membership_fk
    FOREIGN KEY (tenant_id, assignee_user_id)
    REFERENCES control.tenant_memberships (tenant_id, user_id);

CREATE INDEX support_tickets_assignee_idx
    ON support.support_tickets (tenant_id, assignee_user_id, status)
    WHERE assignee_user_id IS NOT NULL AND status NOT IN ('CLOSED', 'CANCELLED');

INSERT INTO control.permissions (key, description) VALUES
    ('support.ticket.read', 'Read support tickets, incidents, problems and the HITL center aggregation'),
    ('support.incident.write', 'Open/transition incidents and problems (owning context for incident/problem lifecycle)'),
    ('knowledge.read', 'Read tenant knowledge items and versions'),
    ('knowledge.write', 'Create/update/archive tenant knowledge items')
ON CONFLICT (key) DO NOTHING;

INSERT INTO control.role_permissions (role_key, permission_key) VALUES
    ('platform_admin', 'support.ticket.read'),
    ('platform_admin', 'support.incident.write'),
    ('platform_admin', 'knowledge.read'),
    ('platform_admin', 'knowledge.write'),
    ('tenant_owner', 'support.ticket.read'),
    ('tenant_owner', 'support.incident.write'),
    ('tenant_owner', 'knowledge.read'),
    ('tenant_owner', 'knowledge.write'),
    ('tenant_admin', 'support.ticket.read'),
    ('tenant_admin', 'support.incident.write'),
    ('tenant_admin', 'knowledge.read'),
    ('tenant_admin', 'knowledge.write'),
    ('tenant_operator', 'support.ticket.read'),
    ('tenant_operator', 'knowledge.read')
ON CONFLICT DO NOTHING;

COMMIT;
