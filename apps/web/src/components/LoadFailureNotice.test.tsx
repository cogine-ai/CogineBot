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
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
  vi.restoreAllMocks();
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

function useTimedAbort() {
  vi.useFakeTimers();
  // The platform timeout uses its own clock; use a controlled clock with a real AbortSignal.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
      milliseconds,
    );
    return controller.signal;
  });
}
function stalledAuthProbe(_input: undefined, options?: { signal?: AbortSignal }) {
  return new Promise<never>((_resolve, reject) => {
    const signal = options?.signal;
    if (!signal) return;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
it("bounds a stalled auth probe and permits a new recovery attempt without signing out", async () => {
  useTimedAbort();
  api.me.mockImplementation(stalledAuthProbe);
  const f = await render();
  await act(async () => {
    f.node.querySelector("button")!.click();
    f.node.querySelector("button")!.click();
  });
  expect(api.me).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(14_999));
  expect(f.retry).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(f.retry).toHaveBeenCalledOnce();
  expect(f.signIn).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
  await act(async () => f.node.querySelector("button")!.click());
  expect(api.me).toHaveBeenCalledTimes(2);
});

it.each(["space-aba", "unmount"])("ignores a timed-out auth probe after %s", async (boundary) => {
  useTimedAbort();
  api.me.mockImplementation(stalledAuthProbe);
  const f = await render();
  await act(async () => f.node.querySelector("button")!.click());
  if (boundary === "space-aba") api.generation += 2;
  else {
    act(() => root?.unmount());
    root = undefined;
  }
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(api.me.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(f.retry).not.toHaveBeenCalled();
  expect(f.signIn).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
});
