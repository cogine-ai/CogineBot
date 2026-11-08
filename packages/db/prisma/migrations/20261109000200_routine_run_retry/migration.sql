ALTER TABLE "routines"
  ADD COLUMN "latestRunId" TEXT,
  ADD COLUMN "autoCompletedRunId" TEXT;

ALTER TABLE "runs"
  ADD COLUMN "retryOfRunId" TEXT,
  ADD COLUMN "routineRetryAt" TIMESTAMP(3);
