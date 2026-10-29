// @vitest-environment jsdom
import type { AnnouncementSnapshot } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useReplyAnnouncements } from "../lib/use-reply-announcements";
import { SubscriptionGate } from "./SubscriptionGate";

const state = vi.hoisted(() => ({ access: true, denied: new Set<() => void>() }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../lib/auth-capabilities", () => ({
  fetchAuthCapabilities: async () => ({ billing: true }),
}));
vi.mock("../lib/bootstrap", () => ({ peekInitialBootstrap: () => undefined }));
vi.mock("../lib/rpc", () => ({
  createSpaceRpc: () => ({
    me: async () => ({ userId: "user", billingEnabled: true }),
    billing: { status: async () => ({ access: state.access }) },
  }),
  currentSpaceSelectionGeneration: () => 0,
  currentRpcSessionGeneration: () => 0,
  rememberImplicitRpcSpace: () => {},
  selectedSpaceId: () => "space",
  subscribeSelectedSpace: () => () => {},
  subscribeSubscriptionRequired: (listener: () => void) => {
    state.denied.add(listener);
    return () => state.denied.delete(listener);
  },
}));
vi.mock("@rakazo/ui-web", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../pages/Paywall", () => ({
  PaywallPage: ({ onDismiss }: { onDismiss: () => void }) => (
    <button type="button" onClick={onDismiss}>
      Back
    </button>
  ),
  BillingUnavailablePage: () => null,
}));
let cleanup = async () => {};
afterEach(async () => {
  await cleanup();
  state.denied.clear();
  vi.useRealTimers();
});

it.each(["covered", "queued-before-cover", "stop-across-cover"])(
  "suppresses a mounted chat live region during actual billing modal: %s",
  async (kind) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    state.access = true;
    const element = document.createElement("div");
    const root = createRoot(element);
    cleanup = async () => {
      await act(async () => root.unmount());
    };
    let value: AnnouncementSnapshot = {
      threadId: "thread",
      cursor: 10,
      run: { id: "run", status: "running" },
      messages: [],
    };
    let controls: ReturnType<typeof useReplyAnnouncements>;
    function Thread() {
      controls = useReplyAnnouncements("owner", value);
      return <div role="status">{controls[0]}</div>;
    }
    const draw = () =>
      root.render(
        <SubscriptionGate userId="user" fallback={<span>Loading</span>}>
          <Thread />
        </SubscriptionGate>,
      );
    await act(async () => draw());
    const complete = async (id: string, seq: number) => {
      await act(async () => {
        controls[2]({
          type: "run.completed",
          threadId: "thread",
          runId: id,
          seq,
          payload: { messageId: `message-${id}` },
        });
        value = {
          ...value,
          cursor: seq,
          run: null,
          messages: [
            ...value.messages,
            {
              id: `message-${id}`,
              role: "bot",
              runId: id,
              blocks: [{ kind: "text", text: `Reply-${id}` }],
            },
          ],
        };
        draw();
      });
    };
    if (kind === "stop-across-cover") await act(async () => controls[1]());
    if (kind === "queued-before-cover") await complete("run", 12);
    state.access = false;
    await act(async () => {
      for (const listener of state.denied) listener();
    });
    expect(element.querySelector('[role="dialog"]')).not.toBeNull();
    if (kind === "covered") await complete("run", 12);
    await act(async () => vi.runOnlyPendingTimers());
    expect(element.querySelector('[role="status"]')?.textContent).toBe("");
    await act(async () => element.querySelector<HTMLButtonElement>("button")!.click());
    if (kind === "stop-across-cover") await complete("run", 12);
    await act(async () => vi.runOnlyPendingTimers());
    expect(element.querySelector('[role="status"]')?.textContent).toBe("");
    await act(async () => {
      value = { ...value, run: { id: "new", status: "running" } };
      draw();
    });
    await complete("new", 14);
    await act(async () => vi.runOnlyPendingTimers());
    expect(element.querySelector('[role="status"]')?.textContent).toBe("Reply-new");
  },
);
