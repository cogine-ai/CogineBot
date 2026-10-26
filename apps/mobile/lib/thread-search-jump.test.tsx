// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ThreadScrollState } from "@rakazo/core";
import * as core from "@rakazo/core";
import { openThreadWindow, withLiveStreamingProgress } from "@rakazo/core";
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { MobileSnapshot, mergeMobileSnapshot, protectMobileMessagePage } from "./api";
import { ThreadJumpAnchor } from "./thread-jump";
import { ThreadScrollBehavior } from "./thread-scroll";
import { reconcileVisibleThreadSnapshot } from "./thread-snapshot";

// Exercise the screen's handlers without importing its native dependencies.
const testFileUrl = import.meta.url;
const source = readFileSync(new URL("../app/thread.tsx", testFileUrl), "utf8");
const commitStart = source.indexOf("  function commitSnap(");
const commitHandler = source.slice(commitStart, source.indexOf("  useEffect(() => {", commitStart));
const jumpHandler = source.slice(
  source.indexOf("  async function applyMessageJump("),
  source.indexOf("  async function loadNewerMessages("),
);
const apiSource = readFileSync(new URL("./api.ts", testFileUrl), "utf8");
const apiHandlers = ts
  .transpileModule(
    `${apiSource
      .slice(
        apiSource.indexOf("function observeMobileMessages("),
        apiSource.indexOf("const MESSAGING_PROVIDER_LABELS"),
      )
      .replaceAll("export ", "")}\nreturn { mergeMobileSnapshot, protectMobileMessagePage };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  )
  .outputText.replaceAll("export ", "");
const api: {
  mergeMobileSnapshot: typeof mergeMobileSnapshot;
  protectMobileMessagePage: typeof protectMobileMessagePage;
} = new Function(...Object.keys(core), apiHandlers)(...Object.values(core));
const forwardHandler = source.slice(
  source.indexOf("  async function loadNewerMessages("),
  source.indexOf("  function showLatest("),
);
const raceHandlers = ts.transpileModule(
  `${commitHandler}\n${jumpHandler}\n${forwardHandler}\nreturn { jump: applyMessageJump, forward: loadNewerMessages, commit: commitSnap };`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  },
).outputText;
const handlers = ts.transpileModule(`${commitHandler}\n${jumpHandler}\nreturn applyMessageJump;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

describe("mobile search jump", () => {
  it.each(["botId", "groupId"] as const)(
    "publishes jumps within an unchanged, already-loaded %s thread",
    async (targetKey) => {
      const latest: MobileSnapshot = {
        threadId: "thread-1",
        cursor: 2,
        olderCursor: null,
        run: null,
        messages: [1, 2].map((seq) => ({
          id: `message-${seq}`,
          seq,
          role: "user",
          blocks: [{ kind: "text", text: `Message ${seq}` }],
        })),
      };
      const page = {
        threadId: latest.threadId,
        olderCursor: latest.olderCursor,
        messages: structuredClone(latest.messages),
      };
      const opened = openThreadWindow(latest, page);
      expect(opened.newerCursor).toBeNull();
      expect(reconcileVisibleThreadSnapshot(latest, opened.snapshot)).toBe(latest);
      const rpc = vi.fn(async (method: string) =>
        method === "threads/get" ? structuredClone(latest) : page,
      );
      let jump!: (target: { botId?: string; groupId?: string; messageId: string }) => Promise<void>;
      let renderedSnapshot: MobileSnapshot | null = null;
      const anchor = new ThreadJumpAnchor();

      function Probe() {
        const [snap, setSnap] = useState<MobileSnapshot | null>(latest);
        const [, setThreadScrollState] = useState<ThreadScrollState>({
          detached: false,
          unread: false,
        });
        const pinnedAroundRef = useRef<{ messageId: string } | null>(null);
        const jumpScrollTarget = useRef<string | null>(null);
        const scope = {
          rpc,
          liveSavedChatsScope: async () => ({}),
          isIntegrationsScopeCurrent: () => true,
          snapshotOrigin: useRef(null),
          setShowingSaved: vi.fn(),
          historyEpoch: useRef(0),
          jumpGeneration: useRef(0),
          activeGroupId: useRef(targetKey === "groupId" ? "target-1" : undefined),
          activeBotId: useRef(targetKey === "botId" ? "target-1" : undefined),
          expandedHistoryThread: useRef<string | null>(null),
          pinnedAroundRef,
          jumpAnchor: useRef(anchor),
          jumpScrollTarget,
          newerLoadFailed: useRef(false),
          joinPinnedAfterLayout: useRef<number | null>(null),
          pinnedScrollMetrics: useRef({ offset: 0, viewport: 0, content: 0 }),
          snapRef: useRef<MobileSnapshot | null>(latest),
          streamResponsesRef: useRef(false),
          setSnap,
          setThreadScrollState,
          scrollBehavior: useRef(new ThreadScrollBehavior()),
          openThreadWindow,
          ...api,
          withLiveStreamingProgress,
          reconcileVisibleThreadSnapshot,
        };
        jump = new Function(...Object.keys(scope), handlers)(...Object.values(scope));
        renderedSnapshot = snap;
        return (
          <div
            data-list={pinnedAroundRef.current ? "pinned" : "live"}
            data-target={jumpScrollTarget.current}
          />
        );
      }

      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        act(() => root.render(<Probe />));
        expect(container.querySelector('[data-list="live"]')).not.toBeNull();
        for (const seq of [1, 2]) {
          await act(() => jump({ [targetKey]: "target-1", messageId: `message-${seq}` }));
          expect(renderedSnapshot).toBe(latest);
          expect(container.querySelector('[data-list="pinned"]')?.getAttribute("data-target")).toBe(
            `message-${seq}`,
          );
          expect(anchor.onMessageLayout(`message-${seq}`, 200, seq - 1, 24)).toBe(176);
        }
      } finally {
        act(() => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["botId", "groupId"] as const)(
  "keeps a released card and run when an older %s around request finishes",
  async (targetKey) => {
    const initial: MobileSnapshot = {
      threadId: "thread-1",
      cursor: 10,
      olderCursor: 1,
      run: { id: "run-1", status: "waiting_takeover" },
      messages: [
        {
          id: "card",
          seq: 1,
          role: "bot",
          blocks: [{ kind: "computer", text: "Sign in", state: "Needs you" }],
        },
      ],
    };
    const pending = deferred<MobileSnapshot>();
    const page = {
      threadId: initial.threadId,
      olderCursor: null,
      messages: structuredClone(initial.messages),
    };
    const scope = raceScope(initial, targetKey, async (method: string) =>
      method === "threads/get" ? pending.promise : page,
    );
    const handlers = new Function(...Object.keys(scope), raceHandlers)(...Object.values(scope));
    const jump = handlers.jump({ [targetKey]: "target-1", messageId: "card" });
    await Promise.resolve();
    handlers.commit(released(initial));
    pending.resolve(initial);
    await jump;
    expect(scope.snapRef.current?.cursor).toBe(12);
    expect(scope.snapRef.current?.run?.status).toBe("queued");
    expect(
      scope.snapRef.current?.messages.find((message) => message.id === "card")?.blocks,
    ).toEqual([{ kind: "computer", text: "Sign in", state: "Done" }]);
    expect(scope.pinnedAroundRef.current?.messageId).toBe("card");
  },
);

it("keeps a released overlapping card when an older forward page finishes", async () => {
  const initial: MobileSnapshot = {
    threadId: "thread-1",
    cursor: 10,
    olderCursor: 0,
    run: { id: "run-1", status: "waiting_takeover" },
    messages: [
      { id: "old", seq: 0, role: "user", blocks: [{ kind: "text", text: "Old" }] },
      {
        id: "card",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "computer", text: "Sign in", state: "Needs you" }],
      },
      { id: "tail", seq: 3, role: "user", blocks: [{ kind: "text", text: "Latest" }] },
    ],
  };
  const page = deferred<unknown>();
  const scope = raceScope(initial, "botId", () => page.promise);
  scope.pinnedAroundRef.current = { messageId: "old", threadId: initial.threadId, newerCursor: 0 };
  const handlers = new Function(...Object.keys(scope), raceHandlers)(...Object.values(scope));
  const forward = handlers.forward();
  handlers.commit(released(initial));
  page.resolve({
    threadId: initial.threadId,
    olderCursor: null,
    messages: initial.messages.slice(0, 2),
    coveredThroughSeq: 1,
  });
  await forward;
  expect(scope.snapRef.current?.cursor).toBe(12);
  expect(scope.snapRef.current?.run?.status).toBe("queued");
  expect(scope.snapRef.current?.messages.find((message) => message.id === "card")?.blocks).toEqual([
    { kind: "computer", text: "Sign in", state: "Done" },
  ]);
});

function released(initial: MobileSnapshot): MobileSnapshot {
  return {
    ...initial,
    cursor: 12,
    run: { id: "run-1", status: "queued" },
    messages: initial.messages.map((message) =>
      message.id === "card"
        ? {
            ...message,
            observedEventSeq: 11,
            blocks: [{ kind: "computer", text: "Sign in", state: "Done" }],
          }
        : message,
    ),
  };
}

function raceScope(
  initial: MobileSnapshot,
  targetKey: "botId" | "groupId",
  rpc: (method: string, input?: unknown) => Promise<unknown>,
) {
  return {
    ...core,
    ...api,
    rpc,
    botId: targetKey === "botId" ? "target-1" : undefined,
    groupId: targetKey === "groupId" ? "target-1" : undefined,
    liveSavedChatsScope: async () => ({}),
    isIntegrationsScopeCurrent: () => true,
    snapshotOrigin: { current: null },
    setShowingSaved: vi.fn(),
    historyEpoch: { current: 0 },
    jumpGeneration: { current: 0 },
    activeGroupId: { current: targetKey === "groupId" ? "target-1" : undefined },
    activeBotId: { current: targetKey === "botId" ? "target-1" : undefined },
    expandedHistoryThread: { current: null },
    pinnedAroundRef: {
      current: null as { messageId: string; threadId: string; newerCursor: number | null } | null,
    },
    jumpAnchor: { current: new ThreadJumpAnchor() },
    jumpScrollTarget: { current: null },
    newerLoadFailed: { current: false },
    joinPinnedAfterLayout: { current: null },
    pinnedScrollMetrics: { current: { offset: 0, viewport: 0, content: 0 } },
    snapRef: { current: initial as MobileSnapshot | null },
    streamResponsesRef: { current: false },
    setSnap: vi.fn(),
    setThreadScrollState: vi.fn(),
    scrollBehavior: { current: new ThreadScrollBehavior() },
    reconcileVisibleThreadSnapshot,
    loadingNewerContent: { current: false },
    setLoadingNewer: vi.fn(),
    loadNewerNearEnd: vi.fn(),
    setError: vi.fn(),
    errorText: String,
    t: (text: string) => text,
  };
}
