-- Additive only: no existing Routine, credential or run is rewritten.
CREATE TABLE "native_routine_triggers" (
  "id" TEXT NOT NULL,
  "routineId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "authorizationRevision" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "authGeneration" INTEGER NOT NULL,
  "configId" TEXT NOT NULL,
  "configRevision" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "spec" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "armedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "state" JSONB NOT NULL DEFAULT '{}',
  "nextPollAt" TIMESTAMP(3),
  "leaseId" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "native_routine_triggers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "native_routine_triggers_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "routines"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "native_routine_triggers_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "native_routine_triggers_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "native_oauth_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "native_routine_triggers_positive_versions" CHECK ("version" > 0 AND "authGeneration" > 0 AND "configRevision" > 0),
  CONSTRAINT "native_routine_triggers_kind" CHECK ("kind" IN ('calendar.event_changed','calendar.event_starting','notion.page_content_changed','notion.page_properties_or_data_source_changed','notion.comment_changed'))
);
CREATE INDEX "native_routine_triggers_routineId_idx" ON "native_routine_triggers"("routineId");
CREATE INDEX "native_routine_triggers_connectionId_revision_idx" ON "native_routine_triggers"("connectionId","authorizationRevision");
CREATE INDEX "native_routine_triggers_nextPollAt_idx" ON "native_routine_triggers"("nextPollAt");
