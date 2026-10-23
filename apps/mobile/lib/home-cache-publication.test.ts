import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { MobileScope } from "./mobile-scope";
import type { SavedChatsScope, SavedInbox } from "./saved-chats";

const source = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

function execute(body: string, scope: Record<string, unknown>) {
  return new Function(
    ...Object.keys(scope),
    ts.transpileModule(body, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
  )(...Object.values(scope));
}

function sourceBetween(start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Home source boundary missing: ${start}`);
  return source.slice(from, to);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function inbox(name: string, spaceId = "space-1"): SavedInbox {
  return {
    bots: [],
    groups: [],
    botSections: [],
    spaces: [
      {
        id: spaceId,
        name,
        isDefault: true,
        hasContent: false,
        bots: [],
        groups: [],
        botSections: [],
        externalConversations: [],
      },
    ],
    me: { userId: "user-1", spaceId, name },
  };
}

function home(hasSession = true) {
  const live = {
    apiBase: "https://api.example.test",
    apiGeneration: 1,
    sessionGeneration: 1,
    spaceId: "space-1" as string | null,
    spaceGeneration: 1,
    selectionSeq: 0,
  };
  const saved = inbox("Saved");
  const server = inbox("Live");
  const navigation = {
    current: {
      id: server.me.spaceId,
      name: "Live",
      bots: server.bots,
      groups: server.groups,
      botSections: server.botSections,
      externalConversations: [],
    },
    spaces: server.spaces,
  };
  const cacheReads: Array<ReturnType<typeof deferred<SavedChatsScope | null>>> = [];
  const listeners = new Set<() => void>();
  const captureMobileScope = (): MobileScope => ({ ...live });
  const isMobileSessionCurrent = (owner: MobileScope) =>
    owner.apiBase === live.apiBase &&
    owner.apiGeneration === live.apiGeneration &&
    owner.sessionGeneration === live.sessionGeneration;
  const isMobileScopeCurrent = (owner: MobileScope) =>
    isMobileSessionCurrent(owner) &&
    owner.spaceId === live.spaceId &&
    owner.spaceGeneration === live.spaceGeneration &&
    owner.selectionSeq === live.selectionSeq;
  const scope = {
    hasSession,
    useCallback: (callback: unknown) => callback,
    captureMobileScope,
    isMobileScopeCurrent,
    isMobileSessionCurrent,
    mounted: { current: true },
    inboxRequestId: { current: 0 },
    inboxLoaded: { current: false },
    publicationRevision: { current: 0 },
    verifiedInbox: {
      current: null as {
        scope: MobileScope;
        me: SavedInbox["me"];
        rawInbox: typeof navigation;
        publicationRevision: number;
      } | null,
    },
    bootstrap: { current: null },
    inboxState: { current: { ...saved, spaceId: saved.me.spaceId } },
    spaceActionRef: { current: { busy: false, recoveryId: null } },
    organizationBusyRef: { current: false },
    setBots: vi.fn(),
    setBotSections: vi.fn(),
    setGroups: vi.fn(),
    setSpaces: vi.fn(),
    setMe: vi.fn(),
    setSearchInbox: vi.fn(),
    setError: vi.fn(),
    saveInbox: vi.fn(),
    adoptDeviceTimezone: vi.fn(async (_me: unknown, _current: () => boolean) => undefined),
    rpc: vi.fn(async (procedure: string) => (procedure === "me" ? server.me : navigation)),
    retainInboxValue: (_current: unknown, next: unknown) => next,
    selectInitialSpace: vi.fn(async () => true),
    errorText: (error: Error) => error.message,
    t: (text: string) => text,
    savedChatsScope: vi.fn(() => {
      const pending = deferred<SavedChatsScope | null>();
      cacheReads.push(pending);
      return pending.promise;
    }),
    readSavedInbox: vi.fn<(_scope: SavedChatsScope) => SavedInbox | null>(() => saved),
    subscribeMobileScope: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  const loadBots = execute(
    `${sourceBetween("  const loadBots = useCallback(", "  const refreshBots")}\nreturn loadBots;`,
    scope,
  ) as () => Promise<void>;
  const startCache = () => {
    let cleanup: (() => void) | undefined;
    execute(sourceBetween("  // A cache keeps", "\n  useFocusEffect("), {
      ...scope,
      useEffect: (effect: () => (() => void) | undefined) => {
        cleanup = effect();
      },
    });
    return () => cleanup?.();
  };
  const cacheScope = (): SavedChatsScope => ({
    namespace: "fake-session-namespace",
    apiBase: live.apiBase,
    userId: "user-1",
    spaceId: live.spaceId ?? "space-1",
    sessionGeneration: live.sessionGeneration,
    selectionId: live.spaceId,
  });
  const finishCache = async (index: number, result: SavedChatsScope | null = cacheScope()) => {
    const pending = cacheReads[index];
    if (!pending) throw new Error(`Missing cache read ${index}`);
    pending.resolve(result);
    await pending.promise;
  };
  const emitScope = () => {
    for (const listener of listeners) listener();
  };
  return {
    ...scope,
    live,
    saved,
    server,
    navigation,
    cacheReads,
    cacheScope,
    finishCache,
    emitScope,
    listeners,
    startCache,
    loadBots,
  };
}

describe("Home cache and live inbox publication", () => {
  it("starts device adoption only after publishing an authenticated current account", async () => {
    const state = home();
    await state.loadBots();
    expect(state.adoptDeviceTimezone).toHaveBeenCalledExactlyOnceWith(
      state.server.me,
      expect.any(Function),
    );
    expect(state.setMe.mock.invocationCallOrder[0]).toBeLessThan(
      state.adoptDeviceTimezone.mock.invocationCallOrder[0]!,
    );
    const current = state.adoptDeviceTimezone.mock.calls[0]![1] as () => boolean;
    expect(current()).toBe(true);
    state.live.sessionGeneration += 2;
    expect(current()).toBe(false);
  });

  it("never adopts a timezone from the saved unauthenticated cache", async () => {
    const state = home();
    state.startCache();
    await state.finishCache(0);
    expect(state.adoptDeviceTimezone).not.toHaveBeenCalled();
  });

  it("shows saved data first, then replaces it with the verified live roster", async () => {
    const state = home();
    const network = deferred<typeof state.navigation | typeof state.server.me>();
    state.rpc.mockImplementation((procedure) =>
      network.promise.then(() => (procedure === "me" ? state.server.me : state.navigation)),
    );
    state.startCache();
    const loading = state.loadBots();

    await state.finishCache(0);
    expect(state.setMe).toHaveBeenLastCalledWith(state.saved.me);
    expect(state.setSearchInbox).toHaveBeenLastCalledWith(
      state.captureMobileScope(),
      state.saved.spaces,
    );
    expect(state.verifiedInbox.current?.rawInbox.spaces).toBe(state.saved.spaces);

    network.resolve(state.navigation);
    await loading;
    expect(state.setSearchInbox.mock.calls.map(([, spaces]) => spaces)).toEqual([
      state.saved.spaces,
      state.server.spaces,
    ]);
    expect(state.verifiedInbox.current?.rawInbox).toBe(state.navigation);
    expect(state.inboxState.current.spaces).toBe(state.server.spaces);
    expect(state.publicationRevision.current).toBe(2);
    expect(state.saveInbox).toHaveBeenCalledOnce();
  });

  it("keeps the live publication when an earlier saved read finishes later", async () => {
    const state = home();
    state.startCache();
    await state.loadBots();
    await state.finishCache(0);

    expect(state.readSavedInbox).not.toHaveBeenCalled();
    expect(state.setSearchInbox).toHaveBeenCalledExactlyOnceWith(
      state.captureMobileScope(),
      state.server.spaces,
    );
    expect(state.verifiedInbox.current?.rawInbox).toBe(state.navigation);
    expect(state.inboxState.current.spaces).toBe(state.server.spaces);
    expect(state.publicationRevision.current).toBe(1);
  });

  it("does not reread storage over a current verified publication", async () => {
    const state = home();
    await state.loadBots();
    state.startCache();
    state.emitScope();

    expect(state.savedChatsScope).not.toHaveBeenCalled();
    expect(state.setSearchInbox).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "API ABA",
      (state: ReturnType<typeof home>) => {
        state.live.apiBase = "https://other.example.test";
        state.live.apiGeneration++;
        state.live.apiBase = "https://api.example.test";
        state.live.apiGeneration++;
      },
    ],
    [
      "Space ABA",
      (state: ReturnType<typeof home>) => {
        state.live.spaceId = "space-2";
        state.live.spaceGeneration++;
        state.live.spaceId = "space-1";
        state.live.spaceGeneration++;
      },
    ],
    [
      "same-ID selection attempt",
      (state: ReturnType<typeof home>) => {
        state.live.selectionSeq++;
      },
    ],
    [
      "new session",
      (state: ReturnType<typeof home>) => {
        state.live.sessionGeneration++;
      },
    ],
  ] as const)("discards a saved read captured before %s", async (_name, change) => {
    const state = home();
    state.startCache();
    const original = state.cacheScope();
    change(state);
    await state.finishCache(0, original);

    expect(state.readSavedInbox).not.toHaveBeenCalled();
    expect(state.setMe).not.toHaveBeenCalled();
    expect(state.setSearchInbox).not.toHaveBeenCalled();
    expect(state.verifiedInbox.current).toBeNull();
    expect(state.publicationRevision.current).toBe(0);
  });

  it.each(["Space", "API", "selection attempt"] as const)(
    "loads a new %s owner in the same mounted Home after an earlier publication",
    async (change) => {
      const state = home();
      state.startCache();
      await state.finishCache(0);
      await state.loadBots();
      state.inboxLoaded.current = true;
      const original = state.verifiedInbox.current?.scope;
      if (change === "Space") {
        state.live.spaceId = "space-2";
        state.live.spaceGeneration++;
      } else if (change === "API") {
        state.live.apiBase = "https://other.example.test";
        state.live.apiGeneration++;
      } else {
        state.live.selectionSeq++;
      }
      const next = inbox("New owner", state.live.spaceId ?? "space-1");
      state.readSavedInbox.mockReturnValue(next);
      state.emitScope();
      expect(state.savedChatsScope).toHaveBeenCalledTimes(2);
      await state.finishCache(1);

      expect(state.verifiedInbox.current?.scope).not.toEqual(original);
      expect(state.verifiedInbox.current?.scope).toEqual(state.captureMobileScope());
      expect(state.setSearchInbox).toHaveBeenLastCalledWith(
        state.captureMobileScope(),
        next.spaces,
      );
      expect(state.setMe).toHaveBeenLastCalledWith(next.me);
      expect(state.inboxState.current.spaceId).toBe(next.me.spaceId);
      expect(state.publicationRevision.current).toBe(3);
    },
  );

  it.each(["userId", "spaceId"] as const)(
    "rejects saved me.%s that does not match its verified cache identity",
    async (field) => {
      const state = home();
      state.readSavedInbox.mockReturnValue({
        ...state.saved,
        me: { ...state.saved.me, [field]: "other-owner" },
      });
      state.startCache();
      await state.finishCache(0);

      expect(state.setMe).not.toHaveBeenCalled();
      expect(state.setSearchInbox).not.toHaveBeenCalled();
      expect(state.verifiedInbox.current).toBeNull();
      expect(state.publicationRevision.current).toBe(0);
    },
  );

  it.each(["no identity", "no inbox"] as const)("does not publish with %s", async (missing) => {
    const state = home();
    if (missing === "no inbox") state.readSavedInbox.mockReturnValue(null);
    state.startCache();
    await state.finishCache(0, missing === "no identity" ? null : state.cacheScope());

    expect(state.setMe).not.toHaveBeenCalled();
    expect(state.setSearchInbox).not.toHaveBeenCalled();
    expect(state.verifiedInbox.current).toBeNull();
  });

  it("keeps the first accepted publication over another pending cache read", async () => {
    const state = home();
    state.startCache();
    state.emitScope();
    await state.finishCache(1);
    state.readSavedInbox.mockReturnValue(inbox("Late stale cache"));
    await state.finishCache(0);

    expect(state.readSavedInbox).toHaveBeenCalledOnce();
    expect(state.setMe).toHaveBeenCalledExactlyOnceWith(state.saved.me);
    expect(state.publicationRevision.current).toBe(1);
  });

  it("discards pending work and removes its subscription when the cache effect unmounts", async () => {
    const state = home();
    const cleanup = state.startCache();
    expect(state.listeners.size).toBe(1);
    cleanup();
    await state.finishCache(0);
    state.emitScope();

    expect(state.listeners.size).toBe(0);
    expect(state.savedChatsScope).toHaveBeenCalledOnce();
    expect(state.readSavedInbox).not.toHaveBeenCalled();
    expect(state.setMe).not.toHaveBeenCalled();
    expect(state.setSearchInbox).not.toHaveBeenCalled();
  });

  it("discards a pending cache read after the Home lifetime has ended", async () => {
    const state = home();
    state.startCache();
    state.mounted.current = false;
    await state.finishCache(0);

    expect(state.readSavedInbox).not.toHaveBeenCalled();
    expect(state.setMe).not.toHaveBeenCalled();
    expect(state.setSearchInbox).not.toHaveBeenCalled();
  });

  it("does not start cache work without a session", () => {
    const state = home(false);
    state.startCache();

    expect(state.savedChatsScope).not.toHaveBeenCalled();
    expect(state.subscribeMobileScope).not.toHaveBeenCalled();
  });
});
