// @vitest-environment jsdom
import type { MessageBlock } from "@rakazo/contracts";
import type { AnnouncementEvent, AnnouncementSnapshot } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import replyAnnouncementCases from "../../../packages/testkit/src/reply-announcement-fixtures.json" with {
  type: "json",
};
import { useReplyAnnouncements } from "./use-reply-announcements";

const REPLY_ANNOUNCEMENT_CASES = replyAnnouncementCases as {
  name: string;
  blocks: MessageBlock[];
  spoken: string;
}[];

const screen = vi.hoisted(() => ({ focused: true, active: true, announce: vi.fn() }));
vi.mock("expo-router", () => ({ useIsFocused: () => screen.focused }));
vi.mock("./app-active", () => ({ useAppActive: () => screen.active }));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: screen.announce },
}));
let stop = () => {};
let observe: (event: AnnouncementEvent) => void = () => {};
function Thread({ value, scope = "scope" }: { value: AnnouncementSnapshot; scope?: string }) {
  [stop, observe] = useReplyAnnouncements(scope, value);
  return null;
}
let cleanup = async () => {};
afterEach(async () => {
  await cleanup();
  screen.focused = true;
  screen.active = true;
  screen.announce.mockClear();
});
function value(status: string, run = "r", blocks?: MessageBlock[]): AnnouncementSnapshot {
  return {
    threadId: "t",
    run: status === "completed" ? null : { id: run, status },
    messages:
      status === "completed"
        ? [
            {
              id: `m-${run}`,
              role: "bot",
              runId: run,
              blocks: blocks ?? [{ kind: "text", text: "完整新回复 👩‍👩‍👧‍👦" }],
            },
          ]
        : [],
  };
}
async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const view = document.createElement("div");
  const root = createRoot(view);
  cleanup = async () => {
    await act(async () => root.unmount());
  };
  return async (status: string, run = "r", scope = "scope", blocks?: MessageBlock[]) => {
    if (status === "completed")
      await act(async () =>
        observe({
          type: "run.completed",
          threadId: "t",
          runId: run,
          payload: { messageId: `m-${run}` },
        }),
      );
    await act(async () => root.render(<Thread value={value(status, run, blocks)} scope={scope} />));
  };
}

describe("native completed reply announcements", () => {
  it.each(REPLY_ANNOUNCEMENT_CASES)(
    "calls the native API with visible $name only once",
    async ({ blocks, spoken }) => {
      const render = await setup();
      await render("running");
      await render("completed", "r", "scope", blocks);
      await render("completed", "r", "scope", blocks);
      if (spoken) expect(screen.announce).toHaveBeenCalledExactlyOnceWith(spoken);
      else expect(screen.announce).not.toHaveBeenCalled();
    },
  );
  it("does not announce a late edit after consuming a formatting-only completion", async () => {
    const render = await setup();
    await render("running");
    await render("completed", "r", "scope", [{ kind: "text", text: "***" }]);
    await render("completed", "r", "scope", [{ kind: "text", text: "Late visible edit" }]);
    expect(screen.announce).not.toHaveBeenCalled();
  });
  it("retains Stop across background reentry with an unchanged running snapshot", async () => {
    const render = await setup();
    await render("running");
    await act(async () => stop());
    screen.active = false;
    await render("running");
    screen.active = true;
    await render("running");
    await render("completed");
    expect(screen.announce).not.toHaveBeenCalled();
  });

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
