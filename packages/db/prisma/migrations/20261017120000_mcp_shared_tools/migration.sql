-- A server has one tool policy for every current and future bot of its owning actor.
-- Legacy bot assignments are deliberately not merged into broader permissions.
ALTER TABLE "mcp_servers"
  ADD COLUMN "allowAllTools" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "allowedTools" JSONB NOT NULL DEFAULT '[]';

-- Preserve exact user-selected connection references without changing the task prompt.
ALTER TABLE "tasks" ADD COLUMN "connectionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "steering_messages" ADD COLUMN "connectionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
