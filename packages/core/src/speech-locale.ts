/** BCP-47 recognition tags for the app's supported UI languages. */
const SPEECH_LOCALE_TAGS: Readonly<Record<string, string>> = {
  en: "en-US",
  de: "de-DE",
  es: "es-ES",
  fr: "fr-FR",
  hi: "hi-IN",
  ko: "ko-KR",
  "pt-BR": "pt-BR",
  ru: "ru-RU",
  tr: "tr-TR",
  "zh-CN": "zh-CN",
};

export function speechLocaleTag(locale: string): string | undefined {
  return Object.hasOwn(SPEECH_LOCALE_TAGS, locale) ? SPEECH_LOCALE_TAGS[locale] : undefined;
}

/** An explicit UI choice wins, including English. Unknown languages keep device detection. */
export function recognitionLanguage(locale: string, deviceLanguage?: string): string {
  return speechLocaleTag(locale) ?? (deviceLanguage || "en-US");
}

export function transcriptionLanguageHint(locale: string): string | undefined {
  return speechLocaleTag(locale)?.split("-")[0]?.toLowerCase();
}
