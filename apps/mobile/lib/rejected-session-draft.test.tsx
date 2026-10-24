// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolveComposerSendPlan } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import type { ReactNode } from "react";
import React, {
  act,
  createRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadComposerHandle } from "../components/thread-composer";
import { ThreadComposer } from "../components/thread-composer";
import {
  clearSpace,
  currentApiBase,
  rpc,
  saveApiBase,
  selectedSpaceId,
  selectInitialSpace,
  selectSpace,
  signIn,
  subscribeSelectedSpace,
  subscribeSessionRejected,
} from "./api";
import { replaceWithSignIn } from "./auth-routing";
import { captureMobileScope, isMobileScopeCurrent } from "./mobile-scope";
import type { PickedAttachment } from "./pick-attachments-filter";
import * as recovery from "./rejected-session-draft";
import {
  clearRejectedSessionToken,
  clearSessionToken,
  currentSessionGeneration,
  loadSessionToken,
  saveSessionToken,
  snapshotSessionToken,
} from "./session";
import type { SendAttempt, SendPayload } from "./thread-feedback";
import { configureUnsentSends, useThreadFeedback } from "./thread-feedback";

const mock = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  input: (_text: string) => {},
  route: (_path: string) => {},
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => mock.disk.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => void mock.disk.set(key, value)),
  deleteItemAsync: vi.fn(async (key: string) => void mock.disk.delete(key)),
}));
vi.mock("expo-router", () => ({
  router: {
    dismissTo: vi.fn(),
    replace: vi.fn((route: string | { pathname: string }) =>
      mock.route(typeof route === "string" ? route : route.pathname),
    ),
  },
}));
vi.mock("./artifact-cache-session", () => ({
  invalidateArtifactCacheSession: vi.fn(async () => undefined),
}));
vi.mock("./live-notifications", () => ({
  stopLiveNotifications: vi.fn(async () => undefined),
  resumeLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("react-native", () => {
  const Surface = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Surface,
    Text: Surface,
    ScrollView: Surface,
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      disabled,
    }: {
      children?: ReactNode;
      onPress: () => void;
      accessibilityLabel?: string;
      disabled?: boolean;
    }) => (
      <button type="button" onClick={onPress} aria-label={accessibilityLabel} disabled={disabled}>
        {children}
      </button>
    ),
    TextInput: ({
      value,
      onChangeText,
    }: {
      value: string;
      onChangeText: (text: string) => void;
    }) => {
      mock.input = onChangeText;
      return <input value={value} readOnly />;
    },
  };
});
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../components/glass-surface", () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}), useResolvedAppearance: () => "light" }));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
}));

const testFileUrl = import.meta.url;
const file = readFileSync(new URL("../app/thread.tsx", testFileUrl), "utf8");
const recoveryStart = file.indexOf("  useSyncExternalStore(\n    subscribeRejectedSessionDraft,");
const recoveryEnd = file.indexOf("  const separatorIds", recoveryStart);
if (recoveryStart < 0 || recoveryEnd < recoveryStart)
  throw new Error("Production recovery hook missing");
const productionRecovery = file.slice(recoveryStart, recoveryEnd);
const homeSource = readFileSync(new URL("../app/index.tsx", testFileUrl), "utf8");
const homeBootstrap = homeSource.match(
  /selected = await selectInitialSpace\(nextMe\.spaceId, \{ isCurrent: selectionCurrent \}\);/,
)?.[0];
if (!homeBootstrap) throw new Error("Production Home bootstrap missing");
const bootstrapHome = new Function(
  "selectInitialSpace",
  "nextMe",
  "selectionCurrent",
  `return (async () => { let selected; ${homeBootstrap} return selected; })();`,
);

