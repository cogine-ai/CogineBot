BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':coginebot-runtime-role-provision', 0));

-- Existing pages retain their visibility, tenant policies and runtime grants.
ALTER TABLE "cogine_pages"."pages"
    ADD COLUMN "shareTokenHash" TEXT,
    ADD COLUMN "shareSecretId" TEXT,
    ADD CONSTRAINT "pages_shareSecretId_fkey" FOREIGN KEY ("shareSecretId")
        REFERENCES "public"."secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "pages_shareTokenHash_key" ON "cogine_pages"."pages"("shareTokenHash");
CREATE UNIQUE INDEX "pages_shareSecretId_key" ON "cogine_pages"."pages"("shareSecretId");

COMMIT;
