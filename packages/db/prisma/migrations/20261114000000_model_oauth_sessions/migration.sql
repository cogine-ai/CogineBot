BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE SCHEMA cogine_model_auth;
REVOKE ALL ON SCHEMA cogine_model_auth FROM PUBLIC;

CREATE TABLE cogine_model_auth.model_oauth_sessions (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  provider TEXT NOT NULL,
  "modelId" TEXT,
  "thinkingLevel" TEXT,
  "hasThinkingLevel" BOOLEAN NOT NULL DEFAULT false,
  label TEXT,
  "credentialId" TEXT,
  "credentialRevision" INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  "handoffCiphertext" TEXT,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  error TEXT,
  result JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "model_oauth_sessions_spaceId_userId_fkey" FOREIGN KEY ("spaceId", "userId")
    REFERENCES public.space_members ("spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "model_oauth_sessions_userId_provider_spaceId_idx"
  ON cogine_model_auth.model_oauth_sessions ("userId", provider, "spaceId");
CREATE INDEX "model_oauth_sessions_expiresAt_idx" ON cogine_model_auth.model_oauth_sessions ("expiresAt");
REVOKE ALL ON TABLE cogine_model_auth.model_oauth_sessions FROM PUBLIC;

DO $$
DECLARE
  grant_role text := 'coginebot_app_' || (SELECT oid FROM pg_catalog.pg_database
    WHERE datname = pg_catalog.current_database())::text;
BEGIN
  IF (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.space_members'::regclass) THEN
    ALTER TABLE cogine_model_auth.model_oauth_sessions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE cogine_model_auth.model_oauth_sessions FORCE ROW LEVEL SECURITY;
    CREATE POLICY model_oauth_sessions_tenant ON cogine_model_auth.model_oauth_sessions FOR ALL TO PUBLIC USING (
      "spaceId" = NULLIF(current_setting('app.space_id', true), '')
      AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    );
    CREATE POLICY model_oauth_sessions_system ON cogine_model_auth.model_oauth_sessions FOR ALL TO PUBLIC USING (
      (SELECT public.app_rls_bypass() AS app_rls_bypass)
    );
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = grant_role) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA cogine_model_auth TO %I', grant_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON cogine_model_auth.model_oauth_sessions TO %I', grant_role);
  END IF;
END $$;

COMMIT;
