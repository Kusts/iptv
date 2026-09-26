-- AI Revenue & Operations Platform
-- Migration 010: Support, Incident/Problem, HITL and Knowledge Intelligence

BEGIN;

CREATE SCHEMA IF NOT EXISTS support;
CREATE SCHEMA IF NOT EXISTS knowledge;
CREATE SCHEMA IF NOT EXISTS agent;

CREATE TABLE support.incidents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    status text NOT NULL DEFAULT 'DETECTED',
    severity text NOT NULL DEFAULT 'MEDIUM',
    provider_account_id uuid,
    server_key text,
    service_key text,
    title text NOT NULL,
    summary text,
    detected_at timestamptz NOT NULL DEFAULT now(),
    confirmed_at timestamptz,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT incidents_provider_account_fk FOREIGN KEY (tenant_id, provider_account_id)
        REFERENCES provider.provider_accounts (tenant_id, id),
    CONSTRAINT incidents_status_check CHECK (status IN ('DETECTED','CONFIRMED','MONITORING','RESOLVED','CANCELLED')),
    CONSTRAINT incidents_severity_check CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    CONSTRAINT incidents_title_not_blank CHECK (btrim(title) <> ''),
    CONSTRAINT incidents_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX incidents_active_idx
    ON support.incidents (tenant_id, status, severity, detected_at DESC)
    WHERE status IN ('DETECTED','CONFIRMED','MONITORING');

CREATE TABLE support.problems (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    status text NOT NULL DEFAULT 'OPEN',
    title text NOT NULL,
    root_cause text,
    workaround_summary text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    CONSTRAINT problems_status_check CHECK (status IN ('OPEN','INVESTIGATING','KNOWN_ERROR','RESOLVED','CLOSED')),
    CONSTRAINT problems_title_not_blank CHECK (btrim(title) <> ''),
    CONSTRAINT problems_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE support.support_tickets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    person_id uuid NOT NULL,
    customer_id uuid,
    conversation_id uuid,
    status text NOT NULL DEFAULT 'NEW',
    priority text NOT NULL DEFAULT 'NORMAL',
    category text,
    summary text NOT NULL,
    first_response_at timestamptz,
    resolved_at timestamptz,
    closed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_tickets_person_fk FOREIGN KEY (tenant_id, person_id)
        REFERENCES identity.persons (tenant_id, id),
    CONSTRAINT support_tickets_customer_fk FOREIGN KEY (tenant_id, customer_id)
        REFERENCES crm.customers (tenant_id, id),
    CONSTRAINT support_tickets_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
        REFERENCES communication.conversations (tenant_id, id),
    CONSTRAINT support_tickets_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT support_tickets_status_check CHECK (status IN ('NEW','TRIAGING','IN_PROGRESS','WAITING_CUSTOMER','WAITING_INTERNAL','WAITING_PROVIDER','RESOLVED','CLOSED','CANCELLED')),
    CONSTRAINT support_tickets_priority_check CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
    CONSTRAINT support_tickets_summary_not_blank CHECK (btrim(summary) <> ''),
    CONSTRAINT support_tickets_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX support_tickets_queue_idx
    ON support.support_tickets (tenant_id, status, priority, created_at)
    WHERE status NOT IN ('CLOSED','CANCELLED');
CREATE INDEX support_tickets_person_idx
    ON support.support_tickets (tenant_id, person_id, created_at DESC);

CREATE TABLE support.ticket_incident_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    support_ticket_id uuid NOT NULL,
    incident_id uuid NOT NULL,
    linked_at timestamptz NOT NULL DEFAULT now(),
    linked_by_type text NOT NULL,
    linked_by_id text,
    CONSTRAINT ticket_incident_links_ticket_fk FOREIGN KEY (tenant_id, support_ticket_id)
        REFERENCES support.support_tickets (tenant_id, id),
    CONSTRAINT ticket_incident_links_incident_fk FOREIGN KEY (tenant_id, incident_id)
        REFERENCES support.incidents (tenant_id, id),
    CONSTRAINT ticket_incident_links_actor_check CHECK (linked_by_type IN ('system','agent','human','external')),
    CONSTRAINT ticket_incident_links_unique UNIQUE (tenant_id, support_ticket_id, incident_id)
);

