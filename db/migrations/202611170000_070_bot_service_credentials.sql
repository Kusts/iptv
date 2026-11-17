BEGIN;

CREATE TABLE platform.bot_service_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES control.tenants(id),
    label text NOT NULL CHECK (btrim(label) <> ''),
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    token_prefix text NOT NULL CHECK (char_length(token_prefix) = 8),
    scopes text[] NOT NULL CHECK (
        cardinality(scopes) > 0 AND scopes <@ ARRAY['bot.streammax.execute']::text[]
    ),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_by text,
    CHECK (expires_at > created_at)
);

ALTER TABLE platform.bot_service_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.bot_service_credentials
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT USAGE ON SCHEMA platform TO iptv_app;
GRANT SELECT ON platform.bot_service_credentials TO iptv_app;

CREATE FUNCTION platform.guard_bot_service_credential_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = platform, pg_temp AS $$
BEGIN
    IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
       OR (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at') THEN
        RAISE EXCEPTION 'bot service credentials are append-only; only revocation is allowed';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER bot_service_credentials_no_update
    BEFORE UPDATE ON platform.bot_service_credentials
    FOR EACH ROW EXECUTE FUNCTION platform.guard_bot_service_credential_update();

CREATE FUNCTION platform.guard_bot_service_credential_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path = platform, pg_temp AS $$
BEGIN
    RAISE EXCEPTION 'bot service credentials cannot be deleted';
END;
$$;
CREATE TRIGGER bot_service_credentials_no_delete
    BEFORE DELETE ON platform.bot_service_credentials
    FOR EACH ROW EXECUTE FUNCTION platform.guard_bot_service_credential_delete();

CREATE FUNCTION platform.resolve_bot_credential(p_token_hash text)
RETURNS TABLE (credential_id uuid, tenant_id uuid, scopes text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = platform, control, pg_temp AS $$
    SELECT c.id, c.tenant_id, c.scopes
    FROM platform.bot_service_credentials c
    JOIN control.tenants t ON t.id = c.tenant_id
    WHERE c.token_hash = p_token_hash
      AND c.revoked_at IS NULL
      AND c.expires_at > now()
      AND t.status = 'ACTIVE'
$$;
DO $$
DECLARE owner_name name;
BEGIN
    SELECT pg_get_userbyid(relowner) INTO owner_name
    FROM pg_class JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
    WHERE nspname = 'platform' AND relname = 'bot_service_credentials';
    EXECUTE format('ALTER FUNCTION platform.resolve_bot_credential(text) OWNER TO %I', owner_name);
END $$;
REVOKE ALL ON FUNCTION platform.resolve_bot_credential(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.resolve_bot_credential(text) TO iptv_app;
REVOKE ALL ON FUNCTION platform.guard_bot_service_credential_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_bot_service_credential_delete() FROM PUBLIC;
COMMIT;
