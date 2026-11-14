BEGIN;
SET LOCAL lock_timeout = '10s';
-- No server FK: deletion must not erase the receipt or allow a late retry to recreate it.
CREATE TABLE public.mcp_create_requests (
  "spaceId" TEXT NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "requestId" TEXT NOT NULL,
  "serverId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("spaceId", "userId", "requestId")
);
CREATE INDEX "mcp_create_requests_userId_idx" ON public.mcp_create_requests ("userId");

-- Preserve centralized activation on fresh deployments. An already protected
-- deployment must never expose this new table between migration and policy apply.
DO $$
BEGIN
  IF (SELECT relrowsecurity FROM pg_catalog.pg_class
      WHERE oid = 'public.mcp_servers'::regclass) THEN
    ALTER TABLE public.mcp_create_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.mcp_create_requests FORCE ROW LEVEL SECURITY;
    CREATE POLICY mcp_create_requests_tenant ON public.mcp_create_requests
      FOR ALL TO PUBLIC USING (
        "spaceId" = NULLIF(current_setting('app.space_id'::text, true), ''::text)
        AND "userId" = NULLIF(current_setting('app.user_id'::text, true), ''::text)
      );
    CREATE POLICY mcp_create_requests_system ON public.mcp_create_requests
      FOR ALL TO PUBLIC USING ((SELECT public.app_rls_bypass() AS app_rls_bypass));
  END IF;
END $$;
COMMIT;