CREATE TABLE support.ticket_problem_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    support_ticket_id uuid NOT NULL,
    problem_id uuid NOT NULL,
    linked_at timestamptz NOT NULL DEFAULT now(),
    linked_by_type text NOT NULL,
    linked_by_id text,
    CONSTRAINT ticket_problem_links_ticket_fk FOREIGN KEY (tenant_id, support_ticket_id)
        REFERENCES support.support_tickets (tenant_id, id),
    CONSTRAINT ticket_problem_links_problem_fk FOREIGN KEY (tenant_id, problem_id)
        REFERENCES support.problems (tenant_id, id),
    CONSTRAINT ticket_problem_links_actor_check CHECK (linked_by_type IN ('system','agent','human','external')),
    CONSTRAINT ticket_problem_links_unique UNIQUE (tenant_id, support_ticket_id, problem_id)
);

CREATE TABLE knowledge.knowledge_sources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    source_type text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    trust_level text NOT NULL DEFAULT 'UNTRUSTED',
    uri_or_ref text,
    object_ref text,
    title text,
    provenance_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    rights_status text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    CONSTRAINT knowledge_sources_status_check CHECK (status IN ('ACTIVE','ARCHIVED','REVOKED')),
    CONSTRAINT knowledge_sources_trust_check CHECK (trust_level IN ('UNTRUSTED','CONDITIONAL','TRUSTED','AUTHORITATIVE')),
    CONSTRAINT knowledge_sources_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE knowledge.knowledge_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    status text NOT NULL DEFAULT 'DISCOVERED',
    knowledge_type text NOT NULL,
    canonical_key text,
    current_version_id uuid,
    confidence_score numeric(5,4),
    freshness_score numeric(5,4),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT knowledge_items_status_check CHECK (status IN ('DISCOVERED','CANDIDATE','VALIDATING','VERIFIED','DEGRADED','SUPERSEDED','DEPRECATED','REJECTED')),
    CONSTRAINT knowledge_items_type_check CHECK (knowledge_type IN ('PROCEDURE','SOLUTION','FACT','POLICY_REFERENCE','COMPATIBILITY_EVIDENCE','INCIDENT_NOTE','FAQ')),
    CONSTRAINT knowledge_items_confidence_check CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)),
    CONSTRAINT knowledge_items_freshness_check CHECK (freshness_score IS NULL OR (freshness_score >= 0 AND freshness_score <= 1)),
    CONSTRAINT knowledge_items_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX knowledge_items_canonical_unique
    ON knowledge.knowledge_items (tenant_id, canonical_key)
    WHERE canonical_key IS NOT NULL AND status <> 'REJECTED';

CREATE TABLE knowledge.knowledge_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    knowledge_item_id uuid NOT NULL,
    version_no integer NOT NULL,
    content_text text,
    structured_content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_refs_json jsonb NOT NULL DEFAULT '[]'::jsonb,
    valid_from timestamptz NOT NULL DEFAULT now(),
    valid_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT knowledge_versions_item_fk FOREIGN KEY (tenant_id, knowledge_item_id)
        REFERENCES knowledge.knowledge_items (tenant_id, id),
    CONSTRAINT knowledge_versions_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT knowledge_versions_version_positive CHECK (version_no > 0),
    CONSTRAINT knowledge_versions_window_check CHECK (valid_until IS NULL OR valid_until > valid_from),
    CONSTRAINT knowledge_versions_unique UNIQUE (tenant_id, knowledge_item_id, version_no),
    CONSTRAINT knowledge_versions_tenant_id_id_unique UNIQUE (tenant_id, id)
);

