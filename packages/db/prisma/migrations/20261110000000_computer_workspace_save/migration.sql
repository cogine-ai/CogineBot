ALTER TABLE "computers"
  ADD COLUMN "homeRevisionAt" TIMESTAMP(3),
  ADD COLUMN "restorePending" BOOLEAN NOT NULL DEFAULT false;
