// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type { AgentSkillCatalogEntry, ThreadMessage } from "@rakazo/contracts";
import type { ComposerMention } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act, createRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  clearComposerDrafts,
  consumeSubmittedComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from "../lib/composer-draft";
import { useComposerDraft } from "../lib/use-composer-draft";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

import { Composer } from "./Shell";

type ComposerProps = ComponentProps<typeof Composer>;
type HarnessProps = Omit<ComposerProps, "draftState" | "onDraftChange" | "pendingAttachments">;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let props: HarnessProps;
const draftKey = "composer-test";
const bob: ComposerMention = { kind: "bot", id: "bot-2", name: "Bob" };
const summarize: AgentSkillCatalogEntry = {
  id: "skill-1",
  name: "summarize",
  description: "Summarize a document",
  source: "user",
  readOnly: false,
};

function Harness() {
  const { draft, updateDraft } = useComposerDraft(props.draftKey);
  const key = props.draftKey;
  const onSend = props.onSend;
  return (
    <Composer
      {...props}
      draftState={draft}
      onDraftChange={updateDraft}
      pendingAttachments={draft.attachments}
      replyTarget={draft.replyTarget}
      replyQuote={draft.replyQuote}
      onSend={async (text, mentions, version) => {
        const submitted = readComposerDraft(key);
        const accepted = await onSend(text, mentions, version);
        if (accepted) consumeSubmittedComposerDraft(key, submitted);
        return accepted;
      }}
    />
  );
}
function rerender(overrides: Partial<HarnessProps> = {}) {
  props = { ...props, ...overrides };
  act(() => root?.render(<Harness />));
}
function renderComposer(onSend: ComposerProps["onSend"]) {
  i18n.load("en", {});
  i18n.activate("en");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia ??= () =>
    ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  props = {
    draftKey,
    active: true,
    artifactTarget: { botId: "bot-1" },
    activeName: "Ada",
    running: false,
    attachmentNotice: null,
    sendError: null,
    runError: null,
    runErrorId: null,
    onRunErrorPresented: () => {},
    onDismissError: () => {},
    sending: false,
    fileInputRef: createRef(),
    onAttachmentPick: () => {},
    onRemoveAttachment: () => {},
    onSend,
    onStop: async () => {},
    mentionTargets: [bob],
    agentSkills: [summarize],
  };
  rerender();
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[name="chat-message"]');
  if (!textarea) throw new Error("composer textarea not found");
  return textarea;
}
function type(textarea: HTMLTextAreaElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function send(textarea: HTMLTextAreaElement) {
  act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
function deferred() {
  let resolve!: (accepted: boolean) => void;
  return {
    promise: new Promise<boolean>((done) => {
      resolve = done;
    }),
    finish: (accepted: boolean) => resolve(accepted),
  };
}
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  clearComposerDrafts();
});