ALTER TABLE knowledge.knowledge_items
    ADD CONSTRAINT knowledge_items_current_version_fk
    FOREIGN KEY (tenant_id, current_version_id)
    REFERENCES knowledge.knowledge_versions (tenant_id, id);

CREATE TABLE knowledge.knowledge_source_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    knowledge_item_id uuid NOT NULL,
    knowledge_source_id uuid NOT NULL,
    relation_type text NOT NULL DEFAULT 'SUPPORTS',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT knowledge_source_links_item_fk FOREIGN KEY (tenant_id, knowledge_item_id)
        REFERENCES knowledge.knowledge_items (tenant_id, id),
    CONSTRAINT knowledge_source_links_source_fk FOREIGN KEY (tenant_id, knowledge_source_id)
        REFERENCES knowledge.knowledge_sources (tenant_id, id),
    CONSTRAINT knowledge_source_links_relation_check CHECK (relation_type IN ('SUPPORTS','DERIVED_FROM','CONTRADICTS','SUPERSEDES')),
    CONSTRAINT knowledge_source_links_unique UNIQUE (tenant_id, knowledge_item_id, knowledge_source_id, relation_type)
);

CREATE TABLE knowledge.solutions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    knowledge_item_id uuid NOT NULL,
    problem_signature_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    procedure_json jsonb NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT solutions_item_fk FOREIGN KEY (tenant_id, knowledge_item_id)
        REFERENCES knowledge.knowledge_items (tenant_id, id),
    CONSTRAINT solutions_status_check CHECK (status IN ('ACTIVE','DEGRADED','DEPRECATED')),
    CONSTRAINT solutions_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE support.solution_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    support_ticket_id uuid NOT NULL,
    solution_id uuid,
    procedure_key text,
    attempt_no integer NOT NULL,
    actor_type text NOT NULL,
    actor_id text,
    outcome text,
    context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT solution_attempts_ticket_fk FOREIGN KEY (tenant_id, support_ticket_id)
        REFERENCES support.support_tickets (tenant_id, id),
    CONSTRAINT solution_attempts_solution_fk FOREIGN KEY (tenant_id, solution_id)
        REFERENCES knowledge.solutions (tenant_id, id),
    CONSTRAINT solution_attempts_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT solution_attempts_shape_check CHECK (solution_id IS NOT NULL OR procedure_key IS NOT NULL),
    CONSTRAINT solution_attempts_attempt_positive CHECK (attempt_no > 0),
    CONSTRAINT solution_attempts_actor_check CHECK (actor_type IN ('system','agent','human','external')),
    CONSTRAINT solution_attempts_outcome_check CHECK (outcome IS NULL OR outcome IN ('SUCCEEDED','FAILED','PARTIAL','INCONCLUSIVE','NOT_APPLICABLE')),
    CONSTRAINT solution_attempts_unique UNIQUE (tenant_id, support_ticket_id, attempt_no),
    CONSTRAINT solution_attempts_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE knowledge.solution_outcomes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    solution_id uuid NOT NULL,
    support_ticket_id uuid,
    trial_id uuid,
    context_fingerprint text NOT NULL,
    outcome text NOT NULL,
    evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    observed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT solution_outcomes_solution_fk FOREIGN KEY (tenant_id, solution_id)
        REFERENCES knowledge.solutions (tenant_id, id),
    CONSTRAINT solution_outcomes_ticket_fk FOREIGN KEY (tenant_id, support_ticket_id)
        REFERENCES support.support_tickets (tenant_id, id),
    CONSTRAINT solution_outcomes_trial_fk FOREIGN KEY (tenant_id, trial_id)
        REFERENCES trial.trials (tenant_id, id),
    CONSTRAINT solution_outcomes_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT solution_outcomes_outcome_check CHECK (outcome IN ('SUCCEEDED','FAILED','PARTIAL','INCONCLUSIVE','NOT_APPLICABLE')),
    CONSTRAINT solution_outcomes_context_not_blank CHECK (btrim(context_fingerprint) <> ''),
    CONSTRAINT solution_outcomes_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX solution_outcomes_solution_idx
    ON knowledge.solution_outcomes (tenant_id, solution_id, observed_at DESC);

