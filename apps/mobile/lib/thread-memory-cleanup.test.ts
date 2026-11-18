import { readFileSync } from "node:fs";
import { applyThreadClearReceipt, hasNewThreadWork, observeMemoryCleanup } from "@rakazo/core";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { MobileSnapshot } from "./api";

// Run the actual screen callbacks with offline native/state seams.
const text = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile(
  "thread.tsx",
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let notify = "";
let clear = "";
let effect = "";
let commit = "";
let ownerExpression = "";
function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === "memoryCleanupOwner")
    ownerExpression = node.initializer!.getText(file);
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === "showMemoryCleanupNotice")
    notify = `const ${node.getText(file)};`;
  if (ts.isFunctionDeclaration(node) && node.name?.text === "clearConversation")
    clear = node.getText(file);
  if (ts.isFunctionDeclaration(node) && node.name?.text === "commitSnap")
    commit = node.getText(file);
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(file) === "useEffect" &&
    node.arguments[0]?.getText(file).includes("snap?.memoryCleanupUnconfirmed")
  )
    effect = node.arguments[0].getText(file);
  ts.forEachChild(node, collect);
}
collect(file);
if (!notify || !clear || !effect) throw new Error("Missing actual cleanup callbacks");
const code = ts.transpileModule(
  `${notify}\n${clear}\nreturn { clear: clearConversation, notify: showMemoryCleanupNotice, effect: ${effect} };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

type ClearReceipt = {
  ok: true;
  threadId?: string;
  clearEventSeq?: number;
  cancelledRunIds?: string[];
  memoryCleanupUnconfirmed?: true;
  memoryCleanupPending?: boolean;
  memoryCleanupCursor?: number;
};

function fixture(
  overrides: {
    blocked?: boolean;
    error?: string;
    focused?: boolean;
    otherBot?: boolean;
    persisted?: boolean;
    owner?: string;
  } = {},
) {
  const responses: Array<{
    promise: Promise<ClearReceipt>;
    release: (value: ClearReceipt) => void;
    reject: (error: Error) => void;
  }> = [];
  function nextResponse() {
    let release!: (value: ClearReceipt) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ClearReceipt>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    responses.push({ promise, release, reject });
    return promise;
  }
  const initial: MobileSnapshot = {
    botId: "bot-one",
    threadId: "thread-one",
    cursor: 1,
    messages: [{ id: "old", seq: 1, role: "user", blocks: [] }],
    olderCursor: null,
    run: null,
    ...(overrides.persisted ? { memoryCleanupUnconfirmed: true as const } : {}),
  };
  const snapRef = { current: overrides.otherBot ? { ...initial, botId: "other-bot" } : initial };
  const ownerRef = { current: overrides.owner ?? "owner-one" };
  const botRef = { current: "bot-one" };
  const historyEpoch = { current: 1 };
  const blocked = { current: overrides.blocked ?? false };
  const alert = vi.fn();
  const commitSnap = vi.fn((snapshot: MobileSnapshot) => {
    snapRef.current = snapshot;
  });
  const scope = {
    useCallback: (callback: unknown) => callback,
    seenMemoryCleanupNotices: { current: new Map<string, boolean>() },
    pendingMemoryCleanupClears: { current: new Set<string>() },
    pendingMemoryCleanupEvents: { current: new Map() },
    memoryCleanupAlertBlocked: blocked,
    memoryCleanupOwner: ownerRef.current,
    memoryCleanupOwnerRef: ownerRef,
    Alert: { alert },
    t: (value: string) => value,
    botId: "bot-one",
    groupId: undefined,
    activeBotId: botRef,
    snapRef,
    snap: snapRef.current,
    focused: overrides.focused ?? true,
    error: overrides.error,
    runError: null,
    historyEpoch,
    rpc: vi.fn(async () => nextResponse()),
    observeMemoryCleanup,
    hasNewThreadWork,
    applyThreadClearReceipt,
    modelPolicyRefusal: false,
    refresh: vi.fn(async () => undefined),
    expandedHistoryThread: { current: null },
    pinnedAroundRef: { current: null },
    jumpScrollTarget: { current: null },
    jumpAnchor: { current: { release: vi.fn() } },
    commitSnap,
    errorText: (_error: unknown, fallback: string) => fallback,
  };
  const handlers = new Function(...Object.keys(scope), code)(...Object.values(scope)) as {
    clear(): void;
    notify(id: string, immediate: boolean): void;
    effect(): void;
  };
  const finish = async (receipt: ClearReceipt = { ok: true, memoryCleanupUnconfirmed: true }) => {
    const response = responses.shift()!;
    response.release(receipt);
    await response.promise;
    await Promise.resolve();
    await Promise.resolve();
  };
  const fail = async () => {
    const response = responses.shift()!;
    response.reject(new Error("response lost"));
    await response.promise.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    ...handlers,
    effect: () => {
      const current = { ...scope, snap: snapRef.current };
      const callbacks = new Function(...Object.keys(current), code)(...Object.values(current));
      callbacks.effect();
    },
    finish,
    fail,
    snapRef,
    ownerRef,
    botRef,
    historyEpoch,
    blocked,
    alert,
    commitSnap,
    pendingMemoryCleanupEvents: scope.pendingMemoryCleanupEvents,
    rpc: scope.rpc,
    rerenderOwner: (owner: string) => {
      ownerRef.current = owner;
      scope.memoryCleanupOwner = owner;
      return new Function(...Object.keys(scope), code)(...Object.values(scope)) as typeof handlers;
    },
  };
}

describe("native memory cleanup outcomes", () => {
  it("reports each explicit clear while replayed background state stays deduplicated", async () => {
    const f = fixture();
    f.clear();
    await f.finish();
    f.effect();
    expect(f.alert).toHaveBeenCalledOnce();
    f.clear();
    f.effect();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.alert).toHaveBeenCalledOnce();
    await f.finish();
    f.effect();
    expect(f.alert).toHaveBeenCalledTimes(2);
  });
  it("keeps one outstanding clear per thread until its receipt arrives", async () => {
    const f = fixture();
    f.clear();
    f.clear();
    expect(f.rpc).toHaveBeenCalledOnce();
    expect(f.alert).not.toHaveBeenCalled();
    await f.finish();
    expect(f.alert).toHaveBeenCalledOnce();
  });
  it("preserves newer messages and Run at the same history epoch", async () => {
    const f = fixture();
    f.clear();
    const newer = [{ id: "new", seq: 2, role: "user" as const, blocks: [] }];
    f.snapRef.current = {
      ...f.snapRef.current,
      cursor: 30,
      messages: newer,
      run: { id: "new-run", status: "running" },
    };
    await f.finish();
    expect(f.snapRef.current.messages).toEqual(newer);
    expect(f.snapRef.current.run?.id).toBe("new-run");
  });
  it("uses the clear commit boundary without consuming newer messages or the send receipt", async () => {
    const f = fixture();
    f.clear();
    f.snapRef.current = {
      ...f.snapRef.current,
      cursor: 14,
      messages: [
        { id: "before", seq: 2, observedEventSeq: 11, role: "user", blocks: [] },
        { id: "after", seq: 3, observedEventSeq: 13, role: "user", blocks: [] },
      ],
      run: { id: "new-run", status: "queued" },
      activeRuns: [{ id: "new-run", status: "queued" }],
    };
    await f.finish({
      ok: true,
      threadId: "thread-one",
      clearEventSeq: 12,
      cancelledRunIds: [],
      memoryCleanupCursor: 20,
    });
    expect(f.snapRef.current.messages.map((message) => message.id)).toEqual(["after"]);
    expect(f.snapRef.current.run?.id).toBe("new-run");
    expect(f.snapRef.current.cursor).toBe(14);
    expect(f.snapRef.current.memoryCleanupCursor).toBe(20);
  });
  it("a provisional native notice cannot consume a later recorded failure", () => {
    const f = fixture();
    f.snapRef.current = { ...f.snapRef.current, memoryCleanupPending: true };
    f.effect();
    expect(f.alert).toHaveBeenCalledOnce();
    f.snapRef.current = {
      ...f.snapRef.current,
      memoryCleanupPending: false,
      memoryCleanupUnconfirmed: true,
    };
    f.effect();
    expect(f.alert).toHaveBeenCalledTimes(2);
    f.effect();
    expect(f.alert).toHaveBeenCalledTimes(2);
  });
  it("guards overlapping cold clears before the first snapshot exists", async () => {
    const f = fixture();
    f.snapRef.current = null as unknown as MobileSnapshot;
    f.clear();
    f.clear();
    expect(f.rpc).toHaveBeenCalledOnce();
    await f.finish({
      ok: true,
      threadId: "thread-one",
      memoryCleanupUnconfirmed: true,
      memoryCleanupCursor: 10,
    });
    expect(f.pendingMemoryCleanupEvents.current.get("thread-one")).toMatchObject({
      owner: "owner-one",
      seq: 10,
      unconfirmed: true,
    });
    expect(f.alert).not.toHaveBeenCalled();
    expect(f.commitSnap).not.toHaveBeenCalled();
    // Exactly one response exists; a second clear now gets a fresh response.
    f.snapRef.current = {
      botId: "bot-one",
      threadId: "thread-one",
      cursor: 1,
      messages: [],
      olderCursor: null,
      run: null,
    };
    f.clear();
    await f.finish();
    expect(f.alert).toHaveBeenCalledOnce();
  });

  it("rejects a returned thread that conflicts with the known request after its snapshot unloads", async () => {
    const f = fixture();
    f.clear();
    f.snapRef.current = null as unknown as MobileSnapshot;
    await f.finish({ ok: true, threadId: "other-thread", memoryCleanupUnconfirmed: true });
    expect(f.pendingMemoryCleanupEvents.current.size).toBe(0);
    expect(f.alert).not.toHaveBeenCalled();
  });
  it("does not replace newer buffered settlement with an older cold receipt", async () => {
    const f = fixture();
    f.snapRef.current = null as unknown as MobileSnapshot;
    f.clear();
    f.pendingMemoryCleanupEvents.current.set("thread-one", {
      owner: "owner-one",
      seq: 20,
      pending: false,
    });
    await f.finish({
      ok: true,
      threadId: "thread-one",
      memoryCleanupCursor: 10,
      memoryCleanupPending: true,
    });
    expect(f.pendingMemoryCleanupEvents.current.get("thread-one")).toMatchObject({
      seq: 20,
      pending: false,
    });
  });
  it("keeps a pending clear owned when profile readiness changes", async () => {
    const owner = (profileScope: unknown, apiGeneration = 1, spaceEpoch = 1) =>
      new Function(
        "ownerUserId",
        "sessionEpoch",
        "currentApiBaseGeneration",
        "spaceEpoch",
        "profileScope",
        `return ${ownerExpression};`,
      )("user-one", 1, () => apiGeneration, spaceEpoch, profileScope) as string;
    const initial = owner(null);
    const ready = owner({ apiBase: "https://app.example.test", userId: "user-one" });
    expect(ready).toBe(initial);
    expect(owner(null, 2)).not.toBe(initial);
    expect(owner(null, 1, 2)).not.toBe(initial);
    const f = fixture({ owner: initial });
    f.clear();
    f.rerenderOwner(ready).clear();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.rpc).toHaveBeenCalledOnce();
    await f.finish();
    expect(f.alert).toHaveBeenCalledOnce();
  });
  it("preserves a newer native send receipt without a cursor advance", async () => {
    const f = fixture();
    f.clear();
    f.snapRef.current = {
      ...f.snapRef.current,
      run: { id: "new-receipt-run", status: "queued" },
      activeRuns: [{ id: "new-receipt-run", status: "queued" }],
    };
    await f.finish();
    expect(f.snapRef.current.run?.id).toBe("new-receipt-run");
    expect(f.snapRef.current.activeRuns?.map((run) => run.id)).toEqual(["new-receipt-run"]);
  });
  it("does not show a false warning after pending cleanup is confirmed", async () => {
    const f = fixture();
    f.clear();
    f.snapRef.current = { ...f.snapRef.current, memoryCleanupPending: true };
    f.effect();
    expect(f.alert).not.toHaveBeenCalled();
    await f.finish({ ok: true, memoryCleanupPending: false, memoryCleanupCursor: 10 });
    f.effect();
    expect(f.snapRef.current.memoryCleanupPending).toBe(false);
    expect(f.alert).not.toHaveBeenCalled();
  });
  it("does not overwrite newer pending state with a late clear receipt", async () => {
    const f = fixture();
    f.clear();
    f.historyEpoch.current++;
    f.snapRef.current = { ...f.snapRef.current, cursor: 30, memoryCleanupPending: true };
    await f.finish({ ok: true, memoryCleanupPending: false, memoryCleanupCursor: 20 });
    expect(f.snapRef.current.memoryCleanupPending).toBe(true);
  });
  it.each([
    ["sticky", false],
    ["sticky", true],
    ["pending", false],
    ["pending", true],
  ] as const)(
    "rechecks %s cleanup after dismissing a lost-response error (owner changes: %s)",
    async (kind, ownerChanges) => {
      const f = fixture();
      f.clear();
      f.snapRef.current = {
        ...f.snapRef.current,
        ...(kind === "sticky"
          ? { memoryCleanupUnconfirmed: true as const }
          : { memoryCleanupPending: true }),
      };
      f.notify("thread-one", false);
      expect(f.alert).not.toHaveBeenCalled();
      await f.fail();
      expect(f.alert).toHaveBeenCalledOnce();
      expect(f.alert.mock.calls[0]?.[0]).toBe("Could not clear conversation");
      f.notify("thread-one", false);
      expect(f.alert).toHaveBeenCalledOnce();
      if (ownerChanges) f.ownerRef.current = "other-owner";
      const acknowledge = f.alert.mock.calls[0]?.[2]?.[0]?.onPress;
      expect(acknowledge).toBeTypeOf("function");
      acknowledge();
      expect(f.alert).toHaveBeenCalledTimes(ownerChanges ? 1 : 2);
      if (!ownerChanges) {
        expect(f.alert).toHaveBeenLastCalledWith(
          "Clear conversation",
          "External memory cleanup could not be confirmed.",
        );
        f.notify("thread-one", false);
        expect(f.alert).toHaveBeenCalledTimes(2);
      }
    },
  );
  it("defers metadata that precedes a clear receipt so its native alert uses the immediate copy", async () => {
    const f = fixture();
    f.clear();
    f.notify("thread-one", false);
    expect(f.alert).not.toHaveBeenCalled();
    await f.finish();
    expect(f.alert).toHaveBeenCalledExactlyOnceWith(
      "Clear conversation",
      "Messages cleared. External memory cleanup could not be confirmed.",
    );
  });
  it("clears local rows and reports uncertainty once without changing the snapshot contract", async () => {
    const f = fixture();
    f.clear();
    await f.finish();
    expect(f.snapRef.current.messages).toEqual([]);
    expect(f.snapRef.current.memoryCleanupUnconfirmed).toBe(true);
    expect(f.alert).toHaveBeenCalledExactlyOnceWith(
      "Clear conversation",
      "Messages cleared. External memory cleanup could not be confirmed.",
    );
    f.notify("thread-one", false);
    expect(f.alert).toHaveBeenCalledOnce();
  });
  it("defers a native notice while another error is active", async () => {
    const f = fixture({ blocked: true });
    f.clear();
    await f.finish();
    expect(f.alert).not.toHaveBeenCalled();
    expect(f.snapRef.current.memoryCleanupUnconfirmed).toBe(true);
    f.blocked.current = false;
    f.effect();
    expect(f.alert).toHaveBeenCalledExactlyOnceWith(
      "Clear conversation",
      "External memory cleanup could not be confirmed.",
    );
  });
  it.each(["owner", "bot", "thread"])(
    "ignores a completed clear after the %s changes",
    async (change) => {
      const f = fixture();
      f.clear();
      if (change === "owner") f.ownerRef.current = "other-owner";
      if (change === "bot") f.botRef.current = "other-bot";
      if (change === "thread")
        f.snapRef.current = { ...f.snapRef.current, threadId: "other-thread" };
      const before = f.snapRef.current;
      await f.finish();
      expect(f.alert).not.toHaveBeenCalled();
      expect(f.commitSnap).not.toHaveBeenCalled();
      expect(f.snapRef.current).toBe(before);
    },
  );
  it("preserves post-clear messages when its receipt arrives late", async () => {
    const f = fixture();
    f.clear();
    f.historyEpoch.current += 1;
    const newer = [{ id: "new", seq: 2, role: "user" as const, blocks: [] }];
    f.snapRef.current = {
      ...f.snapRef.current,
      messages: newer,
      run: { id: "new-run", status: "running" },
    };
    await f.finish();
    expect(f.snapRef.current.messages).toEqual(newer);
    expect(f.snapRef.current.run?.id).toBe("new-run");
    expect(f.snapRef.current.memoryCleanupUnconfirmed).toBe(true);
  });
  it("shows a persisted reload notice only once across rerenders", () => {
    const f = fixture({ persisted: true });
    f.effect();
    f.effect();
    expect(f.alert).toHaveBeenCalledExactlyOnceWith(
      "Clear conversation",
      "External memory cleanup could not be confirmed.",
    );
  });
  it.each([{ focused: false }, { error: "another error" }, { otherBot: true }])(
    "suppresses a reload notice outside the visible error-free target %j",
    (options) => {
      const f = fixture({ ...options, persisted: true });
      f.effect();
      expect(f.alert).not.toHaveBeenCalled();
    },
  );
});

describe("cold jump cleanup metadata commit", () => {
  it.each(["current", "receipt", "receipt-clear", "other-owner", "old-subscription"])(
    "applies only the current reader's buffered flag: %s",
    (reader) => {
      expect(commit).not.toBe("");
      const pendingMemoryCleanupEvents = {
        current: new Map([
          [
            "thread-one",
            {
              owner: "owner-one",
              ...(reader.startsWith("receipt") ? {} : { subscription: 1 }),
              ...(reader === "receipt-clear"
                ? { clearEventSeq: 12, cancelledRunIds: ["new-run"] }
                : {}),
              seq: 10,
              unconfirmed: true,
              pending: true,
            },
          ],
        ]),
      };
      const snapRef = { current: null as MobileSnapshot | null };
      const next: MobileSnapshot = {
        botId: "bot-one",
        threadId: "thread-one",
        cursor: 5,
        messages: [{ id: "pinned", seq: 1, role: "user", blocks: [] }],
        olderCursor: 1,
        run: { id: "new-run", status: "running" },
      };
      const source = ts.transpileModule(`${commit}; return commitSnap;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const scope = {
        pendingMemoryCleanupEvents,
        applyThreadClearReceipt,
        observeMemoryCleanup,
        snapRef,
        memoryCleanupOwnerRef: { current: reader === "other-owner" ? "owner-two" : "owner-one" },
        liveSubscriptionGeneration: { current: reader === "old-subscription" ? 2 : 1 },
        streamResponsesRef: { current: true },
        withLiveStreamingProgress: (value: MobileSnapshot) => value,
        setSnap: vi.fn(),
        reconcileVisibleThreadSnapshot: (_old: unknown, value: MobileSnapshot) => value,
      };
      const commitSnapshot = new Function(...Object.keys(scope), source)(...Object.values(scope));
      commitSnapshot(next);
      expect(snapRef.current?.memoryCleanupUnconfirmed).toBe(
        reader === "current" || reader.startsWith("receipt") ? true : undefined,
      );
      expect(snapRef.current?.cursor).toBe(reader === "receipt-clear" ? 12 : 5);
      if (reader === "receipt-clear") {
        expect(snapRef.current?.messages).toEqual([]);
        expect(snapRef.current?.run).toBeNull();
      } else {
        expect(snapRef.current?.messages).toBe(next.messages);
        expect(snapRef.current?.run).toBe(next.run);
      }
      expect(pendingMemoryCleanupEvents.current.size).toBe(0);
    },
  );
});
