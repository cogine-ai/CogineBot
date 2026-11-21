-- Prepare to run an older application that only reads bots.autoSpeak.
-- Run with application writers stopped. Preference and Bot history stay in place.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;

LOCK TABLE public."user", public.spaces, public.space_members IN SHARE MODE;
LOCK TABLE public.bots IN SHARE ROW EXCLUSIVE MODE;

WITH inherited AS (
  SELECT bot.id, COALESCE(
    (membership."readAloudHistory" -> 0 ->> 'value')::boolean,
    (owner."readAloudHistory" -> 0 ->> 'value')::boolean,
    false
  ) AS enabled
  FROM public.bots AS bot
  LEFT JOIN public.spaces AS space ON space.id = bot."spaceId" AND space."deletingAt" IS NULL
  LEFT JOIN public.space_members AS membership
    ON membership."spaceId" = space.id AND membership."userId" = bot."userId"
  LEFT JOIN public."user" AS owner ON owner.id = membership."userId"
  WHERE bot."autoSpeakInherited"
)
UPDATE public.bots AS bot
SET "autoSpeak" = inherited.enabled, "autoSpeakInherited" = false
FROM inherited
WHERE bot.id = inherited.id;

-- An older application cannot undo an override by restoring inheritance.
UPDATE public.bots AS bot
SET "settingsRevision" = bot."settingsRevision" + 1
WHERE NOT bot."autoSpeakInherited"
  AND (bot."settingsHistory" -> 0 ->> 'revision')::integer = bot."settingsRevision"
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(bot."settingsHistory" -> 0 -> 'changes') AS entry(change)
    WHERE change ->> 'field' = 'readAloud' AND change ->> 'before' = 'Space default'
  );

COMMIT;
