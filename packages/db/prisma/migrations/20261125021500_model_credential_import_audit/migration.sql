ALTER TABLE "public"."bot_package_imports"
  ADD COLUMN "createdModelCredentialId" TEXT,
  ADD COLUMN "modelCredentialCreatedAt" TIMESTAMP(3);

CREATE INDEX "bot_package_imports_model_audit_expiry_idx"
  ON "public"."bot_package_imports" ("modelCredentialCreatedAt", "id")
  WHERE "modelCredentialCreatedAt" IS NOT NULL;
