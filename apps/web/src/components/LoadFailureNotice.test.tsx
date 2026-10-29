// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ me: vi.fn(), generation: 0, space: "space-old" as string | null }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../lib/rpc", () => ({
  selectedSpaceId: () => api.space,
  currentSpaceSelectionGeneration: () => api.generation,
  createSpaceRpc: () => ({ me: api.me }),
}));

import { LoadFailureNotice } from "./LoadFailureNotice";

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  api.me.mockReset();
  api.generation = 0;
  api.space = "space-old";
  vi.unstubAllGlobals();
});
async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  root = createRoot(node);
  const signIn = vi.fn(),
    recover = vi.fn(),
    retry = vi.fn();
  await act(async () =>
    root!.render(
      <LoadFailureNotice
        error={{ status: 401 }}
        cached
        pending={false}
        onSignIn={signIn}
        onRecoverSpace={recover}
        onRetry={retry}
      />,
    ),
  );
  return { node, signIn, recover, retry };
}
it("recovers an inaccessible Space without signing out the valid session", async () => {
  api.me.mockResolvedValue({ userId: "user-fake" });
  const f = await render();
  await act(async () => f.node.querySelector("button")!.click());
  expect(f.recover).toHaveBeenCalledOnce();
  expect(f.signIn).not.toHaveBeenCalled();
});
it("requests sign-in only after the same-session scope-less read also returns401", async () => {
  api.me.mockRejectedValue({ status: 401 });
  const f = await render();
  await act(async () => f.node.querySelector("button")!.click());
  expect(f.signIn).toHaveBeenCalledOnce();
  expect(f.recover).not.toHaveBeenCalled();
});
it("does not confuse a failed probe with session expiry", async () => {
  api.me.mockRejectedValue(new Error("offline"));
  const f = await render();
  await act(async () => f.node.querySelector("button")!.click());
  expect(f.retry).toHaveBeenCalledOnce();
  expect(f.signIn).not.toHaveBeenCalled();
});
it("does not recover an old A to B to A selection after a late read", async () => {
  let resolve!: (value: unknown) => void;
  api.me.mockReturnValue(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const f = await render();
  await act(async () => f.node.querySelector("button")!.click());
  api.generation += 2;
  await act(async () => resolve({ userId: "user-fake" }));
  expect(f.signIn).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
});
