ALTER TABLE "public"."usage_records"
  ADD COLUMN "costOwner" TEXT,
  ADD COLUMN "providerRequestId" TEXT,
  ADD COLUMN "openRouterFeeUsd" DOUBLE PRECISION,
  ADD COLUMN "upstreamInferenceCostUsd" DOUBLE PRECISION,
  ADD COLUMN "pricingSnapshot" JSONB;
