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
      channels: { list: api.channels },
      connections: { list: api.connections },
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
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  await select("bot-2");
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
