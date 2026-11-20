ALTER TABLE "public"."routines"
  ADD COLUMN "startAt" TIMESTAMP(3),
  ADD COLUMN "intervalBased" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "intervalAnchorAt" TIMESTAMP(3),
  ADD COLUMN "groupScoped" BOOLEAN NOT NULL DEFAULT false;

UPDATE "public"."routines" AS routine
SET "groupScoped" = true
FROM "public"."threads" AS thread
WHERE routine."threadId" = thread.id AND thread."groupId" IS NOT NULL;

UPDATE "public"."routines" AS routine
SET active = false, "nextRunAt" = NULL, "latestRunId" = NULL, "autoCompletedRunId" = NULL
WHERE routine."groupScoped" AND NOT EXISTS (
  SELECT 1 FROM "public"."threads" AS thread
  JOIN "public"."chat_groups" AS origin ON origin.id = thread."groupId"
  JOIN "public"."chat_group_members" AS member ON member."groupId" = origin.id
  WHERE thread.id = routine."threadId" AND origin."archivedAt" IS NULL
    AND member."botId" = routine."botId"
);
