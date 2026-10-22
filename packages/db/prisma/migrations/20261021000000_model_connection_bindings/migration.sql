BEGIN;

ALTER TABLE "user_model_credentials" ADD COLUMN "connectionRevision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "bots" ADD COLUMN "modelCredentialId" TEXT;
ALTER TABLE "routines" ADD COLUMN "modelCredentialId" TEXT;
ALTER TABLE "runs" ADD COLUMN "modelCredentialId" TEXT;
ALTER TABLE "steering_messages" ADD COLUMN "modelCredentialId" TEXT;
ALTER TABLE "space_backup_models" ADD COLUMN "modelCredentialId" TEXT;
ALTER TABLE "usage_records" ADD COLUMN "modelCredentialId" TEXT;

-- A single account connection is unambiguous. Multiple candidates remain
-- unbound and require an explicit choice; timestamps never choose an endpoint.
CREATE TEMP VIEW "unique_model_connections" AS
SELECT "userId", "provider", MIN("id") AS "id"
FROM "user_model_credentials"
GROUP BY "userId", "provider" HAVING COUNT(*) = 1;

UPDATE "bots" AS pin SET "modelCredentialId" = connection."id"
FROM "unique_model_connections" AS connection
WHERE pin."userId" = connection."userId" AND pin."modelProvider" = connection."provider"
  AND pin."modelId" IS NOT NULL;
UPDATE "routines" AS pin SET "modelCredentialId" = connection."id"
FROM "unique_model_connections" AS connection
WHERE pin."userId" = connection."userId" AND pin."modelProvider" = connection."provider"
  AND pin."modelId" IS NOT NULL;
UPDATE "runs" AS pin SET "modelCredentialId" = connection."id"
FROM "unique_model_connections" AS connection
WHERE pin."userId" = connection."userId" AND pin."modelProvider" = connection."provider"
  AND pin."modelId" IS NOT NULL AND pin."modelPinned" = TRUE;
UPDATE "steering_messages" AS pin SET "modelCredentialId" = connection."id"
FROM "unique_model_connections" AS connection
WHERE pin."userId" = connection."userId" AND pin."modelProvider" = connection."provider"
  AND pin."modelId" IS NOT NULL;
UPDATE "space_backup_models" AS pin SET "modelCredentialId" = connection."id"
FROM "unique_model_connections" AS connection
WHERE pin."userId" = connection."userId" AND pin."provider" = connection."provider";

DROP VIEW "unique_model_connections";
DROP INDEX "space_backup_models_spaceId_userId_provider_modelId_key";
CREATE UNIQUE INDEX "space_backup_models_connection_model_key"
  ON "space_backup_models"("spaceId", "userId", "modelCredentialId", "provider", "modelId");

COMMIT;
