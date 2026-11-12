BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE public.messaging_install_sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "installationId" TEXT,
  "expectedRevision" INTEGER,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  outcome TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX messaging_install_sessions_expires_idx ON public.messaging_install_sessions ("expiresAt");
CREATE INDEX messaging_install_sessions_owner_idx ON public.messaging_install_sessions ("userId", "spaceId", "botId");

CREATE TABLE public.messaging_installations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "workspaceName" TEXT NOT NULL,
  "installerId" TEXT NOT NULL,
  "installerName" TEXT,
  "providerBotId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  ciphertext TEXT,
  "credentialId" TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  "acceptAfter" TIMESTAMP(3) NOT NULL,
  "authorizedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT messaging_installations_status_check CHECK (
    (status IN ('active', 'paused') AND ciphertext IS NOT NULL AND "credentialId" IS NOT NULL)
    OR (status IN ('revoked', 'removed') AND ciphertext IS NULL AND "credentialId" IS NULL)
  )
);
CREATE UNIQUE INDEX messaging_installations_workspace_key ON public.messaging_installations (provider, "workspaceId");
CREATE INDEX messaging_installations_owner_idx ON public.messaging_installations ("spaceId", "userId");

CREATE TABLE public.messaging_credential_cleanups (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  "pendingWrite" BOOLEAN NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX messaging_credential_cleanups_due_idx ON public.messaging_credential_cleanups ("nextAttemptAt");

-- Match the existing deployment's row-security activation state. On a fresh
-- database the administrator activates the whole policy catalog together.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  IF (SELECT relrowsecurity FROM pg_catalog.pg_class
      WHERE oid = 'public.messaging_outbound'::regclass) THEN
    FOREACH table_name IN ARRAY ARRAY[
      'messaging_install_sessions', 'messaging_installations', 'messaging_credential_cleanups'
    ] LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO PUBLIC USING ((SELECT public.app_rls_bypass() AS app_rls_bypass))',
        table_name || '_system', table_name
      );
    END LOOP;
  END IF;
END $$;

COMMIT;
