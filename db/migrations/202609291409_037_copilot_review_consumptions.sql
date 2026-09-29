-- AI Revenue & Operations Platform
-- Migration 037: Copilot review single-use consumptions (Wave 14-COPILOT fix)
--
-- An approved `copilot_command` human review authorizes EXACTLY ONE Copilot
-- execution: the first `execute` with a given reviewId atomically claims the
-- row below (INSERT wins, concurrent/duplicate claims hit the UNIQUE guard
-- and fail with 409). Without this, an approval is reusable: a new execute
-- with the same reviewId passes again (e.g. cancel + uncancel + re-execute).
-- A dedicated table (instead of widening `human_review_requests`) keeps the
-- append-only HITL substrate untouched; the FK guarantees the review exists
-- and tenant scoping mirrors the HITL convention (tenant_id, id) UNIQUE.

BEGIN;

CREATE TABLE agent.copilot_review_consumptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    human_review_request_id uuid NOT NULL,
    command text NOT NULL,
    command_hash text NOT NULL,
    consumed_by_actor_id text NOT NULL,
    consumed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT copilot_consumptions_command_not_blank CHECK (btrim(command) <> ''),
    CONSTRAINT copilot_consumptions_request_fk FOREIGN KEY (tenant_id, human_review_request_id)
        REFERENCES agent.human_review_requests (tenant_id, id),
    CONSTRAINT copilot_consumptions_tenant_id_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT copilot_consumptions_single_use UNIQUE (tenant_id, human_review_request_id)
);

CREATE INDEX copilot_consumptions_request_idx
    ON agent.copilot_review_consumptions (tenant_id, human_review_request_id);

COMMIT;
