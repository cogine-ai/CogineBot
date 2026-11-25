ALTER TABLE "routines" ADD COLUMN "failurePausedAt" TIMESTAMP(3);
ALTER TABLE "runs"
  ADD COLUMN "routineFailureCause" TEXT,
  ADD COLUMN "routineRetrySkipped" BOOLEAN NOT NULL DEFAULT false;
