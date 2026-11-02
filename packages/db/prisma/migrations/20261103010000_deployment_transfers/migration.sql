ALTER TABLE "bot_secrets" ADD COLUMN "revision" TEXT NOT NULL DEFAULT gen_random_uuid()::text;

-- Every writer, including storage migrations and explicit-id inserts, gets a fresh fence.
CREATE FUNCTION rotate_bot_secret_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := gen_random_uuid()::text;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rotate_bot_secret_revision BEFORE INSERT OR UPDATE ON "bot_secrets"
FOR EACH ROW EXECUTE FUNCTION rotate_bot_secret_revision();

CREATE TABLE "deployment_identities" (
  "id" TEXT PRIMARY KEY DEFAULT 'primary' CHECK ("id" = 'primary'),
  "deploymentId" TEXT NOT NULL UNIQUE,
  "publicKey" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "secretRecordId" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

-- Historical scope ids deliberately have no cascading parent relation.
CREATE TABLE "deployment_transfer_sessions" (
  "id" TEXT PRIMARY KEY,
  "side" TEXT NOT NULL CHECK ("side" IN ('source', 'target')),
  "targetTransferId" TEXT NOT NULL,
  "localUserId" TEXT NOT NULL,
  "localSpaceId" TEXT NOT NULL,
  "localBotId" TEXT NOT NULL,
  "localSessionId" TEXT NOT NULL,
  "sourceOrigin" TEXT NOT NULL,
  "targetOrigin" TEXT NOT NULL,
  "sourceDeploymentId" TEXT,
  "sourcePublicKey" TEXT,
  "sourceFingerprint" TEXT,
  "targetDeploymentId" TEXT NOT NULL,
  "targetPublicKey" TEXT NOT NULL,
  "targetFingerprint" TEXT NOT NULL,
  "remoteOwnerId" TEXT,
  "remoteSpaceId" TEXT,
  "remoteBotId" TEXT,
  "remoteOwnerGrantNonce" TEXT,
  "localNonce" TEXT NOT NULL,
  "peerNonce" TEXT,
  "targetBindingDigest" TEXT NOT NULL,
  "proposalDigest" TEXT,
  "planDigest" TEXT,
  "proposalJson" JSONB,
  "planJson" JSONB,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "status" TEXT NOT NULL DEFAULT 'created',
  "clientNonce" TEXT NOT NULL,
  "requestBinding" TEXT NOT NULL,
  "tokenHash" TEXT,
  "ciphertext" TEXT,
  "secretRecordId" TEXT,
  "grantDelivery" TEXT NOT NULL DEFAULT 'none',
  "acceptedNonce" TEXT,
  "consumedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "cancelRequestedAt" TIMESTAMP(3),
  "writeRevokedAt" TIMESTAMP(3),
  "writeRevokedReason" TEXT,
  "terminalAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CHECK (("ciphertext" IS NULL) = ("secretRecordId" IS NULL))
);
CREATE UNIQUE INDEX "deployment_transfer_sessions_localUserId_side_clientNonce_key"
ON "deployment_transfer_sessions"("localUserId", "side", "clientNonce");
CREATE UNIQUE INDEX "deployment_transfer_sessions_peer_owner_key"
ON "deployment_transfer_sessions"("side", "targetOrigin", "targetTransferId", "localUserId", "localSpaceId");
CREATE INDEX "deployment_transfer_sessions_owner_updated_idx"
ON "deployment_transfer_sessions"("localUserId", "localSpaceId", "updatedAt");
CREATE INDEX "deployment_transfer_sessions_status_expires_idx"
ON "deployment_transfer_sessions"("status", "expiresAt");

CREATE TABLE "deployment_transfer_items" (
  "id" TEXT PRIMARY KEY,
  "sessionId" TEXT NOT NULL REFERENCES "deployment_transfer_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "itemKey" TEXT NOT NULL,
  "sourceBotId" TEXT NOT NULL,
  "sourceSecretId" TEXT NOT NULL,
  "sourceRevision" TEXT NOT NULL,
  "targetBotId" TEXT,
  "targetName" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "auth" JSONB NOT NULL,
  "expectedTargetId" TEXT,
  "expectedTargetRevision" TEXT,
  "decision" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "writeState" TEXT NOT NULL DEFAULT 'none',
  "dispatchClaimId" TEXT UNIQUE,
  "writeFence" INTEGER NOT NULL DEFAULT 0 CHECK ("writeFence" >= 0),
  "claimedAt" TIMESTAMP(3),
  "secretRecordId" TEXT,
  "recoveryRef" TEXT,
  "ciphertext" TEXT,
  "targetSecretId" TEXT,
  "acceptedRevision" TEXT,
  "acceptedAt" TIMESTAMP(3),
  "receiptJson" JSONB,
  "cleanupState" TEXT NOT NULL DEFAULT 'none',
  "reasonCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CHECK (("expectedTargetId" IS NULL) = ("expectedTargetRevision" IS NULL)),
  CHECK ("ciphertext" IS NULL OR "secretRecordId" IS NOT NULL),
  CHECK ("recoveryRef" IS NULL OR "secretRecordId" IS NOT NULL)
);
CREATE UNIQUE INDEX "deployment_transfer_items_sessionId_itemKey_key"
ON "deployment_transfer_items"("sessionId", "itemKey");
CREATE INDEX "deployment_transfer_items_writeState_updatedAt_idx"
ON "deployment_transfer_items"("writeState", "updatedAt");
CREATE INDEX "deployment_transfer_items_recoveryRef_idx" ON "deployment_transfer_items"("recoveryRef");
CREATE UNIQUE INDEX "deployment_transfer_items_active_destination_key"
ON "deployment_transfer_items"("targetBotId", "targetName")
WHERE "targetBotId" IS NOT NULL AND "writeState" IN ('reserved', 'claimed', 'stored', 'cleanup_pending', 'cleanup_unknown');
