// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Pages from "../../lib/pages";
import { PagesProvider, usePagesForChat } from "../../lib/pages";
import type * as Rpc from "../../lib/rpc";
import { selectSpace, synchronizeRpcSession } from "../../lib/rpc";
import { PageViewHost } from "./PageViewHost";

const fixture = vi.hoisted(() => ({
  detail: {
    id: "page-plan",
    title: "Plan",
    botId: "origin-bot" as string | null,
    groupId: null as string | null,
    visibility: "private" as const,
    currentVersion: 1,
    version: 1,
    pinned: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    code: "compiled",
    owner: { name: "Page Owner", image: null },
  },
  get: vi.fn(),
  rename: vi.fn(),
  renameAction: undefined as ((title: string) => void) | undefined,
  reply: undefined as ((text: string) => void) | undefined,
  views: [] as { route: string; canReply: boolean; hasComposer: boolean }[],
}));
vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String.raw }) }));
vi.mock("../../lib/rpc", async (original) => ({
  ...(await original<typeof Rpc>()),
  createSpaceRpc: () => ({ pages: { get: fixture.get, rename: fixture.rename } }),
}));
vi.mock("../../lib/pages", async (original) => ({
  ...(await original<typeof Pages>()),
  useMedia: () => false,
  usePageDocument: () => ({ document: "<p>Plan</p>", failed: false, retry: vi.fn() }),
}));
vi.mock("./PageView", () => ({
  PageView: ({
    composer,
    onReply,
    onRename,
    renameError,
  }: {
    composer?: ReactNode;
    onReply?: (text: string) => void;
    onRename?: (title: string) => void;
    renameError?: string | null;
  }) => {
    const location = useLocation();
    fixture.reply = onReply;
    fixture.renameAction = onRename;
    fixture.views.push({
      route: location.pathname + location.search,
      canReply: Boolean(onReply),
      hasComposer: composer !== undefined,
    });
    return (
      <section aria-label="Page reader">
        <button
          type="button"
          data-testid="page-reply"
          disabled={!onReply}
          onClick={() => onReply?.("What changed?")}
        >
          Reply from page
        </button>
        <button
          type="button"
          data-testid="page-rename"
          disabled={!onRename}
          onClick={() => onRename?.("Renamed plan")}
        >
          Rename page
        </button>
        {renameError ? <p role="alert">{renameError}</p> : null}
        {composer}
      </section>
    );
  },
}));

const bots = [{ id: "current-bot" }, { id: "origin-bot" }];
const groups = [{ id: "current-group" }, { id: "origin-group" }];
let unmount: (() => Promise<void>) | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.get.mockReset().mockImplementation(async ({ pageId }: { pageId: string }) => ({
    ...fixture.detail,
    id: pageId,
  }));
  fixture.rename.mockReset().mockResolvedValue({ ok: true });
  fixture.renameAction = undefined;
  fixture.detail.botId = "origin-bot";
  fixture.detail.groupId = null;
  fixture.reply = undefined;
  fixture.views.length = 0;
  selectSpace("space-1");
  synchronizeRpcSession("authenticated", "owner-1", "session-1");
});
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount(initial: string, available = { bots, groups }) {
  const drafts = new Map([[initial.split("?")[0]!, "Existing draft"]]);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  function Shell() {
    const { botId, groupId } = useParams();
    const location = useLocation();
    const navigate = useNavigate();
    const pages = usePagesForChat(
      JSON.stringify(["owner-1", "space-1", botId, groupId]),
      "space-1",
    );
    const [, update] = useState(0);
    useEffect(
      () =>
        pages.session.subscribeReply((text) => {
          const previous = drafts.get(location.pathname) ?? "";
          drafts.set(location.pathname, previous ? `${previous} ${text}` : text);
          update((n) => n + 1);
        }),
      [pages.session, location.pathname],
    );
    return (
      <PagesProvider value={pages}>
        <output data-testid="route">{location.pathname + location.search}</output>
        <input aria-label="Chat draft" readOnly value={drafts.get(location.pathname) ?? ""} />
        <button type="button" data-testid="close-page" onClick={() => navigate(location.pathname)}>
          Close reader
        </button>
        <button
          type="button"
          data-testid="other-page"
          onClick={() => navigate(`${location.pathname}?page=page-other`)}
        >
          Other page
        </button>
        <PageViewHost bots={available.bots} groups={available.groups} />
      </PagesProvider>
    );
  }
  const render = () =>
    root.render(
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/app/:botId" element={<Shell />} />
          <Route path="/app/g/:groupId" element={<Shell />} />
        </Routes>
      </MemoryRouter>,
    );
  await act(async () => render());
  unmount = async () => act(() => root.unmount());
  const reply = () =>
    act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="page-reply"]')!.click();
    });
  return {
    container,
    drafts,
    reply,
    roster: async (next: typeof available) => {
      available = next;
      await act(async () => render());
    },
  };
}

