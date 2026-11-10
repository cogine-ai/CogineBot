ALTER TABLE "computers"
  ADD COLUMN "runningSince" TIMESTAMP(3),
  ADD COLUMN "runningObservedAt" TIMESTAMP(3),
  ADD COLUMN "suspensionReason" TEXT;
