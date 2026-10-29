import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { transcriptionLanguageHint } from "@rakazo/core";
import { getLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as dictation from "./dictation";
import { bootstrapI18n, getActiveUiLocale, setUiLocale } from "./i18n";
import { recognitionLanguage, transcriptionLanguage } from "./speech-locale";
import type { UiLocale } from "./ui-locale";

vi.mock("expo-localization", () => ({ getLocales: vi.fn(() => [{ languageTag: "en-US" }]) }));
vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
vi.mock("./ui-direction", () => ({ applyMobileUiDirection: vi.fn() }));
afterEach(() => {
  dictation.stop();
  dictation.setSpeechRecognizer(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const testFileUrl = import.meta.url;
const source = readFileSync(new URL("./call-session.ts", testFileUrl), "utf8");
const start = source.indexOf("async function transcribeClip(");
const end = source.indexOf("\nasync function sendHeard(", start);
if (start < 0 || end < 0) throw new Error("Hosted call transcription function not found");
const body = stripTypeScriptTypes(source.slice(start, end));

function fixture(locale: string, status = 200, actualLocale = false) {
  const requestContext = {
    apiBase: "https://api.example.test",
    headers: { authorization: "Bearer synthetic-session", "x-rakazo-space-id": "space-captured" },
  };
  const captureApiRequestContext = vi.fn(async () => requestContext);
  const noteSubscriptionRequired = vi.fn();
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json(status === 200 ? { text: "Heard" } : { error: "Subscription required" }, {
      status,
    }),
  );
  const env = {
    captureApiRequestContext,
    noteSubscriptionRequired,
    getActiveUiLocale: actualLocale ? getActiveUiLocale : () => locale,
    transcriptionLanguageHint,
    transcriptionLanguage: actualLocale
      ? transcriptionLanguage
      : () => transcriptionLanguageHint(locale),
    fetch,
    errorText: (text: string) => text,
    t: (text: string) => text,
  };
  const transcribe = new Function(...Object.keys(env), `${body}; return transcribeClip;`)(
    ...Object.values(env),
  ) as (clip: { base64: string; mimeType: string }, signal: AbortSignal) => Promise<string>;
  return { transcribe, requestContext, fetch, noteSubscriptionRequired };
}

describe("actual hosted mobile transcription body", () => {
  it.each([
    ["en", "en"],
    ["de", "de"],
    ["zh-CN", "zh"],
    ["pt-BR", "pt"],
    ["zh-TW", undefined],
    ["unknown", undefined],
  ])("uses only the shared known primary hint for %s", async (locale, language) => {
    const value = fixture(locale!);
    const abort = new AbortController();
    await expect(
      value.transcribe({ base64: "AQ==", mimeType: "audio/m4a" }, abort.signal),
    ).resolves.toBe("Heard");
    const [url, init] = value.fetch.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/api/voice/transcribe");
    expect(JSON.parse(init!.body as string)).toEqual({
      audioBase64: "AQ==",
      mimeType: "audio/m4a",
      ...(language ? { language } : {}),
    });
    expect(init!.headers).toMatchObject(value.requestContext.headers);
    expect(init!.signal).toBe(abort.signal);
  });
  it.each([false, true])(
    "preserves the captured402 projection and cancellation boundary: %s",
    async (cancelled) => {
      const value = fixture("en", 402);
      const abort = new AbortController();
      if (cancelled) abort.abort();
      await expect(
        value.transcribe({ base64: "AQ==", mimeType: "audio/m4a" }, abort.signal),
      ).rejects.toThrow("Subscription required");
      expect(value.noteSubscriptionRequired).toHaveBeenCalledTimes(cancelled ? 0 : 1);
      if (!cancelled)
        expect(value.noteSubscriptionRequired).toHaveBeenCalledWith(value.requestContext);
    },
  );
});

type LocaleCase = {
  device: string | null;
  stored?: string;
  env?: string;
  ui: UiLocale;
  recognition: string;
  hint?: string;
  select?: UiLocale;
  readFailure?: boolean;
  writeFailure?: boolean;
  localizationFailure?: boolean;
};
const localeCases: LocaleCase[] = [
  { device: "es-ES", ui: "en", recognition: "es-ES", hint: "es" },
  { device: "it-IT", ui: "en", recognition: "it-IT", hint: undefined },
  { device: "fr-CA", ui: "en", recognition: "fr-CA", hint: "fr" },
  { device: "pt-BR", ui: "en", recognition: "pt-BR", hint: "pt" },
  { device: "en-GB", ui: "en", recognition: "en-GB", hint: "en" },
  { device: "de-CH", ui: "de", recognition: "de-CH", hint: "de" },
  { device: "zh-TW", ui: "en", recognition: "zh-TW", hint: undefined },
  { device: "zh-Hant-HK", ui: "en", recognition: "zh-Hant-HK", hint: undefined },
  { device: "unknown", ui: "en", recognition: "unknown", hint: undefined },
  { device: "zh-TW", stored: "en", ui: "en", recognition: "en-US", hint: "en" },
  { device: "it-IT", stored: "en", ui: "en", recognition: "en-US", hint: "en" },
  { device: "zh-TW", stored: "zh-CN", ui: "zh-CN", recognition: "zh-CN", hint: "zh" },
  { device: "it-IT", stored: "de-CH", ui: "de", recognition: "de-DE", hint: "de" },
  { device: "it-IT", env: "en", ui: "en", recognition: "en-US", hint: "en" },
  { device: "it-IT", stored: "zh-CN", env: "en", ui: "zh-CN", recognition: "zh-CN", hint: "zh" },
  { device: "it-IT", select: "en", writeFailure: true, ui: "en", recognition: "en-US", hint: "en" },
  { device: "es-ES", readFailure: true, ui: "en", recognition: "es-ES", hint: "es" },
  { device: "it-IT", localizationFailure: true, ui: "en", recognition: "it-IT", hint: undefined },
  { device: null, ui: "en", recognition: "en-US", hint: undefined },
  { device: "pt-PT", ui: "en", recognition: "pt-PT", hint: undefined },
  { device: "it-IT", stored: "es-ES", ui: "en", recognition: "it-IT", hint: undefined },
  { device: "es-ES", env: "it-IT", ui: "en", recognition: "es-ES", hint: "es" },
  { device: "zh-TW", stored: "zh-TW", ui: "en", recognition: "zh-TW", hint: undefined },
  { device: "it-IT", stored: "en-GB", ui: "en", recognition: "en-US", hint: "en" },
  { device: "zh-TW", stored: "   ", env: "de", ui: "en", recognition: "zh-TW", hint: undefined },
  { device: "it-IT", stored: "enochian", ui: "en", recognition: "it-IT", hint: undefined },
  { device: "es-ES", stored: "unknown", ui: "en", recognition: "es-ES", hint: "es" },
  { device: "it-IT", stored: " EN_gb ", ui: "en", recognition: "en-US", hint: "en" },
  { device: "it-IT", stored: "ZH_hans_CN", ui: "zh-CN", recognition: "zh-CN", hint: "zh" },
  { device: "zh-TW", env: "   ", ui: "en", recognition: "zh-TW", hint: undefined },
  { device: "it-IT", env: "enochian", ui: "en", recognition: "it-IT", hint: undefined },
  { device: "it-IT", env: "EN_gb", ui: "en", recognition: "en-US", hint: "en" },
];

describe.each(["hosted", "device"] as const)(
  "actual mobile locale bootstrap through %s call input",
  (path) => {
    it.each(localeCases)(
      "preserves provenance for $device / stored $stored / env $env / select $select",
      async (input) => {
        vi.stubEnv("EXPO_PUBLIC_DEFAULT_UI_LOCALE", input.env ?? "");
        vi.mocked(SecureStore.getItemAsync)
          .mockReset()
          .mockResolvedValue(input.stored ?? null);
        vi.mocked(SecureStore.setItemAsync).mockReset().mockResolvedValue();
        if (input.readFailure)
          vi.mocked(SecureStore.getItemAsync).mockRejectedValue(new Error("Locked"));
        if (input.writeFailure)
          vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("Locked"));
        vi.mocked(getLocales)
          .mockReset()
          .mockReturnValue(
            (input.device ? [{ languageTag: input.device }] : []) as unknown as ReturnType<
              typeof getLocales
            >,
          );
        if (input.localizationFailure || input.device === null) {
          vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
            resolvedOptions: () => ({ locale: input.device ?? "" }),
          } as unknown as Intl.DateTimeFormat);
          if (input.localizationFailure)
            vi.mocked(getLocales).mockImplementation(() => {
              throw new Error("Unavailable");
            });
        }
        await bootstrapI18n();
        if (input.select) await setUiLocale(input.select);
        expect(getActiveUiLocale()).toBe(input.ui);
        const signal = new AbortController().signal;
        if (path === "hosted") {
          const value = fixture("", 200, true);
          await expect(
            value.transcribe({ base64: "AQ==", mimeType: "audio/m4a" }, signal),
          ).resolves.toBe("Heard");
          const request = JSON.parse(value.fetch.mock.calls[0]![1]!.body as string);
          expect(request).toEqual({
            audioBase64: "AQ==",
            mimeType: "audio/m4a",
            ...(input.hint ? { language: input.hint } : {}),
          });
          expect(value.fetch.mock.calls[0]![1]!.signal).toBe(signal);
          expect(value.fetch.mock.calls[0]![1]!.headers).toMatchObject(
            value.requestContext.headers,
          );
        } else {
          const nativeStart = vi.fn();
          dictation.setSpeechRecognizer({
            start: nativeStart,
            stop() {},
            abort() {},
            isRecognitionAvailable: () => true,
            requestPermissionsAsync: async () => ({ granted: true }),
            addListener: () => ({ remove() {} }),
          });
          const dictateStart = source.indexOf("async function dictateTurn("),
            dictateEnd = source.indexOf("/** Records one hands-free turn", dictateStart);
          if (dictateStart < 0 || dictateEnd < 0)
            throw new Error("Actual call device recognizer boundary not found");
          const dictate = new Function(
            "dictation",
            "recognitionLanguage",
            `${stripTypeScriptTypes(source.slice(dictateStart, dictateEnd))}; return dictateTurn;`,
          )(dictation, recognitionLanguage);
          await expect(dictate({ onFinal() {} }, signal)).resolves.toBe(true);
          expect(nativeStart).toHaveBeenCalledWith({
            lang: input.recognition,
            interimResults: true,
            continuous: true,
          });
        }
      },
    );
  },
);
