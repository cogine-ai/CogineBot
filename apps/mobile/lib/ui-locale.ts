import type { UiLocale } from "@rakazo/core/ui-locale";
import { normalizeUiLocale, UI_LOCALES } from "@rakazo/core/ui-locale";

export type { UiLocale } from "@rakazo/core/ui-locale";
export {
  isUiLocale,
  normalizeUiLocale,
  UI_LOCALE_LABELS,
  UI_LOCALE_STORAGE_KEY,
  UI_LOCALES,
} from "@rakazo/core/ui-locale";

/** Every bundled UI locale is selectable on both native platforms. */
export const ACCOUNT_UI_LOCALES = UI_LOCALES;
export type AccountUiLocale = UiLocale;
export function htmlLangForLocale(locale: string): string {
  return locale;
}

export type ResolveUiLocaleOptions = {
  stored?: string | null;
  envDefault?: string | null;
  deviceLanguage?: string | null;
};

/**
 * Order: saved choice → `EXPO_PUBLIC_DEFAULT_UI_LOCALE` → device language → English.
 */
export function resolveUiLocale(options: ResolveUiLocaleOptions = {}): UiLocale {
  if (options.stored) return normalizeUiLocale(options.stored);
  if (options.envDefault) return normalizeUiLocale(options.envDefault);
  if (options.deviceLanguage) return normalizeUiLocale(options.deviceLanguage);
  return "en";
}
