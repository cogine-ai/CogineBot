import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { InboxOrganizationState } from "./inbox-organization";
import { reconcileInboxOrganization } from "./inbox-organization";

const source = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

function callback(name: string, next: string, scope: Record<string, unknown>) {
  const body = source.slice(
    source.indexOf(`  const ${name} = useCallback(`),
    source.indexOf(`  const ${next}`),
  );
  return new Function(
    ...Object.keys(scope),
    ts.transpileModule(`${body}\nreturn ${name};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
  )(...Object.values(scope));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function home() {
  const live = {
    api: "https://api.example.test",
    generation: 1,
    apiGeneration: 1,
    spaceGeneration: 1,
    selectionSeq: 0,
    selection: "space-1" as string | null,
  };
  const me = { userId: "user-1", spaceId: "space-1", name: "Owner" };
  const navigation = {
    current: {
      id: me.spaceId,
      name: "Personal",
      bots: [],
      groups: [],
      botSections: [],
      externalConversations: [],
    },
    spaces: [],
  };
  const organizationBusyRef = { current: false };
  const inboxRequestId = { current: 0 };
  const organizationScope = `${live.api}:${live.generation}:${me.userId}:${me.spaceId}`;
  const rpc = vi.fn<(procedure: string, body?: unknown) => Promise<unknown>>(async (procedure) =>
    procedure === "me" ? me : navigation,
  );
  const setBots = vi.fn();
  const setError = vi.fn();
  const captureMobileScope = () => ({
    apiBase: live.api,
    apiGeneration: live.apiGeneration,
    sessionGeneration: live.generation,
    spaceId: live.selection,
    spaceGeneration: live.spaceGeneration,
    selectionSeq: live.selectionSeq,
  });
  const isMobileSessionCurrent = (owner: ReturnType<typeof captureMobileScope>) =>
    owner.apiBase === live.api &&
    owner.apiGeneration === live.apiGeneration &&
    owner.sessionGeneration === live.generation;
  const isMobileScopeCurrent = (owner: ReturnType<typeof captureMobileScope>) =>
    isMobileSessionCurrent(owner) &&
    owner.spaceId === live.selection &&
    owner.spaceGeneration === live.spaceGeneration &&
    owner.selectionSeq === live.selectionSeq;
  const scope = {
    useCallback: (fn: unknown) => fn,
    captureMobileScope,
    isMobileScopeCurrent,
    isMobileSessionCurrent,
    mounted: { current: true },
    bootstrap: { current: null },
    verifiedInbox: {
      current: { scope: captureMobileScope(), me, rawInbox: navigation, publicationRevision: 0 },
    },
    publicationRevision: { current: 0 },
    setSearchInbox: vi.fn(),
    notificationRevision: { current: 0 },
    showNotificationPermission: vi.fn(),
    spaceActionRef: { current: { busy: false, recoveryId: null } },
    organizationBusyRef,
    inboxRequestId,
    currentApiBase: () => live.api,
    currentSessionGeneration: () => live.generation,
    selectedSpaceId: () => live.selection,
    setError,
    rpc,
    selectInitialSpace: vi.fn(async (id: string) => {
      if (!live.selection) {
        live.selectionSeq++;
        live.selection = id;
        live.spaceGeneration++;
      }
      return true;
    }),
    retainInboxValue: (_current: unknown, next: unknown) => next,
    setBots,
    setBotSections: vi.fn(),
    setGroups: vi.fn(),
    setSpaces: vi.fn(),
    setMe: vi.fn(),
    inboxLoaded: { current: false },
    inboxState: {
      current: {
        spaceId: me.spaceId,
        bots: [],
        groups: [],
        botSections: [],
        spaces: [],
      } as InboxOrganizationState,
    },
    saveInbox: vi.fn(),
    errorText: (error: Error) => error.message,
    t: (text: string) => text,
    me,
    organizationScopeRef: { current: organizationScope },
    setOrganizationBusy: vi.fn(),
  };
  const loadBots = callback("loadBots", "refreshBots", scope) as (
    duringOrganization?: boolean,
  ) => Promise<void>;
  const saveOrganization = callback("saveOrganization", "reportOrganizationError", {
    ...scope,
    loadBots,
  }) as <T>(
    scope: string,
    spaceId: string,
    request: () => Promise<T>,
    confirmed: (result: T) => void,
  ) => Promise<void>;
  const applyOrganization = callback("applyOrganization", "saveOrganization", {
    ...scope,
    reconcileInboxOrganization,
  });
  const trackedSave = vi.fn(saveOrganization);
  const actions = {
    ...scope,
    loadBots,
    applyOrganization,
    organizationScope,
    saveOrganization: trackedSave,
    botSections: [],
    setDeletedSection: vi.fn(),
    setSectionPrompt: vi.fn(),
    setOrganizationNotice: vi.fn(),
    reportOrganizationError: vi.fn(),
    reorderedSectionIds: () => null,
    loadSessionToken: vi.fn<() => Promise<string | null>>(async () => {
      throw new Error("Notification refresh failed");
    }),
    spaceRequestContext: vi.fn(async () => ({
      apiBase: live.api,
      sessionGeneration: live.generation,
      headers: { authorization: "Bearer fake-notify-owner", "x-rakazo-space-id": live.selection },
    })),
    afterChatNotifyChange: vi.fn(async (_change: Record<string, unknown>) => null as string | null),
    registerPushToken: vi.fn(async (_options: unknown) => undefined),
  };
  const handleSectionAction = callback("handleSectionAction", "renderItem", actions);
  const handleChatAction = callback("handleChatAction", "handleSectionAction", actions);
  return { live, navigation, trackedSave, handleSectionAction, handleChatAction, ...actions };
}

describe("confirmed mobile organization recovery", () => {
  it.each(["apiGeneration", "spaceGeneration", "selectionSeq"] as const)(
    "drops a roster response after the %s changes even when IDs match",
    async (field) => {
      const state = home();
      const read = deferred<typeof state.navigation>();
      state.rpc.mockImplementationOnce(() => read.promise);
      const loading = state.loadBots();
      state.live[field]++;
      read.resolve(state.navigation);
      await loading;
      expect(state.setBots).not.toHaveBeenCalled();
      expect(state.setSearchInbox).not.toHaveBeenCalled();
    },
  );

  it("rejects an organization action retained from a prior same-ID selection", async () => {
    const state = home();
    state.live.spaceGeneration++;
    const request = vi.fn(async () => ({}));
    await expect(
      state.saveOrganization(state.organizationScope, state.me.spaceId, request, vi.fn()),
    ).rejects.toThrow("Could not update chat");
    expect(request).not.toHaveBeenCalled();
  });

  it("does not publish a default selection claimed by a later same-ID attempt", async () => {
    const state = home();
    state.live.selection = null;
    state.selectInitialSpace.mockImplementationOnce(async (id) => {
      state.live.selection = id;
      state.live.spaceGeneration += 2;
      state.live.selectionSeq += 2;
      return true;
    });
    await state.loadBots();
    expect(state.setBots).not.toHaveBeenCalled();
    expect(state.setSearchInbox).not.toHaveBeenCalled();
  });

  it("publishes the verified unfiltered roster even when UI objects are retained", async () => {
    const state = home();
    await state.loadBots();
    expect(state.setSearchInbox).toHaveBeenCalledExactlyOnceWith(
      state.captureMobileScope(),
      state.navigation.spaces,
    );
  });

  it("applies a confirmed deletion once even when the following list refresh fails", async () => {
    const state = home();
    state.rpc.mockRejectedValue(new Error("Offline"));
    const result = { section: { id: "section" }, botIds: ["bot"], groupIds: [] };
    const request = vi.fn(async () => result);
    const confirmed = vi.fn();

    await expect(
      state.saveOrganization(state.organizationScope, state.me.spaceId, request, confirmed),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
    expect(confirmed).toHaveBeenCalledExactlyOnceWith(result);
    expect(state.setError).toHaveBeenLastCalledWith("Offline");
    expect(state.organizationBusyRef.current).toBe(false);
  });

  it("keeps genuine write failures retryable without applying any confirmed state", async () => {
    const state = home();
    const confirmed = vi.fn();
    await expect(
      state.saveOrganization(
        state.organizationScope,
        state.me.spaceId,
        async () => {
          throw new Error("Write failed");
        },
        confirmed,
      ),
    ).rejects.toThrow("Write failed");
    expect(confirmed).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.organizationBusyRef.current).toBe(false);
  });

  it("reconciles the actual delete action and saved inbox before showing Undo after a refresh failure", async () => {
    const state = home();
    const section = { id: "work", name: "Work", position: 0, createdAt: "", updatedAt: "" };
    const snapshot = { section, botIds: ["a"], groupIds: [] };
    Object.assign(state.inboxState.current, {
      bots: [{ id: "a", sectionId: section.id, pinned: true }],
      botSections: [section],
      spaces: [
        {
          id: state.me.spaceId,
          bots: [{ id: "a", sectionId: section.id, pinned: true }],
          groups: [],
          botSections: [section],
        },
      ],
    });
    state.rpc.mockImplementation(async (procedure) => {
      if (procedure === "botSections/remove") return snapshot;
      throw new Error("Offline");
    });
    state.handleSectionAction(section, "delete");
    await state.trackedSave.mock.results[0]!.value;
    expect(state.inboxState.current.botSections).toEqual([]);
    expect(state.inboxState.current.bots[0]).toMatchObject({ sectionId: null, pinned: true });
    expect(state.inboxState.current.spaces[0]?.bots[0]?.sectionId).toBeNull();
    expect(state.setDeletedSection).toHaveBeenCalledExactlyOnceWith({
      scope: state.organizationScope,
      spaceId: state.me.spaceId,
      snapshot,
    });
    expect(state.saveInbox).toHaveBeenCalledOnce();
    expect(state.saveInbox.mock.calls[0]?.[1].current).toMatchObject({
      botSections: [],
      bots: [{ sectionId: null }],
    });
    expect(state.reportOrganizationError).not.toHaveBeenCalled();
    expect(
      state.rpc.mock.calls.filter(([procedure]) => procedure === "botSections/remove"),
    ).toHaveLength(1);
  });

  it("keeps a confirmed pin change when an optional notification refresh also fails", async () => {
    const state = home();
    const chat = {
      id: "a",
      sectionId: null,
      pinned: true,
      unread: false,
      notifyOnFinish: true,
      spaceId: state.me.spaceId,
    };
    Object.assign(state.inboxState.current, { bots: [chat] });
    state.rpc.mockImplementation(async (procedure) => {
      if (procedure === "bots/update")
        return { ...chat, pinned: false, notifyOnFinish: false, updatedAt: "confirmed" };
      throw new Error("Offline");
    });
    state.handleChatAction("bot", chat, "notifications");
    await state.trackedSave.mock.results[0]!.value;
    expect(state.inboxState.current.bots[0]).toMatchObject({
      pinned: false,
      notifyOnFinish: false,
      updatedAt: "confirmed",
    });
    expect(state.reportOrganizationError).not.toHaveBeenCalled();
    expect(state.spaceRequestContext).toHaveBeenCalledOnce();
    expect(state.afterChatNotifyChange).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        botId: "a",
        notifyOnFinish: false,
        token: "fake-notify-owner",
        spaceId: state.me.spaceId,
      }),
    );
  });

  it("registers an allowed notification device with the saved request owner", async () => {
    const state = home();
    const chat = {
      id: "a",
      sectionId: null,
      pinned: false,
      unread: false,
      notifyOnFinish: false,
      spaceId: state.me.spaceId,
    };
    Object.assign(state.inboxState.current, { bots: [chat] });
    state.rpc.mockImplementation(async (procedure) => {
      if (procedure === "bots/update")
        return { ...chat, notifyOnFinish: true, updatedAt: "confirmed" };
      throw new Error("Offline");
    });
    state.afterChatNotifyChange.mockImplementationOnce(async (change) => {
      await (change.onAllowed as () => Promise<void>)();
      return "allowed";
    });
    state.handleChatAction("bot", chat, "notifications");
    await state.trackedSave.mock.results[0]!.value;
    expect(state.registerPushToken).toHaveBeenCalledExactlyOnceWith({
      permission: "allowed",
      requestContext: await state.spaceRequestContext.mock.results[0]!.value,
      isCurrent: expect.any(Function),
    });
    const options = state.registerPushToken.mock.calls[0]![0] as {
      isCurrent: () => boolean;
    };
    expect(options.isCurrent()).toBe(true);
    state.live.selectionSeq++;
    expect(options.isCurrent()).toBe(false);
    expect(state.inboxState.current.bots[0]?.notifyOnFinish).toBe(true);
    expect(state.rpc.mock.calls.filter(([procedure]) => procedure === "bots/update")).toHaveLength(
      1,
    );
    expect(state.reportOrganizationError).not.toHaveBeenCalled();
  });

  it("keeps notification maintenance in the busy phase after applying the confirmed preference", async () => {
    const state = home();
    const follow = deferred<null>();
    state.afterChatNotifyChange.mockReturnValueOnce(follow.promise);
    const chat = {
      id: "a",
      sectionId: null,
      pinned: false,
      unread: false,
      notifyOnFinish: true,
      spaceId: state.me.spaceId,
    };
    Object.assign(state.inboxState.current, { bots: [chat] });
    state.rpc.mockImplementation(async (procedure) => {
      if (procedure === "bots/update")
        return { ...chat, notifyOnFinish: false, updatedAt: "confirmed" };
      throw new Error("Offline");
    });
    state.handleChatAction("bot", chat, "notifications");
    await vi.waitFor(() => expect(state.afterChatNotifyChange).toHaveBeenCalledOnce());
    expect(state.inboxState.current.bots[0]?.notifyOnFinish).toBe(false);
    expect(state.organizationBusyRef.current).toBe(true);
    await state.loadBots();
    expect(state.rpc).toHaveBeenCalledOnce();
    follow.resolve(null);
    await state.trackedSave.mock.results[0]!.value;
    expect(state.afterChatNotifyChange).toHaveBeenCalledOnce();
    expect(state.organizationBusyRef.current).toBe(false);
  });

  it("drops a poll started before the write and skips new polls while the write is pending", async () => {
    const state = home();
    const oldRead = deferred<typeof state.navigation>();
    state.rpc.mockImplementationOnce(() => oldRead.promise);
    const priorPoll = state.loadBots();
    const write = deferred<void>();
    const confirmed = vi.fn();
    const saving = state.saveOrganization(
      state.organizationScope,
      state.me.spaceId,
      () => write.promise,
      confirmed,
    );
    const callsBeforePoll = state.rpc.mock.calls.length;
    await state.loadBots();
    expect(state.rpc).toHaveBeenCalledTimes(callsBeforePoll);
    state.rpc.mockRejectedValue(new Error("Refresh failed"));
    write.resolve();
    await saving;
    oldRead.resolve(state.navigation);
    await priorPoll;
    expect(confirmed).toHaveBeenCalledOnce();
    expect(state.setBots).not.toHaveBeenCalled();
  });

  it.each(["api", "generation", "selection"] as const)(
    "does not apply a late write after the %s changes",
    async (field) => {
      const state = home();
      const confirmed = vi.fn();
      await state.saveOrganization(
        state.organizationScope,
        state.me.spaceId,
        async () => {
          if (field === "generation") state.live.generation++;
          else state.live[field] = "changed";
          return { ok: true };
        },
        confirmed,
      );
      expect(confirmed).not.toHaveBeenCalled();
      expect(state.rpc).not.toHaveBeenCalled();
    },
  );

  it("drops a list response after an external space switch but allows its own initial selection", async () => {
    const state = home();
    const read = deferred<typeof state.navigation>();
    state.rpc.mockImplementationOnce(() => read.promise);
    const loading = state.loadBots();
    state.live.selection = "space-2";
    read.resolve(state.navigation);
    await loading;
    expect(state.setBots).not.toHaveBeenCalled();
    state.live.selection = null;
    await state.loadBots();
    expect(state.setBots).toHaveBeenCalledOnce();
    expect(state.live.selection).toBe(state.me.spaceId);
  });

  it("does not apply or save a navigation response for a different authenticated space", async () => {
    const state = home();
    state.rpc.mockImplementation(async (procedure) =>
      procedure === "me"
        ? state.me
        : { ...state.navigation, current: { ...state.navigation.current, id: "foreign-space" } },
    );
    await state.loadBots();
    expect(state.setBots).not.toHaveBeenCalled();
    expect(state.saveInbox).not.toHaveBeenCalled();
  });
});
