import type { UiLocale } from "@rakazo/core/ui-locale";
import { normalizeUiLocale, UI_LOCALE_STORAGE_KEY } from "@rakazo/core/ui-locale";

export type { UiLocale } from "@rakazo/core/ui-locale";
export {
  isUiLocale,
  normalizeUiLocale,
  UI_LOCALE_LABELS,
  UI_LOCALE_STORAGE_KEY,
  UI_LOCALES,
} from "@rakazo/core/ui-locale";

function readStoredLocale(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(UI_LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readEnvDefault(env: { VITE_DEFAULT_UI_LOCALE?: string } | undefined): string | null {
  const value = env?.VITE_DEFAULT_UI_LOCALE;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNavigatorLanguage(
  nav: Pick<Navigator, "language" | "languages"> | null | undefined,
): string | null {
  if (!nav) return null;
  if (typeof nav.language === "string" && nav.language) return nav.language;
  const first = nav.languages?.[0];
  return typeof first === "string" && first ? first : null;
}

export type ResolveUiLocaleOptions = {
  stored?: string | null;
  envDefault?: string | null;
  navigatorLanguage?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
  env?: { VITE_DEFAULT_UI_LOCALE?: string };
  navigator?: Pick<Navigator, "language" | "languages"> | null;
};

function readUiLocaleChoice(options: ResolveUiLocaleOptions): string | null {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStoredLocale(
          options.storage ?? (typeof localStorage !== "undefined" ? localStorage : null),
        );
  if (stored) return stored;

  const envDefault =
    options.envDefault !== undefined
      ? options.envDefault
      : readEnvDefault(
          options.env ??
            (typeof import.meta !== "undefined"
              ? {
                  VITE_DEFAULT_UI_LOCALE: (import.meta as ImportMeta).env?.VITE_DEFAULT_UI_LOCALE,
                }
              : undefined),
        );
  return envDefault || null;
}

/** A supported saved/configured choice, distinct from an English display fallback. */
export function resolveUiLocalePreference(
  options: ResolveUiLocaleOptions = {},
): UiLocale | undefined {
  const choice = readUiLocaleChoice(options);
  if (!choice) return undefined;
  const locale = normalizeUiLocale(choice);
  return locale !== "en" || /^en(?:[-_]|$)/i.test(choice.trim()) ? locale : undefined;
}

/** Saved choice → configured default → browser language → English. */
export function resolveUiLocale(options: ResolveUiLocaleOptions = {}): UiLocale {
  const choice = readUiLocaleChoice(options);
  if (choice) return normalizeUiLocale(choice);
  const navigatorLanguage =
    options.navigatorLanguage !== undefined
      ? options.navigatorLanguage
      : readNavigatorLanguage(
          options.navigator ?? (typeof navigator !== "undefined" ? navigator : null),
        );
  if (navigatorLanguage) return normalizeUiLocale(navigatorLanguage);

  return "en";
}

export function persistUiLocale(
  locale: UiLocale,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null,
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore quota / private-mode failures; in-memory locale still applies.
  }
}
