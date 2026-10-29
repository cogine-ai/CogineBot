import { describe, expect, it } from "vitest";
import {
  normalizeUiLocale,
  persistUiLocale,
  resolveUiLocale,
  resolveUiLocalePreference,
  UI_LOCALE_STORAGE_KEY,
} from "./ui-locale";

describe("normalizeUiLocale", () => {
  it("maps regional tags onto supported locales", () => {
    expect(normalizeUiLocale("de-DE")).toBe("de");
    expect(normalizeUiLocale("ko-KR")).toBe("ko");
    expect(normalizeUiLocale("en-US")).toBe("en");
    expect(normalizeUiLocale("pt-BR")).toBe("pt-BR");
    expect(normalizeUiLocale("pt")).toBe("pt-BR");
    expect(normalizeUiLocale("hi-IN")).toBe("hi");
    expect(normalizeUiLocale("DE")).toBe("de");
    expect(normalizeUiLocale("es")).toBe("es");
    expect(normalizeUiLocale("es-ES")).toBe("es");
    expect(normalizeUiLocale("es-MX")).toBe("es");
    expect(normalizeUiLocale("es-419")).toBe("es");
    expect(normalizeUiLocale("ES")).toBe("es");
    expect(normalizeUiLocale("es_AR")).toBe("es");
    expect(normalizeUiLocale("ru-RU")).toBe("ru");
    expect(normalizeUiLocale("ru_KZ")).toBe("ru");
    expect(normalizeUiLocale(" RU ")).toBe("ru");
    expect(normalizeUiLocale("fr")).toBe("fr");
    expect(normalizeUiLocale("fr-FR")).toBe("fr");
    expect(normalizeUiLocale("fr-CA")).toBe("fr");
    expect(normalizeUiLocale("FR")).toBe("fr");
    expect(normalizeUiLocale("fr_BE")).toBe("fr");
    expect(normalizeUiLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeUiLocale("zh")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans-SG")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-SG")).toBe("zh-CN");
    expect(normalizeUiLocale("zh_cn")).toBe("zh-CN");
    expect(normalizeUiLocale("ZH-cn")).toBe("zh-CN");
    expect(normalizeUiLocale(" zh-CN ")).toBe("zh-CN");
    expect(normalizeUiLocale("zh_Hans_CN")).toBe("zh-CN");
  });

  it("does not fold Traditional Chinese into Simplified", () => {
    expect(normalizeUiLocale("zh-TW")).toBe("en");
    expect(normalizeUiLocale("zh-HK")).toBe("en");
    expect(normalizeUiLocale("zh-MO")).toBe("en");
    expect(normalizeUiLocale("zh-Hant")).toBe("en");
    expect(normalizeUiLocale("zh-Hant-TW")).toBe("en");
    expect(normalizeUiLocale("zh-Hant-HK")).toBe("en");
  });

  it("falls back to English for unknown locales", () => {
    expect(normalizeUiLocale("he-IL")).toBe("en");
    expect(normalizeUiLocale("")).toBe("en");
    expect(normalizeUiLocale(null)).toBe("en");
  });
});

describe("resolveUiLocale", () => {
  it("prefers the saved choice over env and navigator", () => {
    expect(
      resolveUiLocale({
        stored: "ko",
        envDefault: "de",
        navigatorLanguage: "en-US",
      }),
    ).toBe("ko");
  });

  it("uses VITE_DEFAULT_UI_LOCALE when nothing is saved", () => {
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: "de-AT",
        navigatorLanguage: "ko-KR",
      }),
    ).toBe("de");
  });

  it("uses navigator.language next, then English", () => {
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: "ko-KR",
      }),
    ).toBe("ko");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: "zh-CN",
      }),
    ).toBe("zh-CN");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: "es-MX",
      }),
    ).toBe("es");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: "ru-RU",
      }),
    ).toBe("ru");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: "fr-FR",
      }),
    ).toBe("fr");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: null,
      }),
    ).toBe("en");
  });

  it("reads localStorage via the storage helper", () => {
    const storage = {
      getItem: (key: string) => (key === UI_LOCALE_STORAGE_KEY ? "de" : null),
    };
    expect(resolveUiLocale({ storage, envDefault: null, navigatorLanguage: null })).toBe("de");
  });
});

