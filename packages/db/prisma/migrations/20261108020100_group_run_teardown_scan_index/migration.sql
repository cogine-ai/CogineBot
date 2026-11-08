-- Match the bounded worker scan without blocking writes to active computers.
CREATE INDEX CONCURRENTLY "computers_pending_group_run_teardowns_idx"
  ON "public"."computers" ("id") WHERE "pendingGroupRunTeardowns" IS NOT NULL;
