ALTER TABLE "cloud_agents"
  ADD COLUMN "launchReviewEffectId" TEXT,
  ADD COLUMN "followupReviewEffectId" TEXT,
  ADD COLUMN "followupReviewGeneration" INTEGER,
  ADD COLUMN "cancelReviewEffectId" TEXT,
  ADD COLUMN "cancelReviewGeneration" INTEGER;
