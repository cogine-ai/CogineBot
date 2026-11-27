export const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_MODEL_PAGE_SIZE = 1000;

type GeminiModelList = {
  nextPageToken?: unknown;
  models?: { name?: unknown; supportedGenerationMethods?: unknown }[];
};

export function geminiDirectoryModelIds(body: GeminiModelList): string[] {
  if (body?.nextPageToken !== undefined && body.nextPageToken !== "") {
    throw new Error("Model server returned an incomplete models list.");
  }
  if (!Array.isArray(body?.models) || body.models.length > GEMINI_MODEL_PAGE_SIZE) {
    throw new Error("Model server returned an invalid models list.");
  }
  const ids: string[] = [];
  for (const model of body.models) {
    const name = model?.name;
    const methods = model?.supportedGenerationMethods;
    if (
      typeof name !== "string" ||
      !/^models\/[a-z0-9][a-z0-9._-]{0,511}$/i.test(name) ||
      !Array.isArray(methods) ||
      methods.some((method: unknown) => typeof method !== "string")
    ) {
      throw new Error("Model server returned an invalid models list.");
    }
    if (methods.includes("generateContent")) ids.push(name.slice("models/".length));
  }
  return ids;
}

export function isGeminiApiKeyError(details: unknown): boolean {
  return (
    Array.isArray(details) &&
    details.some(
      (entry) =>
        entry?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" &&
        typeof entry.reason === "string" &&
        /^API_KEY_[A-Z_]+$/.test(entry.reason),
    )
  );
}
