-- Restored write permissions must not revive a previously issued transfer grant.
-- Run after the dump, inside the same transaction, without removing recovery evidence.
DO $restore_transfer_fence$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bot_secrets' AND column_name = 'revision'
  ) THEN
    UPDATE public.bot_secrets SET revision = gen_random_uuid()::text;
  END IF;

  IF to_regclass('public.deployment_transfer_sessions') IS NOT NULL THEN
    UPDATE public.deployment_transfer_sessions
    SET "writeRevokedAt" = CURRENT_TIMESTAMP,
        "writeRevokedReason" = 'restore',
        "expiresAt" = LEAST("expiresAt", CURRENT_TIMESTAMP),
        revision = revision + 1,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "writeRevokedAt" IS NULL;
  END IF;
END;
$restore_transfer_fence$;
