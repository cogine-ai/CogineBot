BEGIN;
SET LOCAL lock_timeout = '10s';
-- No server FK: deletion must not erase the receipt or allow a late retry to recreate it.
CREATE TABLE public.mcp_create_requests (
  "spaceId" TEXT NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "requestId" TEXT NOT NULL,
  "serverId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("spaceId", "userId", "requestId")
);
COMMIT;
