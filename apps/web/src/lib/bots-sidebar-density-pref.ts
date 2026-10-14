export type BotsSidebarDensity = "comfortable" | "compact";

export const BOTS_SIDEBAR_DENSITY_STORAGE_KEY = "rakazo.botsSidebarDensity";

type DensityStorage = Pick<Storage, "getItem" | "setItem">;

const listeners = new Set<() => void>();
let memoryPreference: BotsSidebarDensity | null = null;

function getLocalStorage(): DensityStorage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function normalizeBotsSidebarDensity(raw: string | null | undefined): BotsSidebarDensity {
  return raw?.trim().toLowerCase() === "compact" ? "compact" : "comfortable";
}

export function readBotsSidebarDensity(
  storage: Pick<Storage, "getItem"> | null = getLocalStorage(),
): BotsSidebarDensity {
  if (!storage) return "comfortable";
  try {
    return normalizeBotsSidebarDensity(storage.getItem(BOTS_SIDEBAR_DENSITY_STORAGE_KEY));
  } catch {
    return "comfortable";
  }
}

export function persistBotsSidebarDensity(
  density: BotsSidebarDensity,
  storage: Pick<Storage, "setItem"> | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(BOTS_SIDEBAR_DENSITY_STORAGE_KEY, normalizeBotsSidebarDensity(density));
  } catch {
    // Keep the in-memory preference when local storage is unavailable or blocked.
  }
}

export function getBotsSidebarDensity(): BotsSidebarDensity {
  return memoryPreference ?? readBotsSidebarDensity();
}

export function setBotsSidebarDensity(density: BotsSidebarDensity): BotsSidebarDensity {
  memoryPreference = normalizeBotsSidebarDensity(density);
  persistBotsSidebarDensity(memoryPreference);
  for (const listener of listeners) listener();
  return memoryPreference;
}

export function subscribeBotsSidebarDensity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
