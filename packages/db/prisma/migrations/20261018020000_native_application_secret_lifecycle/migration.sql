-- Deployment credentials follow their application configuration, not the user
-- or Space that happened to create it. Preserve existing SecretStore AAD/refs.
ALTER TABLE "native_app_configs" ADD COLUMN "ciphertext" TEXT,
ADD COLUMN "secretRecordId" TEXT;

UPDATE "native_app_configs" AS config
SET "ciphertext" = secret."ciphertext", "secretRecordId" = secret."id"
FROM "secrets" AS secret
WHERE secret."id" = config."secretId";

ALTER TABLE "native_app_configs" DROP CONSTRAINT "native_app_configs_secretId_fkey";
ALTER TABLE "native_app_configs" DROP COLUMN "secretId";

-- The reference is now owned by the global configuration; deleting this legacy
-- row must not delete the external SecretStore resource it still references.
DELETE FROM "secrets" AS secret
USING "native_app_configs" AS config
WHERE secret."id" = config."secretRecordId"
AND secret."kind" = 'native_application';

ALTER TABLE "native_app_configs" ADD CONSTRAINT "native_app_config_material_check"
CHECK (("ciphertext" IS NULL) = ("secretRecordId" IS NULL));
