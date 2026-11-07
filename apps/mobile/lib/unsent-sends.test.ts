import { resolveComposerSendPlan } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxDisk } from "./outbox-disk";
import type { SendAttempt } from "./thread-feedback";
import { clearFailedSends, sendWaitingMessages } from "./thread-feedback";
import { prepareUnsentSends, startUnsentSends } from "./unsent-sends";

const host = vi.hoisted(() => ({
  files: new Map<string, string>(),
  readFails: false,
  reads: 0,
  generation: 0,
  readyGeneration: 0,
  apiBase: "https://api.example.test",
  userId: "owner-a",
  spaceId: "space-a",
  cacheSession: "cache-a",
  reachable: true,
  network: new Set<() => void>(),
  session: new Set<() => void>(),
  appState: new Set<(state: string) => void>(),
  rpc: vi.fn(),
  verified: vi.fn(),
  integrations: vi.fn(),
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      host.appState.add(listener);
      return { remove: () => host.appState.delete(listener) };
    },
  },
}));
vi.mock("./api", () => ({
  currentApiBase: () => host.apiBase,
  selectedSpaceId: () => host.spaceId,
  isServerReachable: () => host.reachable,
  subscribeServerReachable: (listener: () => void) => {
    host.network.add(listener);
    return () => host.network.delete(listener);
  },
  captureApiRequestContext: async () => ({ headers: {}, apiBase: host.apiBase }),
  rpc: (...args: unknown[]) => host.rpc(...args),
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => host.generation,
  currentReadySessionGeneration: () => host.readyGeneration,
  loadSessionToken: async () => "fake-session",
  loadVerifiedIntegrationsScope: () => host.verified(),
  subscribeSessionGeneration: (listener: () => void) => {
    host.session.add(listener);
    return () => host.session.delete(listener);
  },
}));
vi.mock("./artifact-cache-session", () => ({
  artifactCacheSession: async () => host.cacheSession,
}));
vi.mock("./integrations-cache", () => ({ integrationsCacheScope: () => host.integrations() }));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
vi.mock("./user-error", () => ({ errorText: String }));
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    get exists() {
      return [...host.files.keys()].some((p) => p === this.uri || p.startsWith(`${this.uri}/`));
    }
    create() {}
    delete() {
      for (const path of host.files.keys())
        if (path === this.uri || path.startsWith(`${this.uri}/`)) host.files.delete(path);
    }
    moveSync(target: Directory) {
      for (const [path, value] of [...host.files]) {
        if (path === this.uri || path.startsWith(`${this.uri}/`)) {
          host.files.set(target.uri + path.slice(this.uri.length), value);
          host.files.delete(path);
        }
      }
      this.uri = target.uri;
    }
    list() {
      const names = new Set(
        [...host.files.keys()]
          .filter((path) => path.startsWith(`${this.uri}/`))
          .map((path) => path.slice(this.uri.length + 1).split("/")[0]!),
      );
      return [...names].map((name) =>
        host.files.has(`${this.uri}/${name}`) ? new File(this, name) : new Directory(this, name),
      );
    }
  }
  class File extends Directory {
    override get exists() {
      return host.files.has(this.uri);
    }
    get size() {
      return Buffer.byteLength(host.files.get(this.uri) ?? "");
    }
    textSync() {
      host.reads += 1;
      if (host.readFails) throw new Error("Storage is temporarily unavailable");
      return host.files.get(this.uri)!;
    }
    write(text: string) {
      host.files.set(this.uri, text);
    }
    async base64() {
      return host.files.get(this.uri) ?? "";
    }
  }
  return { Directory, File, Paths: { cache: "cache" } };
});

