// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigationType, useParams } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const capability = vi.hoisted(() => ({
  enabled: undefined as boolean | undefined,
  listeners: new Set<() => void>(),
  boardLoaded: vi.fn(),
  shellRendered: vi.fn(),
  peek: vi.fn<() => Promise<unknown> | undefined>(),
  take: vi.fn<() => Promise<unknown>>(),
  pathname: "",
  userId: "user-1",
  sessionId: "session-1",
  ownerSync: vi.fn(),
  navigationType: "",
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("./lib/bootstrap", () => ({
  getTicketBoardEnabled: () => capability.enabled,
  subscribeTicketBoardEnabled: (listener: () => void) => {
    capability.listeners.add(listener);
    return () => capability.listeners.delete(listener);
  },
  peekInitialBootstrap: capability.peek,
  takeInitialBootstrap: capability.take,
}));
vi.mock("./lib/auth", () => ({
  authClient: {
    useSession: () => ({
      isPending: false,
      data: { user: { id: capability.userId }, session: { id: capability.sessionId } },
      refetch: vi.fn(),
    }),
  },
}));
vi.mock("./lib/remote-images-preference", () => ({
  getRemoteImagesEnabled: () => false,
  subscribeRemoteImages: () => () => {},
}));
vi.mock("./lib/performance", () => ({ markOnce: () => {}, markAfterPaint: () => {} }));
vi.mock("./lib/rpc", () => ({
  rpc: {},
  synchronizeRpcSession: capability.ownerSync,
  clearSpaceSelection: vi.fn(),
}));
vi.mock("./components/SubscriptionGate", () => ({
  SubscriptionGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./pages/Shell", () => ({
  ShellPage: () => {
    capability.shellRendered(useParams().botId);
    return <div>Shell</div>;
  },
}));
vi.mock("./pages/Board", () => {
  capability.boardLoaded();
  return { BoardPage: () => <div>Board page</div> };
});
vi.mock("./pages/IntegrationSetup", () => ({ IntegrationSetupPage: () => null }));
vi.mock("./pages/LocalSettings", () => ({ LocalSettingsPage: () => null }));
vi.mock("./pages/McpOAuthCallback", () => ({ McpOAuthCallbackPage: () => null }));

import { App } from "./App";

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  capability.userId = "user-1";
  capability.sessionId = "session-1";
  capability.ownerSync.mockClear();
  capability.enabled = undefined;
  capability.listeners.clear();
  capability.shellRendered.mockClear();
  capability.peek.mockReset();
  capability.take.mockReset();
  container = document.createElement("div");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

function LocationProbe() {
  capability.pathname = useLocation().pathname;
  capability.navigationType = useNavigationType();
  return null;
}

async function renderAt(pathname = "/app/board") {
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[pathname]}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    );
  });
}

function publishCapability(enabled: boolean) {
  capability.enabled = enabled;
  for (const listener of capability.listeners) listener();
}

it("keeps a pending Board deep link until bootstrap enables it, without loading its chunk early", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  capability.peek.mockReturnValue(pending);
  await renderAt();
  expect(capability.pathname).toBe("/app/board");
  expect(capability.shellRendered).not.toHaveBeenCalled();
  expect(capability.boardLoaded).not.toHaveBeenCalled();
  expect(container.querySelector('[data-rakazo-app-state="session-pending"]')).not.toBeNull();

  await act(async () => {
    publishCapability(true);
    finish();
  });
  expect(capability.boardLoaded).toHaveBeenCalledOnce();
  expect(container.textContent).toBe("Board page");
  expect(capability.pathname).toBe("/app/board");
  expect(capability.take).not.toHaveBeenCalled();
});

it("reserves a known-disabled Board path and replaces it with the app route", async () => {
  capability.enabled = false;
  const boardLoads = capability.boardLoaded.mock.calls.length;
  await renderAt();
  expect(capability.pathname).toBe("/app");
  expect(capability.navigationType).toBe("REPLACE");
  expect(capability.shellRendered).toHaveBeenCalledWith(undefined);
  expect(capability.shellRendered).not.toHaveBeenCalledWith("board");
  expect(capability.boardLoaded).toHaveBeenCalledTimes(boardLoads);
  expect(capability.take).not.toHaveBeenCalled();
});

it("redirects an open Board when its capability becomes disabled", async () => {
  capability.enabled = true;
  await renderAt();
  expect(container.textContent).toBe("Board page");
  await act(async () => publishCapability(false));
  expect(capability.pathname).toBe("/app");
  expect(capability.navigationType).toBe("REPLACE");
  expect(capability.shellRendered).not.toHaveBeenCalledWith("board");
});

it("keeps ordinary Bot routes independent of Board capability loading", async () => {
  await renderAt("/app/bot-1");
  expect(container.textContent).toBe("Shell");
  expect(capability.pathname).toBe("/app/bot-1");
  expect(capability.shellRendered).toHaveBeenCalledWith("bot-1");
  expect(capability.peek).not.toHaveBeenCalled();
  expect(capability.take).not.toHaveBeenCalled();
});

it("shows the existing refresh recovery after a capability failure and can recover on a fresh mount", async () => {
  capability.take.mockRejectedValueOnce(new Error("Server unavailable"));
  await renderAt();
  expect(capability.take).toHaveBeenCalledOnce();
  expect(capability.pathname).toBe("/app/board");
  expect(container.querySelector('[data-rakazo-app-state="failed"]')).not.toBeNull();
  expect(container.textContent).toContain("Something went wrong. Try again.");
  expect(container.textContent).toContain("Refresh");
  expect(capability.shellRendered).not.toHaveBeenCalled();

  await act(async () => root?.unmount());
  capability.take.mockImplementationOnce(async () => publishCapability(true));
  await renderAt();
  expect(container.textContent).toBe("Board page");
  expect(capability.pathname).toBe("/app/board");
  expect(capability.take).toHaveBeenCalledTimes(2);
});

it("publishes account and exact session changes including A to B to A to the transport", async () => {
  await renderAt("/app");
  const render = () =>
    root!.render(
      <MemoryRouter initialEntries={["/app"]}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    );
  await act(async () => {
    capability.userId = "user-2";
    capability.sessionId = "session-2";
    render();
  });
  await act(async () => {
    capability.userId = "user-1";
    capability.sessionId = "session-1";
    render();
  });
  expect(capability.ownerSync.mock.calls.slice(-3)).toEqual([
    ["authenticated", "user-1", "session-1"],
    ["authenticated", "user-2", "session-2"],
    ["authenticated", "user-1", "session-1"],
  ]);
});
