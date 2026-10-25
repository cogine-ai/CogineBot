// @vitest-environment jsdom

import type { MessagingStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  status: vi.fn(),
  start: vi.fn(),
  channels: vi.fn(),
  connections: vi.fn(),
  bots: vi.fn(),
  spaces: vi.fn(),
  unlink: vi.fn(),
  channelRespond: vi.fn(),
  channelLeave: vi.fn(),
  connectionRespond: vi.fn(),
  connectionRevoke: vi.fn(),
  selection: "space-1",
  generation: 1,
}));
vi.mock("../lib/rpc", () => ({
  selectedSpaceId: () => api.selection,
  currentSpaceSelectionGeneration: () => api.generation,
  createSpaceRpc: () => ({
    messaging: {
      status: api.status,
      link: { start: api.start },
      identities: { unlink: api.unlink },
      channels: { list: api.channels, respond: api.channelRespond, leave: api.channelLeave },
      connections: {
        list: api.connections,
        respond: api.connectionRespond,
        revoke: api.connectionRevoke,
      },
    },
    bots: { list: api.bots },
    spaces: { list: api.spaces },
  }),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
  DialogClose: () => null,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));
vi.mock("./ExternalConversationSettings", () => ({ ExternalConversationSettings: () => null }));

import { MessagingSettingsOverlay } from "./MessagingSettingsOverlay";

const empty: MessagingStatus = {
  enabled: true,
  providers: ["telegram"],
  openSignup: false,
  identities: [],
};
const linked: MessagingStatus = {
  ...empty,
  identities: [
    {
      id: "identity-new",
      botId: "bot-1",
      botName: "Helper",
      provider: "telegram",
      address: "example",
    },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let view: Awaited<ReturnType<typeof mount>> | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.selection = "space-1";
  api.generation = 1;
  api.status.mockResolvedValue(empty);
  api.channels.mockResolvedValue([]);
  api.connections.mockResolvedValue([]);
  api.bots.mockResolvedValue([
    { id: "bot-1", name: "Helper" },
    { id: "bot-2", name: "Other" },
  ]);
  api.spaces.mockResolvedValue({ current: { id: "space-1", externalConversations: [] } });
  api.start.mockImplementation(async () => ({
    code: "ABCD-2345",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));
});
afterEach(async () => {
  if (view) {
    await act(async () => view!.root.unmount());
    view.container.remove();
    view = null;
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (ownerKey = "owner-1") =>
    act(async () => {
      root.render(
        <MessagingSettingsOverlay ownerKey={ownerKey} spaceId={api.selection} onClose={() => {}} />,
      );
    });
  await render();
  return { container, root, render };
}
async function select(botId: string) {
  await act(async () => {
    const el = view!.container.querySelector("select")!;
    el.value = botId;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function issue() {
  await select("bot-1");
  await act(async () => {
    [...view!.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Link a chat app")!
      .click();
  });
}
it("polls once at a time and refreshes the linked identity without issuing another code", async () => {
  view = await mount();
  await issue();
  const pending = deferred<typeof empty>();
  api.status.mockReturnValueOnce(pending.promise);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  const calls = api.status.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12_000);
  });
  expect(api.status).toHaveBeenCalledTimes(calls);
  api.status.mockResolvedValue(linked);
  await act(async () => pending.resolve(linked));
  expect(view.container.textContent).toContain("example");
  expect(view.container.textContent).not.toContain("ABCD-2345");
  expect(api.start).toHaveBeenCalledOnce();
});
it("keeps the same code after a network failure and stops at its original expiry", async () => {
  api.start.mockImplementation(async () => ({
    code: "ABCD-2345",
    expiresAt: new Date(Date.now() + 6000).toISOString(),
  }));
  view = await mount();
  await issue();
  api.status.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(view.container.textContent).toContain("Could not check the connection");
  expect(view.container.textContent).toContain("ABCD-2345");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(view.container.textContent).toContain("Link code expired");
  expect(view.container.textContent).not.toContain("ABCD-2345");
  expect(api.start).toHaveBeenCalledOnce();
});
it("does not publish a code issued for a target the user has left", async () => {
  view = await mount();
  const issued = deferred<{ code: string; expiresAt: string }>();
  api.start.mockReturnValueOnce(issued.promise);
  await issue();
  const signal = api.start.mock.calls[0]![1].signal as AbortSignal;
  await select("bot-2");
  expect(signal.aborted).toBe(true);
  await act(async () =>
    issued.resolve({ code: "OLD-CODE", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  );
  expect(view.container.textContent).not.toContain("OLD-CODE");
});
it("aborts a polling read on owner change and ignores its late result", async () => {
  view = await mount();
  await issue();
  const pending = deferred<typeof empty>();
  api.status.mockReturnValueOnce(pending.promise);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  const signal = api.status.mock.calls.at(-1)![1].signal as AbortSignal;
  await view.render("owner-2");
  expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve(linked));
  expect(view.container.textContent).not.toContain("example");
  expect(view.container.textContent).not.toContain("ABCD-2345");
});
it("recognizes an existing identity reassigned from another bot", async () => {
  api.status.mockResolvedValue({
    ...linked,
    identities: [{ ...linked.identities[0], botId: "bot-2", botName: "Other" }],
  });
  view = await mount();
  await issue();
  api.status.mockResolvedValue(linked);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(view.container.textContent).not.toContain("ABCD-2345");
  expect(api.start).toHaveBeenCalledOnce();
});

function section(heading: string) {
  return [...view!.container.querySelectorAll("section")].find(
    (element) => element.querySelector("h3")?.textContent === heading,
  )!;
}
async function clickAction(heading: string, label: string) {
  await act(async () => {
    [...section(heading).querySelectorAll("button")]
      .find((button) => button.textContent === label)!
      .click();
  });
}
const channel = {
  id: "membership-1",
  channelId: "channel-1",
  identityId: "identity-new",
  provider: "telegram",
  name: "Synthetic group",
  memberCount: 3,
};
const connection = {
  id: "connection-1",
  peerBotName: "Peer helper",
  peerOwnerLabel: "Synthetic peer",
  incoming: true,
};
for (const [operation, heading, button, mutation] of [
  ["unlink", "Chat apps", "Unlink", api.unlink],
  ["approve channel", "Channels", "Approve", api.channelRespond],
  ["decline channel", "Channels", "Decline", api.channelRespond],
  ["leave channel", "Channels", "Leave", api.channelLeave],
  ["approve connection", "Agent connections", "Approve", api.connectionRespond],
  ["decline connection", "Agent connections", "Decline", api.connectionRespond],
  ["revoke connection", "Agent connections", "Revoke", api.connectionRevoke],
] as const) {
  it(`refreshes a completed ${operation} after the link Bot selection changes`, async () => {
    api.status.mockResolvedValue(linked);
    api.channels.mockResolvedValue([
      { ...channel, status: operation === "leave channel" ? "approved" : "invited" },
    ]);
    api.connections.mockResolvedValue([
      { ...connection, status: operation === "revoke connection" ? "approved" : "pending" },
    ]);
    const pending = deferred<unknown>();
    mutation.mockReturnValueOnce(pending.promise);
    view = await mount();
    await select("bot-1");
    await clickAction(heading, button);
    await select("bot-2");
    const linkButton = [...view.container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Link a chat app",
    )!;
    expect(linkButton.disabled).toBe(true);
    let expected: string;
    if (operation === "unlink") {
      api.status.mockResolvedValue(empty);
      expected = "No chat apps linked yet.";
    } else if (operation === "approve channel") {
      api.channels.mockResolvedValue([{ ...channel, status: "approved" }]);
      expected = "Leave";
    } else if (operation.endsWith("channel")) {
      api.channels.mockResolvedValue([]);
      expected = "No group chats yet.";
    } else if (operation === "approve connection") {
      api.connections.mockResolvedValue([{ ...connection, status: "approved" }]);
      expected = "Revoke";
    } else {
      api.connections.mockResolvedValue([]);
      expected = "No agent connections yet.";
    }
    await act(async () => pending.resolve({}));
    expect(section(heading).textContent).toContain(expected);
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector("select")!.value).toBe("bot-2");
    expect(linkButton.disabled).toBe(false);
    expect(mutation).toHaveBeenCalledOnce();
    expect(api.start).not.toHaveBeenCalled();
  });
}
it("shows a failed messaging mutation after the link Bot selection changes", async () => {
  api.status.mockResolvedValue(linked);
  const pending = deferred<unknown>();
  api.unlink.mockReturnValueOnce(pending.promise);
  view = await mount();
  await select("bot-1");
  await clickAction("Chat apps", "Unlink");
  await select("bot-2");
  await act(async () => pending.reject(new Error("Synthetic mutation failure")));
  expect(view.container.textContent).toContain("Couldn't update messaging settings");
  expect(section("Chat apps").textContent).toContain("example");
  expect(api.status).toHaveBeenCalledOnce();
  expect(api.unlink).toHaveBeenCalledOnce();
  expect(api.start).not.toHaveBeenCalled();
});
it("does not refresh a new owner's settings after an old owner's mutation completes", async () => {
  api.status.mockResolvedValue(linked);
  const pending = deferred<unknown>();
  api.unlink.mockReturnValueOnce(pending.promise);
  view = await mount();
  await clickAction("Chat apps", "Unlink");
  api.status.mockResolvedValue(empty);
  await view.render("owner-2");
  await act(async () => pending.resolve({}));
  expect(api.status).toHaveBeenCalledTimes(2);
  expect(section("Chat apps").textContent).not.toContain("example");
  expect(view.container.textContent).not.toContain("Couldn't update messaging settings");
});
it("aborts the old polling read when the selected link Bot changes", async () => {
  view = await mount();
  await issue();
  const pending = deferred<typeof empty>();
  api.status.mockReturnValueOnce(pending.promise);
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  const signal = api.status.mock.calls.at(-1)![1].signal as AbortSignal;
  const calls = api.status.mock.calls.length;
  await select("bot-2");
  expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve(linked));
  await act(async () => vi.advanceTimersByTimeAsync(12_000));
  expect(api.status).toHaveBeenCalledTimes(calls);
  expect(view.container.textContent).not.toContain("example");
  expect(view.container.textContent).not.toContain("ABCD-2345");
});
