ALTER TABLE public.threads
ADD COLUMN "memoryCleanupUnconfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "memoryCleanupIntents" JSONB NOT NULL DEFAULT '[]'::jsonb;
