import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOTS_SIDEBAR_DENSITY_STORAGE_KEY,
  getBotsSidebarDensity,
  normalizeBotsSidebarDensity,
  persistBotsSidebarDensity,
  readBotsSidebarDensity,
  setBotsSidebarDensity,
  subscribeBotsSidebarDensity,
} from "./bots-sidebar-density-pref";

beforeEach(() => {
  vi.stubGlobal("localStorage", undefined);
  setBotsSidebarDensity("comfortable");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("bot sidebar density preference", () => {
  it("defaults to Comfortable and accepts only Compact as the compact value", () => {
    expect(BOTS_SIDEBAR_DENSITY_STORAGE_KEY).toBe("rakazo.botsSidebarDensity");
    expect(normalizeBotsSidebarDensity(null)).toBe("comfortable");
    expect(normalizeBotsSidebarDensity("unknown")).toBe("comfortable");
    expect(normalizeBotsSidebarDensity(" COMPACT ")).toBe("compact");
    expect(normalizeBotsSidebarDensity("comfortable")).toBe("comfortable");
    expect(readBotsSidebarDensity()).toBe("comfortable");
  });

  it("reads a saved choice and falls back for invalid stored values", () => {
    expect(readBotsSidebarDensity({ getItem: () => "compact" })).toBe("compact");
    expect(readBotsSidebarDensity({ getItem: () => "unexpected" })).toBe("comfortable");
    expect(readBotsSidebarDensity({ getItem: () => null })).toBe("comfortable");
  });

  it("updates subscribers and persists a choice", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    const listener = vi.fn();
    const unsubscribe = subscribeBotsSidebarDensity(listener);

    expect(getBotsSidebarDensity()).toBe("comfortable");
    expect(setBotsSidebarDensity("compact")).toBe("compact");
    expect(getBotsSidebarDensity()).toBe("compact");
    expect(store.get(BOTS_SIDEBAR_DENSITY_STORAGE_KEY)).toBe("compact");
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    setBotsSidebarDensity("comfortable");
    expect(store.get(BOTS_SIDEBAR_DENSITY_STORAGE_KEY)).toBe("comfortable");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("falls back safely when storage is unavailable or blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readBotsSidebarDensity(blocked)).toBe("comfortable");
    expect(() => persistBotsSidebarDensity("compact", blocked)).not.toThrow();
    expect(() => setBotsSidebarDensity("compact")).not.toThrow();
    expect(getBotsSidebarDensity()).toBe("compact");
  });
});
