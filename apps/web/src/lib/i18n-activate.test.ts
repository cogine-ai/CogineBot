import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateUiLocale,
  bootstrapI18n,
  getActiveUiLocale,
  getUiLocalePreference,
  i18n,
  setCatalogLoadersForTests,
  setUiLocale,
} from "./i18n";
import { UI_LOCALE_STORAGE_KEY, UI_LOCALES } from "./ui-locale";

vi.mock("./apply-ui-direction", () => ({
  applyUiDirection: vi.fn(),
}));

function stubLocaleStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: () => null,
    length: 0,
  });
  return store;
}

describe("activateUiLocale", () => {
  beforeEach(() => {
    setCatalogLoadersForTests(null);
    i18n.load("en", {});
    i18n.activate("en");
    vi.unstubAllGlobals();
  });

  it("does not turn the browser's display fallback into an explicit speech preference", async () => {
    stubLocaleStorage();
    vi.stubGlobal("navigator", { language: "zh-TW" });
    setCatalogLoadersForTests(
      Object.fromEntries(
        UI_LOCALES.map((locale) => [locale, async () => ({ messages: {} })]),
      ) as NonNullable<Parameters<typeof setCatalogLoadersForTests>[0]>,
    );
    await bootstrapI18n();
    expect(getActiveUiLocale()).toBe("en");
    expect(getUiLocalePreference()).toBeUndefined();
  });

  it.each(["it-IT", "unknown", "enochian", "   ", "zh-TW", "ZH_hant_HK"])(
    "does not turn unsupported stored %s into a preference through activation",
    async (stored) => {
      const storage = stubLocaleStorage();
      storage.set(UI_LOCALE_STORAGE_KEY, stored);
      vi.stubGlobal("navigator", { language: "de-CH" });
      setCatalogLoadersForTests(
        Object.fromEntries(
          UI_LOCALES.map((locale) => [locale, async () => ({ messages: {} })]),
        ) as NonNullable<Parameters<typeof setCatalogLoadersForTests>[0]>,
      );
      await bootstrapI18n();
      expect(getActiveUiLocale()).toBe("en");
      expect(getUiLocalePreference()).toBeUndefined();
      await activateUiLocale("de");
      expect(getActiveUiLocale()).toBe("de");
      expect(getUiLocalePreference()).toBeUndefined();
      expect(storage.get(UI_LOCALE_STORAGE_KEY)).toBe(stored);
      await setUiLocale("en");
      expect(getUiLocalePreference()).toBe("en");
      expect(storage.get(UI_LOCALE_STORAGE_KEY)).toBe("en");
    },
  );

  it("retains an explicit English choice even when storage is unavailable", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("Private mode");
      },
    });
    vi.stubGlobal("navigator", { language: "zh-TW" });
    setCatalogLoadersForTests(
      Object.fromEntries(
        UI_LOCALES.map((locale) => [locale, async () => ({ messages: {} })]),
      ) as NonNullable<Parameters<typeof setCatalogLoadersForTests>[0]>,
    );
    await setUiLocale("en");
    expect(getUiLocalePreference()).toBe("en");
  });

  it("falls back to English when the preferred catalog fails to load", async () => {
    setCatalogLoadersForTests({
      en: async () => ({ messages: { Settings: "Settings" } }),
      de: async () => {
        throw new Error("de catalog missing");
      },
      ko: async () => ({ messages: { Settings: "설정" } }),
      tr: async () => ({ messages: { Settings: "Ayarlar" } }),
      hi: async () => ({ messages: { Settings: "सेटिंग्स" } }),
      "pt-BR": async () => ({ messages: { Settings: "Configurações" } }),
      "zh-CN": async () => ({ messages: { Settings: "设置" } }),
      es: async () => ({ messages: { Settings: "Configuración" } }),
      ru: async () => ({ messages: { Settings: "Настройки" } }),
      fr: async () => ({ messages: { Settings: "Paramètres" } }),
    });

    const locale = await activateUiLocale("de");
    expect(locale).toBe("en");
    expect(getActiveUiLocale()).toBe("en");
    expect(i18n.locale).toBe("en");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Settings");
  });

  it("falls back to empty English when every catalog fails", async () => {
    setCatalogLoadersForTests({
      en: async () => {
        throw new Error("en missing");
      },
      de: async () => {
        throw new Error("de missing");
      },
      ko: async () => {
        throw new Error("ko missing");
      },
      tr: async () => {
        throw new Error("tr missing");
      },
      hi: async () => {
        throw new Error("hi missing");
      },
      "pt-BR": async () => {
        throw new Error("pt-BR missing");
      },
      "zh-CN": async () => {
        throw new Error("zh-CN missing");
      },
      es: async () => {
        throw new Error("es missing");
      },
      ru: async () => {
        throw new Error("ru missing");
      },
      fr: async () => {
        throw new Error("fr missing");
      },
    });

    const locale = await activateUiLocale("ko");
    expect(locale).toBe("en");
    expect(i18n.locale).toBe("en");
  });

  it("lets the latest locale selection win under concurrency", async () => {
    let resolveDe!: (value: { messages: Record<string, string> }) => void;
    const dePromise = new Promise<{ messages: Record<string, string> }>((resolve) => {
      resolveDe = resolve;
    });

    setCatalogLoadersForTests({
      en: async () => ({ messages: { Settings: "Settings" } }),
      de: async () => dePromise,
      ko: async () => ({ messages: { Settings: "설정" } }),
      tr: async () => ({ messages: { Settings: "Ayarlar" } }),
      hi: async () => ({ messages: { Settings: "सेटिंग्स" } }),
      "pt-BR": async () => ({ messages: { Settings: "Configurações" } }),
      "zh-CN": async () => ({ messages: { Settings: "设置" } }),
      es: async () => ({ messages: { Settings: "Configuración" } }),
      ru: async () => ({ messages: { Settings: "Настройки" } }),
      fr: async () => ({ messages: { Settings: "Paramètres" } }),
    });

    const first = activateUiLocale("de");
    const second = activateUiLocale("ko");
    resolveDe({ messages: { Settings: "Einstellungen" } });

    await expect(first).resolves.toBe("ko");
    await expect(second).resolves.toBe("ko");
    expect(getActiveUiLocale()).toBe("ko");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("설정");
  });

  it("cancels a pending activation when re-selecting the already-active locale", async () => {
    let resolveDe!: (value: { messages: Record<string, string> }) => void;
    const dePromise = new Promise<{ messages: Record<string, string> }>((resolve) => {
      resolveDe = resolve;
    });

    setCatalogLoadersForTests({
      en: async () => ({ messages: { Settings: "Settings" } }),
      de: async () => dePromise,
      ko: async () => ({ messages: { Settings: "설정" } }),
      tr: async () => ({ messages: { Settings: "Ayarlar" } }),
      hi: async () => ({ messages: { Settings: "सेटिंग्स" } }),
      "pt-BR": async () => ({ messages: { Settings: "Configurações" } }),
      "zh-CN": async () => ({ messages: { Settings: "设置" } }),
      es: async () => ({ messages: { Settings: "Configuración" } }),
      ru: async () => ({ messages: { Settings: "Настройки" } }),
      fr: async () => ({ messages: { Settings: "Paramètres" } }),
    });

    await activateUiLocale("en");
    expect(getActiveUiLocale()).toBe("en");

    const pendingDe = activateUiLocale("de");
    const backToEn = activateUiLocale("en");
    resolveDe({ messages: { Settings: "Einstellungen" } });

    await expect(pendingDe).resolves.toBe("en");
    await expect(backToEn).resolves.toBe("en");
    expect(getActiveUiLocale()).toBe("en");
    expect(i18n.locale).toBe("en");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Settings");
  });

  it("does not let a stale setUiLocale fallback overwrite the latest stored locale", async () => {
    const store = stubLocaleStorage();
    let resolveDe!: (value: { messages: Record<string, string> }) => void;
    const dePromise = new Promise<{ messages: Record<string, string> }>((resolve) => {
      resolveDe = resolve;
    });

    setCatalogLoadersForTests({
      en: async () => ({ messages: { Settings: "Settings" } }),
      de: async () => dePromise,
      ko: async () => ({ messages: { Settings: "설정" } }),
      tr: async () => ({ messages: { Settings: "Ayarlar" } }),
      hi: async () => ({ messages: { Settings: "सेटिंग्स" } }),
      "pt-BR": async () => ({ messages: { Settings: "Configurações" } }),
      "zh-CN": async () => ({ messages: { Settings: "设置" } }),
      es: async () => ({ messages: { Settings: "Configuración" } }),
      ru: async () => ({ messages: { Settings: "Настройки" } }),
      fr: async () => ({ messages: { Settings: "Paramètres" } }),
    });

    await activateUiLocale("en");
    const pendingDe = setUiLocale("de");
    const pendingKo = setUiLocale("ko");
    expect(store.get(UI_LOCALE_STORAGE_KEY)).toBe("ko");

    resolveDe({ messages: { Settings: "Einstellungen" } });
    await expect(pendingDe).resolves.toBe("ko");
    await expect(pendingKo).resolves.toBe("ko");
    expect(getActiveUiLocale()).toBe("ko");
    expect(store.get(UI_LOCALE_STORAGE_KEY)).toBe("ko");
    expect(getUiLocalePreference()).toBe("ko");
  });
});
