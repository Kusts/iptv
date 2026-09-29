-- AI Revenue & Operations Platform
-- Migration 038: Knowledge/Learning maturation MVP (Wave 15)
--
-- Tenant-scoped maturation tables over the Wave 8 substrate (migration
-- 010): human corrections against versioned items (the correction itself
-- is mutable workflow; the item history stays append-only — applying a
-- correction INSERTs a new `knowledge_versions` row and only moves the
-- item pointer), knowledge gaps (questions/tickets without a usable
-- answer) and research candidates linking a gap to a proposed item.
-- Lifecycle enums mirror the knowledge_items convention (tenant_id, id
-- UNIQUE); no UPDATE/DELETE is ever issued against knowledge_versions.

BEGIN;

CREATE TABLE knowledge.knowledge_corrections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    knowledge_item_id uuid NOT NULL,
    target_version_id uuid,
    proposed_text text NOT NULL,
    proposed_structured_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'OPEN',
    applied_in_version_id uuid,
    decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT knowledge_corrections_item_fk FOREIGN KEY (tenant_id, knowledge_item_id)
        REFERENCES knowledge.knowledge_items (tenant_id, id),
    CONSTRAINT knowledge_corrections_target_fk FOREIGN KEY (tenant_id, target_version_id)
        REFERENCES knowledge.knowledge_versions (tenant_id, id),
    CONSTRAINT knowledge_corrections_applied_fk FOREIGN KEY (tenant_id, applied_in_version_id)
        REFERENCES knowledge.knowledge_versions (tenant_id, id),
    CONSTRAINT knowledge_corrections_status_check CHECK (status IN ('OPEN','APPLIED','REJECTED')),
    CONSTRAINT knowledge_corrections_text_not_blank CHECK (btrim(proposed_text) <> ''),
    CONSTRAINT knowledge_corrections_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX knowledge_corrections_queue_idx
    ON knowledge.knowledge_corrections (tenant_id, status, created_at)
    WHERE status = 'OPEN';
CREATE INDEX knowledge_corrections_item_idx
    ON knowledge.knowledge_corrections (tenant_id, knowledge_item_id, created_at DESC);

CREATE TABLE knowledge.knowledge_gaps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    question text NOT NULL,
    support_ticket_id uuid,
    status text NOT NULL DEFAULT 'OPEN',
    closed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT knowledge_gaps_ticket_fk FOREIGN KEY (tenant_id, support_ticket_id)
        REFERENCES support.support_tickets (tenant_id, id),
    CONSTRAINT knowledge_gaps_status_check CHECK (status IN ('OPEN','RESEARCHING','CLOSED')),
    CONSTRAINT knowledge_gaps_question_not_blank CHECK (btrim(question) <> ''),
    CONSTRAINT knowledge_gaps_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX knowledge_gaps_queue_idx
    ON knowledge.knowledge_gaps (tenant_id, status, created_at)
    WHERE status IN ('OPEN','RESEARCHING');

CREATE TABLE knowledge.knowledge_research_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    knowledge_gap_id uuid NOT NULL,
    knowledge_item_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'PROPOSED',
    decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT knowledge_research_candidates_gap_fk FOREIGN KEY (tenant_id, knowledge_gap_id)
        REFERENCES knowledge.knowledge_gaps (tenant_id, id),
    CONSTRAINT knowledge_research_candidates_item_fk FOREIGN KEY (tenant_id, knowledge_item_id)
        REFERENCES knowledge.knowledge_items (tenant_id, id),
    CONSTRAINT knowledge_research_candidates_status_check CHECK (status IN ('PROPOSED','ACCEPTED','REJECTED','PUBLISHED')),
    CONSTRAINT knowledge_research_candidates_unique UNIQUE (tenant_id, knowledge_gap_id, knowledge_item_id),
    CONSTRAINT knowledge_research_candidates_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX knowledge_research_candidates_gap_idx
    ON knowledge.knowledge_research_candidates (tenant_id, knowledge_gap_id, status);

COMMIT;
