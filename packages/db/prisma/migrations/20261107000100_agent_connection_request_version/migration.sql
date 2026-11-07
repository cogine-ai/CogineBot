ALTER TABLE "agent_connections" ADD COLUMN "requestVersion" INTEGER NOT NULL DEFAULT 1;

-- Application rollback keeps this schema. The previous application can reopen
-- a request by changing status alone; it must still invalidate any older card.
CREATE FUNCTION preserve_agent_connection_request_version() RETURNS trigger
LANGUAGE plpgsql AS $connection_version$
BEGIN
  IF OLD.status IN ('declined', 'revoked') AND NEW.status = 'pending'
     AND NEW."requestVersion" = OLD."requestVersion" THEN
    NEW."requestVersion" := OLD."requestVersion" + 1;
  END IF;
  RETURN NEW;
END;
$connection_version$;

CREATE TRIGGER agent_connections_request_version
BEFORE UPDATE OF status ON "agent_connections"
FOR EACH ROW EXECUTE FUNCTION preserve_agent_connection_request_version();
