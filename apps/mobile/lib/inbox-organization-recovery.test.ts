import { readFileSync } from "node:fs";
import { loadFailureKind } from "@rakazo/core";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { InboxOrganizationState } from "./inbox-organization";
import { reconcileInboxOrganization } from "./inbox-organization";

const source = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

function homeSignIn(scope: Record<string, unknown>): () => void {
  const file = ts.createSourceFile(
    "index.tsx",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  let expression: string | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(file) === "onSignIn" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      expression = node.initializer.expression.getText(file);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!expression) throw new Error("Home sign-in action not found");
  return new Function(
    ...Object.keys(scope),
    ts.transpileModule(`return (${expression});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )(...Object.values(scope));
}

it.each(["wipe", "storage-failure", "new-login", "api-aba"] as const)(
  "fences the actual Home sign-in continuation after %s",
  async (mode) => {
    const state = home();
    const pending = deferred<boolean>();
    const replaceWithSignIn = vi.fn();
    const run = homeSignIn({
      ...state,
      clearRejectedSessionToken: () => pending.promise,
      replaceWithSignIn,
    });
    run();
    state.live.generation += mode === "new-login" ? 2 : 1;
    if (mode === "api-aba") state.live.apiGeneration += 2;
    pending.resolve(mode !== "storage-failure");
    await pending.promise;
    await Promise.resolve();
    expect(replaceWithSignIn).toHaveBeenCalledTimes(
      mode === "wipe" || mode === "storage-failure" ? 1 : 0,
    );
  },
);

it("opens the editable new-Bot route instead of creating from the inbox action", () => {
  const start = source.indexOf("  const runCreateAction = useCallback(");
  const end = source.indexOf("  useLayoutEffect", start);
  const router = { push: vi.fn() };
  const createQuickBot = vi.fn();
  const state = { busy: false, recoveryId: null };
  const organizationBusy = { current: false };
  const scope = {
    useCallback: (fn: unknown) => fn,
    router,
    createQuickBot,
    spaceActionRef: { current: state },
    organizationBusyRef: organizationBusy,
  };
  const run = new Function(
    ...Object.keys(scope),
    ts.transpileModule(`${source.slice(start, end)}\nreturn runCreateAction;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
  )(...Object.values(scope));
  run("bot");
  expect(router.push).toHaveBeenCalledExactlyOnceWith("/new");
  expect(createQuickBot).not.toHaveBeenCalled();
  organizationBusy.current = true;
  run("bot");
  expect(router.push).toHaveBeenCalledOnce();
});

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

function settingsReturn() {
  return { open: vi.fn(async () => undefined), focus: vi.fn(), blur: vi.fn(), cancel: vi.fn() };
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
    notificationPermissionRequest: { current: 0 },
    showNotificationPermission: vi.fn(),
    spaceActionRef: { current: { busy: false, recoveryId: null } },
    organizationBusyRef,
    inboxRequestId,
    currentApiBase: () => live.api,
    currentSessionGeneration: () => live.generation,
    selectedSpaceId: () => live.selection,
    setError,
    setLoadFailure: vi.fn(),
    loadFailureKind,
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
    adoptDeviceTimezone: vi.fn(async () => undefined),
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
    notificationFocused: { current: true },
    notificationSettingsReturn: { current: null as ReturnType<typeof settingsReturn> | null },
    createNotificationSettingsReturn: vi.fn((_options: Record<string, unknown>) =>
      settingsReturn(),
    ),
    openLiveNotificationSettings: vi.fn(async () => undefined),
    readChatNotificationPermission: vi.fn<(_current: () => boolean) => Promise<string | null>>(
      async () => "denied",
    ),
    Alert: {
      alert: vi.fn(
        (_title: string, _message: string, _buttons: Array<{ onPress?: () => void }>) => undefined,
      ),
    },
  };
  const showPermission = callback(
    "showNotificationPermission",
    "handleChatAction",
    Object.fromEntries(
      Object.entries(actions).filter(([key]) => key !== "showNotificationPermission"),
    ),
  );
  const handleSectionAction = callback("handleSectionAction", "renderItem", actions);
  const handleChatAction = callback("handleChatAction", "handleSectionAction", actions);
  return {
    live,
    navigation,
    trackedSave,
    handleSectionAction,
    handleChatAction,
    showPermission,
    ...actions,
  };
}

