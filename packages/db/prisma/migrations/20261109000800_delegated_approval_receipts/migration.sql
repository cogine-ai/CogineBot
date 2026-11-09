BEGIN;

ALTER TABLE "external_effects"
  ADD COLUMN "delegatedApprovalNonce" TEXT,
  ADD COLUMN "requiresPeerApprovalRecheck" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "approvalReceipt" JSONB;

-- Protect an ordinary peer approval already queued by the previous application.
UPDATE "external_effects" effect
SET "requiresPeerApprovalRecheck" = true
FROM "runs" peer
JOIN "runs" parent ON parent.id = peer."parentRunId"
JOIN "threads" sender ON sender.id = parent."threadId"
JOIN "threads" recipient ON recipient.id = peer."threadId"
WHERE effect."runId" = peer.id AND effect."spaceId" = peer."spaceId"
  AND effect.status = 'approved'
  AND effect.kind NOT IN ('request_secret', 'request_takeover')
  AND peer.origin = 'bot_peer' AND peer.status IN ('queued', 'leased', 'running', 'waiting_limit')
  AND peer."collaborationMessageId" IS NOT NULL
  AND peer."collaborationSourceBotId" = parent."botId"
  AND peer."collaborationSourceSpaceId" = peer."spaceId"
  AND parent."spaceId" = peer."spaceId" AND parent."userId" = peer."userId"
  AND parent."parentRunId" IS NULL
  AND sender."botId" = parent."botId" AND sender."groupId" IS NULL AND sender."externalConversationId" IS NULL
  AND recipient."botId" = peer."botId" AND recipient."groupId" IS NULL AND recipient."externalConversationId" IS NULL
  AND EXISTS (
    SELECT 1 FROM "messages" message
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(message.blocks) = 'array' THEN message.blocks ELSE '[]'::jsonb END
    ) block
    WHERE message."threadId" = peer."threadId" AND message."runId" = peer.id
      AND message.role = 'bot' AND block->>'kind' = 'ask'
      AND block->>'approvalEffectId' = effect.id AND block->>'status' = 'answered'
      AND block->>'answer' IN ('allow', 'always')
      AND block->>'reviewMode' IS NULL AND block->>'credential' IS NULL AND block->>'purpose' IS NULL
      AND block->>'input' IS DISTINCT FROM 'secret'
  );

COMMIT;
