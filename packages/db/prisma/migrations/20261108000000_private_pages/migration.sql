BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL quote_all_identifiers = off;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':coginebot-runtime-role-provision', 0));

-- This migration extends one known predecessor. Fingerprint the frozen public
-- catalog and installed policies before exposing any Page relation. The
-- public namespace stays unchanged so the preceding app can still start.
DO $predecessor$
DECLARE
    tables_digest text;
    all_enabled boolean;
    any_enabled boolean;
    policy_count integer;
    policies_digest text;
BEGIN
    IF to_regnamespace('cogine_pages') IS NOT NULL THEN
        RAISE EXCEPTION 'The private Pages schema already exists';
    END IF;

    SELECT encode(sha256(convert_to(string_agg(c.relname || ':' || c.relkind::text,
             E'\n' ORDER BY c.relname COLLATE "C"), 'UTF8')), 'hex'),
           bool_and(c.relrowsecurity), bool_or(c.relrowsecurity)
      INTO tables_digest, all_enabled, any_enabled
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND c.relname <> '_prisma_migrations';

    IF tables_digest IS DISTINCT FROM '0570d9474fdeec01aafec42e638b0aa1f02c76ef1725e184479ca76298e7c254'
       OR to_regprocedure('public.app_rls_version()') IS NOT NULL
       OR NOT EXISTS (
           SELECT 1
             FROM pg_proc f
             JOIN pg_language l ON l.oid = f.prolang
             JOIN pg_class k ON k.oid = to_regclass('cogine_private.rls_bypass_keys')
             JOIN pg_namespace n ON n.oid = k.relnamespace
            WHERE f.oid = to_regprocedure('public.app_rls_bypass()')
              AND f.prosecdef AND NOT f.proretset AND f.prokind = 'f' AND f.provolatile = 's'
              AND f.prorettype = 'bool'::regtype AND l.lanname = 'sql'
              AND f.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
              AND k.relkind = 'r' AND f.proowner = k.relowner
              AND encode(sha256(convert_to(btrim(regexp_replace(f.prosrc, '[[:space:]]+', ' ', 'g')),
                    'UTF8')), 'hex') = '08717c8cf0bfd32ce55549254bacbf7874ba08f58086394548cb7ce69a7ffb4d'
              AND NOT EXISTS (SELECT 1 FROM aclexplode(CASE WHEN cardinality(n.nspacl) > 0 THEN n.nspacl END) a WHERE a.grantee = 0)
              AND NOT EXISTS (SELECT 1 FROM aclexplode(CASE WHEN cardinality(k.relacl) > 0 THEN k.relacl END) a WHERE a.grantee = 0)
              AND NOT EXISTS (
                  SELECT 1 FROM pg_attribute c,
                  LATERAL aclexplode(CASE WHEN cardinality(c.attacl) > 0 THEN c.attacl END) a
                   WHERE c.attrelid = k.oid AND c.attnum > 0 AND NOT c.attisdropped AND a.grantee = 0
              )
       ) THEN
        RAISE EXCEPTION 'Private Pages requires the complete predecessor database catalog';
    END IF;

    SELECT count(*), encode(sha256(convert_to(string_agg(
               jsonb_build_array(c.relname, p.polname, p.polcmd::text, p.polpermissive,
                 p.polroles = ARRAY[0::oid],
                 btrim(regexp_replace(pg_get_expr(p.polqual, p.polrelid, false), '[[:space:]]+', ' ', 'g')),
                 btrim(regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid, false), '[[:space:]]+', ' ', 'g')))::text,
               E'\n' ORDER BY c.relname COLLATE "C", p.polname COLLATE "C"), 'UTF8')), 'hex')
      INTO policy_count, policies_digest
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public';

    IF NOT (
        (NOT any_enabled AND policy_count = 0)
        OR (all_enabled AND policies_digest IS NOT DISTINCT FROM
            '2a8065aa7bdafb393dbbdc6544f4aa55c84b003191c55e0354a92b989624ce07')
    ) THEN
        RAISE EXCEPTION 'Private Pages requires an unprotected or fully protected predecessor';
    END IF;
END;
$predecessor$;

CREATE SCHEMA "cogine_pages";
REVOKE ALL ON SCHEMA "cogine_pages" FROM PUBLIC;

