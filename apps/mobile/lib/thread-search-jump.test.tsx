// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ThreadScrollState } from "@rakazo/core";
import * as core from "@rakazo/core";
import { openThreadWindow, withLiveStreamingProgress } from "@rakazo/core";
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type {
  applyMobileThreadEvent,
  MobileSnapshot,
  mergeMobileSnapshot,
  protectMobileMessagePage,
} from "./api";
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
      .replaceAll(
        "export ",
        "",
      )}\n${apiSource.slice(apiSource.indexOf("export function applyMobileThreadEvent("), apiSource.indexOf("\nexport {", apiSource.indexOf("export function applyMobileThreadEvent("))).replaceAll("export ", "")}\nreturn { mergeMobileSnapshot, protectMobileMessagePage, applyMobileThreadEvent };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  )
  .outputText.replaceAll("export ", "");
const api: {
  applyMobileThreadEvent: typeof applyMobileThreadEvent;
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
  "keeps a released card and run while an earlier %s page is pending",
  async (targetKey) => {
    for (const origin of ["cold", "cross-high", "same-thread"]) {
      const initial: MobileSnapshot = {
        ...jumpCard("target-thread", 10, "Needs you"),
        run: { id: "run-1", status: "waiting_takeover" },
      };
      const page = deferred<unknown>();
      const started = deferred<void>();
      const scope = raceScope(
        origin === "cold"
          ? null
          : origin === "cross-high"
            ? jumpCard("other-thread", 100, "Needs you")
            : initial,
        targetKey,
        async (method) => {
          if (method === "threads/get") return initial;
          started.resolve();
          return page.promise;
        },
      );
      const handlers = new Function(...Object.keys(scope), raceHandlers)(...Object.values(scope));
      const jump = handlers.jump({ [targetKey]: "target-1", messageId: "card" });
      await started.promise;
      handlers.commit(
        api.applyMobileThreadEvent(initial, {
          type: "thread.message.updated",
          threadId: initial.threadId,
          seq: 11,
          runId: "run-1",
          payload: {
            messageId: "card",
            messageSeq: 1,
            role: "bot",
            blocks: [{ kind: "computer", text: "Sign in", state: "Done" }],
          },
        }),
      );
      handlers.commit(
        api.applyMobileThreadEvent(scope.snapRef.current, {
          type: "computer.takeover.released",
          threadId: initial.threadId,
          seq: 12,
          runId: "run-1",
          payload: { reason: "done" },
        }),
      );
      page.resolve({ threadId: initial.threadId, olderCursor: null, messages: initial.messages });
      await jump;
      expect(scope.snapRef.current?.cursor, origin).toBe(12);
      expect(scope.snapRef.current?.run?.status, origin).toBe("queued");
      expect(
        scope.snapRef.current?.messages.find((message) => message.id === "card")?.blocks,
        origin,
      ).toEqual([{ kind: "computer", text: "Sign in", state: "Done" }]);
      expect(scope.pinnedAroundRef.current?.messageId, origin).toBe("card");
    }
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
  initial: MobileSnapshot | null,
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

const jumpOrigins = ["cold", "cross-low", "cross-equal", "cross-high", "same-thread"] as const;
it.each(["botId", "groupId"] as const)(
  "reads a %s around page after its target snapshot for every origin",
  async (targetKey) => {
    for (const origin of jumpOrigins) {
      const target = jumpCard("target-thread", 20, "Done");
      const originCursor = {
        "cross-low": 5,
        "cross-equal": 20,
        "cross-high": 100,
        "same-thread": 10,
      };
      const initial =
        origin === "cold"
          ? null
          : jumpCard(
              origin === "same-thread" ? target.threadId : "other-thread",
              originCursor[origin],
              "Needs you",
            );
      const read = deferred<MobileSnapshot>();
      let server = jumpCard(target.threadId, 19, "Needs you");
      let pageReads = 0;
      const scope = raceScope(initial, targetKey, async (method) => {
        if (method === "threads/get") {
          const result = await read.promise;
          server = result;
          return result;
        }
        pageReads += 1;
        return {
          threadId: server.threadId,
          messages: structuredClone(server.messages),
          olderCursor: null,
        };
      });
      const handlers = new Function(...Object.keys(scope), raceHandlers)(...Object.values(scope));
      const jump = handlers.jump({ [targetKey]: "target-1", messageId: "card" });
      await Promise.resolve();
      await Promise.resolve();
      expect.soft(pageReads, origin).toBe(0);
      read.resolve(target);
      await jump;
      expect.soft(pageReads, origin).toBe(1);
      expect.soft(scope.snapRef.current?.threadId, origin).toBe(target.threadId);
      expect.soft(scope.snapRef.current?.cursor, origin).toBe(20);
      expect
        .soft(
          scope.snapRef.current?.messages.find((message) => message.id === "card")?.blocks,
          origin,
        )
        .toEqual(target.messages[0]!.blocks);
      expect.soft(scope.pinnedAroundRef.current?.messageId, origin).toBe("card");
      expect.soft(scope.jumpScrollTarget.current, origin).toBe("card");
    }
  },
);

it.each(["botId", "groupId"] as const)(
  "preserves receipt projection and post-clear absence for a cold %s jump",
  async (targetKey) => {
    for (const deleted of [false, true]) {
      const read = deferred<MobileSnapshot>();
      const receipt = {
        id: "receipt",
        seq: 9,
        role: "bot" as const,
        blocks: [
          {
            kind: "bot_message_sent" as const,
            toBotId: "peer",
            toBotName: "Peer",
            text: "A receipt",
          },
        ],
      };
      const target: MobileSnapshot = {
        threadId: "target-thread",
        cursor: 20,
        olderCursor: null,
        run: null,
        messages: [
          { id: "base", seq: 1, role: "user", blocks: [{ kind: "text", text: "Earlier" }] },
        ],
      };
      let serverMessages = [receipt];
      let pageReads = 0;
      const scope = raceScope(null, targetKey, async (method) => {
        if (method === "threads/get") {
          const result = await read.promise;
          serverMessages = deleted ? [] : [receipt];
          return result;
        }
        pageReads += 1;
        return {
          threadId: target.threadId,
          olderCursor: null,
          messages: structuredClone(serverMessages),
        };
      });
      const handlers = new Function(...Object.keys(scope), raceHandlers)(...Object.values(scope));
      const jump = handlers.jump({ [targetKey]: "target-1", messageId: receipt.id });
      await Promise.resolve();
      await Promise.resolve();
      expect.soft(pageReads).toBe(0);
      read.resolve(target);
      await jump;
      expect(scope.pinnedAroundRef.current?.messageId ?? null).toBe(deleted ? null : receipt.id);
      expect(scope.snapRef.current?.messages.some((message) => message.id === receipt.id)).toBe(
        !deleted,
      );
    }
  },
);

it.each(["botId", "groupId"] as const)(
  "drops an actual %s page after same-thread clear while it is pending",
  async (targetKey) => {
    const initial = jumpCard("target-thread", 10, "Needs you");
    const page = deferred<unknown>();
    let pageReads = 0;
    const scope = raceScope(initial, targetKey, async (method) => {
      if (method === "threads/get") return initial;
      pageReads += 1;
      return page.promise;
    });
    const handlers = new Function(...Object.keys(scope), raceHandlers)(...Object.values(scope));
    const jump = handlers.jump({ [targetKey]: "target-1", messageId: "card" });
    for (let i = 0; i < 8 && !pageReads; i += 1) await Promise.resolve();
    expect(pageReads).toBe(1);
    scope.historyEpoch.current += 1;
    handlers.commit(
      api.applyMobileThreadEvent(scope.snapRef.current, {
        type: "thread.cleared",
        threadId: initial.threadId,
        seq: 12,
      }),
    );
    page.resolve({ threadId: initial.threadId, olderCursor: null, messages: initial.messages });
    await jump;
    expect(scope.snapRef.current?.cursor).toBe(12);
    expect(scope.snapRef.current?.messages).toEqual([]);
    expect(scope.pinnedAroundRef.current).toBeNull();
  },
);

function jumpCard(threadId: string, cursor: number, state: string): MobileSnapshot {
  return {
    threadId,
    cursor,
    olderCursor: null,
    run: null,
    messages: [
      { id: "card", seq: 1, role: "bot", blocks: [{ kind: "computer", text: "Sign in", state }] },
    ],
  };
}

it.each(["botId", "groupId"] as const)(
  "admits paginated cold and cross-thread %s history",
  async (targetKey) => {
    for (const initial of [null, jumpCard("other-thread", 100, "Needs you")]) {
      const target: MobileSnapshot = {
        ...jumpCard("target-thread", 20, "Done"),
        olderCursor: 50,
        messages: [
          { id: "tail", seq: 50, role: "user", blocks: [{ kind: "text", text: "Latest" }] },
        ],
      };
      const page = { ...jumpCard(target.threadId, 20, "Done"), olderCursor: null };
      const scope = raceScope(initial, targetKey, async (method) =>
        method === "threads/get" ? target : page,
      );
      const handlers = new Function(...Object.keys(scope), raceHandlers)(...Object.values(scope));
      await handlers.jump({ [targetKey]: "target-1", messageId: "card" });
      expect(scope.snapRef.current?.cursor).toBe(20);
      expect(scope.snapRef.current?.messages.map((message) => message.id)).toEqual([
        "card",
        "tail",
      ]);
      expect(scope.pinnedAroundRef.current?.messageId).toBe("card");
    }
  },
);

it.each(["get", "page"] as const)(
  "keeps mobile jump authority checks after the %s await",
  async (phase) => {
    for (const targetKey of ["botId", "groupId"] as const) {
      for (const invalidation of ["epoch", "newer-jump", "target", "scope"]) {
        const initial = jumpCard("target-thread", 10, "Needs you");
        const get = deferred<MobileSnapshot>();
        const page = deferred<unknown>();
        const getStarted = deferred<void>();
        const pageStarted = deferred<void>();
        let pageReads = 0;
        let current = true;
        const scope = raceScope(initial, targetKey, async (method) => {
          if (method === "threads/get") {
            getStarted.resolve();
            return get.promise;
          }
          pageReads += 1;
          pageStarted.resolve();
          return page.promise;
        });
        scope.isIntegrationsScopeCurrent = () => current;
        const handlers = new Function(...Object.keys(scope), raceHandlers)(...Object.values(scope));
        const jump = handlers.jump({ [targetKey]: "target-1", messageId: "card" });
        await getStarted.promise;
        if (phase === "page") {
          get.resolve(initial);
          await pageStarted.promise;
        }
        if (invalidation === "epoch") scope.historyEpoch.current += 1;
        else if (invalidation === "newer-jump") scope.jumpGeneration.current += 1;
        else if (invalidation === "target") {
          if (targetKey === "botId") scope.activeBotId.current = "new-target";
          else scope.activeGroupId.current = "new-target";
        } else current = false;
        if (phase === "get") get.resolve(initial);
        else
          page.resolve({
            threadId: initial.threadId,
            olderCursor: null,
            messages: initial.messages,
          });
        await jump;
        expect(scope.snapRef.current, `${targetKey}/${invalidation}`).toBe(initial);
        expect(scope.pinnedAroundRef.current).toBeNull();
        expect(pageReads).toBe(phase === "get" ? 0 : 1);
      }
    }
  },
);

it.each(["botId", "groupId"] as const)(
  "uses an authoritative loaded %s target when its older page is rejected",
  async (targetKey) => {
    for (const deleted of [false, true]) {
      const initial = jumpCard("target-thread", 20, "Needs you");
      const page = deferred<unknown>();
      const started = deferred<void>();
      const scope = raceScope(initial, targetKey, async (method) => {
        if (method === "threads/get") return initial;
        started.resolve();
        return page.promise;
      });
      const handlers = new Function(...Object.keys(scope), raceHandlers)(...Object.values(scope));
      const jump = handlers.jump({ [targetKey]: "target-1", messageId: "card" });
      await started.promise;
      const authoritative = api.mergeMobileSnapshot(initial, {
        ...jumpCard(initial.threadId, 21, "Done"),
        messages: deleted ? [] : jumpCard(initial.threadId, 21, "Done").messages,
        run: { id: "new-run", status: "queued" },
      });
      handlers.commit(authoritative);
      page.resolve({ threadId: initial.threadId, olderCursor: 1, messages: initial.messages });
      await jump;
      expect(scope.snapRef.current).toBe(authoritative);
      expect(scope.snapRef.current?.cursor).toBe(21);
      expect(scope.snapRef.current?.run?.id).toBe("new-run");
      expect(scope.pinnedAroundRef.current).toBeNull();
      expect(scope.jumpScrollTarget.current).toBe(deleted ? null : "card");
    }
  },
);

it.each(["botId", "groupId"] as const)(
  "does not anchor a hidden peer target from an authoritative %s snapshot",
  async (targetKey) => {
    const initial = jumpCard("target-thread", 20, "Needs you");
    const page = deferred<unknown>();
    const started = deferred<void>();
    const scope = raceScope(initial, targetKey, async (method) => {
      if (method === "threads/get") return initial;
      started.resolve();
      return page.promise;
    });
    const handlers = new Function(...Object.keys(scope), raceHandlers)(...Object.values(scope));
    const jump = handlers.jump({ [targetKey]: "target-1", messageId: "card" });
    await started.promise;
    handlers.commit(
      api.mergeMobileSnapshot(initial, {
        ...initial,
        cursor: 21,
        messages: [
          {
            ...initial.messages[0]!,
            runId: "peer-run",
            blocks: [{ kind: "progress", text: "Hidden peer activity" }],
          },
          {
            id: "receipt",
            seq: 2,
            runId: "peer-run",
            role: "bot",
            blocks: [
              {
                kind: "bot_message_received",
                fromBotId: "peer",
                fromBotName: "Peer",
                text: "Receipt",
              },
            ],
          },
        ],
      }),
    );
    page.resolve({ threadId: initial.threadId, olderCursor: 1, messages: initial.messages });
    await jump;
    expect(scope.pinnedAroundRef.current).toBeNull();
    expect(scope.jumpScrollTarget.current).toBeNull();
    expect(scope.snapRef.current?.cursor).toBe(21);
  },
);
