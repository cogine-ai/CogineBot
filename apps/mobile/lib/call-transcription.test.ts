import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { transcriptionLanguageHint } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";

const testFileUrl = import.meta.url;
const source = readFileSync(new URL("./call-session.ts", testFileUrl), "utf8");
const start = source.indexOf("async function transcribeClip(");
const end = source.indexOf("\nasync function sendHeard(", start);
if (start < 0 || end < 0) throw new Error("Hosted call transcription function not found");
const body = stripTypeScriptTypes(source.slice(start, end));

function fixture(locale: string, status = 200) {
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
    getActiveUiLocale: () => locale,
    transcriptionLanguageHint,
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