CREATE TABLE "cogine_pages"."pages" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT,
    "groupId" TEXT,
    "title" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "pinnedAt" TIMESTAMP(3),
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pages_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "pages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "pages_botId_fkey" FOREIGN KEY ("botId") REFERENCES "public"."bots"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "pages_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "public"."chat_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "cogine_pages"."page_versions" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "page_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "page_versions_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "cogine_pages"."pages"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "pages_spaceId_userId_updatedAt_idx" ON "cogine_pages"."pages"("spaceId", "userId", "updatedAt");
CREATE INDEX "pages_botId_idx" ON "cogine_pages"."pages"("botId");
CREATE INDEX "pages_groupId_idx" ON "cogine_pages"."pages"("groupId");
CREATE UNIQUE INDEX "page_versions_pageId_version_key" ON "cogine_pages"."page_versions"("pageId", "version");

DO $isolation$
DECLARE
    database_oid oid := (SELECT oid FROM pg_database WHERE datname = current_database());
    grant_role text := 'coginebot_app_' || database_oid::text;
    grant_oid oid := (SELECT oid FROM pg_roles WHERE rolname = grant_role);
    protected boolean := (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user'::regclass);
BEGIN
    -- The restricted database-scoped role can itself be the runtime login.
    IF (protected AND grant_oid IS NULL) OR EXISTS (
        SELECT 1 FROM pg_roles WHERE oid = grant_oid
          AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)
    ) OR EXISTS (
        SELECT 1 FROM pg_shdepend d
        JOIN pg_roles ancestor ON ancestor.oid = d.refobjid
         WHERE d.refclassid = 'pg_authid'::regclass
           AND pg_has_role(grant_oid, ancestor.oid, 'MEMBER')
           AND ((d.dbid <> 0 AND d.dbid <> database_oid)
             OR (d.dbid = 0 AND d.classid = 'pg_database'::regclass AND d.objid <> database_oid))
    ) THEN
        RAISE EXCEPTION 'Private Pages requires the restricted database grant role';
    END IF;

    IF protected THEN
        CREATE POLICY pages_tenant ON "cogine_pages"."pages" FOR ALL TO PUBLIC USING (
            "spaceId" = NULLIF(current_setting('app.space_id', true), '')
            AND "userId" = NULLIF(current_setting('app.user_id', true), '')
        );
        CREATE POLICY pages_system ON "cogine_pages"."pages" FOR ALL TO PUBLIC USING (
            (SELECT public.app_rls_bypass())
        );
        CREATE POLICY page_versions_tenant ON "cogine_pages"."page_versions" FOR ALL TO PUBLIC USING (
            EXISTS (SELECT 1 FROM "cogine_pages"."pages" p WHERE p.id = page_versions."pageId"
                AND p."spaceId" = NULLIF(current_setting('app.space_id', true), '')
                AND p."userId" = NULLIF(current_setting('app.user_id', true), ''))
        );
        CREATE POLICY page_versions_system ON "cogine_pages"."page_versions" FOR ALL TO PUBLIC USING (
            (SELECT public.app_rls_bypass())
        );
        ALTER TABLE "cogine_pages"."pages" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "cogine_pages"."page_versions" ENABLE ROW LEVEL SECURITY;
    END IF;

    REVOKE ALL ON TABLE "cogine_pages"."pages", "cogine_pages"."page_versions" FROM PUBLIC;
    IF grant_oid IS NOT NULL THEN
        EXECUTE format('GRANT USAGE ON SCHEMA cogine_pages TO %I', grant_role);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cogine_pages.pages, cogine_pages.page_versions TO %I', grant_role);
    END IF;

    -- Reject access inherited from database-wide defaults before the tables can
    -- become visible. Restore and role provisioning use the same grant scope.
    IF EXISTS (
        SELECT 1 FROM pg_namespace n,
        LATERAL aclexplode(CASE WHEN cardinality(n.nspacl) > 0 THEN n.nspacl END) a
         WHERE n.nspname = 'cogine_pages' AND a.grantee <> n.nspowner
           AND (a.grantee IS DISTINCT FROM grant_oid OR a.privilege_type <> 'USAGE' OR a.is_grantable)
    ) OR EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(CASE WHEN cardinality(c.relacl) > 0 THEN c.relacl END) a
         WHERE n.nspname = 'cogine_pages' AND c.relkind = 'r' AND a.grantee <> c.relowner
           AND (a.grantee IS DISTINCT FROM grant_oid OR a.is_grantable
                OR a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
    ) THEN
        RAISE EXCEPTION 'Private Pages cannot inherit unexpected database grants';
    END IF;
END;
$isolation$;

COMMIT;
