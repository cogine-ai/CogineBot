// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  status: vi.fn(),
  generation: 0,
  sessionGeneration: 0,
  space: null as string | null,
  selected: new Set<() => void>(),
  denied: new Set<() => void>(),
  bootstrap: undefined as
    | Promise<{ me: { userId: string; spaceId: string; billingEnabled: boolean } }>
    | undefined,
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
  currentRpcSessionGeneration: () => api.sessionGeneration,
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
vi.mock("../lib/bootstrap", () => ({ peekInitialBootstrap: () => api.bootstrap }));
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
async function renderGate(billing: boolean, children: ReactNode = <div>app</div>) {
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
        {children}
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
  api.sessionGeneration = 0;
  api.space = null;
  api.bootstrap = undefined;
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

it("keeps a newer work denial while an older initial status settles", async () => {
  const initial = deferred<{ access: boolean }>();
  const fresh = deferred<{ access: boolean }>();
  api.status.mockReturnValueOnce(initial.promise).mockReturnValueOnce(fresh.promise);
  const { container } = await renderGate(true);
  await act(async () => {
    for (const fn of api.denied) fn();
    await settle();
  });
  await act(async () => {
    initial.resolve({ access: true });
    await settle();
  });
  expect(container.textContent).not.toBe("app");
  expect(api.status).toHaveBeenCalledTimes(2);
  expect(api.status).toHaveBeenLastCalledWith(
    { refresh: true },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  await act(async () => {
    fresh.resolve({ access: false });
    await settle();
  });
  expect(container.textContent).toContain("paywall");
});

it("does not fall through a new denial when an older initial status fails", async () => {
  const initial = deferred<{ access: boolean }>();
  const fresh = deferred<{ access: boolean }>();
  api.status.mockReturnValueOnce(initial.promise).mockReturnValueOnce(fresh.promise);
  const { container } = await renderGate(true);
  await act(async () => {
    for (const fn of api.denied) fn();
    await settle();
  });
  await act(async () => {
    initial.reject(new Error("old initial failure"));
    await settle();
  });
  expect(container.textContent).not.toBe("app");
  expect(api.status).toHaveBeenCalledTimes(2);
  await act(async () => {
    fresh.resolve({ access: false });
    await settle();
  });
  expect(container.textContent).toContain("paywall");
});

it("rechecks identity instead of applying an older billing exemption after a denial", async () => {
  const initialIdentity = deferred<{ billingEnabled: boolean }>();
  const fresh = deferred<{ access: boolean }>();
  api.me.mockReturnValueOnce(initialIdentity.promise).mockResolvedValue({ billingEnabled: true });
  api.status.mockReturnValue(fresh.promise);
  const { container } = await renderGate(true);
  await act(async () => {
    for (const fn of api.denied) fn();
    await settle();
  });
  await act(async () => {
    initialIdentity.resolve({ billingEnabled: false });
    await settle();
  });
  expect(container.textContent).not.toBe("app");
  expect(api.me).toHaveBeenCalledTimes(2);
  expect(api.status).toHaveBeenLastCalledWith(
    { refresh: true },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  await act(async () => {
    fresh.resolve({ access: false });
    await settle();
  });
  expect(container.textContent).toContain("paywall");
});

it("rechecks an already cached billing exemption after new work is denied", async () => {
  const fresh = deferred<{ access: boolean }>();
  api.me
    .mockResolvedValueOnce({ billingEnabled: false })
    .mockResolvedValue({ billingEnabled: true });
  api.status.mockReturnValue(fresh.promise);
  const { container } = await renderGate(true);
  expect(container.textContent).toBe("app");
  await act(async () => {
    for (const fn of api.denied) fn();
    await settle();
  });
  expect(container.textContent).not.toBe("app");
  expect(api.me).toHaveBeenCalledTimes(2);
  expect(api.status).toHaveBeenCalledTimes(1);
  await act(async () => {
    fresh.resolve({ access: false });
    await settle();
  });
  expect(container.textContent).toContain("paywall");
});

it("does not reuse an initial bootstrap exemption to resolve a later denial", async () => {
  api.bootstrap = Promise.resolve({
    me: { userId: "user-1", spaceId: "space-a", billingEnabled: false },
  });
  const fresh = deferred<{ access: boolean }>();
  api.status.mockReturnValue(fresh.promise);
  const { container } = await renderGate(true);
  expect(container.textContent).toBe("app");
  expect(api.me).not.toHaveBeenCalled();
  await act(async () => {
    for (const fn of api.denied) fn();
    await settle();
  });
  expect(container.textContent).not.toBe("app");
  expect(api.me).toHaveBeenCalledTimes(1);
  expect(api.status).toHaveBeenCalledTimes(1);
  await act(async () => {
    fresh.resolve({ access: false });
    await settle();
  });
  expect(container.textContent).toContain("paywall");
});

it("rechecks a real denial even when cached deployment capabilities skipped billing", async () => {
  const fresh = deferred<{ access: boolean }>();
  api.status.mockReturnValue(fresh.promise);
  const { container } = await renderGate(false);
  expect(container.textContent).toBe("app");
  expect(api.me).not.toHaveBeenCalled();
  await act(async () => {
    for (const fn of api.denied) fn();
    await settle();
  });
  expect(container.textContent).not.toBe("app");
  expect(api.me).toHaveBeenCalledTimes(1);
  expect(api.status).toHaveBeenCalledTimes(1);
  await act(async () => {
    fresh.resolve({ access: false });
    await settle();
  });
  expect(container.textContent).toContain("paywall");
});

it("coalesces repeated denials with focus and visibility into one forced check", async () => {
  const initial = deferred<{ access: boolean }>();
  const fresh = deferred<{ access: boolean }>();
  api.status.mockReturnValueOnce(initial.promise).mockReturnValueOnce(fresh.promise);
  const { container } = await renderGate(true);
  await act(async () => {
    for (let index = 0; index < 3; index += 1) {
      for (const fn of api.denied) fn();
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    }
    await settle();
  });
  expect(api.status).toHaveBeenCalledTimes(1);
  await act(async () => {
    initial.resolve({ access: true });
    await settle();
  });
  expect(api.status).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toBe("app");
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    fresh.resolve({ access: false });
    await settle();
  });
  expect(api.status).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("paywall");
});

it.each(["active", "error"])(
  "rechecks a denial arriving during an older queued %s result",
  async (result) => {
    const initial = deferred<{ access: boolean }>();
    const queued = deferred<{ access: boolean }>();
    const latest = deferred<{ access: boolean }>();
    api.status
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(queued.promise)
      .mockReturnValueOnce(latest.promise);
    const { container } = await renderGate(true);
    await act(async () => {
      for (const fn of api.denied) fn();
      initial.resolve({ access: true });
      await settle();
    });
    expect(api.status).toHaveBeenCalledTimes(2);
    await act(async () => {
      for (const fn of api.denied) fn();
      if (result === "active") queued.resolve({ access: true });
      else queued.reject(new Error("old queued failure"));
      await settle();
    });
    expect(container.textContent).not.toBe("app");
    expect(container.textContent).not.toContain("billing unavailable");
    expect(api.status).toHaveBeenCalledTimes(3);
    await act(async () => {
      latest.resolve({ access: false });
      await settle();
    });
    expect(container.textContent).toContain("paywall");
    expect(api.status).toHaveBeenCalledTimes(3);
  },
);

it("keeps the mounted draft when a new denial supersedes an in-flight refresh", async () => {
  const old = deferred<{ access: boolean }>();
  const fresh = deferred<{ access: boolean }>();
  api.status
    .mockResolvedValueOnce({ access: true })
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise);
  const { container } = await renderGate(true, <textarea defaultValue="draft" />);
  const draft = container.querySelector("textarea")!;
  draft.value = "draft in progress";
  await act(async () => {
    for (const fn of api.denied) fn();
    await settle();
  });
  await act(async () => {
    for (const fn of api.denied) fn();
    old.resolve({ access: true });
    await settle();
  });
  expect(container.querySelector("textarea")).toBe(draft);
  expect(draft.value).toBe("draft in progress");
  await act(async () => {
    fresh.resolve({ access: false });
    await settle();
  });
  expect(container.textContent).toContain("paywall");
  expect(container.querySelector("textarea")).toBe(draft);
  expect(draft.value).toBe("draft in progress");
});

