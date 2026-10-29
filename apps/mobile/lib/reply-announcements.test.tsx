// @vitest-environment jsdom
import type { AnnouncementSnapshot } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReplyAnnouncements } from "./use-reply-announcements";

const screen = vi.hoisted(() => ({ focused: true, active: true, announce: vi.fn() }));
vi.mock("expo-router", () => ({ useIsFocused: () => screen.focused }));
vi.mock("./app-active", () => ({ useAppActive: () => screen.active }));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: screen.announce },
}));
let stop = () => {};
function Thread({ value, scope = "scope" }: { value: AnnouncementSnapshot; scope?: string }) {
  stop = useReplyAnnouncements(scope, value);
  return null;
}
let cleanup = async () => {};
afterEach(async () => {
  await cleanup();
  screen.focused = true;
  screen.active = true;
  screen.announce.mockClear();
});
function value(status: string, run = "r"): AnnouncementSnapshot {
  return {
    threadId: "t",
    run: { id: run, status },
    messages: [
      {
        id: `m-${run}`,
        role: "bot",
        runId: run,
        blocks: [{ kind: "text", text: "完整新回复 👩‍👩‍👧‍👦" }],
      },
    ],
  };
}
async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const view = document.createElement("div");
  const root = createRoot(view);
  cleanup = async () => {
    await act(async () => root.unmount());
  };
  return async (status: string, run = "r", scope = "scope") => {
    await act(async () => root.render(<Thread value={value(status, run)} scope={scope} />));
  };
}

describe("native completed reply announcements", () => {
  it("calls the native accessibility API once for a visible completed Run", async () => {
    const render = await setup();
    await render("running");
    await render("completed");
    await render("completed");
    expect(screen.announce).toHaveBeenCalledExactlyOnceWith("完整新回复 👩‍👩‍👧‍👦");
  });
  it("suppresses Stop before late completion, but permits a later new Run", async () => {
    const render = await setup();
    await render("running");
    stop();
    await render("completed");
    expect(screen.announce).not.toHaveBeenCalled();
    await render("running", "new");
    await render("completed", "new");
    expect(screen.announce).toHaveBeenCalledOnce();
  });
  it("does not announce a background result on foreground or a previous route's history", async () => {
    const render = await setup();
    await render("running");
    screen.active = false;
    await render("running");
    screen.active = true;
    await render("completed");
    await render("completed", "old", "other-scope");
    expect(screen.announce).not.toHaveBeenCalled();
  });
});
