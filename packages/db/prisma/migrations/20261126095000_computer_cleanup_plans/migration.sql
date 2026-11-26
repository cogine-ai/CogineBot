BEGIN;

CREATE SCHEMA cogine_storage;
REVOKE ALL ON SCHEMA cogine_storage FROM PUBLIC;

CREATE TABLE cogine_storage.computer_cleanup_plans (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "computerId" TEXT NOT NULL,
    "homeKey" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "requestNonce" TEXT NOT NULL,
    "confirmationNonce" TEXT,
    "selected" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting_confirmation',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    CONSTRAINT computer_cleanup_plans_pkey PRIMARY KEY ("id"),
    CONSTRAINT computer_cleanup_plans_status_check CHECK ("status" IN ('awaiting_confirmation', 'reviewed', 'cancelled')),
    CONSTRAINT computer_cleanup_plans_revision_check CHECK (
      ("status" = 'awaiting_confirmation' AND "revision" = 1)
      OR ("status" IN ('reviewed', 'cancelled') AND "revision" = 2)
    ),
    CONSTRAINT computer_cleanup_plans_confirmation_check CHECK (
      ("status" = 'reviewed' AND "confirmationNonce" IS NOT NULL AND "confirmedAt" IS NOT NULL)
      OR ("status" <> 'reviewed' AND "confirmationNonce" IS NULL AND "confirmedAt" IS NULL)
    ),
    CONSTRAINT "computer_cleanup_plans_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "computer_cleanup_plans_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public.spaces("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "computer_cleanup_plans_botId_fkey" FOREIGN KEY ("botId") REFERENCES public.bots("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "computer_cleanup_plans_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES public.computers("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "computer_cleanup_plans_spaceId_userId_requestNonce_key" ON cogine_storage.computer_cleanup_plans("spaceId", "userId", "requestNonce");
CREATE INDEX "computer_cleanup_plans_computerId_idx" ON cogine_storage.computer_cleanup_plans("computerId");
CREATE INDEX "computer_cleanup_plans_botId_idx" ON cogine_storage.computer_cleanup_plans("botId");
CREATE INDEX "computer_cleanup_plans_userId_idx" ON cogine_storage.computer_cleanup_plans("userId");

REVOKE ALL ON TABLE cogine_storage.computer_cleanup_plans FROM PUBLIC;

DO $$
DECLARE
  grant_role text := 'coginebot_app_' || (SELECT oid FROM pg_catalog.pg_database
    WHERE datname = pg_catalog.current_database())::text;
BEGIN
  IF (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.space_members'::regclass) THEN
    ALTER TABLE cogine_storage.computer_cleanup_plans ENABLE ROW LEVEL SECURITY;
    ALTER TABLE cogine_storage.computer_cleanup_plans FORCE ROW LEVEL SECURITY;
    CREATE POLICY computer_cleanup_plans_tenant ON cogine_storage.computer_cleanup_plans FOR ALL TO PUBLIC USING (
      ("spaceId" = NULLIF(current_setting('app.space_id'::text, true), ''::text))
      AND ("userId" = NULLIF(current_setting('app.user_id'::text, true), ''::text))
    );
    CREATE POLICY computer_cleanup_plans_system ON cogine_storage.computer_cleanup_plans FOR ALL TO PUBLIC USING (
      (SELECT public.app_rls_bypass() AS app_rls_bypass)
    );
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = grant_role) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA cogine_storage TO %I', grant_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON cogine_storage.computer_cleanup_plans TO %I', grant_role);
  END IF;
END $$;

COMMIT;
