BEGIN;

ALTER TABLE "capability_installs"
  ADD COLUMN "clientNonce" TEXT,
  ADD COLUMN "requestBinding" TEXT,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'installed',
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "cleanupRefs" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "installedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "capability_installs_revision_check" CHECK ("revision" >= 1),
  ADD CONSTRAINT "capability_installs_managed_plugin_check" CHECK (
    "clientNonce" IS NULL OR (
      "kind" = 'plugin' AND
      "requestBinding" IS NOT NULL AND "version" IS NOT NULL AND "digest" IS NOT NULL AND
      length("clientNonce") BETWEEN 1 AND 128 AND
      "requestBinding" ~ '^[a-f0-9]{64}$' AND
      "version" ~ '^[a-f0-9]{40}$' AND
      "digest" ~ '^sha256:[a-f0-9]{64}$' AND
      "status" IN ('installing', 'installed', 'failed', 'uninstalling', 'cleanup_failed', 'removed')
    )
  );

CREATE UNIQUE INDEX "capability_installs_spaceId_userId_clientNonce_key"
  ON "capability_installs"("spaceId", "userId", "clientNonce");

ALTER TABLE "agent_skills" ADD COLUMN "installId" TEXT;
ALTER TABLE "mcp_servers" ADD COLUMN "installId" TEXT;
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_installId_fkey"
  FOREIGN KEY ("installId") REFERENCES "capability_installs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_installId_fkey"
  FOREIGN KEY ("installId") REFERENCES "capability_installs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "agent_skills_installId_idx" ON "agent_skills"("installId");
CREATE INDEX "mcp_servers_installId_idx" ON "mcp_servers"("installId");

COMMIT;
