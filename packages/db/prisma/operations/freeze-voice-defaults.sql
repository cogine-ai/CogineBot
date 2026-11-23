-- Run in the session holding the operator's voice_freeze_verified temporary table.
-- Stop application writers first. Keep preference history and connection ownership.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;

LOCK TABLE public."user", public.spaces, public.space_members,
  public.user_voice_credentials IN SHARE MODE;
LOCK TABLE public.space_voice_preferences IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMPORARY TABLE voice_freeze_candidates ON COMMIT DROP AS
SELECT membership."spaceId" AS space_id, membership."userId" AS user_id,
  choice.value ->> 'provider' AS provider, choice.value ->> 'voiceId' AS voice_id,
  local.id AS preference_id, local."voiceId" AS previous_voice_id,
  local.provider AS local_provider, local.credential_id, local.credential_updated_at
FROM public.space_members AS membership
JOIN public."user" AS owner ON owner.id = membership."userId"
JOIN public.spaces AS space ON space.id = membership."spaceId" AND space."deletingAt" IS NULL
CROSS JOIN LATERAL (SELECT owner."voiceDefaultHistory" -> 0 -> 'value' AS value) AS choice
LEFT JOIN LATERAL (
  SELECT preference.id, preference."voiceId", credential.provider,
    credential.id AS credential_id, credential."updatedAt" AS credential_updated_at
  FROM public.space_voice_preferences AS preference
  JOIN public.user_voice_credentials AS credential
    ON credential.id = preference."credentialId" AND credential."userId" = preference."userId"
  WHERE preference."spaceId" = membership."spaceId"
    AND preference."userId" = membership."userId" AND preference."isDefault"
  ORDER BY preference."updatedAt" DESC, preference.id DESC
  LIMIT 1
) AS local ON true
WHERE COALESCE((membership."voiceOverrideHistory" -> 0 ->> 'value')::boolean, false) = false
  AND jsonb_typeof(choice.value) = 'object'
  -- A Space with no local connection cannot play speech on either version.
  AND local.id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_temp.voice_freeze_candidates AS candidate
    WHERE candidate.local_provider IS DISTINCT FROM candidate.provider
      OR NOT EXISTS (
        SELECT 1 FROM pg_temp.voice_freeze_verified AS verified
        WHERE verified.space_id = candidate.space_id AND verified.user_id = candidate.user_id
          AND verified.provider = candidate.provider AND verified.voice_id = candidate.voice_id
          AND verified.credential_id = candidate.credential_id
          AND verified.credential_updated_at = candidate.credential_updated_at
      )
  ) THEN
    RAISE EXCEPTION 'Resolve or verify each following Space voice before downgrading';
  END IF;
END $$;

UPDATE public.space_voice_preferences AS preference
SET "voiceId" = candidate.voice_id
FROM pg_temp.voice_freeze_candidates AS candidate
WHERE preference.id = candidate.preference_id AND candidate.previous_voice_id <> candidate.voice_id;

COMMIT;
