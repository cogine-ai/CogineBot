ALTER TABLE "agent_skills" ADD COLUMN "clientNonce" TEXT;
CREATE UNIQUE INDEX "agent_skills_spaceId_userId_clientNonce_key"
ON "agent_skills"("spaceId", "userId", "clientNonce");
