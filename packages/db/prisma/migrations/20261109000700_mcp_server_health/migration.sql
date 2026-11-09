ALTER TABLE "public"."mcp_servers"
  ADD COLUMN "healthRevision" INTEGER,
  ADD COLUMN "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "healthMessage" TEXT,
  ADD COLUMN "healthCode" TEXT,
  ADD COLUMN "healthToolCount" INTEGER,
  ADD COLUMN "healthCheckedAt" TIMESTAMP(3);
