-- Keep teardown intent after the group's Run rows cascade, without a new runtime relation.
ALTER TABLE "public"."computers" ADD COLUMN "pendingGroupRunTeardowns" JSONB;
