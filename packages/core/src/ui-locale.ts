export const UI_LOCALES = [
  "en",
  "de",
  "ko",
  "tr",
  "hi",
  "pt-BR",
  "zh-CN",
  "es",
  "ru",
  "fr",
] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

export const UI_LOCALE_STORAGE_KEY = "rakazo.uiLocale";

export const UI_LOCALE_LABELS: Record<UiLocale, string> = {
  en: "English",
  de: "Deutsch",
  ko: "한국어",
  tr: "Türkçe",
  hi: "हिन्दी",
  "pt-BR": "Português (Brasil)",
  "zh-CN": "简体中文",
  es: "Español",
  ru: "Русский",
  fr: "Français",
};

/** Return whether a value is one of the supported UI locales. */
export function isUiLocale(value: string | null | undefined): value is UiLocale {
  return UI_LOCALES.some((locale) => locale === value);
}

/** Normalize BCP-47 tags (`de-DE`, `ko-KR`, `pt-BR`, `zh-CN`, `es-ES`) to a supported UI locale, else `en`. */
export function normalizeUiLocale(raw: string | null | undefined): UiLocale {
  if (!raw) return "en";
  const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "pt" || normalized.startsWith("pt-")) return "pt-BR";
  if (normalized === "es" || normalized.startsWith("es-")) return "es";
  // Simplified Chinese only. Do not fold zh-TW / zh-HK / zh-Hant into zh-CN.
  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh-hans" ||
    normalized === "zh-sg" ||
    normalized.startsWith("zh-hans-") ||
    normalized.startsWith("zh-cn-")
  ) {
    return "zh-CN";
  }
  const primary = normalized.split("-")[0] ?? "";
  return isUiLocale(primary) ? primary : "en";
}
