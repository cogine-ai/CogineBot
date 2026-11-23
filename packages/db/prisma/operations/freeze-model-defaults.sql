-- Run in the session holding the operator's model_freeze_verified temporary table.
-- Stop application writers and settle captured inherited Runs before starting.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;

LOCK TABLE public."user", public.spaces, public.space_members, public.user_model_credentials,
  public.secrets, public.runs, public.steering_messages IN SHARE MODE;
LOCK TABLE public.space_model_preferences IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMPORARY TABLE model_freeze_candidates ON COMMIT DROP AS
SELECT membership."spaceId" AS space_id, membership."userId" AS user_id,
  choice.value ->> 'provider' AS provider, choice.value ->> 'modelId' AS model_id,
  local.preference_id, local.credential_id, local.connection_revision, local.secret_id
FROM public.space_members AS membership
JOIN public."user" AS owner ON owner.id = membership."userId"
JOIN public.spaces AS space ON space.id = membership."spaceId" AND space."deletingAt" IS NULL
CROSS JOIN LATERAL (SELECT owner."modelDefaultHistory" -> 0 -> 'value' AS value) AS choice
LEFT JOIN LATERAL (
  SELECT preference.id AS preference_id, credential.id AS credential_id,
    credential."connectionRevision" AS connection_revision, secret.id AS secret_id
  FROM public.space_model_preferences AS preference
  JOIN public.user_model_credentials AS credential
    ON credential.id = preference."credentialId" AND credential."userId" = preference."userId"
  LEFT JOIN public.secrets AS secret
    ON secret.id = credential."secretId" AND secret."userId" = membership."userId"
    AND secret."spaceId" IS NULL AND secret.kind = 'model'
  WHERE preference."spaceId" = membership."spaceId"
    AND preference."userId" = membership."userId"
    AND preference."modelId" = choice.value ->> 'modelId'
    AND credential.provider = choice.value ->> 'provider'
) AS local ON true
WHERE COALESCE((membership."modelOverrideHistory" -> 0 ->> 'value')::boolean, false) = false
  AND jsonb_typeof(choice.value) = 'object';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.runs
    WHERE "requiresSpaceModelBinding" AND status NOT IN ('completed', 'failed', 'cancelled')
  ) OR EXISTS (
    SELECT 1 FROM public.steering_messages
    WHERE "requiresSpaceModelBinding" AND "runId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Settle queued and active inherited model Runs before downgrading';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_temp.model_freeze_candidates
    GROUP BY space_id, user_id
    HAVING count(*) <> 1 OR count(secret_id) <> 1
  ) OR EXISTS (
    SELECT 1 FROM pg_temp.model_freeze_candidates AS candidate
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_temp.model_freeze_verified AS verified
      WHERE verified.space_id = candidate.space_id AND verified.user_id = candidate.user_id
        AND verified.provider = candidate.provider AND verified.model_id = candidate.model_id
        AND verified.credential_id = candidate.credential_id
        AND verified.connection_revision = candidate.connection_revision
    )
  ) THEN
    RAISE EXCEPTION 'Resolve and verify each following Space model before downgrading';
  END IF;
END $$;

UPDATE public.space_model_preferences AS preference
SET "isDefault" = false
FROM pg_temp.model_freeze_candidates AS candidate
WHERE preference."spaceId" = candidate.space_id AND preference."userId" = candidate.user_id
  AND preference.id <> candidate.preference_id AND preference."isDefault";

UPDATE public.space_model_preferences AS preference
SET "isDefault" = true
FROM pg_temp.model_freeze_candidates AS candidate
WHERE preference.id = candidate.preference_id AND NOT preference."isDefault";

COMMIT;
