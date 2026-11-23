BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public."user" ADD COLUMN "thinkingDefaultHistory" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE public.space_members ADD COLUMN "thinkingOverrideHistory" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE public.runs ADD COLUMN "usesDefaultThinkingLevel" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.steering_messages ADD COLUMN "usesDefaultThinkingLevel" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
