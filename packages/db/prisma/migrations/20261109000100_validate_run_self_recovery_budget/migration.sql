-- Scan after the add migration commits, using a lock compatible with row writes.
ALTER TABLE "runs" VALIDATE CONSTRAINT "runs_self_recovery_budget";
