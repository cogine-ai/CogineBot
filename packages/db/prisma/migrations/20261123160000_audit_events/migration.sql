BEGIN;

CREATE SCHEMA cogine_audit;
REVOKE ALL ON SCHEMA cogine_audit FROM PUBLIC;

CREATE TABLE cogine_audit.audit_events (
  id TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "organizationId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  action TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  outcome TEXT NOT NULL,
  metadata JSONB NOT NULL
);

CREATE INDEX "audit_events_organizationId_createdAt_id_idx"
  ON cogine_audit.audit_events ("organizationId", "createdAt", id);
CREATE INDEX "audit_events_createdAt_id_idx" ON cogine_audit.audit_events ("createdAt", id);
REVOKE ALL ON TABLE cogine_audit.audit_events FROM PUBLIC;

DO $$
DECLARE
  grant_role text := 'coginebot_app_' || (SELECT oid FROM pg_catalog.pg_database
    WHERE datname = pg_catalog.current_database())::text;
BEGIN
  IF (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.space_members'::regclass) THEN
    ALTER TABLE cogine_audit.audit_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE cogine_audit.audit_events FORCE ROW LEVEL SECURITY;
    CREATE POLICY audit_events_system ON cogine_audit.audit_events FOR ALL TO PUBLIC USING (
      (SELECT public.app_rls_bypass() AS app_rls_bypass)
    );
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = grant_role) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA cogine_audit TO %I', grant_role);
    EXECUTE format('GRANT SELECT, INSERT, DELETE ON cogine_audit.audit_events TO %I', grant_role);
  END IF;
END $$;

COMMIT;
