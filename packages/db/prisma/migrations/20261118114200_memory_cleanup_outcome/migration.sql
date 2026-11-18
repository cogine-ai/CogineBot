ALTER TABLE public.threads
ADD COLUMN "memoryCleanupUnconfirmed" BOOLEAN NOT NULL DEFAULT false;
