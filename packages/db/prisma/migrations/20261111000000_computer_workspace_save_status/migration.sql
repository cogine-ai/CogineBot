ALTER TABLE "public"."computers"
  ADD COLUMN "workspaceSaveProgress" JSONB,
  ADD COLUMN "workspaceSaveFailure" JSONB;
