// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  status: vi.fn(),
  generation: 0,
  space: null as string | null,
  selected: new Set<() => void>(),
  denied: new Set<() => void>(),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../lib/rpc", () => ({
  createSpaceRpc: () =>
    Object.assign(
      () => {
        throw new Error("A callable RPC client must be stored, never invoked as a state updater");
      },
      { me: api.me, billing: { status: api.status } },
    ),
  currentSpaceSelectionGeneration: () => api.generation,
  currentRpcSessionGeneration: () => 0,
  rememberImplicitRpcSpace: vi.fn(),
  selectedSpaceId: () => api.space,
  subscribeSelectedSpace: (listener: () => void) => {
    api.selected.add(listener);
    return () => api.selected.delete(listener);
  },
  subscribeSubscriptionRequired: (listener: () => void) => {
    api.denied.add(listener);
    return () => api.denied.delete(listener);
  },
}));
vi.mock("@rakazo/ui-web", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../lib/bootstrap", () => ({ peekInitialBootstrap: () => undefined }));
vi.mock("../pages/Paywall", () => ({
  BillingUnavailablePage: ({
    onRetry,
    onDismiss,
  }: {
    onRetry: () => void;
    onDismiss: () => void;
  }) => (
    <div>
      billing unavailable
      <button type="button" onClick={onRetry}>
        retry
      </button>
      <button type="button" onClick={onDismiss}>
        back
      </button>
    </div>
  ),
  PaywallPage: ({
    refreshFailed,
    onRetry,
    onDismiss,
  }: {
    refreshFailed: boolean;
    onRetry: () => void;
    onDismiss: () => void;
  }) => (
    <div>
      paywall{refreshFailed ? " unavailable" : ""}
      <button type="button" onClick={onRetry}>
        retry
      </button>
      <button type="button" onClick={onDismiss}>
        back
      </button>
    </div>
  ),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
async function renderGate(billing: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        billing,
        passwordAuth: true,
        sso: null,
        passwordReset: false,
        resetUrl: null,
      }),
    ),
  );
  vi.resetModules();
  const { SubscriptionGate } = await import("./SubscriptionGate");
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const render = (userId = "user-1") =>
    root.render(
      <SubscriptionGate userId={userId} fallback={<div>loading</div>}>
        <div>app</div>
      </SubscriptionGate>,
    );
  await act(async () => {
    render();
    await settle();
  });
  return { container, root, render };
}
beforeEach(() => {
  api.me.mockReset().mockResolvedValue({ billingEnabled: true });
  api.status.mockReset().mockResolvedValue({ access: false });
  api.generation = 0;
  api.space = null;
});
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  api.selected.clear();
  api.denied.clear();
  vi.unstubAllGlobals();
});
it("opens without me or billing when the deployment does not bill", async () => {
  const { container } = await renderGate(false);
  expect(container.textContent).toBe("app");
  expect(api.me).not.toHaveBeenCalled();
  expect(api.status).not.toHaveBeenCalled();
});
it("skips billing for the deployment owner or exempt user", async () => {
  api.me.mockResolvedValue({ billingEnabled: false });
  const { container } = await renderGate(true);
  expect(container.textContent).toBe("app");
  expect(api.status).not.toHaveBeenCalled();
});
it("keeps initial lookup failure as fallthrough rather than fabricated subscription denial", async () => {
  api.status.mockRejectedValue(new Error("offline"));
  const { container } = await renderGate(true);
  expect(container.textContent).toBe("app");
});
it("opens the paywall once a provider-synchronized focus check finds access", async () => {
  const { container } = await renderGate(true);
  expect(container.textContent).toContain("paywall");
  api.status.mockResolvedValue({ access: true });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await settle();
  });
  expect(api.status).toHaveBeenLastCalledWith(
    { refresh: true },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(container.textContent).toBe("app");
});
it("coalesces focus and visibility while preserving a truthful unavailable state", async () => {
  const { container } = await renderGate(true);
  const pending = deferred<never>();
  api.status.mockReturnValue(pending.promise);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await settle();
  });
  expect(api.status).toHaveBeenCalledTimes(2);
  await act(async () => {
    pending.reject({ status: 503, data: { reason: "billing_unavailable" } });
    await settle();
  });
  expect(container.textContent).toContain("paywall unavailable");
  api.status.mockResolvedValue({ access: true });
  await act(async () => {
    container.querySelector("button")!.click();
    await settle();
  });
  expect(container.textContent).toBe("app");
});
it("ignores an old account response after a new account owns the gate", async () => {
  const old = deferred<{ access: boolean }>();
  api.status.mockReturnValueOnce(old.promise).mockResolvedValue({ access: false });
  const { container, render } = await renderGate(true);
  await act(async () => {
    render("user-2");
    await settle();
  });
  expect(container.textContent).toContain("paywall");
  await act(async () => {
    old.resolve({ access: true });
    await settle();
  });
  expect(container.textContent).toContain("paywall");
});
it("uses generation rather than Space identity for A to B to A", async () => {
  api.space = "space-a";
  const old = deferred<{ access: boolean }>();
  api.status.mockReturnValueOnce(old.promise).mockResolvedValue({ access: false });
  const { container } = await renderGate(true);
  await act(async () => {
    api.space = "space-b";
    api.generation += 1;
    for (const fn of api.selected) fn();
    await settle();
  });
  await act(async () => {
    api.space = "space-a";
    api.generation += 1;
    for (const fn of api.selected) fn();
    await settle();
  });
  await act(async () => {
    old.resolve({ access: true });
    await settle();
  });
  expect(container.textContent).toContain("paywall");
});
it("rechecks a genuine new-work denial after an initially failed lookup", async () => {
  api.status.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ access: false });
  const { container } = await renderGate(true);
  expect(container.textContent).toBe("app");
  await act(async () => {
    for (const fn of api.denied) fn();
    await settle();
  });
  expect(container.textContent).toContain("paywall");
});
it("does not pull billing on every focus while access is already open", async () => {
  api.status.mockResolvedValue({ access: true });
  const { container } = await renderGate(true);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await settle();
  });
  expect(container.textContent).toBe("app");
  expect(api.status).toHaveBeenCalledTimes(1);
});

it("keeps Stop and read-only chats reachable without granting new work", async () => {
  const { container } = await renderGate(true);
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "back")!
      .click(),
  );
  expect(container.textContent).toBe("app");
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await settle();
  });
  expect(container.textContent).toBe("app");
  await act(async () => {
    for (const fn of api.denied) fn();
    await settle();
  });
  expect(container.textContent).toContain("paywall");
});

it.each(["active", "no-snapshot"])(
  "recovers an actual402 followed by failed status from %s without inventing billing fields",
  async (initial) => {
    if (initial === "active") api.status.mockResolvedValueOnce({ access: true });
    else api.status.mockRejectedValueOnce(new Error("initial unavailable"));
    const { container } = await renderGate(true);
    expect(container.textContent).toBe("app");
    api.status.mockRejectedValue({ status: 503, data: { reason: "billing_unavailable" } });
    await act(async () => {
      for (const fn of api.denied) fn();
      await settle();
    });
    expect(container.textContent).toContain("app");
    expect(container.textContent).toContain("billing unavailable");
    expect(container.textContent).not.toContain("paywall");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "back")!
        .click(),
    );
    expect(container.textContent).toBe("app");
    api.status.mockResolvedValue({ access: true });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await settle();
    });
    expect(api.status).toHaveBeenLastCalledWith(
      { refresh: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(container.textContent).toBe("app");
  },
);
