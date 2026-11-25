ALTER TABLE "public"."openapi_import_receipts"
  ADD COLUMN "pendingCredentialAuditAt" TIMESTAMP(3);

CREATE INDEX "openapi_import_receipts_credential_audit_expiry_idx"
  ON "public"."openapi_import_receipts" ("pendingCredentialAuditAt", "id")
  WHERE "pendingCredentialAuditAt" IS NOT NULL;
