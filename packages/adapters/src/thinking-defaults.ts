import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { DefaultModelChoice, ThinkingLevel } from "@rakazo/contracts";
import { resolveThinkingDefault, sameDefaultModel, ThinkingLevelSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { readThinkingPreferences } from "@rakazo/db";
import { CHATGPT_OAUTH_PROVIDER } from "./pi-oauth.js";
import { resolveRuntimeModel } from "./pi-runtime.js";

export function runtimeThinkingLevels(model: AgentRunRequest["model"]): ThinkingLevel[] {
  const resolved = resolveRuntimeModel(model).model;
  if (!resolved?.reasoning) return [];
  const levels = ThinkingLevelSchema.array().parse(getSupportedThinkingLevels(resolved));
  return model.provider === CHATGPT_OAUTH_PROVIDER
    ? levels.filter((level) => (resolved.thinkingLevelMap?.[level] ?? level) === level)
    : levels;
}

export async function thinkingPreferencesForModel(
  prisma: Pick<PrismaClient, "spaceMember">,
  scope: { userId: string; spaceId: string },
  model: DefaultModelChoice | null,
) {
  if (!model) return null;
  const preferences = await readThinkingPreferences(prisma, scope);
  return sameDefaultModel(preferences.account?.model ?? null, model) ||
    sameDefaultModel(preferences.space?.model ?? null, model)
    ? preferences
    : null;
}

export function applyThinkingDefault(
  model: AgentRunRequest["model"],
  preferences: Awaited<ReturnType<typeof thinkingPreferencesForModel>>,
  legacy: ThinkingLevel | null,
  allowed?: ThinkingLevel[],
) {
  if (!preferences || !model.modelCredentialId) return { level: legacy, captured: false };
  const effective = resolveThinkingDefault({
    model: { provider: model.provider, modelId: model.id },
    allowed: allowed ?? runtimeThinkingLevels(model),
    explicit: null,
    legacy,
    ...preferences,
  });
  return { level: effective.level, captured: true };
}
