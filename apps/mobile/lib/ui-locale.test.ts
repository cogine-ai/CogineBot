import { describe, expect, it } from "vitest";
import {
  ACCOUNT_UI_LOCALES,
  htmlLangForLocale,
  isUiLocale,
  normalizeUiLocale,
  resolveUiLocale,
  UI_LOCALE_LABELS,
  UI_LOCALES,
} from "./ui-locale";

describe("mobile UI locales", () => {
  it("offers the ten Web languages without a picker-only subset", () => {
    expect(UI_LOCALES).toEqual(["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru", "fr"]);
    expect(ACCOUNT_UI_LOCALES).toEqual(UI_LOCALES);
    expect(Object.keys(UI_LOCALE_LABELS).sort()).toEqual([...UI_LOCALES].sort());
    for (const locale of UI_LOCALES) expect(isUiLocale(locale)).toBe(true);
    expect(isUiLocale("ja")).toBe(false);
  });
});

describe("normalizeUiLocale", () => {
  it.each([
    ["en-US", "en"],
    ["DE_ch", "de"],
    ["KO_kr", "ko"],
    ["tr-TR", "tr"],
    ["hi-IN", "hi"],
    ["pt_PT", "pt-BR"],
    ["pt", "pt-BR"],
    ["pt-BR", "pt-BR"],
    ["zh", "zh-CN"],
    ["ZH_hans_CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
    [" es-419 ", "es"],
    ["ru_KZ", "ru"],
    ["FR_ca", "fr"],
  ])("normalizes %s to %s", (tag, expected) => {
    expect(normalizeUiLocale(tag)).toBe(expected);
  });

  it.each([
    "zh-TW",
    "zh-HK",
    "zh-MO",
    "zh-Hant",
    "zh-Hant-TW",
    "zh_Hant_HK",
    "ja-JP",
    "unknown",
    "",
    null,
    undefined,
  ])("uses English for unsupported %s without silently choosing Simplified Chinese", (tag) =>
    expect(normalizeUiLocale(tag)).toBe("en"),
  );
});

describe("htmlLangForLocale", () => {
  it("keeps Simplified Chinese on zh-CN", () => {
    expect(htmlLangForLocale("zh-CN")).toBe("zh-CN");
    expect(htmlLangForLocale("en")).toBe("en");
  });
});

describe("resolveUiLocale", () => {
  it("prefers the saved choice over env and device language", () => {
    expect(
      resolveUiLocale({
        stored: "zh-CN",
        envDefault: "zh-CN",
        deviceLanguage: "en-US",
      }),
    ).toBe("zh-CN");
  });

  it("uses the env default, then device language, then English", () => {
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: "zh-CN",
        deviceLanguage: "en-US",
      }),
    ).toBe("zh-CN");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        deviceLanguage: "zh-CN",
      }),
    ).toBe("zh-CN");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        deviceLanguage: null,
      }),
    ).toBe("en");
  });
});
