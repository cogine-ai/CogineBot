-- An archive cannot prove that its share links were still active at restore time.
-- Run after the dump, inside the same transaction and before writers restart.
DO $restore_page_share_fence$
DECLARE
  pages_table regclass := pg_catalog.to_regclass('cogine_pages.pages');
  share_columns integer;
BEGIN
  SELECT count(*) INTO share_columns
  FROM pg_catalog.pg_attribute
  WHERE attrelid = pages_table
    AND attname IN ('shareTokenHash', 'shareSecretId')
    AND NOT attisdropped;

  IF share_columns = 0 THEN
    RETURN;
  END IF;
  IF share_columns <> 2 THEN
    RAISE EXCEPTION 'Cannot revoke restored Page links: incomplete share schema';
  END IF;

  -- Fail if the restore role cannot see every Page or secret under row security.
  PERFORM pg_catalog.set_config('row_security', 'off', true);

  WITH linked AS (
    SELECT id, "userId", "spaceId", "shareSecretId"
    FROM cogine_pages.pages
    WHERE visibility = 'link' OR "shareTokenHash" IS NOT NULL OR "shareSecretId" IS NOT NULL
  ), revoked AS (
    UPDATE cogine_pages.pages AS page
    SET visibility = 'private', "shareTokenHash" = NULL, "shareSecretId" = NULL
    FROM linked
    WHERE page.id = linked.id
    RETURNING linked."shareSecretId", linked."userId", linked."spaceId"
  )
  DELETE FROM public.secrets AS secret
  USING revoked
  WHERE secret.id = revoked."shareSecretId"
    AND secret."userId" = revoked."userId"
    AND secret."spaceId" = revoked."spaceId"
    AND secret.kind = 'page_share';
END;
$restore_page_share_fence$;
