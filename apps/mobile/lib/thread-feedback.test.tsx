// @vitest-environment jsdom

import { AiConsentBlocked, resolveComposerSendPlan } from "@rakazo/core";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FailedSendBubble } from "../components/failed-send-bubble";
import { ThreadErrorNotices } from "../components/run-error-notice";
import type { ComposerSnapshot, SendAttempt, SendPayload } from "./thread-feedback";
import {
  clearFailedSends,
  configureUnsentSends,
  confirmEchoes,
  restoreUnsentSends,
  sendWaitingMessages,
  settleComposer,
  useThreadFeedback,
} from "./thread-feedback";

vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("react-native", () => ({
  Linking: { openURL: vi.fn() },
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
    createElement("span", { role: accessibilityRole }, children),
  Image: () => null,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    accessibilityHint,
    onLongPress,
  }: {
    children?: ReactNode;
    onPress: () => void;
    disabled: boolean;
    accessibilityLabel: string;
    accessibilityHint?: string;
    onLongPress: () => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        onClick: onPress,
        onContextMenu: onLongPress,
        disabled,
        "aria-label": accessibilityLabel,
        "aria-description": accessibilityHint,
      },
      children,
    ),
  Platform: { OS: "ios" },
  ActionSheetIOS: { showActionSheetWithOptions: vi.fn() },
  Alert: { alert: vi.fn() },
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("../components/select-text-sheet", () => ({
  SelectTextSheet: ({ text }: { text: string | null }) =>
    text === null ? null : createElement("section", { "aria-label": "Run diagnostics" }, text),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
}));

let feedback: ReturnType<typeof useThreadFeedback>;
let nonces = 0;
const retry = vi.fn();
function Probe({
  threadKey,
  run,
  noticeScope = threadKey,
}: {
  threadKey: string;
  run?: { id: string; error: string };
  noticeScope?: string;
}) {
  feedback = useThreadFeedback(threadKey, () => `nonce-${++nonces}`);
  return (
    <>
      {feedback.unsentSends.map((attempt) => (
        <FailedSendBubble
          key={attempt.clientNonce}
          attempt={attempt}
          onRetry={retry}
          onDelete={() => feedback.discard(attempt)}
        />
      ))}
      {run ? (
        <ThreadErrorNotices
          scopeKey={noticeScope}
          sendError={
            feedback.unsentSends.find((attempt) => attempt.error === "platform_model_forbidden")
              ?.error ?? null
          }
          run={run}
        />
      ) : null}
    </>
  );
}

function payload(text = "Hello"): SendPayload {
  return {
    originThreadKey: "bot-1",
    displayText: text,
    replyPreview: "Quoted message",
    initialBotTarget: "bot-1",
    botTarget: "bot-1",
    reroutedToGroup: false,
    plan: resolveComposerSendPlan({ text, mentions: [], hasAttachments: true }),
    attachments: [
      { id: "attachment-1", name: "photo.png", mimeType: "image/png", contentBase64: "fake" },
    ],
    replyTargetId: "reply-1",
    replyQuote: "Quoted message",
  };
}

describe("composer settlement", () => {
  const submitted: ComposerSnapshot = {
    promptText: "Hello",
    mentions: [{ kind: "bot", id: "bot-1", name: "Bot" }],
    skill: null,
    replyTargetId: "reply-1",
    replyQuote: "Quoted message",
    attachmentIds: ["attachment-1"],
  };
  it("clears an unchanged composition", () => {
    expect(settleComposer(submitted, structuredClone(submitted))).toEqual({ clearComposer: true });
  });

  it.each<Partial<ComposerSnapshot>>([
    { promptText: "Edited" },
    { mentions: [{ kind: "bot", id: "bot-2", name: "Bot" }] },
    { skill: { id: "skill-1", name: "Skill", description: "", source: "user", readOnly: false } },
    { replyTargetId: "reply-2" },
    { replyQuote: "Edited quote" },
    { attachmentIds: ["attachment-1", "attachment-2"] },
    { attachmentIds: [] },
  ])("keeps an edited composition: %j", (edit) => {
    const current = { ...submitted, ...edit };
    const before = structuredClone(current);
    expect(settleComposer(submitted, current)).toEqual({ clearComposer: false });
    expect(current).toEqual(before);
  });
});

describe("scoped mobile outbox", () => {
  let root: Root;
  let container: HTMLDivElement;
  let reachable = true;
  const scope = {
    apiBase: "https://api.example.test",
    userId: "user-a",
    cacheSession: "ns-a",
    spaceId: "space-a",
  };
  const request = vi.fn();
  const disk = {
    admit: vi.fn(() => true),
    hydrate: vi.fn(async () => undefined),
    forget: vi.fn(),
    load: vi.fn(() => []),
    save: vi.fn((_attempts: SendAttempt[]) => true),
    clear: vi.fn(),
  };
  const notDelivered = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    clearFailedSends();
    vi.clearAllMocks();
    reachable = true;
    scope.spaceId = "space-a";
    request.mockImplementation(async (proc) =>
      proc === "artifacts/create" ? { id: "artifact-a" } : { seq: 42 },
    );
    configureUnsentSends({
      request,
      scope: () => scope,
      serverReachable: () => reachable,
      disk,
      errorText: String,
      notDelivered,
    });
    restoreUnsentSends();
    container = document.createElement("div");
    root = createRoot(container);
    act(() => root.render(<Probe threadKey="bot-1" />));
  });
  afterEach(() => {
    act(() => root.unmount());
    clearFailedSends();
    vi.unstubAllGlobals();
  });
  it("retains the page-card reply identity through delivery and removes it on group rerouting", async () => {
    const fromPage = { ...payload("Follow this page"), replyQuote: null, fromPage: true as const };
    const attempt = feedback.sendAttempt(fromPage);
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(request.mock.calls.find(([proc]) => proc === "threads/send")?.[1]).toMatchObject({
      replyToMessageId: "reply-1",
      fromPage: true,
      replyQuote: undefined,
    });
    request.mockClear();
    const rerouted = feedback.sendAttempt({
      ...fromPage,
      displayText: "Other group",
      groupTarget: "group-2",
      botTarget: undefined,
      reroutedToGroup: true,
    });
    await act(async () => {
      await feedback.send(rerouted);
    });
    expect(request.mock.calls.find(([proc]) => proc === "threads/send")?.[1]).toMatchObject({
      groupId: "group-2",
      replyToMessageId: undefined,
      fromPage: undefined,
    });
  });

  it("sends raw fallback owner text with explicit Page context and clears it on group rerouting", async () => {
    const raw = "[https://owner.example/report](page:manual)\nPlease read this.";
    const fallback = {
      ...payload(raw),
      displayText: `[Plan](page:page-a)\n${raw}`,
      replyTargetId: undefined,
      replyQuote: null,
      pageContext: { pageId: "page-a" },
    };
    const attempt = feedback.sendAttempt(fallback);
    await act(async () => feedback.send(attempt));
    const requestBody = request.mock.calls.find(([proc]) => proc === "threads/send")?.[1];
    expect(requestBody).toMatchObject({
      text: raw,
      pageContext: { pageId: "page-a" },
      replyToMessageId: undefined,
    });
    expect(attempt.payload.displayText).toBe(`[Plan](page:page-a)\n${raw}`);
    request.mockClear();
    const redirected = feedback.sendAttempt({
      ...fallback,
      botTarget: undefined,
      groupTarget: "group-2",
      reroutedToGroup: true,
    });
    await act(async () => feedback.send(redirected));
    expect(request.mock.calls.find(([proc]) => proc === "threads/send")?.[1]).toMatchObject({
      groupId: "group-2",
      text: raw,
      pageContext: undefined,
      replyToMessageId: undefined,
      fromPage: undefined,
    });
  });

  it("keeps a failed Page attempt's nonce and context when another Page is submitted", async () => {
    const raw = "Please revise";
    const base = { ...payload(raw), replyTargetId: undefined, replyQuote: null };
    const first = feedback.sendAttempt({
      ...base,
      displayText: `[A](page:page-a)\n${raw}`,
      pageContext: { pageId: "page-a" },
    });
    request.mockImplementation(async (proc) => {
      if (proc === "artifacts/create") return { id: "artifact-a" };
      throw new Error("Missing receipt");
    });
    await act(async () => feedback.send(first));
    expect(first.state).toBe("failed");
    const second = feedback.sendAttempt({
      ...base,
      displayText: `[B](page:page-b)\n${raw}`,
      pageContext: { pageId: "page-b" },
    });
    expect(second.clientNonce).not.toBe(first.clientNonce);
    expect(second.artifactIds.size).toBe(0);
    request.mockImplementation(async (proc) =>
      proc === "artifacts/create" ? { id: "artifact-b" } : { seq: 43 },
    );
    await act(async () => feedback.send(second));
    await act(async () => feedback.send(first, true));
    const sends = request.mock.calls
      .filter(([proc]) => proc === "threads/send")
      .map(([, body]) => body);
    expect(sends.map(({ clientNonce, pageContext }) => ({ clientNonce, pageContext }))).toEqual([
      { clientNonce: first.clientNonce, pageContext: { pageId: "page-a" } },
      { clientNonce: second.clientNonce, pageContext: { pageId: "page-b" } },
      { clientNonce: first.clientNonce, pageContext: { pageId: "page-a" } },
    ]);
    expect(request.mock.calls.filter(([proc]) => proc === "artifacts/create")).toHaveLength(2);
    expect(first.payload.displayText).toBe(`[A](page:page-a)\n${raw}`);
  });

  it("durably drops only rejected automatic Page context and lets the native bubble retry the same intent", async () => {
    const raw = "[Owner link](page:manual)\nPlease revise";
    const attempt = feedback.sendAttempt({
      ...payload(raw),
      displayText: `[Plan](page:page-a)\n${raw}`,
      replyTargetId: undefined,
      replyQuote: null,
      pageContext: { pageId: "page-a" },
    });
    const nonce = attempt.clientNonce;
    request.mockImplementation(async (proc) => {
      if (proc === "artifacts/create") return { id: "artifact-a" };
      throw Object.assign(new Error("Page unavailable"), {
        status: 404,
        code: "NOT_FOUND",
        data: { reason: "page_context_unavailable" },
      });
    });
    let durableTransition = false;
    disk.save.mockImplementation((attempts) => {
      const saved = attempts.find((entry) => entry.clientNonce === nonce);
      if (!durableTransition && saved?.payload.pageContext === undefined) {
        durableTransition = true;
        expect(attempt.payload.pageContext).toEqual({ pageId: "page-a" });
        expect(saved).toMatchObject({
          state: "failed",
          clientNonce: nonce,
          payload: { plan: { trimmed: raw }, botTarget: "bot-1" },
        });
      }
      return true;
    });
    await act(async () => feedback.send(attempt));
    disk.save.mockImplementation(() => true);
    expect(attempt.state).toBe("failed");
    expect(attempt.payload.pageContext).toBeUndefined();
    expect(attempt.payload.displayText).toBe(raw);
    expect(container.textContent).toContain("Not sent · Tap to retry");
    await act(async () => container.querySelector("button")!.click());
    expect(retry).toHaveBeenCalled();
    request.mockResolvedValue({ seq: 42 });
    await act(async () => {
      await Promise.all([feedback.send(attempt, true), feedback.send(attempt, true)]);
    });
    const sends = request.mock.calls.filter(([proc]) => proc === "threads/send");
    expect(sends).toHaveLength(2);
    expect(sends[1]![1]).toMatchObject({
      clientNonce: nonce,
      text: raw,
      pageContext: undefined,
      botId: "bot-1",
      artifactIds: ["artifact-a"],
    });
    expect(request.mock.calls.filter(([proc]) => proc === "artifacts/create")).toHaveLength(1);
  });

  it.each(["storage", "account", "other404", "unknown", "upload", "routine"])(
    "retains automatic Page context on %s without an authorized durable transition",
    async (boundary) => {
      const attempt = feedback.sendAttempt({
        ...payload("Keep raw"),
        replyTargetId: undefined,
        replyQuote: null,
        pageContext: { pageId: "page-a" },
      });
      if (boundary === "routine") {
        attempt.payload.plan.shouldRunRoutines = true;
        attempt.payload.plan.routineIds = ["routine-a"];
      }
      const error = Object.assign(new Error("Page unavailable"), {
        status: 404,
        code: "NOT_FOUND",
        data: { reason: boundary === "other404" ? "other" : "page_context_unavailable" },
      });
      request.mockImplementation(async (proc) => {
        if (boundary !== "upload" && proc === "artifacts/create") return { id: "artifact-a" };
        if (boundary === "account") scope.userId = "user-b";
        throw boundary === "unknown" ? new Error("Connection lost") : error;
      });
      if (boundary === "storage") disk.save.mockReturnValue(false);
      try {
        await act(async () => feedback.send(attempt));
        expect(attempt.payload.pageContext).toEqual({ pageId: "page-a" });
        expect(attempt.acceptedSeq).toBeUndefined();
        expect(request.mock.calls.filter(([proc]) => proc === "threads/send")).toHaveLength(
          ["upload", "routine"].includes(boundary) ? 0 : 1,
        );
        if (boundary === "storage") {
          expect(attempt.state).toBe("failed");
          expect(container.textContent).toContain("Not sent · Tap to retry");
          disk.save.mockReturnValue(true);
          await act(async () => feedback.send(attempt, true));
          expect(attempt.payload.pageContext).toBeUndefined();
          expect(attempt.state).toBe("failed");
          const sends = request.mock.calls.filter(([proc]) => proc === "threads/send");
          expect(sends).toHaveLength(2);
          expect(sends[0]![1].clientNonce).toBe(sends[1]![1].clientNonce);
        }
      } finally {
        scope.userId = "user-a";
        scope.spaceId = "space-a";
        disk.save.mockReturnValue(true);
      }
    },
  );

  it("keeps the captured Space for a rejected Page send and its explicit retry", async () => {
    const attempt = feedback.sendAttempt({
      ...payload("Keep raw"),
      replyTargetId: undefined,
      replyQuote: null,
      pageContext: { pageId: "page-a" },
    });
    request.mockImplementation(async (proc) => {
      if (proc === "artifacts/create") return { id: "artifact-a" };
      scope.spaceId = "space-b";
      throw Object.assign(new Error("Page unavailable"), {
        status: 404,
        code: "NOT_FOUND",
        data: { reason: "page_context_unavailable" },
      });
    });
    await act(async () => feedback.send(attempt));
    expect(attempt.payload.pageContext).toBeUndefined();
    expect(attempt.spaceId).toBe("space-a");
    request.mockResolvedValue({ seq: 42 });
    await act(async () => feedback.send(attempt, true));
    expect(
      request.mock.calls.filter(([proc]) => proc === "threads/send").map((call) => call[3]),
    ).toEqual(["space-a", "space-a"]);
  });

  it("shows the optimistic payload before confirmation, then replaces it with the echo", async () => {
    let finish!: (value: { seq: number }) => void;
    request.mockImplementation(async (proc) =>
      proc === "artifacts/create"
        ? { id: "artifact-a" }
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const attempt = feedback.sendAttempt(payload());
    let sending!: Promise<boolean>;
    act(() => {
      sending = feedback.send(attempt);
    });
    expect(container.textContent).toContain("Hello");
    expect(container.textContent).toContain("Sending…");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const writes = disk.save.mock.calls.length;
    act(() => confirmEchoes("bot-1", []));
    expect(disk.save).toHaveBeenCalledTimes(writes);
    await act(async () => {
      finish({ seq: 42 });
      await sending;
    });
    act(() => confirmEchoes("bot-1", [42]));
    expect(container.textContent).toBe("");
  });
  it("keeps sends ordered, persisted and scoped while offline, and retries on reconnect", async () => {
    reachable = false;
    const first = feedback.sendAttempt(payload("First"));
    const second = feedback.sendAttempt(payload("Second"));
    await act(async () => {
      await feedback.send(first);
      await feedback.send(second);
    });
    expect(request).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Not sent · Tap to retry");
    expect(disk.save).toHaveBeenLastCalledWith([first, second]);
    reachable = true;
    await act(async () => {
      await sendWaitingMessages();
    });
    expect(
      request.mock.calls.filter(([proc]) => proc === "threads/send").map(([, body]) => body.text),
    ).toEqual(["First", "Second"]);
  });
  it("drops late failures and further uploads after a session wipe", async () => {
    let finish!: (value: { id: string }) => void;
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const attempt = feedback.sendAttempt(payload());
    let sending!: Promise<boolean>;
    act(() => {
      sending = feedback.send(attempt);
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    act(() => clearFailedSends());
    await act(async () => {
      finish({ id: "artifact-a" });
      await sending;
    });
    expect(request).toHaveBeenCalledOnce();
    expect(notDelivered).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
    expect(disk.clear).toHaveBeenCalled();
  });
  it("reports real errors and reuses uploaded artifacts on manual retry", async () => {
    const attempt = feedback.sendAttempt(payload());
    request
      .mockResolvedValueOnce({ id: "artifact-a" })
      .mockRejectedValueOnce(new Error("Quota exceeded"));
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(notDelivered).toHaveBeenCalledWith(attempt);
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(request.mock.calls.filter(([proc]) => proc === "artifacts/create")).toHaveLength(1);
    const sends = request.mock.calls.filter(([proc]) => proc === "threads/send");
    expect(sends[0]).toEqual(sends[1]);
  });
  it("retains a policy-refused payload and never resends it during background recovery", async () => {
    const attempt = feedback.sendAttempt(payload("Keep the rejected draft"));
    request
      .mockResolvedValueOnce({ id: "artifact-a" })
      .mockRejectedValueOnce(Object.assign(new Error("platform_model_forbidden"), { status: 403 }));
    await act(async () => {
      await feedback.send(attempt);
    });
    const nonce = attempt.clientNonce;
    const artifacts = Array.from(attempt.artifactIds);
    expect(attempt.state).toBe("refused");
    expect(attempt.payload.displayText).toBe("Keep the rejected draft");
    expect(attempt.payload.attachments[0]?.name).toBeTruthy();
    expect(disk.forget).not.toHaveBeenCalled();
    expect(notDelivered).toHaveBeenCalledWith(attempt);
    const calls = request.mock.calls.length;
    await act(async () => {
      await sendWaitingMessages(true);
      await feedback.send(attempt, true);
    });
    expect(request).toHaveBeenCalledTimes(calls);
    expect(attempt.clientNonce).toBe(nonce);
    expect(Array.from(attempt.artifactIds)).toEqual(artifacts);
  });
  it("keeps a later Run notice and its diagnostics when a refused send is retried or deleted", async () => {
    configureUnsentSends({
      request,
      scope: () => scope,
      serverReachable: () => reachable,
      disk,
      errorText: (error) => (error instanceof Error ? error.message : String(error)),
      notDelivered,
    });
    const run = { id: "later-run", error: "429: too many requests" };
    await act(async () => root.render(<Probe threadKey="bot-1" run={run} />));
    const attempt = feedback.sendAttempt(payload("Retain this refused send"));
    request
      .mockResolvedValueOnce({ id: "artifact-a" })
      .mockRejectedValueOnce(Object.assign(new Error("platform_model_forbidden"), { status: 403 }));
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(2);
    const currentRun = Array.from(container.querySelectorAll('[role="alert"]')).find((alert) =>
      alert.textContent?.includes("rate limiting"),
    )?.parentElement;
    expect(currentRun).toBeDefined();
    const details = Array.from(currentRun!.querySelectorAll("button")).find(
      (button) => button.textContent === "Details",
    );
    await act(async () => details!.click());
    expect(container.querySelector("section")?.textContent).toBe(run.error);
    const nonce = attempt.clientNonce;
    const artifacts = Array.from(attempt.artifactIds);
    const calls = request.mock.calls.length;
    await act(async () => {
      await feedback.send(attempt, true);
      await sendWaitingMessages(true);
    });
    expect(request).toHaveBeenCalledTimes(calls);
    expect(attempt.state).toBe("refused");
    expect(attempt.clientNonce).toBe(nonce);
    expect(Array.from(attempt.artifactIds)).toEqual(artifacts);
    expect(attempt.payload.displayText).toBe("Retain this refused send");
    expect(container.querySelector("section")?.textContent).toBe(run.error);
    await act(async () => feedback.discard(attempt));
    expect(container.textContent).not.toContain("Add API key");
    expect(container.textContent).toContain("rate limiting");
    expect(container.querySelector("section")?.textContent).toBe(run.error);
    expect(request).toHaveBeenCalledTimes(calls);
  });

  it.each(["thread", "Space", "account"] as const)(
    "does not carry refused send recovery across a changed %s",
    async (boundary) => {
      configureUnsentSends({
        request,
        scope: () => scope,
        serverReachable: () => reachable,
        disk,
        errorText: (error) => (error instanceof Error ? error.message : String(error)),
        notDelivered,
      });
      const run = { id: "run-a", error: "429: too many requests" };
      await act(async () =>
        root.render(<Probe threadKey="bot-1" noticeScope="scope-a" run={run} />),
      );
      const attempt = feedback.sendAttempt(payload("Scoped refused draft"));
      request
        .mockResolvedValueOnce({ id: "artifact-a" })
        .mockRejectedValueOnce(
          Object.assign(new Error("platform_model_forbidden"), { status: 403 }),
        );
      await act(async () => {
        await feedback.send(attempt);
      });
      expect(container.textContent).toContain("Add API key");
      try {
        if (boundary === "Space") scope.spaceId = "space-b";
        if (boundary === "account") scope.userId = "user-b";
        await act(async () =>
          root.render(
            <Probe
              threadKey={boundary === "account" ? "bot-1" : "bot-2"}
              noticeScope="scope-b"
              run={{ id: "run-b", error: "503: later failure" }}
            />,
          ),
        );
        expect(container.textContent).not.toContain("Add API key");
        expect(container.textContent).not.toContain("Scoped refused draft");
        expect(container.textContent).not.toContain("rate limiting");
        expect(container.textContent).toContain("The model provider returned an error.");
        expect(attempt.state).toBe("refused");
      } finally {
        scope.userId = "user-a";
        scope.spaceId = "space-a";
      }
    },
  );
  it.each([false, true])("pauses the ordered queue on HTTP 429 (wrapped: %s)", async (wrapped) => {
    reachable = false;
    const first = feedback.sendAttempt(payload("First"));
    const second = feedback.sendAttempt(payload("Second"));
    await act(async () => {
      await feedback.send(first);
      await feedback.send(second);
    });
    reachable = true;
    const error = Object.assign(new Error("Slow down"), { status: 429 });
    request.mockRejectedValueOnce(wrapped ? new AiConsentBlocked("Consent check", error) : error);
    await act(async () => {
      await sendWaitingMessages();
    });
    expect(first.state).toBe("queued");
    expect(second.state).toBe("queued");
    expect(request).toHaveBeenCalledOnce();
    expect(notDelivered).not.toHaveBeenCalled();
  });
  it("retries after a reconnect that arrived during an in-flight send", async () => {
    let rejectUpload!: (error: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject;
        }),
    );
    const attempt = feedback.sendAttempt(payload("Held"));
    let sending!: Promise<boolean>;
    act(() => {
      sending = feedback.send(attempt);
    });
    await vi.waitFor(() => expect(rejectUpload).toBeTypeOf("function"));
    const replay = sendWaitingMessages();
    await act(async () => {
      rejectUpload(Object.assign(new Error("unavailable"), { status: 503 }));
      await sending;
      await replay;
    });
    expect(attempt.acceptedSeq).toBe(42);
    expect(request.mock.calls.filter(([proc]) => proc === "threads/send")).toHaveLength(1);
    expect(notDelivered).not.toHaveBeenCalled();
  });
  it("allows Retry after a consent conflict before dispatch", async () => {
    const attempt = feedback.sendAttempt(payload());
    request.mockRejectedValueOnce(
      new AiConsentBlocked(
        "Review consent again",
        Object.assign(new Error("Changed"), { status: 409 }),
      ),
    );
    await act(async () => {
      await feedback.send(attempt);
    });
    expect(attempt.state).toBe("failed");
    await act(async () => {
      await feedback.send(attempt, true);
    });
    expect(attempt.acceptedSeq).toBe(42);
  });
  it("keeps the original Space while selection changes during an upload", async () => {
    let finish!: (value: { id: string }) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const attempt = feedback.sendAttempt(payload());
    let sending!: Promise<boolean>;
    act(() => {
      sending = feedback.send(attempt);
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    scope.spaceId = "space-b";
    await act(async () => {
      finish({ id: "artifact-a" });
      await sending;
    });
    const [send] = request.mock.calls.filter(([proc]) => proc === "threads/send");
    expect(send?.[3]).toBe("space-a");
    expect(attempt.acceptedSeq).toBe(42);
  });
});
