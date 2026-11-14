BEGIN;
SET LOCAL lock_timeout = '10s';

-- An existing receipt has no grant revision evidence. Do not infer it
-- from Slack timestamps when the installation has already changed.
ALTER TABLE public.external_messages ADD COLUMN "slackGrantRevision" integer;

COMMIT;
