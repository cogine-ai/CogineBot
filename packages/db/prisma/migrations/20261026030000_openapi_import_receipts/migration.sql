CREATE TABLE "openapi_import_receipts" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "installId" TEXT,
  "requestBinding" TEXT NOT NULL,
  "planDigest" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "generation" INTEGER NOT NULL DEFAULT 1,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "reviewExpiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "openapi_import_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "openapi_import_receipts_state_check" CHECK ("state" IN ('pending', 'installed', 'stale', 'invalid')),
  CONSTRAINT "openapi_import_receipts_generation_check" CHECK ("generation" >= 1),
  CONSTRAINT "openapi_import_receipts_lease_pair_check" CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL)),
  CONSTRAINT "openapi_import_receipts_terminal_lease_check" CHECK ("state" = 'pending' OR "leaseOwner" IS NULL),
  CONSTRAINT "openapi_import_receipts_install_state_check" CHECK ("state" = 'installed' OR "installId" IS NULL),
  CONSTRAINT "openapi_import_receipts_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "openapi_import_receipts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "openapi_import_receipts_installId_fkey" FOREIGN KEY ("installId") REFERENCES "capability_installs"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "openapi_import_receipts_installId_key" ON "openapi_import_receipts"("installId");
CREATE INDEX "openapi_import_receipts_spaceId_userId_idx" ON "openapi_import_receipts"("spaceId", "userId");
CREATE INDEX "openapi_import_receipts_userId_idx" ON "openapi_import_receipts"("userId");
