-- Sole statement so the live runs table remains writable during the index build.
CREATE INDEX CONCURRENTLY "runs_status_wakeAt_idx" ON "runs"("status", "wakeAt");