it("moves a linked page to its originating bot before a reply can reach a composer", async () => {
  const view = await mount("/app/current-bot?page=page-plan");
  expect(view.container.querySelector("output")?.textContent).toBe(
    "/app/origin-bot?page=page-plan",
  );
  await view.reply();
  expect(view.drafts.get("/app/current-bot")).toBe("Existing draft");
  expect(view.drafts.get("/app/origin-bot")).toBe("What changed?");
  expect(
    fixture.views
      .filter((entry) => entry.route.startsWith("/app/current-bot"))
      .every((entry) => !entry.canReply && !entry.hasComposer),
  ).toBe(true);
});

it.each([
  { from: "/app/g/current-group", bot: "origin-bot", group: null, to: "/app/origin-bot" },
  { from: "/app/current-bot", bot: "origin-bot", group: "origin-group", to: "/app/g/origin-group" },
  {
    from: "/app/g/current-group",
    bot: "origin-bot",
    group: "origin-group",
    to: "/app/g/origin-group",
  },
])(
  "routes the page from $from to $to without sending to the old chat",
  async ({ from, bot, group, to }) => {
    fixture.detail.botId = bot;
    fixture.detail.groupId = group;
    const view = await mount(`${from}?page=page-plan&m=old-chat-message`);
    expect(view.container.querySelector("output")?.textContent).toBe(`${to}?page=page-plan`);
    await view.reply();
    expect(view.drafts.get(from)).toBe("Existing draft");
    expect(view.drafts.get(to)).toBe("What changed?");
    expect(
      fixture.views
        .filter((entry) => entry.route.startsWith(from))
        .every((entry) => !entry.canReply && !entry.hasComposer),
    ).toBe(true);
  },
);

it.each([
  { bot: "missing-bot", group: null },
  { bot: "origin-bot", group: "missing-group" },
  { bot: null, group: null },
])(
  "leaves a page with unavailable origin $bot/$group readable without a reply target",
  async ({ bot, group }) => {
    fixture.detail.botId = bot;
    fixture.detail.groupId = group;
    const view = await mount("/app/current-bot?page=page-plan");
    expect(view.container.querySelector("output")?.textContent).toBe(
      "/app/current-bot?page=page-plan",
    );
    expect(
      view.container.querySelector<HTMLButtonElement>('[data-testid="page-reply"]')!.disabled,
    ).toBe(true);
    await view.reply();
    expect(view.drafts.get("/app/current-bot")).toBe("Existing draft");
    expect(fixture.views.every((entry) => !entry.canReply && !entry.hasComposer)).toBe(true);
  },
);

it("waits for the current Space roster before routing or enabling a reply", async () => {
  const view = await mount("/app/current-bot?page=page-plan", { bots: [], groups: [] });
  expect(view.container.querySelector("output")?.textContent).toBe(
    "/app/current-bot?page=page-plan",
  );
  await view.reply();
  expect(view.drafts.get("/app/current-bot")).toBe("Existing draft");
  await view.roster({ bots, groups });
  expect(view.container.querySelector("output")?.textContent).toBe(
    "/app/origin-bot?page=page-plan",
  );
  await view.reply();
  expect(view.drafts.get("/app/origin-bot")).toBe("What changed?");
});

