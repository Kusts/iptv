-- AI Revenue & Operations Platform
-- Migration 034: Partner Academy (Wave 13 slice S3)
--
-- MVP Academy covers the 10 canonical onboarding topics (baseline
-- 11-partners-resellers.md: product/service, devices/apps/connections,
-- Trials + legitimate Retrial, provisioning, support/escalation,
-- consultative sales, renewal/retention, finance/pricing,
-- campaigns/acquisition, SaaS pathway).
-- - `learning_content`: global curated catalog (no tenant column — the
--   same curriculum serves every tenant; progress stays tenant-scoped).
-- - `learning_content_versions`: versioned bodies; v1 seeded below.
-- - `learning_progress`: per (tenant, partner, content) completion used
--   by the lifecycle gates (TRAINING -> READY when all 10 complete).
-- POST-MVP: advanced portal/certification (no column here).

BEGIN;

CREATE TABLE partners.learning_content (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    topic_key text NOT NULL,
    title text NOT NULL,
    position integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT learning_content_key_unique UNIQUE (topic_key),
    CONSTRAINT learning_content_position_positive CHECK (position >= 1),
    CONSTRAINT learning_content_title_not_blank CHECK (btrim(title) <> '')
);

CREATE TABLE partners.learning_content_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id uuid NOT NULL REFERENCES partners.learning_content(id),
    version_no integer NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT',
    body_markdown text NOT NULL,
    published_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT learning_content_versions_status_check CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
    CONSTRAINT learning_content_versions_version_positive CHECK (version_no >= 1),
    CONSTRAINT learning_content_versions_content_version_unique UNIQUE (content_id, version_no)
);

CREATE TABLE partners.learning_progress (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    partner_account_id uuid NOT NULL,
    content_id uuid NOT NULL REFERENCES partners.learning_content(id),
    status text NOT NULL DEFAULT 'STARTED',
    completed_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT learning_progress_partner_fk FOREIGN KEY (tenant_id, partner_account_id)
        REFERENCES partners.partner_accounts (tenant_id, id),
    CONSTRAINT learning_progress_status_check CHECK (status IN ('STARTED','COMPLETED')),
    CONSTRAINT learning_progress_partner_content_unique UNIQUE (tenant_id, partner_account_id, content_id),
    CONSTRAINT learning_progress_tenant_id_id_unique UNIQUE (tenant_id, id)
);

-- Seed the 10 MVP topics (curated catalog, stable keys for the gates).
INSERT INTO partners.learning_content (topic_key, title, position) VALUES
    ('academy-01-product-service', 'Produto e servico', 1),
    ('academy-02-devices-apps', 'Dispositivos, apps e conexoes', 2),
    ('academy-03-trials-retrial', 'Trials e Retrial legitimo', 3),
    ('academy-04-provisioning', 'Provisionamento', 4),
    ('academy-05-support-escalation', 'Suporte tecnico e escalacao', 5),
    ('academy-06-consultative-sales', 'Vendas consultivas, objecoes e follow-up', 6),
    ('academy-07-renewal-retention', 'Renovacao e retencao', 7),
    ('academy-08-finance-pricing', 'Financas e precificacao basica', 8),
    ('academy-09-campaigns-acquisition', 'Campanhas e aquisicao', 9),
    ('academy-10-saas-pathway', 'Caminho para o SaaS', 10)
ON CONFLICT (topic_key) DO NOTHING;

INSERT INTO partners.learning_content_versions (content_id, version_no, status, body_markdown, published_at)
SELECT c.id, 1, 'PUBLISHED', '# ' || c.title || E'\n\nMVP Academy v1: conteudo operacional minimo para vender e suportar com autonomia.', now()
FROM partners.learning_content AS c
ON CONFLICT (content_id, version_no) DO NOTHING;

COMMIT;
