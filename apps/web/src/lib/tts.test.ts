import { afterEach, describe, expect, it, vi } from "vitest";
import { selectSpace, subscribeSubscriptionRequired, synchronizeRpcSession } from "./rpc.js";
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

function controlledAudio(play?: () => Promise<void>) {
  const instances: Array<{
    src: string;
    paused: boolean;
    onended: (() => void) | null;
    onerror: (() => void) | null;
    ontimeupdate: (() => void) | null;
  }> = [];
  vi.stubGlobal(
    "Audio",
    class {
      src: string;
      paused = true;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeupdate: (() => void) | null = null;
      constructor(src: string) {
        this.src = src;
        instances.push(this);
      }
      play() {
        this.paused = false;
        return play?.() ?? Promise.resolve();
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("Speaker", () => {
  it.each(["ready", "error"])(
    "releases its preparation when the remote audio request finishes %s for an expired caller",
    async (outcome) => {
      const audios = controlledAudio();
      const response = deferred<Response>();
      const fetchMock = vi.fn(() => response.promise);
      vi.stubGlobal("fetch", fetchMock);
      target.prepare.mockResolvedValue({ ready: true, utterances: ["Sample"] });
      const speaker = new Speaker();
      let current = true;
      const sample = speaker.speak("Sample", { isCurrent: () => current });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      current = false;
      if (outcome === "ready") response.resolve(new Response(new Uint8Array([1, 2, 3])));
      else response.reject(new Error("Late audio response failed"));
      await sample;
      expect(speaker.state).toEqual({ status: "idle" });
      expect(speaker.isSpeaking()).toBe(false);
      expect(audios).toHaveLength(0);
    },
  );

  it.each(["close", "error"])(
    "releases an expired caller when a streaming audio body signals %s",
    async (event) => {
      const audios = controlledAudio();
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const pull = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
          controller.enqueue(new Uint8Array([1]));
        },
        pull,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(stream)),
      );
      target.prepare.mockResolvedValue({ ready: true, utterances: ["Sample"] });
      const speaker = new Speaker();
      let current = true;
      const sample = speaker.speak("Sample", { isCurrent: () => current });
      await vi.waitFor(() => expect(pull).toHaveBeenCalled());
      current = false;
      if (event === "close") body.close();
      else body.error(new Error("Late stream failure"));
      await sample;
      expect(speaker.state).toEqual({ status: "idle" });
      expect(speaker.isSpeaking()).toBe(false);
      expect(audios).toHaveLength(0);
    },
  );

  it("releases playback when the caller expires while Audio.play is starting", async () => {
    const starting = deferred<void>();
    const audios = controlledAudio(() => starting.promise);
    target.prepare.mockResolvedValue({ ready: true, utterances: ["Sample"] });
    const speaker = new Speaker();
    let current = true;
    const sample = speaker.speak("Sample", { isCurrent: () => current });
    try {
      await vi.waitFor(() => expect(audios).toHaveLength(1));
      current = false;
      starting.resolve();
      await vi.waitFor(() => expect(speaker.state.status).toBe("idle"));
      await sample;
      expect(audios[0]?.paused).toBe(true);
      expect(speaker.isSpeaking()).toBe(false);
    } finally {
      speaker.stop();
      starting.resolve();
      await sample;
    }
  });

  it("releases expired playback on media progress and removes its listener", async () => {
    const audios = controlledAudio();
    target.prepare.mockResolvedValue({ ready: true, utterances: ["Sample"] });
    const speaker = new Speaker();
    let current = true;
    const sample = speaker.speak("Sample", { isCurrent: () => current });
    await vi.waitFor(() => expect(audios).toHaveLength(1));
    current = false;
    audios[0]?.ontimeupdate?.();
    await sample;
    expect(speaker.state).toEqual({ status: "idle" });
    expect(audios[0]?.paused).toBe(true);
    expect(audios[0]?.ontimeupdate).toBeNull();
  });

  it("aborts prefetched audio when the expired call still owns the request", async () => {
    controlledAudio();
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi
      .fn((_url: string, _options?: RequestInit) => first.promise)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    vi.stubGlobal("fetch", fetchMock);
    target.prepare.mockResolvedValue({ ready: true, utterances: ["First", "Second"] });
    const speaker = new Speaker();
    let current = true;
    const sample = speaker.speak("Sample", { isCurrent: () => current });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    current = false;
    first.reject(new Error("First audio failed"));
    await sample;
    expect(speaker.state).toEqual({ status: "idle" });
    expect(fetchMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    second.resolve(new Response());
  });

  it("does not let an old progress callback stop the newer owner", async () => {
    const audios = controlledAudio();
    target.prepare.mockResolvedValue({ ready: true, utterances: ["Sample"] });
    const speaker = new Speaker();
    let current = true;
    const old = speaker.speak("Old sample", { isCurrent: () => current });
    await vi.waitFor(() => expect(audios).toHaveLength(1));
    const oldProgress = audios[0]?.ontimeupdate;
    const next = speaker.speak("Current thread", { messageId: "new" });
    await vi.waitFor(() => expect(audios).toHaveLength(2));
    current = false;
    oldProgress?.();
    expect(speaker.state).toMatchObject({ status: "speaking", messageId: "new" });
    expect(audios[1]?.paused).toBe(false);
    audios[1]?.onended?.();
    await Promise.all([old, next]);
  });
  it.each(["ready", "error"])(
    "releases its snapshot when preparation finishes %s after the caller expires",
    async (outcome) => {
      const speaker = new Speaker();
      const preparing = deferred<{ ready: boolean; utterances: string[] }>();
      target.prepare.mockReturnValue(preparing.promise);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      let current = true;
      const sample = speaker.speak("Sample", { isCurrent: () => current });
      expect(speaker.state.status).toBe("preparing");
      current = false;
      if (outcome === "ready") preparing.resolve({ ready: true, utterances: ["Sample"] });
      else preparing.reject(new Error("Late preparation failure"));
      await sample;
      expect(speaker.state).toEqual({ status: "idle" });
      expect(speaker.isSpeaking()).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["ended", "error"])(
    "releases only its playback when audio signals %s after the caller expires",
    async (event) => {
      const audios = controlledAudio();
      const speaker = new Speaker();
      target.prepare.mockResolvedValue({ ready: true, utterances: ["Sample"] });
      let current = true;
      const sample = speaker.speak("Sample", { isCurrent: () => current });
      await vi.waitFor(() => expect(audios).toHaveLength(1));
      current = false;
      if (event === "ended") audios[0]?.onended?.();
      else audios[0]?.onerror?.();
      await sample;
      expect(audios[0]?.paused).toBe(true);
      expect(speaker.state).toEqual({ status: "idle" });
      expect(speaker.isSpeaking()).toBe(false);
    },
  );

  it("leaves a newer preparation untouched when an expired caller finishes late", async () => {
    const speaker = new Speaker();
    const old = deferred<{ ready: boolean; utterances: string[] }>();
    const latest = deferred<{ ready: boolean; utterances: string[] }>();
    target.prepare.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    let oldCurrent = true;
    const sample = speaker.speak("Old sample", { messageId: "old", isCurrent: () => oldCurrent });
    const thread = speaker.speak("Current thread", { messageId: "new" });
    oldCurrent = false;
    old.resolve({ ready: true, utterances: ["Old sample"] });
    await sample;
    expect(speaker.state).toMatchObject({ status: "preparing", messageId: "new" });
    expect(speaker.isSpeaking("new")).toBe(true);
    latest.resolve({ ready: true, utterances: [] });
    await thread;
    expect(speaker.state.status).toBe("idle");
  });
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

describe("voice payment recovery", () => {
  it.each(["current", "reselected", "cancelled", "session", "account-ABA"] as const)(
    "only projects the %s response when its request still owns recovery",
    async (kind) => {
      stubSelectedSpace("space-a");
      synchronizeRpcSession("authenticated", "voice-owner-a", "voice-session-a");
      const pending = deferred<Response>();
      const fetch = vi.fn(() => pending.promise);
      vi.stubGlobal("fetch", fetch);
      target.prepare.mockResolvedValue({ ready: true, utterances: ["Hello"] });
      const listener = vi.fn();
      const stop = subscribeSubscriptionRequired(listener);
      const speaker = new Speaker();
      const sample = speaker.speak("Hello");
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      if (kind === "reselected") {
        selectSpace("space-b");
        selectSpace("space-a");
      }
      if (kind === "cancelled") speaker.stop();
      if (kind === "session")
        synchronizeRpcSession("authenticated", "voice-owner-a", "voice-session-new");
      if (kind === "account-ABA") {
        synchronizeRpcSession("authenticated", "voice-owner-b", "voice-session-b");
        synchronizeRpcSession("authenticated", "voice-owner-a", "voice-session-a");
      }
      pending.resolve(Response.json({ error: "Subscription required" }, { status: 402 }));
      await sample;
      expect(listener).toHaveBeenCalledTimes(kind === "current" ? 1 : 0);
      if (kind === "session" || kind === "account-ABA")
        expect(speaker.state).toEqual({ status: "idle" });
      stop();
    },
  );
});