it("does not start a queued check after its gate unmounts", async () => {
  const initial = deferred<{ access: boolean }>();
  api.status.mockReturnValue(initial.promise);
  const { root } = await renderGate(true);
  await act(async () => {
    for (const fn of api.denied) fn();
    root.unmount();
    roots.splice(roots.indexOf(root), 1);
    initial.resolve({ access: true });
    await settle();
  });
  expect(api.status).toHaveBeenCalledTimes(1);
  expect(api.denied.size).toBe(0);
});

it.each(["account", "Space"])(
  "does not run the old queued check after %s ownership changes",
  async (owner) => {
    api.space = "space-a";
    const initial = deferred<{ access: boolean }>();
    api.status.mockReturnValueOnce(initial.promise).mockResolvedValue({ access: false });
    const { container, render } = await renderGate(true);
    await act(async () => {
      for (const fn of api.denied) fn();
      if (owner === "account") render("user-2");
      else {
        api.space = "space-b";
        api.generation += 1;
        for (const fn of api.selected) fn();
      }
      await settle();
    });
    expect(container.textContent).toContain("paywall");
    expect(api.status).toHaveBeenCalledTimes(2);
    await act(async () => {
      initial.resolve({ access: true });
      await settle();
    });
    expect(container.textContent).toContain("paywall");
    expect(api.status).toHaveBeenCalledTimes(2);
  },
);

