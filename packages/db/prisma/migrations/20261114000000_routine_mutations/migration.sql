BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE TABLE public.routine_mutations (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "routineId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX routine_mutations_spaceId_userId_idx ON public.routine_mutations ("spaceId", "userId");
-- Activate protection in the same transaction as creation, including when the
-- deployment grants future tables to its runtime role through default privileges.
DO $$ BEGIN
  IF (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.routines'::regclass) THEN
    ALTER TABLE public.routine_mutations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.routine_mutations FORCE ROW LEVEL SECURITY;
    CREATE POLICY routine_mutations_system ON public.routine_mutations FOR ALL TO PUBLIC
      USING ((SELECT public.app_rls_bypass() AS app_rls_bypass));
    CREATE POLICY routine_mutations_tenant ON public.routine_mutations FOR ALL TO PUBLIC
      USING (("spaceId" = NULLIF(current_setting('app.space_id'::text, true), ''::text)) AND
             ("userId" = NULLIF(current_setting('app.user_id'::text, true), ''::text)));
  END IF;
END $$;
COMMIT;
