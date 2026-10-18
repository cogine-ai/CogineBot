-- Linear permits replaying a lost refresh response for 30 minutes from the original request.
-- Keep this deadline independent of the per-attempt lease; retries cannot slide the window.
ALTER TABLE "native_oauth_grants" ADD COLUMN "refreshRecoveryUntil" TIMESTAMP(3);
