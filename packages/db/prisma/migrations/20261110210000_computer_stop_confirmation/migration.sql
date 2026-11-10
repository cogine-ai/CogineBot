ALTER TABLE public.computers
  ADD COLUMN "stopPending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "autoRecoveredAt" TIMESTAMP(3);
