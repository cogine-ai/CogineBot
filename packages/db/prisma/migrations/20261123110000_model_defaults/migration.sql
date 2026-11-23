BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public."user" ADD COLUMN "modelDefaultHistory" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE public.space_members ADD COLUMN "modelOverrideHistory" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE public.runs ADD COLUMN "requiresSpaceModelBinding" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.steering_messages ADD COLUMN "requiresSpaceModelBinding" BOOLEAN NOT NULL DEFAULT false;

UPDATE public.space_members AS membership
SET "modelOverrideHistory" = '[{"value":true,"revision":0}]'::jsonb
WHERE EXISTS (
  SELECT 1 FROM public.space_model_preferences AS model
  WHERE model."spaceId" = membership."spaceId" AND model."userId" = membership."userId"
    AND model."isDefault"
);

COMMIT;
