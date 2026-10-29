// @vitest-environment jsdom
import type { BillingStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../lib/rpc";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
    Plural: () => null,
  };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Skeleton: () => <div>loading</div>,
}));

import { BillingSettingsPanel } from "./BillingSettingsPanel";

const status: BillingStatus = {
  access: true,
  canManage: true,
  trialAvailable: false,
  trialDays: 7,
  state: "active",
  price: null,
  seats: 1,
  trialEndsAt: null,
  currentPeriodEndsAt: null,
  cancelAtPeriodEnd: false,
  hasCustomer: true,
};
let root: ReturnType<typeof createRoot> | undefined;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});
async function render(load: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  root = createRoot(node);
  let current = true;
  const isCurrent = () => current;
  const portal = vi.fn();
  const client = { billing: { status: load, portal } } as unknown as RpcClient;
  await act(async () =>
    root!.render(<BillingSettingsPanel client={client} isCurrent={isCurrent} />),
  );
  return {
    node,
    portal,
    expire: () => {
      current = false;
    },
  };
}
it("coalesces focus and visibility while using provider-synchronized refresh", async () => {
  const load = vi.fn().mockResolvedValueOnce(status);
  const f = await render(load);
  expect(f.node.textContent).toContain("Active");
  const pending = deferred<BillingStatus>();
  load.mockReturnValue(pending.promise);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(load).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenLastCalledWith(
    { refresh: true },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  await act(async () => pending.resolve({ ...status, state: "canceled" }));
  expect(f.node.textContent).toContain("Canceled");
});
it("does not publish a delayed old Space result", async () => {
  const pending = deferred<BillingStatus>();
  const f = await render(vi.fn().mockReturnValue(pending.promise));
  f.expire();
  await act(async () => pending.resolve(status));
  expect(f.node.textContent).not.toContain("Active");
});
it("offers retry while retaining the last authoritative status", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce(status)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(status);
  const f = await render(load);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(f.node.textContent).toContain("Active");
  expect(f.node.textContent).toContain("Could not load billing");
  await act(async () =>
    [...f.node.querySelectorAll("button")]
      .find((button) => button.textContent === "Retry")!
      .click(),
  );
  expect(f.node.textContent).not.toContain("Could not load billing");
});

it("does not navigate a delayed portal after its panel is closed", async () => {
  const f = await render(vi.fn().mockResolvedValue(status));
  const pending = deferred<{ url: string }>();
  f.portal.mockReturnValue(pending.promise);
  await act(async () =>
    [...f.node.querySelectorAll("button")]
      .find((button) => button.textContent === "Manage")!
      .click(),
  );
  act(() => root!.unmount());
  root = undefined;
  const assign = vi.fn();
  const originalWindow = window;
  vi.stubGlobal(
    "window",
    new Proxy(originalWindow, {
      get(target, key, receiver) {
        return key === "location" ? { assign } : Reflect.get(target, key, receiver);
      },
    }),
  );
  await act(async () => pending.resolve({ url: "https://billing.example.test/portal" }));
  expect(assign).not.toHaveBeenCalled();
});