it("submits the exact draft version and clears after acceptance", async () => {
  const onSend = vi.fn().mockResolvedValue(true);
  const textarea = renderComposer(onSend);
  type(textarea, "hello");
  const version = readComposerDraft(draftKey).version;
  send(textarea);
  await act(async () => {});
  expect(onSend).toHaveBeenCalledWith("hello", [], version);
  expect(textarea.value).toBe("");
});
it("retains text and mentions until a send is accepted", async () => {
  const pending = deferred();
  const onSend = vi.fn(() => pending.promise);
  const textarea = renderComposer(onSend);
  type(textarea, "@Bo");
  send(textarea);
  type(textarea, "hello");
  send(textarea);
  expect(onSend).toHaveBeenCalledWith("@Bob hello", [bob], expect.any(Number));
  expect(textarea.value).toBe("hello");
  await act(async () => pending.finish(false));
  expect(textarea.value).toBe("hello");
  expect(container?.querySelector('[data-testid="mention-chip"]')?.textContent).toContain("Bob");
});
it("retains a chosen skill when a send fails", async () => {
  const textarea = renderComposer(vi.fn().mockResolvedValue(false));
  type(textarea, "/sum");
  act(() =>
    container?.querySelector<HTMLButtonElement>('button[aria-label="Skill summarize"]')?.click(),
  );
  type(textarea, "the notes");
  send(textarea);
  await act(async () => {});
  expect(textarea.value).toBe("the notes");
  expect(container?.querySelector('[data-testid="skill-chip"]')?.textContent).toContain(
    "summarize",
  );
});
for (const accepted of [false, true]) {
  it(`preserves a newer draft after an earlier send ${accepted ? "succeeds" : "fails"}`, async () => {
    const pending = deferred();
    const textarea = renderComposer(() => pending.promise);
    type(textarea, "hello");
    send(textarea);
    type(textarea, "newer");
    await act(async () => pending.finish(accepted));
    expect(textarea.value).toBe("newer");
  });
}
it("does not resurrect text typed and then cleared during a failed send", async () => {
  const pending = deferred();
  const textarea = renderComposer(() => pending.promise);
  type(textarea, "hello");
  send(textarea);
  type(textarea, "newer");
  type(textarea, "");
  await act(async () => pending.finish(false));
  expect(textarea.value).toBe("");
});
it("does not clear another conversation when the original send succeeds", async () => {
  const pending = deferred();
  const textarea = renderComposer(() => pending.promise);
  type(textarea, "hello");
  send(textarea);
  act(() => writeComposerDraft("another-conversation", { text: "other draft" }));
  rerender({ draftKey: "another-conversation" });
  await act(async () => pending.finish(true));
  expect(textarea.value).toBe("other draft");
  expect(readComposerDraft(draftKey).version).toBe(0);
});
it("submits an unchanged retry with the same draft version and reflects later edits", async () => {
  const onSend = vi.fn().mockResolvedValue(false);
  const textarea = renderComposer(onSend);
  type(textarea, "hello");
  send(textarea);
  await act(async () => {});
  send(textarea);
  await act(async () => {});
  expect(onSend.mock.calls[1]?.[2]).toBe(onSend.mock.calls[0]?.[2]);
  type(textarea, "edited");
  send(textarea);
  await act(async () => {});
  expect(onSend.mock.calls[2]?.[2]).not.toBe(onSend.mock.calls[0]?.[2]);
});
it("keeps newly selected reply context after the old send succeeds", async () => {
  const pending = deferred();
  const textarea = renderComposer(() => pending.promise);
  type(textarea, "hello");
  send(textarea);
  const reply: ThreadMessage = {
    id: "message-1",
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    blocks: [{ kind: "text", text: "original reply" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  act(() =>
    writeComposerDraft(draftKey, { text: "follow-up", replyTarget: reply, replyQuote: "original" }),
  );
  await act(async () => pending.finish(true));
  expect(textarea.value).toBe("follow-up");
  expect(readComposerDraft(draftKey).replyTarget?.id).toBe("message-1");
});

it.each(["run", "send"])(
  "opens Models from a %s policy refusal while keeping the current draft",
  async (source) => {
    const onSend = vi.fn().mockResolvedValue(false);
    const textarea = renderComposer(onSend);
    type(textarea, "Keep this draft");
    const original = readComposerDraft(draftKey);
    const onAddKey = vi.fn();
    rerender({
      runError: source === "run" ? "platform_model_forbidden" : null,
      runErrorId: source === "run" ? "run-policy" : null,
      sendError: source === "send" ? "platform_model_forbidden" : null,
      onAddKey,
    });
    expect(container?.querySelector('[data-testid="composer-error"]')?.textContent).toContain(
      "Add your own API key to continue.",
    );
    const action = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === "Add API key",
    );
    expect(action).toBeDefined();
    await act(async () => action!.click());
    expect(onAddKey).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(readComposerDraft(draftKey)).toEqual(original);
    expect(textarea.value).toBe("Keep this draft");
    rerender({ runError: null, runErrorId: null, sendError: null });
    expect(container?.textContent).not.toContain("Add API key");
  },
);
