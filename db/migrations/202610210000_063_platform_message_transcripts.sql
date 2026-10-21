-- 063 Platform message transcripts (TRANSCRICAO-FIX-063-20261021).
--
-- Transcription state for inbound AUDIO lives here — NOT in
-- `communication.messages.metadata_json`. That table is append-only
-- (`messages_append_only`, migration 009): ANY UPDATE is rejected by
-- `platform.reject_append_only_mutation()`, so the previous drain design
-- (CAS flip PENDING → TRANSCRIBING on the message row) can never run. The
-- ingest-time `metadata_json.transcription = { status: "PENDING_FOLLOW_UP" }`
-- marker stays exactly as `mediaMetadataFor` writes it (INSERT-time only) and
-- is now read-only evidence; the per-attempt history (CLAIMED → TRANSCRIBED /
-- FAILED) accumulates here as new rows.
--
-- Shape: one row per transcription event. `status` is CLAIMED (a tick owns
-- the attempt), TRANSCRIBED (terminal success, carries `engine`/`model`/
-- `transcript`) or FAILED (terminal-or-retryable failure, carries `error`).
-- `attempt` is the 1-based cycle number: the claim and its outcome share it
-- (next claim = prior CLAIMED count + 1); a message is retried while the
-- latest row is FAILED with `attempt < 5`, and is terminal once the latest
-- row is TRANSCRIBED or FAILED with `attempt >= 5`. Readers take the latest
-- row per (message_id, created_at DESC, id DESC).
--
-- Concurrency: a partial unique index admits at most one CLAIMED row per
-- (tenant, message, attempt). The claim INSERT carries `ON CONFLICT DO
-- NOTHING`, so a concurrent tick losing the same cycle inserts 0 rows and
-- skips it — never double-transcribed, never an error. A retry runs at the
-- next attempt number, so its own history never fences it.
--
-- RLS enrollment (052 template): `tenant_isolation` USING/WITH CHECK on
-- `app.tenant_id`, fail-closed when unset. DML grants to `iptv_app` only
-- (SELECT + INSERT; the app NEVER updates or deletes here — the trigger
-- below rejects it for every role, owner included).
--
-- Deliberately NOT in this migration:
--   * No BYPASSRLS anywhere.
--   * No grants to outbox roles (`outbox_worker`/`outbox_executor` keep
--     their 050 EXECUTE-only boundary on platform.* and hold NOTHING here).
--   * No GRANT to PUBLIC (explicitly revoked).
--   * No change to 001-062 (append-only).
-- Migrations keep running as the owner role on a direct connection.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iptv_app') THEN
        CREATE ROLE iptv_app LOGIN NOBYPASSRLS;
    END IF;
END $$;

CREATE TABLE platform.message_transcripts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants (id),
    message_id uuid NOT NULL,
    status text NOT NULL,
    attempt integer NOT NULL,
    engine text NULL,
    model text NULL,
    transcript text NULL,
    error text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT message_transcripts_message_fk FOREIGN KEY (tenant_id, message_id)
        REFERENCES communication.messages (tenant_id, id),
    CONSTRAINT message_transcripts_status_check CHECK (status IN ('CLAIMED', 'TRANSCRIBED', 'FAILED')),
    CONSTRAINT message_transcripts_attempt_check CHECK (attempt >= 1)
);

CREATE INDEX message_transcripts_message_history_idx
    ON platform.message_transcripts (tenant_id, message_id, created_at DESC);

-- Anti-double-claim: at most one CLAIMED row per (tenant, message,
-- attempt). Concurrent ticks racing the same cycle collide on the fence and
-- the loser inserts 0 rows (`ON CONFLICT DO NOTHING`) — never
-- double-transcribed, never an error. History (old CLAIMED cycles and every
-- outcome) is unbounded; only a live race on the SAME cycle is fenced, so a
-- retry at the next attempt is never blocked by its own history.
CREATE UNIQUE INDEX message_transcripts_single_claim_idx
    ON platform.message_transcripts (tenant_id, message_id, attempt)
    WHERE status = 'CLAIMED';

-- Least privilege for an append-only event log: the app reads history and
-- appends rows. No UPDATE/DELETE grants, and the trigger below rejects
-- UPDATE/DELETE for every role including the owner.
GRANT USAGE ON SCHEMA platform TO iptv_app;
GRANT SELECT, INSERT ON platform.message_transcripts TO iptv_app;
REVOKE ALL ON TABLE platform.message_transcripts FROM PUBLIC;

ALTER TABLE platform.message_transcripts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON platform.message_transcripts;
CREATE POLICY tenant_isolation ON platform.message_transcripts
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER message_transcripts_append_only
BEFORE UPDATE OR DELETE ON platform.message_transcripts
FOR EACH ROW EXECUTE FUNCTION platform.reject_append_only_mutation();

COMMIT;
