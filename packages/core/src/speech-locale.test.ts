import { describe, expect, it } from "vitest";
import {
  recognitionLanguage,
  speechLocaleTag,
  transcriptionLanguageHint,
} from "./speech-locale.js";

describe("speech language selection", () => {
  it.each([
    ["en", "en-US", "en"],
    ["zh-CN", "zh-CN", "zh"],
    ["pt-BR", "pt-BR", "pt"],
    ["de", "de-DE", "de"],
    ["ru", "ru-RU", "ru"],
    ["ko", "ko-KR", "ko"],
  ])("follows explicit %s over a different device language", (locale, tag, hint) => {
    expect(recognitionLanguage(locale, "it-IT")).toBe(tag);
    expect(transcriptionLanguageHint(locale)).toBe(hint);
  });
  it.each(["zh-TW", "zh-Hant", "nl", "constructor", "unknown"])(
    "does not invent a supported mapping for %s",
    (locale) => {
      expect(speechLocaleTag(locale)).toBeUndefined();
      expect(transcriptionLanguageHint(locale)).toBeUndefined();
      expect(recognitionLanguage(locale, "zh-TW")).toBe("zh-TW");
    },
  );
});
