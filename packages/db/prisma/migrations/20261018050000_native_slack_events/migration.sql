-- Slack signing secrets belong to the deployment app, separate from OAuth client secrets.
CREATE TABLE "native_slack_hooks" (
  "id" TEXT PRIMARY KEY,
  "configId" TEXT NOT NULL REFERENCES "native_app_configs"("id") ON DELETE CASCADE,
  "configRevision" INTEGER NOT NULL CHECK ("configRevision">0),
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision">0),
  "appId" TEXT NOT NULL,
  "teamId" TEXT,
  "botEvents" TEXT[] NOT NULL,
  "secretRecordId" TEXT UNIQUE,
  "ciphertext" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "disabledAt" TIMESTAMP(3),
  "ownerConfirmedAt" TIMESTAMP(3) NOT NULL,
  "lastVerifiedAt" TIMESTAMP(3),
  "setupOwnerUserId" TEXT NOT NULL,
  "setupSpaceId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "native_slack_hooks_enabled_check" CHECK (NOT enabled OR ("secretRecordId" IS NOT NULL AND ciphertext IS NOT NULL AND "disabledAt" IS NULL AND cardinality("botEvents")>0))
);
CREATE INDEX "native_slack_hooks_configId_idx" ON "native_slack_hooks"("configId");
CREATE UNIQUE INDEX "native_slack_hooks_enabled_config" ON "native_slack_hooks"("configId") WHERE enabled=true;
CREATE UNIQUE INDEX "native_slack_hooks_enabled_app" ON "native_slack_hooks"("appId") WHERE enabled=true;
CREATE TABLE "native_slack_event_inbox" (
  "id" TEXT PRIMARY KEY,
  "hookId" TEXT NOT NULL REFERENCES "native_slack_hooks"("id") ON DELETE CASCADE,
  "hookRevision" INTEGER NOT NULL CHECK ("hookRevision">0),
  "configRevision" INTEGER NOT NULL CHECK ("configRevision">0),
  "eventId" TEXT NOT NULL,
  "signal" JSONB NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatchedAt" TIMESTAMP(3),
  UNIQUE("hookId","eventId")
);
CREATE INDEX "native_slack_event_inbox_dispatchedAt_receivedAt_idx" ON "native_slack_event_inbox"("dispatchedAt","receivedAt");
