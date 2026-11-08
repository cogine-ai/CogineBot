ALTER TABLE "runs"
  ADD COLUMN "selfRecoveries" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "runs_self_recovery_budget" CHECK ("selfRecoveries" BETWEEN 0 AND 3);
