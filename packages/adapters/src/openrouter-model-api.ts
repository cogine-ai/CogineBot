export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_USER_MODELS_URL = `${OPENROUTER_API_BASE_URL}/models/user`;

type OpenRouterModelList = {
  data?: {
    id?: unknown;
    architecture?: { input_modalities?: unknown; output_modalities?: unknown };
    endpoints?: unknown;
  }[];
  total_count?: unknown;
  links?: { next?: unknown };
};

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function openRouterDirectoryModelIds(
  body: OpenRouterModelList,
  maxModelIds: number,
): string[] {
  const entries = body?.data;
  if (!Array.isArray(entries) || entries.length > maxModelIds) {
    throw new Error("Model server returned an invalid models list.");
  }
  // The unpaginated request returns the full list. A partial list cannot prove absence.
  if (
    body.links?.next != null ||
    (body.total_count !== undefined && body.total_count !== entries.length)
  ) {
    throw new Error("Model server returned an incomplete models list.");
  }
  const ids: string[] = [];
  for (const entry of entries) {
    const id = entry?.id;
    const inputs = entry?.architecture?.input_modalities;
    const outputs = entry?.architecture?.output_modalities;
    const endpoints = entry?.endpoints;
    if (
      typeof id !== "string" ||
      !/^[\x21-\x7e]{1,256}$/.test(id) ||
      !isStringList(inputs) ||
      !isStringList(outputs) ||
      (endpoints !== undefined && !isStringList(endpoints))
    ) {
      throw new Error("Model server returned an invalid models list.");
    }
    if (
      inputs.includes("text") &&
      outputs.includes("text") &&
      (endpoints === undefined || endpoints.includes("/api/v1/chat/completions"))
    ) {
      ids.push(id);
    }
  }
  return ids;
}