it("discards the old queued check when the RPC session rotates", async () => {
  const initial = deferred<{ access: boolean }>();
  api.status.mockReturnValue(initial.promise);
  const { container } = await renderGate(true);
  await act(async () => {
    for (const fn of api.denied) fn();
    api.sessionGeneration += 1;
    initial.resolve({ access: true });
    await settle();
  });
  expect(container.textContent).not.toBe("app");
  expect(api.status).toHaveBeenCalledTimes(1);
});

it("opens only after the queued current status confirms access", async () => {
  const initial = deferred<{ access: boolean }>();
  const fresh = deferred<{ access: boolean }>();
  api.status.mockReturnValueOnce(initial.promise).mockReturnValueOnce(fresh.promise);
  const { container } = await renderGate(true);
  await act(async () => {
    for (const fn of api.denied) fn();
    initial.resolve({ access: true });
    await settle();
  });
  expect(container.textContent).not.toBe("app");
  await act(async () => {
    fresh.resolve({ access: true });
    await settle();
  });
  expect(container.textContent).toBe("app");
  expect(api.status).toHaveBeenCalledTimes(2);
});

it("honors a current identity exemption after discarding the old status", async () => {
  const initial = deferred<{ access: boolean }>();
  api.me
    .mockResolvedValueOnce({ billingEnabled: true })
    .mockResolvedValue({ billingEnabled: false });
  api.status.mockReturnValue(initial.promise);
  const { container } = await renderGate(true);
  await act(async () => {
    for (const fn of api.denied) fn();
    initial.resolve({ access: false });
    await settle();
  });
  expect(container.textContent).toBe("app");
  expect(api.me).toHaveBeenCalledTimes(2);
  expect(api.status).toHaveBeenCalledTimes(1);
});

it("honors current exemption after a denial overrides cached optional capabilities", async () => {
  api.me.mockResolvedValue({ billingEnabled: false });
  const { container } = await renderGate(false);
  expect(api.me).not.toHaveBeenCalled();
  await act(async () => {
    for (const fn of api.denied) fn();
    await settle();
  });
  expect(container.textContent).toBe("app");
  expect(api.me).toHaveBeenCalledTimes(1);
  expect(api.status).not.toHaveBeenCalled();
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
  });
  expect(container.textContent).toBe("app");
  expect(api.me).toHaveBeenCalledTimes(1);
});
