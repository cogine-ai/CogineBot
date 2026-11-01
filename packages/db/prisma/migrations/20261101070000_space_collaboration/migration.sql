ALTER TABLE "spaces"
  ADD COLUMN "allowBotCollaboration" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "collaborationRevision" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "spaces_collaboration_revision_check" CHECK ("collaborationRevision" >= 0);

CREATE TABLE "space_collaboration_changes" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "previousAllowed" BOOLEAN NOT NULL,
  "allowed" BOOLEAN NOT NULL,
  "revision" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "space_collaboration_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "space_collaboration_changes_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "space_collaboration_changes_spaceId_revision_key"
  ON "space_collaboration_changes"("spaceId", "revision");

ALTER TABLE "runs"
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'human',
  ADD COLUMN "parentRunId" TEXT,
  ADD COLUMN "collaborationSourceSpaceId" TEXT,
  ADD COLUMN "collaborationSourceBotId" TEXT,
  ADD COLUMN "collaborationSourceRevision" INTEGER,
  ADD COLUMN "collaborationRevision" INTEGER,
  ADD COLUMN "collaborationMessageId" TEXT,
  ADD COLUMN "collaborationStatus" TEXT,
  ADD CONSTRAINT "runs_origin_check"
    CHECK ("origin" IN ('human', 'bot_peer', 'group_handoff', 'child_prompt', 'external_agent', 'peer_return')),
  ADD CONSTRAINT "runs_collaboration_status_check"
    CHECK ("collaborationStatus" IS NULL OR "collaborationStatus" IN ('waiting_peer', 'completed', 'policy_disabled'));

-- Classify only unfinished dispatches. Human follow-ups and historical runs stay untouched.
-- Missing or unverifiable retained provenance fails closed at the initial worker gate.
UPDATE "runs"
SET "origin" = CASE WHEN "trigger" = 'spawn' THEN 'child_prompt' ELSE 'bot_peer' END,
    "collaborationStatus" = 'waiting_peer'
WHERE "startedAt" IS NULL AND "status" IN ('queued', 'leased')
  AND "trigger" IN ('bot_message', 'spawn');

WITH peer_sources AS (
  SELECT DISTINCT ON (r."id") r."id" AS run_id, sender."id" AS bot_id,
    sender."spaceId" AS source_space, source_space."collaborationRevision" AS source_revision,
    target_space."collaborationRevision" AS target_revision,
    sent."id" AS outbound_id, sent."runId" AS parent_run,
    CASE WHEN sender."spaceId" <> r."spaceId" OR sender."userId" <> r."userId"
      THEN 'external_agent'
      WHEN b->>'intent' IN ('result', 'status') THEN 'peer_return'
      ELSE 'bot_peer' END AS origin
  FROM "runs" r
  JOIN "messages" incoming ON incoming."id" = r."sourceMessageId"
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(incoming."blocks") = 'array' THEN incoming."blocks" ELSE '[]'::jsonb END
  ) b
  JOIN "bots" sender ON sender."id" = b->>'fromBotId'
  JOIN "spaces" source_space ON source_space."id" = sender."spaceId"
  JOIN "spaces" target_space ON target_space."id" = r."spaceId"
  LEFT JOIN "messages" sent ON sent."id" = b->>'returnToMessageId'
    AND sent."botId" = sender."id"
  WHERE r."origin" = 'bot_peer' AND r."startedAt" IS NULL
    AND r."status" IN ('queued', 'leased') AND b->>'kind' = 'bot_message_received'
  ORDER BY r."id", incoming."seq"
)
UPDATE "runs" r SET "origin" = p.origin, "parentRunId" = p.parent_run,
  "collaborationSourceSpaceId" = p.source_space, "collaborationSourceBotId" = p.bot_id,
  "collaborationSourceRevision" = p.source_revision, "collaborationRevision" = p.target_revision,
  "collaborationMessageId" = p.outbound_id
FROM peer_sources p WHERE r."id" = p.run_id;

WITH handoffs AS (
  SELECT DISTINCT ON (r."id") r."id" AS run_id, sender."id" AS bot_id,
    sender."spaceId" AS source_space, s."collaborationRevision" AS revision,
    m."id" AS message_id, m."runId" AS parent_run
  FROM "runs" r
  JOIN "messages" m ON m."id" = r."sourceMessageId" AND m."role" = 'bot'
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(m."blocks") = 'array' THEN m."blocks" ELSE '[]'::jsonb END
  ) b
  JOIN "bots" sender ON sender."id" = b->>'fromBotId' AND sender."id" = m."botId"
    AND sender."spaceId" = r."spaceId" AND sender."userId" = r."userId"
  JOIN "spaces" s ON s."id" = r."spaceId"
  WHERE r."trigger" = 'follow_up' AND r."startedAt" IS NULL
    AND r."status" IN ('queued', 'leased')
    AND b->>'kind' = 'handoff' AND b->>'toBotId' = r."botId"
  ORDER BY r."id", m."seq"
)
UPDATE "runs" r SET "origin" = 'group_handoff', "parentRunId" = h.parent_run,
  "collaborationSourceSpaceId" = h.source_space, "collaborationSourceBotId" = h.bot_id,
  "collaborationSourceRevision" = h.revision, "collaborationRevision" = h.revision,
  "collaborationMessageId" = h.message_id, "collaborationStatus" = 'waiting_peer'
FROM handoffs h WHERE r."id" = h.run_id;

UPDATE "runs" r SET "collaborationSourceSpaceId" = parent."spaceId",
  "collaborationSourceBotId" = parent."id",
  "collaborationSourceRevision" = s."collaborationRevision",
  "collaborationRevision" = s."collaborationRevision"
FROM "bots" child JOIN "bots" parent ON parent."id" = child."parentBotId"
  AND parent."spaceId" = child."spaceId" AND parent."userId" = child."userId"
JOIN "spaces" s ON s."id" = parent."spaceId"
WHERE r."botId" = child."id" AND r."origin" = 'child_prompt'
  AND r."startedAt" IS NULL AND r."status" IN ('queued', 'leased');

CREATE INDEX "runs_collaborationSourceSpaceId_collaborationStatus_idx"
  ON "runs"("collaborationSourceSpaceId", "collaborationStatus");
CREATE INDEX "runs_spaceId_origin_status_startedAt_idx"
  ON "runs"("spaceId", "origin", "status", "startedAt");
CREATE INDEX "runs_parentRunId_idx" ON "runs"("parentRunId");