function storedAttempt(state: SendAttempt["state"] = "queued"): SendAttempt {
  return {
    apiBase: host.apiBase,
    userId: host.userId,
    spaceId: "space-a",
    cacheSession: host.cacheSession,
    clientNonce: "same-owner-intent",
    state,
    session: 0,
    artifactIds: new Map([["file-a", "uploaded-a"]]),
    payload: {
      originThreadKey: "bot-a",
      displayText: "Owner words",
      replyPreview: null,
      botTarget: "bot-a",
      reroutedToGroup: false,
      replyQuote: null,
      pageContext: { pageId: "page-a" },
      plan: resolveComposerSendPlan({ text: "Owner words", mentions: [], hasAttachments: true }),
      attachments: [
        { id: "file-a", name: "report.txt", mimeType: "text/plain", contentBase64: "ZmlsZQ==" },
      ],
    },
  };
}
function seed(attempt = storedAttempt()) {
  expect(outboxDisk.admit(attempt)).toBe(true);
  expect(outboxDisk.save([attempt])).toBe(true);
  return attempt;
}
const flush = () => vi.advanceTimersByTimeAsync(0);
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  clearFailedSends();
  host.files.clear();
  host.readFails = false;
  host.reads = 0;
  host.generation += 1;
  host.readyGeneration = host.generation;
  host.apiBase = "https://api.example.test";
  host.userId = "owner-a";
  host.spaceId = "space-a";
  host.cacheSession = "cache-a";
  host.reachable = true;
  host.rpc.mockReset().mockResolvedValue({ seq: 42 });
  host.verified.mockReset().mockImplementation(async () => ({
    apiBase: host.apiBase,
    userId: host.userId,
    spaceId: host.spaceId,
    selectionId: host.spaceId,
  }));
  host.integrations.mockReset().mockImplementation(() => host.verified());
});
afterEach(() => {
  stop?.();
  stop = undefined;
  clearFailedSends();
  vi.useRealTimers();
});

