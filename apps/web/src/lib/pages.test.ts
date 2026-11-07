import { describe, expect, it, vi } from "vitest";
import { createPageSession, loadPageRuntime } from "./pages";

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String.raw }) }));

const card = {
  id: "m1",
  blocks: [{ kind: "page" as const, pageId: "p1", version: 1, title: "Plan" }],
};

describe("page session", () => {
  it("replies to the open page's card unless the user picked a reply themselves", () => {
    const session = createPageSession();
    session.dock.set({ page: { id: "p1", title: "Plan" } });
    expect(session.send("bigger", [card])).toEqual({ text: "bigger", replyToMessageId: "m1" });
    expect(session.send("bigger", [card], "m0")).toEqual({ text: "bigger" });
    session.dock.set({ page: null });
    expect(session.send("bigger", [card])).toEqual({ text: "bigger" });
  });

  it("marks only automatic missing-card context while retaining a hand-written leading Page link", () => {
    const session = createPageSession();
    const raw = "[https://owner.example/report](page:manual)\nPlease read this.";
    session.dock.set({ page: { id: "p1", title: "Plan" } });
    expect(session.send(raw, [])).toEqual({
      text: `[Plan](page:p1)\n${raw}`,
      pageContext: { pageId: "p1" },
    });
    expect(session.send(raw, [card])).toEqual({ text: raw, replyToMessageId: "m1" });
    expect(session.send(raw, [], "chosen-message")).toEqual({ text: raw });
    session.dock.set({ page: null });
    expect(session.send(raw, [])).toEqual({ text: raw });
  });
});

describe("page replies", () => {
  it("hands a page's reply to the composer collapsed, only while a page is open", () => {
    const session = createPageSession();
    const received: string[] = [];
    const stop = session.subscribeReply((text) => received.push(text));
    session.offerReply("closed page");
    session.dock.set({ page: { id: "p1", title: "Plan" } });
    session.offerReply("  Watch   the\n shirt ");
    session.offerReply("   ");
    session.offerReply("x".repeat(301));
    session.offerReply({ text: "object" });
    session.offerReply("x".repeat(300));
    stop();
    session.offerReply("after unsubscribe");
    expect(received).toEqual(["Watch the shirt", "x".repeat(300)]);
  });
});

describe("public Page runtime", () => {
  it("coalesces same-server reads and reuses bytes only after an anonymous 304", async () => {
    const url = "https://pages.example.test/runtime.js";
    let complete!: (response: Response) => void;
    const initial = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(initial)
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const one = loadPageRuntime(url, fetcher);
    const two = loadPageRuntime(url, fetcher);
    expect(one).toBe(two);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(url, { credentials: "omit" });
    complete(new Response("Public runtime", { headers: { etag: '"v1"' } }));
    await expect(one).resolves.toBe("Public runtime");
    await expect(loadPageRuntime(url, fetcher)).resolves.toBe("Public runtime");
    expect(fetcher).toHaveBeenLastCalledWith(url, {
      credentials: "omit",
      headers: { "if-none-match": '"v1"' },
    });
  });

  it("keeps server caches separate and retries a failed read", async () => {
    const url = "https://other-pages.example.test/runtime.js";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("Different runtime"));
    await expect(loadPageRuntime(url, fetcher)).rejects.toThrow("503");
    await expect(loadPageRuntime(url, fetcher)).resolves.toBe("Different runtime");
    expect(fetcher.mock.calls).toEqual([
      [url, { credentials: "omit" }],
      [url, { credentials: "omit" }],
    ]);
  });
});
