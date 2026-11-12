BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.messaging_outbound
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "deliveryState" TEXT,
  ADD COLUMN "claimStartedAt" TIMESTAMP(3),
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "partIndex" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "artifactId" TEXT,
  ADD COLUMN "lastErrorClass" TEXT;

CREATE INDEX messaging_outbound_identity_lane_idx
  ON public.messaging_outbound ("identityId", status, "createdAt", "sourceMessageId", "partIndex", id);
CREATE INDEX messaging_outbound_thread_lane_idx
  ON public.messaging_outbound ("threadId", status, "createdAt", "sourceMessageId", "partIndex", id);
CREATE INDEX messaging_outbound_source_msg_idx ON public.messaging_outbound ("sourceMessageId");
CREATE INDEX messaging_outbound_provider_handle_idx
  ON public.messaging_outbound (provider, "providerHandle");

COMMIT;
