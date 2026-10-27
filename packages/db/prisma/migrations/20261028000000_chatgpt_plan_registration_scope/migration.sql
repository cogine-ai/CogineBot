-- Retained ChatGPT registrations belong to the account across all its Spaces.
-- Replace both scope branches together so every other secret keeps its boundary.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "secrets" DROP CONSTRAINT "secrets_scope_check";
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_scope_check" CHECK (
  ("kind" IN ('model', 'voice', 'native_application', 'chatgpt-plan-registration') AND "spaceId" IS NULL)
  OR ("kind" NOT IN ('model', 'voice', 'native_application', 'chatgpt-plan-registration') AND "spaceId" IS NOT NULL)
) NOT VALID;
COMMIT;
ALTER TABLE "secrets" VALIDATE CONSTRAINT "secrets_scope_check";
