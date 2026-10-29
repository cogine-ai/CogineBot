// @vitest-environment jsdom
import type { BillingStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../lib/rpc";

const api = vi.hoisted(() => ({
  checkout: vi.fn(),
  portal: vi.fn(),
  logout: vi.fn(),
  list: vi.fn(),
  assign: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join(""), i18n: { locale: "en" } }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { size?: string; variant?: string }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("./Auth", () => ({
  AuthFrame: ({ title, children, onSubmit }: ComponentProps<"form"> & { title: ReactNode }) => (
    <form onSubmit={onSubmit}>
      <h1>{title}</h1>
      {children}
    </form>
  ),
  submitClass: "",
}));
vi.mock("../lib/billing", () => ({
  BILLING_REQUEST_TIMEOUT_MS: 15_000,
  formatBillingPrice: () => "$12 / month",
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../lib/sign-out", () => ({
  useSignOut: () => ({ signingOut: false, logOut: api.logout }),
}));
vi.mock("../lib/rpc", () => ({
  clearSpaceSelection: vi.fn(),
  selectSpace: vi.fn(),
  createSpaceRpc: () => ({ spaces: { list: api.list } }),
}));

import { BillingUnavailablePage, PaywallPage } from "./Paywall";

const status: BillingStatus = {
  access: false,
  canManage: true,
  trialAvailable: true,
  trialDays: 7,
  state: "none",
  price: { amount: 1200, currency: "usd", interval: "month", intervalCount: 1 },
  seats: 1,
  trialEndsAt: null,
  currentPeriodEndsAt: null,
  cancelAtPeriodEnd: false,
  hasCustomer: false,
};
let root: ReturnType<typeof createRoot> | undefined;
let current: boolean;
const retry = vi.fn();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function render(overrides: Partial<BillingStatus> = {}) {
  const container = document.createElement("div");
  root = createRoot(container);
  const client = {
    billing: { checkout: api.checkout, portal: api.portal },
  } as unknown as RpcClient;
  await act(async () =>
    root!.render(
      <PaywallPage
        status={{ ...status, ...overrides }}
        client={client}
        isCurrent={() => current}
        onRetry={retry}
        onDismiss={vi.fn()}
        recovery={null}
        refreshFailed={false}
      />,
    ),
  );
  return container;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  current = true;
  retry.mockReset();
  api.checkout.mockReset();
  api.portal.mockReset();
  api.logout.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});
it("offers members Space recovery without an ineffective purchase action", async () => {
  const node = await render({ canManage: false });
  expect(node.textContent).toContain("Contact your organization owner");
  expect(node.textContent).toContain("Switch Space");
  expect(node.textContent).not.toContain("Subscribe");
  expect(node.textContent).not.toContain("Start 7-day");
  expect(node.textContent).not.toContain("Manage billing");
});
it("does not guess a price or offer checkout when price lookup is unavailable", async () => {
  const node = await render({ price: null });
  expect(node.textContent).toContain("Subscription required");
  expect(node.textContent).not.toContain("$12");
  expect(node.querySelector('button[type="submit"]')).toBeNull();
  await act(async () =>
    [...node.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click(),
  );
  expect(retry).toHaveBeenCalledOnce();
});
it("blocks same-tick duplicate checkout and retains the page on failure", async () => {
  const pending = deferred<never>();
  api.checkout.mockReturnValue(pending.promise);
  const node = await render();
  await act(async () => {
    const form = node.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(api.checkout).toHaveBeenCalledOnce();
  await act(async () => pending.reject(new Error("offline")));
  expect(node.textContent).toContain("Could not open billing");
  expect(node.querySelector("form")).not.toBeNull();
});
it("does not open a delayed external URL after the owning account or Space changes", async () => {
  const pending = deferred<{ url: string }>();
  api.checkout.mockReturnValue(pending.promise);
  const node = await render();
  await act(async () =>
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  current = false;
  const href = window.location.href;
  await act(async () => pending.resolve({ url: "https://billing.example.test/checkout" }));
  expect(window.location.href).toBe(href);
});
it("makes logout and checkout mutually exclusive before React rerenders", async () => {
  const pending = deferred<void>();
  api.logout.mockReturnValue(pending.promise);
  const node = await render();
  await act(async () => {
    [...node.querySelectorAll("button")].find((b) => b.textContent === "Log out")!.click();
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(api.logout).toHaveBeenCalledOnce();
  expect(api.checkout).not.toHaveBeenCalled();
  await act(async () => pending.resolve());
});

it("renders an unavailable lookup without fabricating owner, price or subscription fields", async () => {
  const node = document.createElement("div");
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <BillingUnavailablePage
        isCurrent={() => current}
        onRetry={retry}
        onDismiss={vi.fn()}
        recovery="billing_unavailable"
      />,
    ),
  );
  expect(node.textContent).toContain("Could not refresh billing");
  expect([...node.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "Retry",
    "Back to chats",
  ]);
  expect(node.textContent).not.toContain("$12");
  expect(api.checkout).not.toHaveBeenCalled();
  await act(async () =>
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(retry).toHaveBeenCalledOnce();
});

it("does not navigate after the paywall unmounts while the same scope remains current", async () => {
  const pending = deferred<{ url: string }>();
  api.checkout.mockReturnValue(pending.promise);
  const node = await render();
  await act(async () =>
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
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
  await act(async () => pending.resolve({ url: "https://billing.example.test/checkout" }));
  expect(assign).not.toHaveBeenCalled();
});
