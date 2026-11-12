ALTER TABLE public.runs ADD COLUMN "receivedOutsideMessage" BOOLEAN;
ALTER TABLE public.runs ALTER COLUMN "receivedOutsideMessage" SET DEFAULT false;
ALTER TABLE public.runs ADD COLUMN "historySourceReferences" JSONB;
