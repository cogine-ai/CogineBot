// @vitest-environment jsdom
import { RemoteImagesContext } from "@rakazo/chat-ui/web";
import type { MessageBlock } from "@rakazo/contracts";
import type { AnnouncementEvent, AnnouncementSnapshot } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import replyAnnouncementCases from "../../../../packages/testkit/src/reply-announcement-fixtures.json" with {
  type: "json",
};
import webAnnouncementCases from "../../../../packages/testkit/src/web-reply-announcement-fixtures.json" with {
  type: "json",
};
import { useReplyAnnouncements } from "./use-reply-announcements";

const REPLY_ANNOUNCEMENT_CASES = replyAnnouncementCases as {
  name: string;
  blocks: MessageBlock[];
  spoken: string;
  webSpoken?: string;
}[];

let stop = () => {};
let observe: (event: AnnouncementEvent) => void = () => {};
function Screen({
  scope,
  snapshot,
  hidden = false,
}: {
  scope: string;
  snapshot: AnnouncementSnapshot;
  hidden?: boolean;
}) {
  const [text, cancel, receive] = useReplyAnnouncements(scope, snapshot, hidden);
  observe = receive;
  stop = cancel;
  return <div role="status">{text}</div>;
}
function snapshot(status: string, run = "r", blocks?: MessageBlock[]): AnnouncementSnapshot {
  return {
    threadId: "thread",
    run: status === "completed" ? null : { id: run, status },
    messages:
      status === "completed"
        ? [
            {
              id: `m-${run}`,
              runId: run,
              role: "bot",
              blocks: blocks ?? [{ kind: "text", text: "Same complete reply" }],
            },
          ]
        : [],
  };
}
let cleanup = async () => {};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
});
async function setup() {
  const view = document.createElement("div");
  document.body.appendChild(view);
  const root = createRoot(view);
  cleanup = async () => {
    await act(async () => root.unmount());
    view.remove();
  };
  const render = async (
    status: string,
    options: {
      scope?: string;
      run?: string;
      hidden?: boolean;
      blocks?: MessageBlock[];
      loadRemoteImages?: boolean;
    } = {},
  ) => {
    if (status === "completed")
      await act(async () =>
        observe({
          type: "run.completed",
          threadId: "thread",
          runId: options.run ?? "r",
          payload: { messageId: `m-${options.run ?? "r"}` },
        }),
      );
    await act(async () =>
      root.render(
        <RemoteImagesContext.Provider value={options.loadRemoteImages ?? false}>
          <Screen
            scope={options.scope ?? "scope"}
            snapshot={snapshot(status, options.run, options.blocks)}
            hidden={options.hidden}
          />
        </RemoteImagesContext.Provider>,
      ),
    );
  };
  const flush = async () => {
    await act(async () => vi.runOnlyPendingTimers());
  };
  return { view, render, flush };
}

describe("rendered reply live region", () => {
  it.each(REPLY_ANNOUNCEMENT_CASES)(
    "publishes visible $name",
    async ({ blocks, spoken, webSpoken }) => {
      const { view, render, flush } = await setup();
      await render("running");
      await render("completed", { blocks });
      await flush();
      expect(view.querySelector('[role="status"]')?.textContent).toBe(webSpoken ?? spoken);
      await render("completed", { blocks });
      await flush();
      expect(view.querySelector('[role="status"]')?.textContent).toBe(webSpoken ?? spoken);
    },
  );
  it.each(webAnnouncementCases)(
    "publishes renderer-owned $name",
    async ({ source, loadRemoteImages, spoken }) => {
      const { view, render, flush } = await setup();
      await render("running", { loadRemoteImages });
      await render("completed", { loadRemoteImages, blocks: [{ kind: "text", text: source }] });
      await flush();
      expect(view.textContent).toBe(spoken);
      await render("completed", {
        loadRemoteImages,
        blocks: [{ kind: "text", text: "Late edit" }],
      });
      await flush();
      expect(view.textContent).toBe(spoken);
    },
  );
  it("keeps image identity and Stop stable when image loading changes", async () => {
    const { view, render, flush } = await setup();
    const blocks: MessageBlock[] = [
      { kind: "text", text: "![chart](https://setting.example.test/p.png)" },
    ];
    await render("running");
    await render("running", { loadRemoteImages: true });
    await render("completed", { blocks, loadRemoteImages: true });
    await flush();
    expect(view.textContent).toBe("chart");
    await render("completed", { blocks, loadRemoteImages: false });
    await flush();
    expect(view.textContent).toBe("chart");
    await render("running", { run: "stopped" });
    await act(async () => stop());
    await render("running", { run: "stopped", loadRemoteImages: true });
    await render("completed", { run: "stopped", blocks, loadRemoteImages: true });
    await flush();
    expect(view.textContent).toBe("");
  });
  it("does not publish a late edit after consuming a formatting-only completion", async () => {
    const { view, render, flush } = await setup();
    await render("running");
    await render("completed", { blocks: [{ kind: "text", text: "***" }] });
    await flush();
    await render("completed", { blocks: [{ kind: "text", text: "Late visible edit" }] });
    await flush();
    expect(view.textContent).toBe("");
  });
  it("retains Stop across hidden reentry even when the Run snapshot is stale", async () => {
    const { view, render, flush } = await setup();
    await render("running");
    await act(async () => stop());
    await render("running", { hidden: true });
    await render("running");
    await render("completed");
    await flush();
    expect(view.textContent).toBe("");
  });

  it("does not let a previous scope's Stop handler suppress a new scope's pending reply", async () => {
    const { view, render, flush } = await setup();
    await render("running");
    const oldStop = stop;
    await render("running", { scope: "new-scope" });
    await render("completed", { scope: "new-scope" });
    await act(async () => oldStop());
    await flush();
    expect(view.textContent).toBe("Same complete reply");
  });

  it("skips history and publishes identical new replies through a real clear-then-set cycle", async () => {
    const { view, render, flush } = await setup();
    await render("completed");
    await flush();
    expect(view.textContent).toBe("");
    await render("running", { run: "next" });
    await render("completed", { run: "next" });
    expect(view.textContent).toBe("");
    await flush();
    expect(view.textContent).toBe("Same complete reply");
    await render("running", { run: "later" });
    await render("completed", { run: "later" });
    expect(view.textContent).toBe("");
    await flush();
    expect(view.textContent).toBe("Same complete reply");
  });
  it("cancels an already scheduled live update when Stop is pressed", async () => {
    const { view, render, flush } = await setup();
    await render("running");
    await render("completed");
    await act(async () => stop());
    await flush();
    expect(view.textContent).toBe("");
  });
  it("drops pending output on thread/account changes and does not replay background completion", async () => {
    const { view, render, flush } = await setup();
    await render("running");
    await render("completed");
    await render("completed", { scope: "other" });
    await flush();
    expect(view.textContent).toBe("");
    await render("running", { scope: "other", run: "new" });
    await render("running", { scope: "other", run: "new", hidden: true });
    await render("completed", { scope: "other", run: "new" });
    await flush();
    expect(view.textContent).toBe("");
  });
});
