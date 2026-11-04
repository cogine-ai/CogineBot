-- Install the protected system-context primitive for the staged RLS rollout.
-- Table policies and runtime-role activation are separate migration stages.
CREATE SCHEMA IF NOT EXISTS cogine_private;
REVOKE ALL ON SCHEMA cogine_private FROM PUBLIC;

CREATE TABLE cogine_private.rls_bypass_keys (
  digest BYTEA PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE cogine_private.rls_bypass_keys FROM PUBLIC;

-- A plain session flag, an empty key table, or an empty supplied key grants
-- nothing. The migration owner registers a digest before system access works.
CREATE FUNCTION app_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT coalesce(current_setting('app.rls_bypass', true) = 'on', false)
      AND NULLIF(current_setting('app.rls_bypass_key', true), '') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM cogine_private.rls_bypass_keys
        WHERE digest = sha256(convert_to(current_setting('app.rls_bypass_key', true), 'UTF8'))
      )
  $$;