describe("persistUiLocale", () => {
  it("writes the storage key", () => {
    const store = new Map<string, string>();
    persistUiLocale("ko", {
      setItem: (key, value) => {
        store.set(key, value);
      },
    });
    expect(store.get(UI_LOCALE_STORAGE_KEY)).toBe("ko");
  });
});

describe("explicit UI locale preference", () => {
  it("distinguishes a chosen/configured English UI from browser normalization", () => {
    expect(
      resolveUiLocalePreference({ stored: "en", envDefault: "de", navigatorLanguage: "zh-TW" }),
    ).toBe("en");
    expect(
      resolveUiLocalePreference({ stored: null, envDefault: "en", navigatorLanguage: "en-GB" }),
    ).toBe("en");
    expect(
      resolveUiLocalePreference({ stored: null, envDefault: null, navigatorLanguage: "zh-TW" }),
    ).toBeUndefined();
    expect(
      resolveUiLocalePreference({ stored: null, envDefault: null, navigatorLanguage: "en-GB" }),
    ).toBeUndefined();
    expect(resolveUiLocale({ stored: null, envDefault: null, navigatorLanguage: "zh-TW" })).toBe(
      "en",
    );
  });
});

describe("configured speech preference provenance", () => {
  const cases = [
    [null, undefined],
    ["", undefined],
    ["   ", undefined],
    ["unknown", undefined],
    ["enochian", undefined],
    ["it-IT", undefined],
    ["zh-TW", undefined],
    ["zh-Hant-HK", undefined],
    ["en", "en"],
    [" EN_gb ", "en"],
    ["en-US", "en"],
    ["DE_ch", "de"],
    ["KO_kr", "ko"],
    ["tr-TR", "tr"],
    ["hi-IN", "hi"],
    ["pt_PT", "pt-BR"],
    ["ZH_hans_CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["ES_ar", "es"],
    ["ru_KZ", "ru"],
    ["FR_ca", "fr"],
  ] as const;

  it.each(cases)("classifies stored %s without changing display normalization", (raw, expected) => {
    const options = { stored: raw, envDefault: null, navigatorLanguage: "de-CH" };
    expect(resolveUiLocalePreference(options)).toBe(expected);
    expect(resolveUiLocale(options)).toBe(raw ? normalizeUiLocale(raw) : "de");
  });

  it.each(cases)(
    "classifies configured %s without changing display normalization",
    (raw, expected) => {
      const options = {
        stored: null,
        env: { VITE_DEFAULT_UI_LOCALE: raw ?? "" },
        navigatorLanguage: "de-CH",
      };
      expect(resolveUiLocalePreference(options)).toBe(expected);
      expect(resolveUiLocale(options)).toBe(raw?.trim() ? normalizeUiLocale(raw) : "de");
      expect(resolveUiLocalePreference({ ...options, envDefault: raw })).toBe(expected);
      expect(resolveUiLocale({ ...options, envDefault: raw })).toBe(
        raw ? normalizeUiLocale(raw) : "de",
      );
    },
  );

  it("does not promote an ignored environment default past an unsupported saved value", () => {
    const options = { stored: "it-IT", envDefault: "de", navigatorLanguage: "ko-KR" };
    expect(resolveUiLocale(options)).toBe("en");
    expect(resolveUiLocalePreference(options)).toBeUndefined();
  });

  it("uses the configured preference after an empty or inaccessible stored value", () => {
    expect(resolveUiLocalePreference({ stored: "", envDefault: "EN_gb" })).toBe("en");
    expect(
      resolveUiLocalePreference({
        storage: {
          getItem() {
            throw new Error("Unavailable");
          },
        },
        envDefault: "zh_Hans_CN",
      }),
    ).toBe("zh-CN");
  });
});
