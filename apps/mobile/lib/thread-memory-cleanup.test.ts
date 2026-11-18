import { readFileSync } from "node:fs";
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
function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === "showMemoryCleanupNotice")
    notify = `const ${node.getText(file)};`;
  if (ts.isFunctionDeclaration(node) && node.name?.text === "clearConversation")
    clear = node.getText(file);
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

function fixture(
  overrides: {
    blocked?: boolean;
    error?: string;
    focused?: boolean;
    otherBot?: boolean;
    persisted?: boolean;
  } = {},
) {
  let release!: (value: { ok: true; memoryCleanupUnconfirmed: true }) => void;
  const response = new Promise<{ ok: true; memoryCleanupUnconfirmed: true }>((resolve) => {
    release = resolve;
  });
  const initial: MobileSnapshot = {
    botId: "bot-one",
    threadId: "thread-one",
    cursor: 1,
    messages: [{ id: "old", seq: 1, role: "user", blocks: [] }],
    olderCursor: null,
    run: null,
    ...(overrides.persisted ? { memoryCleanupUnconfirmed: true as const } : {}),
  };
  const snapRef = { current: initial };
  const ownerRef = { current: "owner-one" };
  const botRef = { current: "bot-one" };
  const historyEpoch = { current: 1 };
  const blocked = { current: overrides.blocked ?? false };
  const alert = vi.fn();
  const commitSnap = vi.fn((snapshot: MobileSnapshot) => {
    snapRef.current = snapshot;
  });
  const scope = {
    useCallback: (callback: unknown) => callback,
    seenMemoryCleanupNotices: { current: new Set<string>() },
    memoryCleanupAlertBlocked: blocked,
    memoryCleanupOwner: "owner-one",
    memoryCleanupOwnerRef: ownerRef,
    Alert: { alert },
    t: (value: string) => value,
    botId: "bot-one",
    groupId: undefined,
    activeBotId: botRef,
    snapRef,
    snap: overrides.otherBot ? { ...initial, botId: "other-bot" } : initial,
    focused: overrides.focused ?? true,
    error: overrides.error,
    runError: null,
    historyEpoch,
    rpc: vi.fn(async () => response),
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
  const finish = async () => {
    release({ ok: true, memoryCleanupUnconfirmed: true });
    await response;
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    ...handlers,
    finish,
    snapRef,
    ownerRef,
    botRef,
    historyEpoch,
    blocked,
    alert,
    commitSnap,
  };
}

describe("native memory cleanup outcomes", () => {
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
    f.notify("thread-one", false);
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
