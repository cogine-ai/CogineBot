-- Extending recovery to failed runs must not publish old, previously unmirrored replies.
-- Runs still in flight keep NULL so failures after this cutover remain recoverable.
UPDATE "runs"
SET "messagingMirroredAt" = COALESCE("completedAt", "updatedAt")
WHERE "trigger" IN ('phone', 'messaging')
  AND "status" = 'failed'
  AND "messagingMirroredAt" IS NULL;
