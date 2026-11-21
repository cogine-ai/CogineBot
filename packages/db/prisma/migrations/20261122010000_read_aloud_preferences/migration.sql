BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public."user" ADD COLUMN "readAloudHistory" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE public.space_members ADD COLUMN "readAloudHistory" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE public.bots
  ADD COLUMN "autoSpeakInherited" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "readAloudRevision" INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.advance_bot_settings_revision() RETURNS trigger
LANGUAGE plpgsql AS $bot_settings_revision$
BEGIN
  IF ROW(NEW.instructions, NEW."modelProvider", NEW."modelId", NEW."modelCredentialId",
         NEW."thinkingLevel", NEW."voiceId", NEW."autoSpeak", NEW."autoSpeakInherited")
    IS DISTINCT FROM
     ROW(OLD.instructions, OLD."modelProvider", OLD."modelId", OLD."modelCredentialId",
         OLD."thinkingLevel", OLD."voiceId", OLD."autoSpeak", OLD."autoSpeakInherited") THEN
    NEW."settingsRevision" := OLD."settingsRevision" + 1;
  END IF;
  IF ROW(NEW."autoSpeak", NEW."autoSpeakInherited")
    IS DISTINCT FROM ROW(OLD."autoSpeak", OLD."autoSpeakInherited") THEN
    NEW."readAloudRevision" := OLD."readAloudRevision" + 1;
  END IF;
  RETURN NEW;
END;
$bot_settings_revision$;

DROP TRIGGER advance_bot_settings_revision ON public.bots;
CREATE TRIGGER advance_bot_settings_revision
BEFORE UPDATE OF instructions, "modelProvider", "modelId", "modelCredentialId",
  "thinkingLevel", "voiceId", "autoSpeak", "autoSpeakInherited" ON public.bots
FOR EACH ROW EXECUTE FUNCTION public.advance_bot_settings_revision();

COMMIT;
