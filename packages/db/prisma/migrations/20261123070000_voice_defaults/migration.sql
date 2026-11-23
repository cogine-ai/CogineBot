BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public."user" ADD COLUMN "voiceDefaultHistory" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE public.space_members ADD COLUMN "voiceOverrideHistory" JSONB NOT NULL DEFAULT '[]';

-- Keep the voice each existing Space already selected.
UPDATE public.space_members AS member
SET "voiceOverrideHistory" = '[{"value":true,"revision":0}]'::jsonb
WHERE EXISTS (
  SELECT 1 FROM public.space_voice_preferences AS voice
  WHERE voice."spaceId" = member."spaceId" AND voice."userId" = member."userId"
    AND voice."isDefault" AND voice."voiceId" <> ''
);

COMMIT;
