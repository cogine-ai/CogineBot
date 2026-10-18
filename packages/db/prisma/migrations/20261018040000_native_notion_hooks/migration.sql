-- Deployment-level encrypted material/AAD follows NativeAppConfig; no User/Space lifecycle FK.
CREATE TABLE "native_notion_hooks" (
  "id" TEXT PRIMARY KEY,
  "configId" TEXT NOT NULL REFERENCES "native_app_configs"("id") ON DELETE CASCADE,
  "configRevision" INTEGER NOT NULL CHECK ("configRevision">0),
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision">0),
  "integrationId" TEXT,
  "candidateIntegrationId" TEXT,
  "subscriptionId" TEXT,
  "secretRecordId" TEXT UNIQUE,
  "ciphertext" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "disabledAt" TIMESTAMP(3),
  "setupOwnerUserId" TEXT NOT NULL,
  "setupSpaceId" TEXT NOT NULL,
  "setupExpiresAt" TIMESTAMP(3) NOT NULL,
  "ownerConfirmedAt" TIMESTAMP(3),
  "lastVerifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "native_notion_hooks_enabled_check" CHECK (NOT enabled OR ("ownerConfirmedAt" IS NOT NULL AND "integrationId" IS NOT NULL AND "secretRecordId" IS NOT NULL AND ciphertext IS NOT NULL AND "disabledAt" IS NULL)),
  UNIQUE("integrationId","subscriptionId")
);
CREATE INDEX "native_notion_hooks_configId_idx" ON "native_notion_hooks"("configId");
CREATE UNIQUE INDEX "native_notion_hooks_one_enabled_config" ON "native_notion_hooks"("configId") WHERE enabled=true;
