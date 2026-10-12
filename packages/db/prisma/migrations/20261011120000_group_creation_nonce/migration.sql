ALTER TABLE "chat_groups"
  ADD COLUMN "clientNonce" TEXT,
  ADD COLUMN "creationSignature" TEXT;

CREATE UNIQUE INDEX "chat_groups_spaceId_userId_clientNonce_key"
  ON "chat_groups"("spaceId", "userId", "clientNonce");
