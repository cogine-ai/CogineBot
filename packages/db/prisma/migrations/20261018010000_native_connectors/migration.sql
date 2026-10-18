-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "mcpServerId" TEXT,
ADD COLUMN     "nativeConfigId" TEXT,
ADD COLUMN     "nativeConfigRevision" INTEGER,
ADD COLUMN     "oauthGrantId" TEXT;

-- AlterTable
ALTER TABLE "mcp_servers" ADD COLUMN     "nativeAppId" TEXT;

-- CreateTable
CREATE TABLE "native_app_configs" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ownership" TEXT NOT NULL,
    "credentialKind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretId" TEXT,
    "callbackUri" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "native_app_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "native_oauth_sessions" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "configRevision" INTEGER NOT NULL,
    "requestedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secretId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "native_oauth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "native_oauth_grants" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "configRevision" INTEGER NOT NULL,
    "authority" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "tenant" TEXT,
    "principal" JSONB NOT NULL DEFAULT '{}',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secretId" TEXT,
    "accessExpiresAt" TIMESTAMP(3),
    "authGeneration" INTEGER NOT NULL DEFAULT 1,
    "tokenVersion" INTEGER NOT NULL DEFAULT 1,
    "revokedAt" TIMESTAMP(3),
    "refreshLeaseId" TEXT,
    "refreshLeaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "native_oauth_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "native_app_configs_appId_enabled_idx" ON "native_app_configs"("appId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "native_oauth_sessions_stateHash_key" ON "native_oauth_sessions"("stateHash");

-- CreateIndex
CREATE UNIQUE INDEX "native_oauth_sessions_connectionId_key" ON "native_oauth_sessions"("connectionId");

-- CreateIndex
CREATE INDEX "native_oauth_sessions_userId_spaceId_expiresAt_idx" ON "native_oauth_sessions"("userId", "spaceId", "expiresAt");

-- CreateIndex
CREATE INDEX "native_oauth_grants_userId_spaceId_authority_idx" ON "native_oauth_grants"("userId", "spaceId", "authority");

-- CreateIndex
CREATE UNIQUE INDEX "connections_mcpServerId_key" ON "connections"("mcpServerId");

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_nativeConfigId_fkey" FOREIGN KEY ("nativeConfigId") REFERENCES "native_app_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_oauthGrantId_fkey" FOREIGN KEY ("oauthGrantId") REFERENCES "native_oauth_grants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "mcp_servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_app_configs" ADD CONSTRAINT "native_app_configs_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_oauth_sessions" ADD CONSTRAINT "native_oauth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_oauth_sessions" ADD CONSTRAINT "native_oauth_sessions_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_oauth_sessions" ADD CONSTRAINT "native_oauth_sessions_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_oauth_sessions" ADD CONSTRAINT "native_oauth_sessions_configId_fkey" FOREIGN KEY ("configId") REFERENCES "native_app_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_oauth_sessions" ADD CONSTRAINT "native_oauth_sessions_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_oauth_grants" ADD CONSTRAINT "native_oauth_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_oauth_grants" ADD CONSTRAINT "native_oauth_grants_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_oauth_grants" ADD CONSTRAINT "native_oauth_grants_configId_fkey" FOREIGN KEY ("configId") REFERENCES "native_app_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_oauth_grants" ADD CONSTRAINT "native_oauth_grants_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A deployment OAuth application must survive deletion of the Space where its
-- administrator opened settings. Account/session credentials remain Space-scoped.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "secrets" DROP CONSTRAINT "secrets_scope_check";
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_scope_check" CHECK (
  ("kind" IN ('model', 'voice', 'native_application') AND "spaceId" IS NULL)
  OR ("kind" NOT IN ('model', 'voice', 'native_application') AND "spaceId" IS NOT NULL)
) NOT VALID;
COMMIT;
ALTER TABLE "secrets" VALIDATE CONSTRAINT "secrets_scope_check";
