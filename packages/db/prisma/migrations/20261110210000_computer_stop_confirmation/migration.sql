ALTER TABLE public.computers
  ADD COLUMN "stopRequestedAt" TIMESTAMP(3),
  ADD COLUMN "autoRecoveredAt" TIMESTAMP(3),
  ADD COLUMN "providerAuthority" TEXT;