it("keeps a same-chat draft and query intact when the page already belongs there", async () => {
  const view = await mount("/app/origin-bot?page=page-plan&attention=1");
  expect(view.container.querySelector("output")?.textContent).toBe(
    "/app/origin-bot?page=page-plan&attention=1",
  );
  expect(view.drafts.get("/app/origin-bot")).toBe("Existing draft");
  await view.reply();
  expect(view.drafts.get("/app/origin-bot")).toBe("Existing draft What changed?");
});

it("leaves new-chat mode before attaching the recorded bot's composer", async () => {
  const view = await mount("/app/origin-bot?page=page-plan&new-chat");
  expect(view.container.querySelector("output")?.textContent).toBe(
    "/app/origin-bot?page=page-plan",
  );
  expect(
    fixture.views
      .filter((entry) => entry.route.includes("new-chat"))
      .every((entry) => !entry.canReply && !entry.hasComposer),
  ).toBe(true);
});

it("rejects a previously enabled reply callback when the roster removes its origin", async () => {
  const view = await mount("/app/origin-bot?page=page-plan");
  const reply = fixture.reply!;
  expect(reply).toBeTypeOf("function");
  await view.roster({ bots: [{ id: "current-bot" }], groups });
  await act(async () => reply("Late page reply"));
  expect(view.drafts.get("/app/origin-bot")).toBe("Existing draft");
  expect(
    view.container.querySelector<HTMLButtonElement>('[data-testid="page-reply"]')!.disabled,
  ).toBe(true);
});

it("rejects the old callback after closing the page within the same chat", async () => {
  const view = await mount("/app/origin-bot?page=page-plan");
  const reply = fixture.reply!;
  await act(async () =>
    view.container.querySelector<HTMLButtonElement>('[data-testid="close-page"]')!.click(),
  );
  expect(view.container.querySelector("output")?.textContent).toBe("/app/origin-bot");
  await act(async () => reply("Late page reply"));
  expect(view.drafts.get("/app/origin-bot")).toBe("Existing draft");
});

it("rejects the old callback immediately when the authenticated account changes", async () => {
  const view = await mount("/app/origin-bot?page=page-plan");
  const reply = fixture.reply!;
  synchronizeRpcSession("authenticated", "owner-2", "session-2");
  await act(async () => reply("Late page reply"));
  expect(view.drafts.get("/app/origin-bot")).toBe("Existing draft");
});

it("disables an in-flight title rename, reconciles a lost reply and clears its error on retry", async () => {
  let reject!: (error: Error) => void;
  fixture.rename.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const view = await mount("/app/origin-bot?page=page-plan");
  const button = () =>
    view.container.querySelector<HTMLButtonElement>('[data-testid="page-rename"]')!;
  await act(async () => button().click());
  expect(fixture.rename).toHaveBeenCalledWith({ pageId: "page-plan", title: "Renamed plan" });
  expect(button().disabled).toBe(true);
  const reads = fixture.get.mock.calls.length;
  await act(async () => reject(new Error("reply lost")));
  expect(button().disabled).toBe(false);
  expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not rename this page. Try again.",
  );
  expect(fixture.get.mock.calls.length).toBe(reads + 1);
  await act(async () => button().click());
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(button().disabled).toBe(false);
});

it("gives the next page independent rename state while the previous page's rename settles", async () => {
  let reject!: (error: Error) => void;
  fixture.rename.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const view = await mount("/app/origin-bot?page=page-plan");
  await act(async () => fixture.renameAction!("Old title"));
  await act(async () =>
    view.container.querySelector<HTMLButtonElement>('[data-testid="other-page"]')!.click(),
  );
  const button = view.container.querySelector<HTMLButtonElement>('[data-testid="page-rename"]')!;
  expect(button.disabled).toBe(false);
  await act(async () => reject(new Error("old reply lost")));
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(fixture.rename).toHaveBeenLastCalledWith({ pageId: "page-other", title: "Renamed plan" });
});

it("rejects a retained rename action after the authenticated account changes", async () => {
  const view = await mount("/app/origin-bot?page=page-plan");
  const rename = fixture.renameAction!;
  synchronizeRpcSession("authenticated", "owner-2", "session-2");
  await act(async () => rename("Late rename"));
  expect(fixture.rename).not.toHaveBeenCalled();
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
});
