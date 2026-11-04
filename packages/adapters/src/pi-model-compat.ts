import type { Api, Model, MutableModels, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { canonicalPiProviderId } from "@rakazo/contracts";

/** Apply provider protocol capabilities before catalog and runtime selection. */
export function applyPiModelCompatibility(models: MutableModels): MutableModels {
  const provider = models.getProvider?.("amazon-bedrock");
  if (provider) {
    const guardedId = "in.anthropic.claude-haiku-4-5-20251001-v1:0";
    const guardedModels = provider
      .getModels()
      .map((model) =>
        model.id === guardedId
          ? { ...model, compat: { ...model.compat, supportsStrictMode: false } }
          : model,
      );
    models.setProvider({ ...provider, getModels: () => guardedModels });
  }
  // Only OpenAI's own endpoints, and OpenRouter (which translates per model), accept the
  // developer role. Other chat templates know system/user/assistant/tool and reject the
  // whole request ("Unexpected message role") when a reasoning model sends developer.
  for (const compatible of models.getProviders?.() ?? []) {
    if (DEVELOPER_ROLE_PROVIDERS.has(compatible.id)) continue;
    const original = compatible.getModels();
    if (!original.some(defaultsToDeveloperRole)) continue;
    const systemModels = original.map((model) =>
      defaultsToDeveloperRole(model)
        ? { ...model, compat: { ...model.compat, supportsDeveloperRole: false } }
        : model,
    );
    models.setProvider({ ...compatible, getModels: () => systemModels });
  }
  const getModel = models.getModel.bind(models);
  models.getModel = (provider, id) => getModel(canonicalPiProviderId(provider), id);
  const getProvider = models.getProvider?.bind(models);
  if (getProvider) models.getProvider = (provider) => getProvider(canonicalPiProviderId(provider));
  return models;
}

const DEVELOPER_ROLE_PROVIDERS = new Set(["openai", "azure", "openrouter"]);

/** A reasoning chat-completions model that pi would send the developer role by default. */
function defaultsToDeveloperRole(model: Model<Api>): boolean {
  if (model.api !== "openai-completions" || !model.reasoning) return false;
  const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
  return compat?.supportsDeveloperRole === undefined;
}

const REASONING_EFFORT_CHOICES =
  /\breasoning_effort\b[\s\S]{0,120}?\b(?:one of|supported values are)\b([^.}"]*)/i;

/**
 * The thinking levels of a model whose endpoint rejected `reasoning_effort` and listed the values
 * it accepts, with the rest mapped out so the request clamps to an accepted one. Off sends no
 * effort when the endpoint refuses the off value. Undefined when the error lists nothing usable.
 */
export function acceptedReasoningEfforts(
  model: Model<Api>,
  errorMessage: string | undefined,
): ThinkingLevelMap | undefined {
  const listed = errorMessage?.match(REASONING_EFFORT_CHOICES)?.[1]?.toLowerCase().match(/\w+/g);
  if (!listed) return undefined;
  const accepted = new Set(listed);
  const current = model.thinkingLevelMap ?? {};
  const levels: ThinkingLevelMap = {};
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const effort = current[level] ?? (level === "xhigh" || level === "max" ? null : level);
    levels[level] = effort !== null && accepted.has(effort) ? effort : null;
  }
  if (Object.values(levels).every((effort) => effort === null)) return undefined;
  if (typeof current.off === "string" && accepted.has(current.off)) levels.off = current.off;
  return levels;
}