describe("outbox startup storage recovery", () => {
  it("restores and delivers the saved intent after storage recovers without any external event", async () => {
    const attempt = seed();
    attempt.payload.plan.shouldRunRoutines = true;
    attempt.payload.plan.routineIds = ["routine-a"];
    outboxDisk.save([attempt]);
    host.spaceId = "space-b";
    const committed = host.files.get("cache/outbox/sends-v4.json");
    host.readFails = true;
    stop = startUnsentSends();
    await flush();
    expect(host.rpc).not.toHaveBeenCalled();
    expect(host.files.get("cache/outbox/sends-v4.json")).toBe(committed);
    host.readFails = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.rpc.mock.calls.filter(([proc]) => proc === "threads/send")).toHaveLength(1);
    const send = host.rpc.mock.calls.find(([proc]) => proc === "threads/send")!;
    expect(send[1]).toMatchObject({
      clientNonce: attempt.clientNonce,
      text: "Owner words",
      botId: "bot-a",
      artifactIds: ["uploaded-a"],
      pageContext: { pageId: "page-a" },
    });
    expect(send[2].requestContext.headers).toEqual({ "x-rakazo-space-id": "space-a" });
    expect(host.rpc.mock.calls.filter(([proc]) => proc === "artifacts/create")).toHaveLength(0);
    expect(host.rpc.mock.calls.filter(([proc]) => proc === "routines/testRun")).toEqual([
      [
        "routines/testRun",
        { routineId: "routine-a", clientNonce: `routine-mention:${attempt.clientNonce}:routine-a` },
        expect.anything(),
      ],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off repeated disk failures to the existing five-second native retry ceiling", async () => {
    seed();
    host.readFails = true;
    const committed = new Map(host.files);
    stop = startUnsentSends();
    await flush();
    expect(host.reads).toBe(1);
    for (const wait of [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]) {
      const before = host.reads;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(host.reads).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(host.reads).toBe(before + 1);
      expect(vi.getTimerCount()).toBe(1);
    }
    expect(host.rpc).not.toHaveBeenCalled();
    expect(host.files).toEqual(committed);
  });

  it("cancels recovery on stop and ignores a queued native lifecycle callback", async () => {
    seed();
    host.readFails = true;
    stop = startUnsentSends();
    await flush();
    const queuedNativeCallback = [...host.appState][0]!;
    expect(vi.getTimerCount()).toBe(1);
    stop();
    stop = undefined;
    const reads = host.reads;
    const preparations = host.verified.mock.calls.length;
    host.readFails = false;
    queuedNativeCallback("active");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.reads).toBe(reads);
    expect(host.verified).toHaveBeenCalledTimes(preparations);
    expect(host.rpc).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.network.size + host.session.size + host.appState.size).toBe(0);
  });

  it("cancels the old session timer and restores only the new ready owner", async () => {
    seed();
    host.readFails = true;
    stop = startUnsentSends();
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    host.generation += 1;
    for (const listener of host.session) listener();
    clearFailedSends();
    expect(vi.getTimerCount()).toBe(0);
    host.userId = "owner-b";
    host.cacheSession = "cache-b";
    const next = storedAttempt();
    next.clientNonce = "owner-b-intent";
    host.readFails = false;
    seed(next);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.rpc).not.toHaveBeenCalled();
    host.readyGeneration = host.generation;
    for (const listener of host.session) listener();
    await flush();
    const sends = host.rpc.mock.calls.filter(([proc]) => proc === "threads/send");
    expect(sends).toHaveLength(1);
    expect(sends[0]![1].clientNonce).toBe("owner-b-intent");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not revive a stale timer after the API base changes without a callback", async () => {
    seed();
    host.readFails = true;
    stop = startUnsentSends();
    await flush();
    const reads = host.reads;
    host.apiBase = "https://other.example.test";
    host.readFails = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.reads).toBe(reads);
    expect(host.rpc).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stop", "session"])("ignores a late scope preparation after %s", async (boundary) => {
    seed();
    let resolve!: (value: unknown) => void;
    host.verified.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    stop = startUnsentSends();
    await flush();
    if (boundary === "stop") {
      stop();
      stop = undefined;
    } else {
      host.generation += 1;
      for (const listener of host.session) listener();
      clearFailedSends();
    }
    host.readFails = true;
    resolve({
      apiBase: host.apiBase,
      userId: host.userId,
      spaceId: host.spaceId,
      selectionId: host.spaceId,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.reads).toBe(0);
    expect(host.rpc).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares restoration and the existing queue drain with concurrent startup and lifecycle events", async () => {
    seed();
    stop = startUnsentSends();
    const first = prepareUnsentSends();
    const second = prepareUnsentSends();
    for (const listener of host.network) listener();
    for (const listener of host.appState) listener("active");
    await Promise.all([first, second]);
    await flush();
    expect(host.reads).toBe(1);
    expect(host.rpc.mock.calls.filter(([proc]) => proc === "threads/send")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not redeliver a receipt when foreground preparation recovers storage before the timer", async () => {
    seed();
    host.readFails = true;
    stop = startUnsentSends();
    await flush();
    host.readFails = false;
    await prepareUnsentSends();
    await sendWaitingMessages();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.rpc.mock.calls.filter(([proc]) => proc === "threads/send")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores a failed item visibly without turning it into an automatic resend", async () => {
    seed(storedAttempt("failed"));
    host.readFails = true;
    stop = startUnsentSends();
    await flush();
    host.readFails = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.rpc).not.toHaveBeenCalled();
    expect(JSON.parse(host.files.get("cache/outbox/sends-v4.json")!)[0]).toMatchObject({
      clientNonce: "same-owner-intent",
      state: "failed",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the committed backup on I/O failure and never restores a failed replacement", async () => {
    seed();
    host.files.set("cache/outbox/sends-v4.json.bak", host.files.get("cache/outbox/sends-v4.json")!);
    host.files.delete("cache/outbox/sends-v4.json");
    host.files.set("cache/outbox/sends-v4.json.tmp", "[]");
    const committed = new Map(host.files);
    host.readFails = true;
    stop = startUnsentSends();
    await flush();
    expect(host.files).toEqual(committed);
    host.readFails = false;
    await vi.advanceTimersByTimeAsync(5_000);
    const sends = host.rpc.mock.calls.filter(([proc]) => proc === "threads/send");
    expect(sends).toHaveLength(1);
    expect(sends[0]![1].clientNonce).toBe("same-owner-intent");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "retains a foreground forced attempt through storage recovery while reachability is false (concurrent=%s)",
    async (concurrent) => {
      seed();
      host.readFails = true;
      host.reachable = false;
      let resolve!: (value: unknown) => void;
      if (concurrent)
        host.verified.mockReturnValue(
          new Promise((done) => {
            resolve = done;
          }),
        );
      stop = startUnsentSends();
      await flush();
      for (const listener of host.appState) listener("active");
      if (concurrent)
        resolve({
          apiBase: host.apiBase,
          userId: host.userId,
          spaceId: host.spaceId,
          selectionId: host.spaceId,
        });
      await flush();
      expect(host.rpc).not.toHaveBeenCalled();
      host.readFails = false;
      await vi.advanceTimersByTimeAsync(5_000);
      const sends = host.rpc.mock.calls.filter(([proc]) => proc === "threads/send");
      expect(sends).toHaveLength(1);
      expect(sends[0]![1].clientNonce).toBe("same-owner-intent");
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(host.rpc.mock.calls.filter(([proc]) => proc === "threads/send")).toHaveLength(1);
    },
  );

  it("does not poll failed authentication or network scope preparation", async () => {
    seed();
    host.verified.mockResolvedValue(null);
    host.integrations.mockRejectedValue(new Error("Scope unavailable"));
    stop = startUnsentSends();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.integrations).toHaveBeenCalledOnce();
    expect(host.reads).toBe(0);
    expect(host.rpc).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
