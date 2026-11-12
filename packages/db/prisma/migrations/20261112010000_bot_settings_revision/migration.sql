ALTER TABLE "bots"
  ADD COLUMN "settingsRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "settingsHistory" JSONB NOT NULL DEFAULT '[]';

CREATE FUNCTION advance_bot_settings_revision() RETURNS trigger
LANGUAGE plpgsql AS $bot_settings_revision$
BEGIN
  IF ROW(NEW.instructions, NEW."modelProvider", NEW."modelId",
         NEW."modelCredentialId", NEW."thinkingLevel", NEW."voiceId", NEW."autoSpeak")
    IS DISTINCT FROM
     ROW(OLD.instructions, OLD."modelProvider", OLD."modelId",
         OLD."modelCredentialId", OLD."thinkingLevel", OLD."voiceId", OLD."autoSpeak") THEN
    NEW."settingsRevision" := OLD."settingsRevision" + 1;
  END IF;
  RETURN NEW;
END;
$bot_settings_revision$;

CREATE TRIGGER advance_bot_settings_revision
BEFORE UPDATE OF instructions, "modelProvider", "modelId", "modelCredentialId",
  "thinkingLevel", "voiceId", "autoSpeak" ON "bots"
FOR EACH ROW EXECUTE FUNCTION advance_bot_settings_revision();

ALTER TABLE "runs" ADD COLUMN "botSettingsSnapshot" JSONB;
