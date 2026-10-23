import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_VOICE_AUDIO_BYTES, Speaker, VOICE_RESPONSE_TIMEOUT_MS } from "./tts.js";

const target = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("./rpc.js", async (original) => ({
  ...(await original<typeof import("./rpc.js")>()),
  rpc: { voice: { prepare: target.prepare } },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubSelectedSpace(id: string) {
  const store = new Map<string, string>([["rakazo:space-id", id]]);
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("localStorage", localStorage);
  return (next: string) => store.set("rakazo:space-id", next);
}

function controlledAudio() {
  const instances: Array<{ src: string; paused: boolean; onended: (() => void) | null }> = [];
  vi.stubGlobal(
    "Audio",
    class {
      src: string;
      paused = true;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(src: string) {
        this.src = src;
        instances.push(this);
      }
      play() {
        this.paused = false;
        return Promise.resolve();
      }
      pause() {
        this.paused = true;
      }
    },
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  );
  return instances;
}

describe("Speaker", () => {
  it("keeps an unbound settings sample on the selected Space", async () => {
    stubSelectedSpace("space-a");
    target.prepare.mockResolvedValue({ ready: true, utterances: [] });
    await new Speaker().speak("Sample", { spaceId: null });
    expect(target.prepare.mock.lastCall?.[1].context.spaceId).toBe("space-a");
  });
  it("stops only the sample owned by an aborted settings lifetime", async () => {
    const audios = controlledAudio();
    const speaker = new Speaker();
    vi.spyOn(
      speaker as unknown as { prepare: () => Promise<string[]> },
      "prepare",
    ).mockResolvedValue(["Sample"]);
    const lifetime = new AbortController();
    const sample = speaker.speak("Sample", { spaceId: "space-b", signal: lifetime.signal });
    await vi.waitFor(() => expect(audios).toHaveLength(1));
    expect(audios[0]?.paused).toBe(false);
    lifetime.abort();
    await sample;
    expect(audios[0]?.paused).toBe(true);
    expect(speaker.state.status).toBe("idle");
  });

  it("does not let an old sample lifetime stop newer thread playback", async () => {
    const audios = controlledAudio();
    const speaker = new Speaker();
    vi.spyOn(
      speaker as unknown as { prepare: () => Promise<string[]> },
      "prepare",
    ).mockResolvedValue(["Sample"]);
    const lifetime = new AbortController();
    const sample = speaker.speak("Sample", { spaceId: "space-b", signal: lifetime.signal });
    await vi.waitFor(() => expect(audios).toHaveLength(1));
    const thread = speaker.speak("Thread reply", { messageId: "new-thread-message" });
    await vi.waitFor(() => expect(audios).toHaveLength(2));
    lifetime.abort();
    expect(audios[1]?.paused).toBe(false);
    expect(speaker.state).toMatchObject({ status: "speaking", messageId: "new-thread-message" });
    audios[1]?.onended?.();
    await Promise.all([sample, thread]);
  });

  it("rejects a stale sample intent without interrupting existing playback", async () => {
    const audios = controlledAudio();
    const speaker = new Speaker();
    vi.spyOn(
      speaker as unknown as { prepare: () => Promise<string[]> },
      "prepare",
    ).mockResolvedValue(["Sample"]);
    const thread = speaker.speak("Thread reply", { messageId: "current" });
    await vi.waitFor(() => expect(audios).toHaveLength(1));
    const expired = new AbortController();
    expired.abort();
    await speaker.speak("Old sample", { signal: expired.signal });
    expect(audios[0]?.paused).toBe(false);
    expect(speaker.state.messageId).toBe("current");
    audios[0]?.onended?.();
    await thread;
  });
  it("prepares and renders an explicit Space sample without changing the selected Space", async () => {
    stubSelectedSpace("space-a");
    target.prepare.mockResolvedValue({ ready: true, utterances: ["Hello."] });
    const fetchMock = vi.fn(
      async (_url: string, _options?: RequestInit) => new Response(new Uint8Array([1, 2, 3])),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "Audio",
      class {
        src = "";
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        play() {
          queueMicrotask(() => this.onended?.());
          return Promise.resolve();
        }
        pause() {}
      },
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    await new Speaker().speak("Hello.", { spaceId: "space-b" });
    expect(target.prepare.mock.lastCall?.[1].context.spaceId).toBe("space-b");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-rakazo-space-id")).toBe(
      "space-b",
    );
    expect(window.localStorage.getItem("rakazo:space-id")).toBe("space-a");
  });
  it("interrupting before audio arrives leaves the speaker idle", async () => {
    const speaker = new Speaker();
    vi.spyOn(
      speaker as unknown as { prepare: () => Promise<string[]> },
      "prepare",
    ).mockImplementation(() => new Promise(() => undefined));
    const pending = speaker.speak("Hello there.", { messageId: "m1" });
    speaker.stop();
    await pending;
    expect(speaker.state.status).toBe("idle");
  });

  it("resolves with an error snapshot instead of rejecting", async () => {
    const speaker = new Speaker();
    vi.spyOn(
      speaker as unknown as { prepare: () => Promise<string[]> },
      "prepare",
    ).mockRejectedValue(new Error("ElevenLabs rejected that key."));
    await expect(speaker.speak("Hi there.")).resolves.toBeUndefined();
    expect(speaker.state.error).toBe("ElevenLabs rejected that key.");
  });

  it("keeps speak requests in the space where playback started", async () => {
    const changeSelectedSpace = stubSelectedSpace("space-support");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      blob: async () => new Blob(["audio"]),
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "Audio",
      class {
        src = "";
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        play() {
          queueMicrotask(() => this.onended?.());
          return Promise.resolve();
        }
        pause() {}
      },
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const speaker = new Speaker();
    const prepare = vi
      .spyOn(
        speaker as unknown as {
          prepare: (
            text: string,
            opts: unknown,
            signal: AbortSignal,
            spaceId: string | null,
          ) => Promise<string[]>;
        },
        "prepare",
      )
      .mockImplementation(async () => {
        changeSelectedSpace("space-other");
        return ["Hello."];
      });
    await speaker.speak("Hello.", { messageId: "m1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/speak",
      expect.objectContaining({ credentials: "include" }),
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-rakazo-space-id")).toBe("space-support");
    expect(headers.get("content-type")).toBe("application/json");
    expect(prepare.mock.calls[0]?.[3]).toBe("space-support");
  });

  it("rejects oversized audio without waiting for response cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: { "content-length": String(MAX_VOICE_AUDIO_BYTES + 1) },
          }),
      ),
    );
    const speaker = new Speaker();
    vi.spyOn(
      speaker as unknown as { prepare: () => Promise<string[]> },
      "prepare",
    ).mockResolvedValue(["Hello."]);

    await expect(speaker.speak("Hello.")).resolves.toBeUndefined();

    expect(speaker.state.error).toBe("Voice response is too large.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("times out while a voice response body is stalled", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull: () => new Promise<void>(() => undefined),
            }),
          ),
      ),
    );
    const speaker = new Speaker();
    vi.spyOn(
      speaker as unknown as { prepare: () => Promise<string[]> },
      "prepare",
    ).mockResolvedValue(["Hello."]);

    const pending = speaker.speak("Hello.");
    await vi.advanceTimersByTimeAsync(VOICE_RESPONSE_TIMEOUT_MS);
    await pending;

    expect(speaker.state.error).toBe("Voice request timed out.");
  });
});