describe("confirmed mobile organization recovery", () => {
  it("keeps the failure category during a background poll and clears it after recovery", async () => {
    const state = home();
    state.rpc.mockRejectedValueOnce(
      Object.assign(new Error("server unavailable"), { status: 503 }),
    );
    await state.loadBots();
    expect(state.setLoadFailure).toHaveBeenLastCalledWith("server");
    state.setLoadFailure.mockClear();
    const read = deferred<typeof state.navigation>();
    state.rpc.mockImplementationOnce(() => read.promise);
    const loading = state.loadBots();
    expect(state.setLoadFailure).not.toHaveBeenCalled();
    read.resolve(state.navigation);
    await loading;
    expect(state.setLoadFailure).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("does not clear a failure when a poll belongs to an obsolete API owner", async () => {
    const state = home();
    const read = deferred<typeof state.navigation>();
    state.rpc.mockImplementationOnce(() => read.promise);
    const loading = state.loadBots();
    state.live.apiGeneration++;
    read.resolve(state.navigation);
    await loading;
    expect(state.setLoadFailure).not.toHaveBeenCalled();
  });

  it("clears a stale category so default-Space persistence errors remain visible", async () => {
    const state = home();
    state.live.selection = null;
    state.selectInitialSpace.mockImplementationOnce(async () => {
      state.live.selectionSeq++;
      return false;
    });
    await state.loadBots();
    expect(state.setLoadFailure).toHaveBeenLastCalledWith(null);
    expect(state.setError).toHaveBeenLastCalledWith("Could not save the default space");
    expect(state.setBots).not.toHaveBeenCalled();
  });

  it.each([
    [401, "auth"],
    [403, "space"],
    [503, "server"],
  ] as const)("keeps the last roster while classifying a %s read failure", async (status, kind) => {
    const state = home();
    state.rpc.mockRejectedValueOnce(Object.assign(new Error("read failed"), { status }));
    await state.loadBots();
    expect(state.setLoadFailure).toHaveBeenLastCalledWith(kind);
    expect(state.setBots).not.toHaveBeenCalled();
    expect(state.setGroups).not.toHaveBeenCalled();
    expect(state.setSearchInbox).not.toHaveBeenCalled();
  });
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

  it("arms Settings return only from the explicit alert action", async () => {
    const state = home();
    const allowed = vi.fn(async (_current: () => boolean) => undefined);
    let current = true;
    state.showPermission("denied", () => current, allowed);
    expect(state.createNotificationSettingsReturn).not.toHaveBeenCalled();
    state.Alert.alert.mock.calls.at(-1)![2][1]!.onPress!();
    expect(state.createNotificationSettingsReturn).toHaveBeenCalledOnce();
    const options = state.createNotificationSettingsReturn.mock.calls[0]![0] as {
      isCurrent: () => boolean;
      isFocused: () => boolean;
      onAllowed: (current: () => boolean) => Promise<void>;
    };
    expect(options.isCurrent()).toBe(true);
    expect(options.isFocused()).toBe(true);
    const queryCurrent = () => true;
    await options.onAllowed(queryCurrent);
    expect(allowed).toHaveBeenCalledExactlyOnceWith(queryCurrent);
    expect(state.notificationSettingsReturn.current?.open).toHaveBeenCalledOnce();
    current = false;
    expect(options.isCurrent()).toBe(false);
    state.notificationFocused.current = false;
    expect(options.isFocused()).toBe(false);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("does not register denied Retry before its separate explicit Settings action", async () => {
    const state = home();
    const allowed = vi.fn(async (_current: () => boolean) => undefined);
    state.showPermission("unknown", () => true, allowed);
    state.Alert.alert.mock.calls.at(-1)![2][1]!.onPress!();
    await vi.waitFor(() => expect(state.Alert.alert).toHaveBeenCalledTimes(2));
    expect(state.readChatNotificationPermission).toHaveBeenCalledOnce();
    expect(state.createNotificationSettingsReturn).not.toHaveBeenCalled();
    expect(allowed).not.toHaveBeenCalled();
    state.Alert.alert.mock.calls.at(-1)![2][1]!.onPress!();
    expect(state.createNotificationSettingsReturn).toHaveBeenCalledOnce();
    expect(state.notificationSettingsReturn.current?.open).toHaveBeenCalledOnce();
  });

  async function unknownNotificationRetry() {
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
    state.afterChatNotifyChange.mockResolvedValueOnce("unknown");
    state.showNotificationPermission.mockImplementation(state.showPermission);
    state.rpc.mockImplementation(async (procedure) => {
      if (procedure === "bots/update") return { ...chat, notifyOnFinish: true };
      throw new Error("Offline");
    });
    state.handleChatAction("bot", chat, "notifications");
    await state.trackedSave.mock.results[0]!.value;
    const retry = state.Alert.alert.mock.calls.at(-1)![2][1]!.onPress!;
    return { state, retry };
  }

  it("registers an allowed Retry using the saved Home context without another save or follow-up", async () => {
    const { state, retry } = await unknownNotificationRetry();
    state.readChatNotificationPermission.mockResolvedValue("allowed");
    retry();
    await vi.waitFor(() => expect(state.registerPushToken).toHaveBeenCalledOnce());
    expect(state.registerPushToken).toHaveBeenCalledExactlyOnceWith({
      permission: "allowed",
      requestContext: await state.spaceRequestContext.mock.results[0]!.value,
      isCurrent: expect.any(Function),
    });
    expect(state.rpc.mock.calls.filter(([p]) => p === "bots/update")).toHaveLength(1);
    expect(state.afterChatNotifyChange).toHaveBeenCalledOnce();
    expect(state.createNotificationSettingsReturn).not.toHaveBeenCalled();
    expect(state.inboxState.current.bots[0]?.notifyOnFinish).toBe(true);
  });

  it.each(["denied", "unknown", null])(
    "does not register Home Retry permission %s",
    async (status) => {
      const { state, retry } = await unknownNotificationRetry();
      state.readChatNotificationPermission.mockResolvedValue(status);
      retry();
      await vi.waitFor(() => expect(state.readChatNotificationPermission).toHaveBeenCalledOnce());
      expect(state.registerPushToken).not.toHaveBeenCalled();
      expect(state.inboxState.current.bots[0]?.notifyOnFinish).toBe(true);
    },
  );

  it("does not undo enabled Home preference if allowed Retry registration rejects", async () => {
    const { state, retry } = await unknownNotificationRetry();
    state.readChatNotificationPermission.mockResolvedValue("allowed");
    state.registerPushToken.mockRejectedValue(new Error("Device unavailable"));
    retry();
    await vi.waitFor(() => expect(state.registerPushToken).toHaveBeenCalledOnce());
    expect(state.inboxState.current.bots[0]?.notifyOnFinish).toBe(true);
    expect(state.reportOrganizationError).not.toHaveBeenCalled();
    expect(state.Alert.alert).toHaveBeenCalledOnce();
  });

  it.each([
    "api",
    "session",
    "Space",
    "selection",
    "new notification",
    "disabled",
    "blur",
    "unmount",
    "new Retry",
  ])("drops a Home Retry query after %s ownership changes", async (change) => {
    const { state, retry } = await unknownNotificationRetry();
    const read = deferred<string>();
    state.readChatNotificationPermission.mockImplementationOnce(() => read.promise);
    retry();
    if (change === "api") state.live.apiGeneration++;
    else if (change === "session") state.live.generation++;
    else if (change === "Space") state.live.spaceGeneration++;
    else if (change === "selection") state.live.selectionSeq++;
    else if (change === "new notification") state.notificationRevision.current++;
    else if (change === "disabled") state.inboxState.current.bots[0]!.notifyOnFinish = false;
    else if (change === "blur") {
      state.notificationFocused.current = false;
      state.notificationPermissionRequest.current++;
      state.notificationFocused.current = true;
    } else if (change === "unmount") state.mounted.current = false;
    else retry();
    read.resolve("allowed");
    await Promise.resolve();
    await Promise.resolve();
    expect(state.registerPushToken).not.toHaveBeenCalled();
  });

  it("invalidates the Home Retry token predicate when another Retry starts", async () => {
    const { state, retry } = await unknownNotificationRetry();
    const pending = deferred<undefined>();
    state.readChatNotificationPermission.mockResolvedValueOnce("allowed");
    state.registerPushToken.mockImplementationOnce(() => pending.promise);
    retry();
    await vi.waitFor(() => expect(state.registerPushToken).toHaveBeenCalledOnce());
    const current = (state.registerPushToken.mock.calls[0]![0] as { isCurrent: () => boolean })
      .isCurrent;
    expect(current()).toBe(true);
    retry();
    expect(current()).toBe(false);
    pending.resolve(undefined);
  });

  it("cancels a pending Settings visit before starting a newer explicit Retry", () => {
    const state = home();
    const previous = settingsReturn();
    state.notificationSettingsReturn.current = previous;
    state.showPermission(
      "unknown",
      () => true,
      async () => undefined,
    );
    state.Alert.alert.mock.calls.at(-1)![2][1]!.onPress!();
    expect(previous.cancel).toHaveBeenCalledOnce();
    expect(state.notificationSettingsReturn.current).toBeNull();
    expect(state.readChatNotificationPermission).toHaveBeenCalledOnce();
  });

  it("replaces an earlier Settings return ticket before opening Settings again", () => {
    const state = home();
    state.showPermission(
      "denied",
      () => true,
      async () => undefined,
    );
    const press = state.Alert.alert.mock.calls.at(-1)![2][1]!.onPress!;
    press();
    const previous = state.notificationSettingsReturn.current!;
    press();
    expect(previous.cancel).toHaveBeenCalledOnce();
    expect(state.createNotificationSettingsReturn).toHaveBeenCalledTimes(2);
    expect(state.notificationSettingsReturn.current).not.toBe(previous);
  });

  it("keeps Settings recovery tied to the latest enabled Bot and saved owner", async () => {
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
    state.afterChatNotifyChange.mockResolvedValueOnce("denied");
    state.rpc.mockImplementation(async (procedure) => {
      if (procedure === "bots/update") return { ...chat, notifyOnFinish: true };
      throw new Error("Offline");
    });
    state.handleChatAction("bot", chat, "notifications");
    await state.trackedSave.mock.results[0]!.value;
    const [status, current, allowed] = state.showNotificationPermission.mock
      .calls[0]! as unknown as [string, () => boolean, (current: () => boolean) => Promise<void>];
    expect(status).toBe("denied");
    expect(current()).toBe(true);
    state.inboxState.current.bots[0]!.notifyOnFinish = false;
    expect(current()).toBe(false);
    state.inboxState.current.bots[0]!.notifyOnFinish = true;
    const queryCurrent = () => true;
    await allowed(queryCurrent);
    expect(state.registerPushToken).toHaveBeenCalledExactlyOnceWith({
      permission: "allowed",
      requestContext: await state.spaceRequestContext.mock.results[0]!.value,
      isCurrent: queryCurrent,
    });
    state.live.selectionSeq++;
    expect(current()).toBe(false);
  });

  it("cancels a Settings ticket before starting a newer notification intent", async () => {
    const state = home();
    const previous = settingsReturn();
    state.notificationSettingsReturn.current = previous;
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
      if (procedure === "bots/update") return { ...chat, notifyOnFinish: true };
      throw new Error("Offline");
    });
    state.handleChatAction("bot", chat, "notifications");
    expect(previous.cancel).toHaveBeenCalledOnce();
    expect(state.notificationSettingsReturn.current).toBeNull();
    await state.trackedSave.mock.results[0]!.value;
  });

  it("cleans up Settings return ownership on Home scope changes, focus and unmount", () => {
    let unmount!: () => void;
    let focus!: () => () => void;
    let scopeChanged!: () => void;
    const unsubscribe = vi.fn();
    const first = settingsReturn();
    const notificationSettingsReturn = {
      current: first as ReturnType<typeof settingsReturn> | null,
    };
    const notificationFocused = { current: false };
    const mounted = { current: false };
    const inboxRequestId = { current: 0 };
    const notificationPermissionRequest = { current: 0 };
    const dependencies = {
      notificationPermissionRequest,
      mounted,
      inboxRequestId,
      notificationSettingsReturn,
      notificationFocused,
      subscribeMobileScope: (listener: () => void) => {
        scopeChanged = listener;
        return unsubscribe;
      },
      useEffect: (setup: () => () => void) => {
        unmount = setup();
      },
      useCallback: (setup: () => () => void) => setup,
      useFocusEffect: (setup: () => () => void) => {
        focus = setup;
      },
    };
    const start = source.indexOf("  useEffect(() => {\n    mounted.current = true;");
    const end = source.indexOf("  const spaceActionRef", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    new Function(
      ...Object.keys(dependencies),
      ts.transpileModule(source.slice(start, end), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText,
    )(...Object.values(dependencies));
    const blur = focus();
    expect(mounted.current).toBe(true);
    expect(notificationFocused.current).toBe(true);
    expect(first.focus).toHaveBeenCalledOnce();
    blur();
    expect(notificationFocused.current).toBe(false);
    expect(first.blur).toHaveBeenCalledOnce();
    expect(notificationPermissionRequest.current).toBe(1);
    scopeChanged();
    expect(notificationPermissionRequest.current).toBe(2);
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(notificationSettingsReturn.current).toBeNull();
    const later = settingsReturn();
    notificationSettingsReturn.current = later;
    unmount();
    expect(mounted.current).toBe(false);
    expect(later.cancel).toHaveBeenCalledOnce();
    expect(notificationSettingsReturn.current).toBeNull();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(inboxRequestId.current).toBe(1);
    expect(notificationPermissionRequest.current).toBe(3);
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
