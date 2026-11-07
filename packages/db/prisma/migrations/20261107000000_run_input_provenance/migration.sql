ALTER TABLE "tasks" ADD COLUMN "routineInstructions" TEXT;
ALTER TABLE "tasks" ADD COLUMN "routineSites" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "messages" ADD COLUMN "authorUserId" TEXT;
ALTER TABLE "routines" ADD COLUMN "authorizedInstructions" TEXT;
ALTER TABLE "routines" ADD COLUMN "authorizedSites" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
