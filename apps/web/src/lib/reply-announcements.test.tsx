// @vitest-environment jsdom
import type { AnnouncementEvent, AnnouncementSnapshot } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReplyAnnouncements } from "./use-reply-announcements";

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
function snapshot(status: string, run = "r"): AnnouncementSnapshot {
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
              blocks: [{ kind: "text", text: "Same complete reply" }],
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
    options: { scope?: string; run?: string; hidden?: boolean } = {},
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
        <Screen
          scope={options.scope ?? "scope"}
          snapshot={snapshot(status, options.run)}
          hidden={options.hidden}
        />,
      ),
    );
  };
  const flush = async () => {
    await act(async () => vi.runOnlyPendingTimers());
  };
  return { view, render, flush };
}

describe("rendered reply live region", () => {
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