CREATE TABLE agent.human_review_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    status text NOT NULL DEFAULT 'REQUESTED',
    review_mode text NOT NULL,
    reason text NOT NULL,
    risk_class text NOT NULL,
    priority text NOT NULL DEFAULT 'NORMAL',
    resource_type text NOT NULL,
    resource_id uuid NOT NULL,
    requested_by_type text NOT NULL,
    requested_by_id text,
    assigned_to_user_id uuid,
    summary text NOT NULL,
    context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    sla_due_at timestamptz,
    escalation_policy text,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    CONSTRAINT human_review_assignee_membership_fk FOREIGN KEY (tenant_id, assigned_to_user_id)
        REFERENCES control.tenant_memberships (tenant_id, user_id),
    CONSTRAINT human_review_status_check CHECK (status IN ('REQUESTED','QUEUED','ACKNOWLEDGED','IN_REVIEW','GUIDANCE_PROVIDED','ACTION_TAKEN','RESOLVED','EXPIRED','CANCELLED')),
    CONSTRAINT human_review_mode_check CHECK (review_mode IN ('APPROVAL','REVIEW','GUIDANCE','MANUAL_EXECUTION')),
    CONSTRAINT human_review_reason_check CHECK (reason IN ('SECURITY_CHALLENGE','PROVIDER_EXCEPTION','RISK_REVIEW','FINANCIAL_REVIEW','CONTENT_COMPLIANCE','OTHER')),
    CONSTRAINT human_review_risk_check CHECK (risk_class IN ('R0','R1','R2','R3','R4')),
    CONSTRAINT human_review_priority_check CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
    CONSTRAINT human_review_requester_check CHECK (requested_by_type IN ('system','agent','human','external')),
    CONSTRAINT human_review_summary_not_blank CHECK (btrim(summary) <> ''),
    CONSTRAINT human_review_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX human_review_queue_idx
    ON agent.human_review_requests (tenant_id, status, priority, sla_due_at)
    WHERE status IN ('REQUESTED','QUEUED','ACKNOWLEDGED','IN_REVIEW');

ALTER TABLE billing.refund_requests
    ADD CONSTRAINT refund_requests_human_review_fk
    FOREIGN KEY (tenant_id, human_review_request_id)
    REFERENCES agent.human_review_requests (tenant_id, id);

CREATE UNIQUE INDEX refund_requests_human_review_unique
    ON billing.refund_requests (tenant_id, human_review_request_id)
    WHERE human_review_request_id IS NOT NULL;

CREATE TABLE agent.human_review_actions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    human_review_request_id uuid NOT NULL,
    action_type text NOT NULL,
    actor_user_id uuid NOT NULL,
    content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT human_review_actions_request_fk FOREIGN KEY (tenant_id, human_review_request_id)
        REFERENCES agent.human_review_requests (tenant_id, id),
    CONSTRAINT human_review_actions_actor_membership_fk FOREIGN KEY (tenant_id, actor_user_id)
        REFERENCES control.tenant_memberships (tenant_id, user_id),
    CONSTRAINT human_review_actions_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES control.tenants (id),
    CONSTRAINT human_review_actions_type_check CHECK (action_type IN ('ACKNOWLEDGE','START_REVIEW','GUIDANCE','APPROVE','REJECT','ACTION_TAKEN','RESOLVE','CANCEL','NOTE')),
    CONSTRAINT human_review_actions_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE TRIGGER knowledge_versions_append_only
BEFORE UPDATE OR DELETE ON knowledge.knowledge_versions
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

CREATE TRIGGER knowledge_solution_outcomes_append_only
BEFORE UPDATE OR DELETE ON knowledge.solution_outcomes
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

CREATE TRIGGER human_review_actions_append_only
BEFORE UPDATE OR DELETE ON agent.human_review_actions
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

COMMIT;
