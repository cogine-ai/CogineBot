-- Edit concurrency and accepted-event delivery have independent generations.
ALTER TABLE "native_slack_hooks" ADD COLUMN "deliveryRevision" INTEGER;
UPDATE "native_slack_hooks" SET "deliveryRevision" = "revision";
ALTER TABLE "native_slack_hooks" ALTER COLUMN "deliveryRevision" SET NOT NULL;
ALTER TABLE "native_slack_hooks" ALTER COLUMN "deliveryRevision" SET DEFAULT 1;
ALTER TABLE "native_slack_hooks" ADD CONSTRAINT "native_slack_hooks_delivery_revision_positive" CHECK ("deliveryRevision" > 0);