const initialScope = () => ({
  apiBase: "https://api.example.test",
  apiGeneration: 1,
  sessionGeneration: currentSessionGeneration(),
  spaceId: "space-a" as string | null,
  spaceGeneration: 1,
  selectionSeq: 1,
});
const picked = {
  id: "old-local-attachment",
  name: "notes.txt",
  mimeType: "text/plain",
  contentBase64: "c3ludGhldGljLW5vdGVz",
  previewUri: "content://synthetic-preview",
} as const;
const target = {
  apiBase: "https://api.example.test",
  userId: "user-a",
  spaceId: "space-a",
  targetKind: "bot" as const,
  targetId: "bot-a",
  threadId: "thread-a",
};
const skill = {
  id: "old-skill",
  name: "Writing",
  description: "Write",
  source: "user",
  readOnly: false,
} as const;
const mention = {
  kind: "connector",
  id: "old-connection",
  name: "Mail",
  connectionId: "old-grant",
  authStatus: "connected",
} as const;

type HarnessState = ReturnType<typeof makeState>;
function makeState() {
  return {
    scope: initialScope(),
    userId: "user-a",
    botId: "bot-a" as string | undefined,
    groupId: undefined as string | undefined,
    threadId: "thread-a",
    focused: true,
    realScope: false,
    profileReady: true,
    readOnly: false,
    showingSaved: false,
    restoring: false,
    sending: false,
    preparing: false,
    working: false,
    onCall: false,
    attachments: [] as PickedAttachment[],
    replyQuote: null as string | null,
    replyTarget: null as { text: string } | null,
    handle: createRef<ThreadComposerHandle>(),
    feedback: null as ReturnType<typeof useThreadFeedback> | null,
    files: [] as PickedAttachment[],
    attempts: [] as SendAttempt[],
  };
}

/** Execute the actual Thread recovery block with native/transport surfaces supplied by the fixture. */
function productionEditor(state: HarnessState) {
  const source = `return function Editor() {
    const composerRef = useRef(null);
    const [pendingAttachments, setPendingAttachments] = useState(state.attachments);
    const profileScope = state.profileReady ? state.scope : null;
    const ownerUserId = state.userId;
    const botId = state.botId;
    const groupId = state.groupId;
    const threadKey = groupId ?? botId;
    const readOnly = state.readOnly;
    const showingSaved = state.showingSaved;
    const restoring = state.restoring;
    const sending = state.sending;
    const preparingSend = useRef(state.preparing);
    preparingSend.current = state.preparing;
    const onCall = state.onCall;
    const replyQuote = state.replyQuote;
    const replyTarget = state.replyTarget;
    const navigation = { isFocused: () => state.focused };
    const snapRef = useRef(null);
    snapRef.current = { threadId: state.threadId, botId, groupId };
    const snapshotOrigin = useRef(null);
    snapshotOrigin.current = { ...state.scope, selectionId: state.scope.spaceId, userId: state.userId };
    const activePendingAttachments = pendingAttachments.filter(a => !a.threadKey || a.threadKey === threadKey);
    const feedback = useThreadFeedback(threadKey, nextNonce);
    ${productionRecovery}
    useLayoutEffect(() => {
      state.handle.current = composerRef.current;
      state.feedback = feedback;
      state.files = pendingAttachments;
    });
    async function send() {
      const submitted = composerRef.current.snapshot();
      const attempt = feedback.sendAttempt({
        originThreadKey: threadKey, displayText: submitted.promptText,
        initialBotTarget: botId, botTarget: botId, groupTarget: groupId,
        reroutedToGroup: false, replyPreview: null, replyQuote: null,
        attachments: pendingAttachments,
        plan: resolveComposerSendPlan({text: submitted.promptText, mentions: submitted.mentions, hasAttachments: pendingAttachments.length > 0}),
      });
      state.attempts.push(attempt);
      composerRef.current.reset();
      setPendingAttachments([]);
    }
    return <ThreadComposer ref={composerRef} agentSkills={[skill]} composerMentionTargets={[mention]}
      composerPrompt="Message" replyTargetId={state.replyTarget ? "old-reply-id" : undefined}
      replyQuote={replyQuote} attachmentIds={pendingAttachments.map(a => a.id)}
      botId={botId} onCall={onCall} working={state.working} sending={sending}
      styles={{circleButton:{},composerFill:{}}} attachActions={[]} attachFrom={()=>{}}
      send={send} stop={async()=>{}} startVoiceCall={async()=>{}} onSlashAction={()=>{}} />;
  }`;
  const compiled = ts.transpile(source, { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 });
  const values = {
    React,
    useRef,
    useState,
    useLayoutEffect,
    useSyncExternalStore,
    useCallback,
    useFocusEffect: (callback: () => (() => void) | undefined) => useEffect(callback, []),
    state,
    ThreadComposer,
    skill,
    mention,
    ...recovery,
    currentSessionGeneration,
    isMobileScopeCurrent: (scope: ReturnType<typeof initialScope>) =>
      scope === state.scope &&
      (state.realScope
        ? isMobileScopeCurrent(scope)
        : scope.sessionGeneration === currentSessionGeneration()),
    isIntegrationsScopeCurrent: (origin: { sessionGeneration: number }) =>
      origin.sessionGeneration === currentSessionGeneration(),
    previewMessageText: (message: { text: string }) => message.text,
    newClientNonce: nextNonce,
    nextNonce,
    useThreadFeedback,
    resolveComposerSendPlan,
  };
  return new Function(...Object.keys(values), compiled)(...Object.values(values));
}
let nonce = 0;
function nextNonce() {
  return `new-nonce-${++nonce}`;
}

