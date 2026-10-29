import {
  recognitionLanguage as recognitionLanguageForUi,
  transcriptionLanguageHint,
} from "@rakazo/core";
import { getDeviceSpeechLocale, getUiLocalePreference } from "./i18n";

export function recognitionLanguage(): string {
  return recognitionLanguageForUi(getUiLocalePreference() ?? "", getDeviceSpeechLocale());
}

export function transcriptionLanguage(): string | undefined {
  const preference = getUiLocalePreference();
  if (preference !== undefined) return transcriptionLanguageHint(preference);
  const device = getDeviceSpeechLocale() ?? "";
  return transcriptionLanguageHint(device) ?? transcriptionLanguageHint(device.split("-")[0] ?? "");
}
