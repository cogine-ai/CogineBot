ALTER TABLE "agent_connections"
  ADD COLUMN "requestVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "responseVersion" INTEGER,
  ADD COLUMN "revocationVersion" INTEGER;

-- Application rollback keeps this schema. The previous application can reopen
-- a request by changing status alone; it must still invalidate any older card.
-- An earlier image cannot safely approve, decline, or revoke without its version.
CREATE FUNCTION enforce_agent_connection_request_version() RETURNS trigger
LANGUAGE plpgsql AS $connection_version$
BEGIN
  IF OLD.status IN ('declined', 'revoked') AND NEW.status = 'pending' THEN
    IF NEW."requestVersion" = OLD."requestVersion" THEN
      NEW."requestVersion" := OLD."requestVersion" + 1;
    END IF;
    NEW."responseVersion" := NULL;
    NEW."revocationVersion" := NULL;
  ELSIF OLD.status = 'pending' AND NEW.status IN ('approved', 'declined')
    AND (NEW."responseVersion" IS DISTINCT FROM OLD."requestVersion"
         OR NEW."responseVersion" IS NOT DISTINCT FROM OLD."responseVersion") THEN
    RETURN NULL;
  ELSIF OLD.status <> 'revoked' AND NEW.status = 'revoked'
    AND (NEW."revocationVersion" IS DISTINCT FROM OLD."requestVersion"
         OR NEW."revocationVersion" IS NOT DISTINCT FROM OLD."revocationVersion") THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$connection_version$;

CREATE TRIGGER agent_connections_request_version
BEFORE UPDATE OF status ON "agent_connections"
FOR EACH ROW EXECUTE FUNCTION enforce_agent_connection_request_version();
