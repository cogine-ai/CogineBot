// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageFrame } from "./PageFrame";

const { open, copy } = vi.hoisted(() => ({
  open: vi.fn<(url: string) => void>(),
  copy: vi.fn<(text: string) => Promise<boolean>>(),
}));
vi.mock("@rakazo/chat-ui/web", () => ({ useExternalLinkOpener: () => ({ open, dialog: null }) }));
vi.mock("../../lib/copy-text", () => ({ writeClipboard: copy }));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  open.mockReset();
  copy.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function harness() {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const onHeight = vi.fn<(height: number) => void>();
  const onReply = vi.fn<(text: string) => void>();
  return {
    onHeight,
    onReply,
    async render(documentKey: string, interactive: boolean) {
      await act(async () =>
        root.render(
          <PageFrame
            document="<p>Identical HTML</p>"
            documentKey={documentKey}
            title="Page fixture"
            interactive={interactive}
            onHeight={onHeight}
            onReply={onReply}
          />,
        ),
      );
      const frame = container.querySelector("iframe")!;
      const source = frame.contentWindow!;
      const post = vi.spyOn(source, "postMessage").mockImplementation(() => {});
      frame.dispatchEvent(new Event("load"));
      const load = post.mock.lastCall?.[0] as { instance: string; document: string } | undefined;
      if (!load) throw new Error("Viewer did not load");
      const { instance } = load;
      post.mockClear();
      return {
        frame,
        source,
        post,
        instance,
        document: load.document,
        send(message: unknown, from = source, key = instance) {
          return act(async () => {
            window.dispatchEvent(
              new MessageEvent("message", {
                source: from,
                origin: "null",
                data: { type: "rakazo-viewer:message", instance: key, message },
              }),
            );
          });
        },
      };
    },
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("draws previews and honors only the current focused interactive frame's validated action once", async () => {
  const view = harness();
  try {
    const preview = await view.render("page-1:1", false);
    expect(preview.document).toContain("media-src data: blob:;");
    preview.frame.focus();
    await preview.send({ type: "rakazo-page:height", height: 300 });
    await preview.send({ type: "rakazo-page:reply", text: "No preview action", gesture: "key:1" });
    expect(view.onHeight.mock.calls).toEqual([[300]]);
    expect(view.onReply).not.toHaveBeenCalled();

    const frame = await view.render("page-1:1", true);
    expect(frame.frame).not.toBe(preview.frame);
    expect(frame.frame.hasAttribute("allow")).toBe(false);
    await frame.send({ type: "rakazo-page:reply", text: "No focus", gesture: "key:1" });
    frame.frame.focus();
    await frame.send({ type: "rakazo-page:reply", text: "No gesture" });
    await frame.send(
      { type: "rakazo-page:reply", text: "Cross frame", gesture: "key:1" },
      preview.source,
    );
    await frame.send(
      { type: "rakazo-page:reply", text: "Stale identity", gesture: "key:1" },
      frame.source,
      preview.instance,
    );
    await frame.send({ type: "rakazo-page:reply", text: "x".repeat(301), gesture: "key:1" });
    await frame.send({ type: "rakazo-page:reply", text: 42, gesture: "key:1" });
    await frame.send({
      type: "rakazo-page:open-link",
      url: "javascript:alert(1)",
      gesture: "key:1",
    });
    await frame.send({
      type: "rakazo-page:copy",
      id: "bad",
      text: "x".repeat(20_001),
      gesture: "key:1",
    });
    await frame.send({
      type: "rakazo-page:reply",
      text: "  Continue\n with this  ",
      gesture: "key:1",
    });
    await frame.send({
      type: "rakazo-page:open-link",
      url: "https://example.invalid/",
      gesture: "key:1",
    });
    await frame.send({
      type: "rakazo-page:open-link",
      url: "https://example.invalid/help",
      gesture: "key:2",
    });
    await frame.send({ type: "rakazo-page:height", height: Infinity });
    await frame.send({ type: "rakazo-page:height", height: 300_000 });
    expect(view.onReply.mock.calls).toEqual([["Continue with this"]]);
    expect(open.mock.calls).toEqual([["https://example.invalid/help"]]);
    expect(copy).not.toHaveBeenCalled();
    expect(view.onHeight.mock.calls).toEqual([[300], [200_000]]);
  } finally {
    await view.cleanup();
  }
});

it("reports copy outcomes only to the owning load and drops an old copy when the shown version changes", async () => {
  const view = harness();
  try {
    let finishCopy!: (ok: boolean) => void;
    copy
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishCopy = resolve;
          }),
      );
    const first = await view.render("page-1:1", true);
    first.frame.focus();
    const request = (id: string) => ({
      type: "rakazo-page:copy",
      id,
      text: `Text ${id}`,
      gesture: `key:${id}`,
    });
    await first.send(request("1"));
    await first.send(request("2"));
    await first.send(request("3"));
    expect(copy.mock.calls).toEqual([["Text 1"], ["Text 2"], ["Text 3"]]);
    expect(first.post.mock.calls).toEqual(
      [true, false].map((ok, index) => [
        {
          type: "rakazo-viewer:answer",
          instance: first.instance,
          message: { type: "rakazo-page:copied", id: String(index + 1), ok },
        },
        "*",
      ]),
    );
    const next = await view.render("page-1:2", true);
    expect(next.frame).not.toBe(first.frame);
    await act(async () => finishCopy(true));
    expect(first.post).toHaveBeenCalledTimes(2);
    expect(next.post).not.toHaveBeenCalled();
  } finally {
    await view.cleanup();
  }
});