describe("rejected-session editor isolation", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  let state: HarnessState;
  let Editor: ReturnType<typeof productionEditor>;
  const diskClear = vi.fn();
  const request = vi.fn();
  function render() {
    act(() => root.render(<Editor />));
  }
  function type(text: string) {
    act(() => mock.input(text));
  }
  function click(label: string) {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    expect(button).not.toBeNull();
    act(() => button.click());
  }
  async function reject() {
    await act(async () => {
      await clearRejectedSessionToken();
      replaceWithSignIn();
    });
    expect(container.querySelector("input")).toBeNull();
  }
  async function reauthenticate(changes: Partial<HarnessState> = {}, prove = true) {
    await act(async () => {
      await saveSessionToken("synthetic-new-session");
    });
    Object.assign(state, changes);
    state.scope = { ...state.scope, sessionGeneration: currentSessionGeneration() };
    if (prove)
      recovery.verifyRejectedSessionDraftOwner({
        apiBase: state.scope.apiBase,
        userId: state.userId,
        spaceId: state.scope.spaceId!,
        sessionGeneration: currentSessionGeneration(),
      });
    render();
  }
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    mock.disk.clear();
    await clearSessionToken();
    await saveSessionToken("synthetic-old-session");
    state = makeState();
    Editor = productionEditor(state);
    configureUnsentSends({
      scope: () => ({
        apiBase: state.scope.apiBase,
        userId: state.userId,
        spaceId: state.scope.spaceId,
        cacheSession: `cache-${currentSessionGeneration()}`,
      }),
      serverReachable: () => false,
      disk: {
        admit: () => true,
        hydrate: async () => {},
        forget: () => {},
        save: () => {},
        load: () => [],
        clear: diskClear,
      },
      request,
      errorText: () => "Unavailable",
      notDelivered: () => {},
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mock.route = (path) => {
      if (path === "/sign-in") root.render(<div>Sign in</div>);
    };
    render();
  });
  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    await clearSessionToken();
    vi.unstubAllGlobals();
  });

  it("survives the real session wipe and sign-in route replacement, then consumes once into the verified empty editor", async () => {
    type("  Unsubmitted\n\ntext  ");
    await reject();
    expect(await snapshotSessionToken()).toEqual({ ok: true, value: "" });
    expect(diskClear).toHaveBeenCalled();
    await reauthenticate({}, false);
    expect(container.querySelector("input")!.value).toBe("");
    act(() =>
      recovery.verifyRejectedSessionDraftOwner({
        ...target,
        spaceId: "default-space",
        sessionGeneration: currentSessionGeneration(),
      }),
    );
    expect(container.querySelector("input")!.value).toBe("");
    act(() =>
      recovery.verifyRejectedSessionDraftOwner({
        ...target,
        sessionGeneration: currentSessionGeneration(),
      }),
    );
    expect(container.querySelector("input")!.value).toBe("  Unsubmittedtext  ");
    expect(state.attempts).toEqual([]);
    act(() => root.render(<div>Other screen</div>));
    render();
    expect(container.querySelector("input")!.value).toBe("");
  });

  it("keeps local attachment bytes and context as editable text without old IDs, grants, URIs or automatic sends", async () => {
    act(() => root.render(<div>Reset</div>));
    state.attachments = [picked];
    state.replyQuote = "Quoted\nline";
    render();
    type("/Wri");
    click("Skill {name}");
    type("@Ma");
    click("@{name}");
    type("Draft");
    await reject();
    state.attachments = [];
    state.replyQuote = null;
    await reauthenticate();
    expect(state.handle.current!.snapshot()).toMatchObject({
      mentions: [],
      skill: null,
      replyTargetId: undefined,
      replyQuote: null,
    });
    expect(state.handle.current!.editableText()).toBe("> Quoted\n> line\n\n/Writing\n@Mail\nDraft");
    expect(state.files).toEqual([
      {
        name: picked.name,
        mimeType: picked.mimeType,
        contentBase64: picked.contentBase64,
        id: expect.stringMatching(/^new-nonce-/),
        threadKey: "bot-a",
      },
    ]);
    expect(JSON.stringify(state.files)).not.toContain("previewUri");
    expect(state.files[0]!.id).not.toBe(picked.id);
    expect(state.attempts).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["restore", "explicit-other-space", "explicit-clear"])(
    "keeps the actual selected-Space draft through authentication probe and Home bootstrap (%s)",
    async (decision) => {
      act(() => root.render(<div>Prepare real API scope</div>));
      let authenticated = true;
      let meSpace = "space-a";
      let signedOut = false;
      let releaseProbe: (() => void) | undefined;
      const wire: Array<{ path: string; body: string; space: string | null }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(
            typeof input === "string" ? input : input instanceof Request ? input.url : input.href,
          ).pathname;
          const headers = new Headers(init?.headers);
          wire.push({
            path,
            body: String(init?.body ?? ""),
            space: headers.get("x-rakazo-space-id"),
          });
          if (path.endsWith("/health")) return Response.json({ ok: true, json: { ok: true } });
          if (path.endsWith("/api/auth/sign-in/email")) {
            authenticated = true;
            return Response.json({ token: "synthetic-replacement-session" });
          }
          if (!authenticated) {
            if (path.endsWith("/rpc/spaces/list") && !headers.get("x-rakazo-space-id")) {
              await new Promise<void>((done) => {
                releaseProbe = done;
              });
            }
            return Response.json(
              { json: { code: "UNAUTHORIZED", message: "Session expired" } },
              { status: 401 },
            );
          }
          if (path.endsWith("/rpc/me"))
            return Response.json({ json: { userId: "user-a", spaceId: meSpace } });
          if (path.endsWith("/rpc/spaces/list"))
            return Response.json({
              json: { current: { id: meSpace, bots: [], groups: [], botSections: [] }, spaces: [] },
            });
          throw new Error(`Unexpected synthetic request: ${path}`);
        }),
      );
      await saveApiBase(target.apiBase);
      await saveSessionToken("synthetic-original-session");
      await selectSpace("space-a");
      state.realScope = true;
      state.scope = captureMobileScope();
      render();
      type("Private selected-Space draft");
      mock.route = (path) => {
        if (path !== "/sign-in") return;
        signedOut = true;
        root.render(<div>Sign in</div>);
      };
      const stopSpace = subscribeSelectedSpace(() => {
        state.scope = captureMobileScope();
        state.profileReady = false;
        if (!signedOut) root.render(<Editor />);
      });
      const stopRejected = subscribeSessionRejected(() => replaceWithSignIn());
      try {
        authenticated = false;
        let rejected!: Promise<unknown>;
        await act(async () => {
          rejected = rpc("threads/get", { botId: "bot-a" }).catch((error: unknown) => error);
          await vi.waitFor(() => expect(releaseProbe).toBeTypeOf("function"));
        });
        expect(selectedSpaceId()).toBeNull();
        expect(recovery.captureRejectedSessionDraft(currentSessionGeneration())).toBeNull();
        await act(async () => {
          releaseProbe!();
          expect(await rejected).toBeInstanceOf(Error);
        });
        expect(signedOut).toBe(true);
        expect(container.querySelector("input")).toBeNull();
        expect(await snapshotSessionToken()).toEqual({ ok: true, value: "" });
        await act(async () => {
          await signIn("person@example.test", "synthetic-password");
          meSpace = "default-space-b";
          const [navigation, me] = await Promise.all([
            rpc<{ current: { id: string } }>("spaces/list"),
            rpc<{ userId: string; spaceId: string }>("me"),
          ]);
          expect(navigation.current.id).toBe(me.spaceId);
          expect(await bootstrapHome(selectInitialSpace, me, () => true)).toBe(true);
          if (decision === "explicit-other-space") await selectSpace(me.spaceId);
          if (decision === "explicit-clear") expect(await clearSpace()).toBe(true);
          await selectSpace("space-a");
          meSpace = "space-a";
          await rpc("me");
        });
        state.scope = captureMobileScope();
        state.profileReady = true;
        render();
        expect(currentApiBase()).toBe(target.apiBase);
        expect(state.handle.current!.editableText()).toBe(
          decision === "restore" ? "Private selected-Space draft" : "",
        );
        expect(state.feedback!.unsentSends).toEqual([]);
        expect(state.attempts).toEqual([]);
        expect(JSON.stringify(wire)).not.toContain("Private selected-Space draft");
        expect(JSON.stringify(wire)).not.toContain("contentBase64");
        expect(JSON.stringify(wire)).not.toContain("clientNonce");
        expect(wire.some((request) => request.path.endsWith("/threads/send"))).toBe(false);
        expect(wire.filter((request) => request.path.endsWith("/rpc/spaces/list"))).toHaveLength(2);
        expect(wire.filter((request) => request.path.endsWith("/rpc/spaces/list"))).toEqual([
          expect.objectContaining({ space: null }),
          expect.objectContaining({ space: null }),
        ]);
      } finally {
        stopSpace();
        stopRejected();
      }
    },
  );

  it("clears the old actual outbox and creates a new nonce only after the user sends the recovered draft", async () => {
    const oldPayload: SendPayload = {
      originThreadKey: "bot-a",
      displayText: "Old queued",
      replyPreview: null,
      initialBotTarget: "bot-a",
      botTarget: "bot-a",
      reroutedToGroup: false,
      attachments: [],
      replyQuote: null,
      plan: resolveComposerSendPlan({ text: "Old queued", mentions: [], hasAttachments: false }),
    };
    let old!: SendAttempt;
    await act(async () => {
      old = state.feedback!.sendAttempt(oldPayload);
      await state.feedback!.send(old);
    });
    expect(state.feedback!.unsentSends).toHaveLength(1);
    type("New unsubmitted draft");
    await reject();
    await reauthenticate();
    expect(state.feedback!.unsentSends).toEqual([]);
    expect(state.attempts).toEqual([]);
    click("Send");
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]!.clientNonce).not.toBe(old.clientNonce);
    expect(state.attempts[0]!.artifactIds.size).toBe(0);
    expect(state.attempts[0]!.payload.displayText).toBe("New unsubmitted draft");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["user", "api", "space", "thread", "target"])(
    "discards a draft for a different verified %s",
    async (kind) => {
      type("Private draft");
      await reject();
      const changes: Partial<HarnessState> =
        kind === "user"
          ? { userId: "user-b" }
          : kind === "thread"
            ? { threadId: "thread-b" }
            : kind === "target"
              ? { botId: "bot-b" }
              : {};
      if (kind === "api") state.scope = { ...state.scope, apiBase: "https://other.example.test" };
      if (kind === "space") state.scope = { ...state.scope, spaceId: "space-b" };
      await reauthenticate(changes);
      expect(container.querySelector("input")!.value).toBe("");
      Object.assign(state, {
        userId: target.userId,
        botId: target.targetId,
        threadId: target.threadId,
      });
      state.scope = { ...initialScope() };
      act(() =>
        recovery.verifyRejectedSessionDraftOwner({
          ...target,
          sessionGeneration: currentSessionGeneration(),
        }),
      );
      render();
      expect(container.querySelector("input")!.value).toBe("");
    },
  );

  it("does not overwrite a newer same-tick edit while proof of the original Space is pending", async () => {
    type("Old draft");
    await reject();
    await reauthenticate({}, false);
    act(() => {
      mock.input(" \nNew draft");
      recovery.verifyRejectedSessionDraftOwner({
        ...target,
        sessionGeneration: currentSessionGeneration(),
      });
    });
    expect(state.handle.current!.editableText()).toBe(" \nNew draft");
    act(() => state.handle.current!.reset());
    render();
    expect(state.handle.current!.editableText()).toBe("");
  });

  it.each([
    "readOnly",
    "showingSaved",
    "restoring",
    "sending",
    "preparing",
    "onCall",
    "focused",
  ] as const)("never captures an ineligible %s editor", async (field) => {
    type("Uncapturable draft");
    state[field] = field !== "focused";
    render();
    await reject();
    state[field] = field === "focused";
    await reauthenticate();
    expect(container.querySelector("input")!.value).toBe("");
  });

  it("captures an unsent editor during working state and restores after it becomes idle", async () => {
    type("Working draft");
    state.working = true;
    render();
    await reject();
    state.working = false;
    await reauthenticate();
    expect(state.handle.current!.editableText()).toBe("Working draft");
    expect(state.attempts).toEqual([]);
  });

  it("restores the editable draft while the same run is still working without a deferred overwrite after it settles", async () => {
    type("Working draft before reauthentication");
    state.working = true;
    render();
    await reject();
    await reauthenticate();
    expect(state.handle.current!.editableText()).toBe("Working draft before reauthentication");
    expect(state.attempts).toEqual([]);
    state.working = false;
    render();
    expect(state.handle.current!.editableText()).toBe("Working draft before reauthentication");
    type("New edit after the run settles");
    render();
    expect(state.handle.current!.editableText()).toBe("New edit after the run settles");
    act(() => state.handle.current!.reset());
    render();
    expect(state.handle.current!.editableText()).toBe("");
    act(() => root.render(<div>Return later</div>));
    render();
    expect(state.handle.current!.editableText()).toBe("");
    expect(state.attempts).toEqual([]);
  });

  it("restores an attachment-only draft in its verified group without retaining a bot target", async () => {
    act(() => root.render(<div>Choose group</div>));
    state.botId = undefined;
    state.groupId = "group-a";
    state.attachments = [picked];
    render();
    await reject();
    state.attachments = [];
    await reauthenticate();
    expect(state.handle.current!.editableText()).toBe("");
    expect(state.files).toHaveLength(1);
    expect(state.files[0]).toMatchObject({
      threadKey: "group-a",
      name: picked.name,
      contentBase64: picked.contentBase64,
    });
    expect(state.attempts).toEqual([]);
  });

  it.each(["file", "quote", "busy"])(
    "keeps a newly occupied %s editor and discards the old draft without later insertion",
    async (occupied) => {
      type("Old draft");
      await reject();
      if (occupied === "file") state.attachments = [picked];
      if (occupied === "quote") state.replyQuote = "";
      if (occupied === "busy") state.sending = true;
      await reauthenticate();
      expect(state.handle.current!.snapshot().promptText).toBe("");
      expect(state.files).toEqual(occupied === "file" ? [picked] : []);
      state.replyQuote = null;
      state.sending = false;
      act(() => root.render(<div>Return later</div>));
      state.attachments = [];
      render();
      expect(state.handle.current!.editableText()).toBe("");
      expect(state.files).toEqual([]);
    },
  );

  it("quarantines the editable draft after a failed physical credential wipe until a new login and fresh identity proof", async () => {
    act(() => root.render(<div>Prepare real API scope</div>));
    await saveApiBase(target.apiBase);
    await saveSessionToken("synthetic-old-session");
    await selectSpace(target.spaceId);
    state.realScope = true;
    state.scope = captureMobileScope();
    render();
    type("Draft before failed wipe");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") throw new Error("Secure storage unavailable");
      mock.disk.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.session_token") throw new Error("Secure storage unavailable");
      mock.disk.set(key, value);
    });
    await act(async () => {
      expect(await clearRejectedSessionToken()).toBe(false);
      replaceWithSignIn();
    });
    expect(container.querySelector("input")).toBeNull();
    expect(await snapshotSessionToken()).toEqual({ ok: true, value: "" });
    expect(await loadSessionToken()).toBe("");
    // Both physical operations failed: the disk fixture still has the old value,
    // while the logical session is invalid and cannot supply it as a bearer.
    expect(mock.disk.get("rakazo.session_token")).toBe("synthetic-old-session");
    expect(state.attempts).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(diskClear).toHaveBeenCalled();
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(
      async (key) => void mock.disk.delete(key),
    );
    vi.mocked(SecureStore.setItemAsync).mockImplementation(
      async (key, value) => void mock.disk.set(key, value),
    );
    const wire: Array<{ path: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(
          typeof input === "string" ? input : input instanceof Request ? input.url : input.href,
        ).pathname;
        wire.push({ path, body: String(init?.body ?? "") });
        if (path.endsWith("/api/auth/sign-in/email"))
          return Response.json({ token: "synthetic-new-session" });
        if (path.endsWith("/rpc/me"))
          return Response.json({ json: { userId: target.userId, spaceId: target.spaceId } });
        throw new Error(`Unexpected synthetic request: ${path}`);
      }),
    );
    await act(async () => {
      await signIn("person@example.test", "synthetic-password");
      await selectSpace(target.spaceId);
    });
    state.scope = captureMobileScope();
    render();
    expect(state.handle.current!.editableText()).toBe("");
    expect(await loadSessionToken()).toBe("synthetic-new-session");
    await act(async () => {
      await rpc("me");
    });
    expect(state.handle.current!.editableText()).toBe("Draft before failed wipe");
    expect(state.feedback!.unsentSends).toEqual([]);
    expect(state.attempts).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(wire.map((entry) => entry.path)).toEqual(["/api/auth/sign-in/email", "/rpc/me"]);
    expect(JSON.stringify(wire)).not.toContain("Draft before failed wipe");
    expect(JSON.stringify(wire)).not.toContain("clientNonce");
  });

  it("does not recreate a captured draft after a concurrent explicit sign-out", async () => {
    type("Before sign-out");
    let release!: () => void;
    let blocked = false;
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token" && !blocked) {
        blocked = true;
        await new Promise<void>((done) => {
          release = done;
        });
      }
      mock.disk.delete(key);
    });
    let clearing!: Promise<boolean>;
    act(() => {
      clearing = clearRejectedSessionToken();
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    let explicit!: Promise<boolean>;
    act(() => {
      explicit = clearSessionToken();
    });
    await act(async () => {
      release();
      await Promise.all([clearing, explicit]);
      replaceWithSignIn();
    });
    await reauthenticate();
    expect(container.querySelector("input")!.value).toBe("");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(
      async (key) => void mock.disk.delete(key),
    );
  });

  it("fences API ABA invalidation during the asynchronous rejected-session wipe", async () => {
    type("Before endpoint switch");
    let release!: () => void;
    vi.mocked(SecureStore.deleteItemAsync).mockImplementationOnce(async () => {
      await new Promise<void>((done) => {
        release = done;
      });
    });
    let clearing!: Promise<boolean>;
    act(() => {
      clearing = clearRejectedSessionToken();
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    act(() => {
      recovery.discardRejectedSessionDraft();
      recovery.discardRejectedSessionDraft();
    });
    await act(async () => {
      release();
      await clearing;
      replaceWithSignIn();
    });
    await reauthenticate();
    expect(container.querySelector("input")!.value).toBe("");
  });
});
