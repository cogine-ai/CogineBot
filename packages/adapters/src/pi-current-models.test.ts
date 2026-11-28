import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { supplementPiModels } from "./pi-current-models.js";
import { listPiCatalog } from "./pi-models.js";
import { modelsForRequest } from "./pi-runtime.js";

describe("current model compatibility", () => {
  it.each([
    ["openai", "gpt-6.1-terra", "openai-responses", 272_000],
    ["openai-codex", "gpt-6.1-terra", "openai-codex-responses", 500_000],
    ["vercel-ai-gateway", "openai/gpt-6.1-terra", "anthropic-messages", 1_050_000],
  ] as const)(
    "registers the selected %s Terra model for tool-using runs",
    (provider, id, api, contextWindow) => {
      const model = supplementPiModels(builtinModels()).getModel(provider, id);
      expect(model).toMatchObject({
        id,
        api,
        contextWindow,
        maxTokens: 128_000,
        input: ["text", "image"],
      });
      expect(listPiCatalog()).toContainEqual(
        expect.objectContaining({ provider, id, inferenceProbe: true }),
      );
      if (provider === "openai") expect(model?.thinkingLevelMap?.off).toBe("none");
      if (provider === "openai-codex") expect(model?.thinkingLevelMap?.off).toBeNull();
    },
  );

  it.each([
    ["anthropic", "claude-sonnet-5-5", ["low", "medium", "high", "xhigh", "max"]],
    ["openai-codex", "gpt-6.1-sol", ["minimal", "low", "medium", "high", "xhigh", "max"]],
  ] as const)(
    "exposes %s/%s in the picker and runtime with valid efforts",
    (provider, id, efforts) => {
      const model = modelsForRequest(
        { model: { provider, id } } as Parameters<typeof modelsForRequest>[0],
        provider,
      ).getModel(provider, id);
      expect(model).toBeDefined();
      expect(getSupportedThinkingLevels(model!)).toEqual(efforts);
      expect(model?.input).toContain("image");
      expect(
        listPiCatalog().find((entry) => entry.provider === provider && entry.id === id)
          ?.thinkingLevels,
      ).toEqual(efforts);
    },
  );
  it("does not replace a provider library model when applying the supplement again", () => {
    const models = supplementPiModels(builtinModels());
    const model = models.getModel("anthropic", "claude-sonnet-5-5");
    supplementPiModels(models);
    expect(models.getModel("anthropic", "claude-sonnet-5-5")).toBe(model);
    expect(model?.compat).toMatchObject({
      forceAdaptiveThinking: true,
      supportsTemperature: false,
      supportsStrictTools: true,
      supportsMidConvoEffort: true,
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolChanges: true,
    });
  });
});
