-- Install the default and enforce the check on writes before scanning existing runs.
ALTER TABLE "runs"
  ADD COLUMN "selfRecoveries" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "runs_self_recovery_budget" CHECK ("selfRecoveries" BETWEEN 0 AND 3) NOT VALID;
