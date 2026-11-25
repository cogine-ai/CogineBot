ALTER TABLE "cogine_audit"."audit_events"
  ADD COLUMN "actorLabel" VARCHAR(200),
  ADD COLUMN "targetLabel" VARCHAR(200);
