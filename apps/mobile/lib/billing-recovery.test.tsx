// @vitest-environment jsdom

import type { BillingStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingRecovery } from "../components/billing-recovery";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  token: vi.fn(),
  capabilities: vi.fn(),
  openURL: vi.fn(),
  signOut: vi.fn(),
  signIn: vi.fn(),
  selectSpace: vi.fn(),
  pathname: "/",
  scope: {
    apiBase: "https://api.example.test",
    apiGeneration: 0,
    sessionGeneration: 0,
    spaceId: "space-a" as string | null,
    spaceGeneration: 0,
    selectionSeq: 0,
  },
  scopeListeners: new Set<() => void>(),
  deniedListeners: new Set<() => void>(),
  activeListeners: new Set<(value: string) => void>(),
}));
vi.mock("expo-router", () => ({ usePathname: () => state.pathname }));
vi.mock("./api", () => ({
  rpc: state.rpc,
  loadSessionToken: state.token,
  passwordResetCapabilities: state.capabilities,
  captureApiRequestContext: async (spaceId: string | null) => ({
    apiBase: state.scope.apiBase,
    headers: {
      authorization: "Bearer synthetic-billing-session",
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
    },
  }),
  selectSpace: state.selectSpace,
  signOut: state.signOut,
  subscribeSubscriptionRequired: (listener: () => void) => {
    state.deniedListeners.add(listener);
    return () => state.deniedListeners.delete(listener);
  },
}));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({ ...state.scope }),
  isMobileScopeCurrent: (owner: typeof state.scope) =>
    JSON.stringify(owner) === JSON.stringify(state.scope),
  isMobileSessionCurrent: (owner: typeof state.scope) =>
    owner.apiBase === state.scope.apiBase &&
    owner.apiGeneration === state.scope.apiGeneration &&
    owner.sessionGeneration === state.scope.sessionGeneration,
  mobileScopeKey: () => JSON.stringify(state.scope),
  subscribeMobileScope: (listener: () => void) => {
    state.scopeListeners.add(listener);
    return () => state.scopeListeners.delete(listener);
  },
}));
vi.mock("./auth-routing", () => ({ replaceWithSignIn: state.signIn }));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string | number>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? `{${key}}`));
  return { t, useI18n: () => ({ t, locale: "en" }) };
});
vi.mock("./native", () => ({
  useMobileTokens: () => ({
    background: "white",
    foreground: "black",
    mutedForeground: "gray",
    destructive: "red",
  }),
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (value: string) => void) => {
      state.activeListeners.add(listener);
      return { remove: () => state.activeListeners.delete(listener) };
    },
  },
  Linking: { openURL: state.openURL },
  Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? <div role="dialog">{children}</div> : null,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({
    children,
    accessibilityLabel,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
  }) => <fieldset aria-label={accessibilityLabel}>{children}</fieldset>,
  Text: ({ children, accessibilityRole }: { children: ReactNode; accessibilityRole?: string }) => (
    <span role={accessibilityRole === "alert" ? "alert" : undefined}>{children}</span>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/menu-picker", () => ({
  MenuPickerMenu: ({
    label,
    choices,
    onChange,
  }: {
    label: string;
    choices: { key: string; label: string }[];
    onChange: (value: string) => void;
  }) => (
    <select aria-label={label} onChange={(event) => onChange(event.target.value)}>
      <option value="" />
      {choices.map((choice) => (
        <option key={choice.key} value={choice.key}>
          {choice.label}
        </option>
      ))}
    </select>
  ),
}));

const unpaid = (overrides: Partial<BillingStatus> = {}): BillingStatus => ({
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
  ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let root: Root;
let container: HTMLDivElement;
let status: BillingStatus;
let me: { billingEnabled: boolean; isDeploymentOwner: boolean };
function button(label: string) {
  const node = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!node) throw new Error(`Missing button ${label}`);
  return node;
}
async function render() {
  await act(async () => root.render(<BillingRecovery />));
}
async function changeScope(patch: Partial<typeof state.scope>) {
  await act(async () => {
    Object.assign(state.scope, patch);
    for (const listener of state.scopeListeners) listener();
  });
}
async function foreground() {
  await act(async () => {
    for (const listener of state.activeListeners) listener("active");
  });
}
function statusCalls() {
  return state.rpc.mock.calls.filter(([procedure]) => procedure === "billing/status");
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.pathname = "/";
  Object.assign(state.scope, {
    apiBase: "https://api.example.test",
    apiGeneration: 0,
    sessionGeneration: 0,
    spaceId: "space-a",
    spaceGeneration: 0,
    selectionSeq: 0,
  });
  state.scopeListeners.clear();
  state.deniedListeners.clear();
  state.activeListeners.clear();
  state.token.mockReset().mockResolvedValue("synthetic-session");
  state.capabilities.mockReset().mockResolvedValue({ billing: true });
  state.openURL.mockReset().mockResolvedValue(undefined);
  state.signOut.mockReset().mockResolvedValue(true);
  state.signIn.mockReset();
  state.selectSpace.mockReset().mockResolvedValue(true);
  status = unpaid();
  me = { billingEnabled: true, isDeploymentOwner: false };
  state.rpc.mockReset().mockImplementation(async (procedure: string) => {
    if (procedure === "me") return me;
    if (procedure === "billing/status") return status;
    if (procedure === "spaces/list")
      return {
        spaces: [
          { id: "space-a", name: "Alpha" },
          { id: "space-b", name: "Beta" },
        ],
      };
    if (procedure === "billing/checkout" || procedure === "billing/portal")
      return { url: "https://billing.example.test/session" };
    throw new Error(`Unexpected ${procedure}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("native access recovery", () => {
  it.each(["capability", "user", "deployment-owner", "signed-out"])(
    "bypasses billing for %s",
    async (kind) => {
      if (kind === "capability") state.capabilities.mockResolvedValue({ billing: false });
      if (kind === "user") me.billingEnabled = false;
      if (kind === "deployment-owner") me.isDeploymentOwner = true;
      if (kind === "signed-out") state.token.mockResolvedValue("");
      await render();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(statusCalls()).toHaveLength(0);
    },
  );
  it("does not label a first lookup failure as unpaid and reopens on a server denial", async () => {
    state.capabilities.mockRejectedValueOnce(new Error("offline"));
    await render();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      for (const listener of state.deniedListeners) listener();
    });
    expect(container.textContent).toContain("Subscription required");
    expect(statusCalls()[0]?.[1]).toEqual({ refresh: true });
  });
  it("gives members Space recovery without checkout or portal", async () => {
    status = unpaid({ canManage: false, hasCustomer: true, state: "past_due" });
    await render();
    expect(container.textContent).toContain("Contact your organization owner");
    expect(container.querySelector('[aria-label="Switch Space"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Subscribe");
    expect(container.textContent).not.toContain("Manage billing");
  });
  it("offers retry without inventing a price or enabling checkout", async () => {
    status = unpaid({ price: null });
    await render();
    expect(container.textContent).not.toContain("Start 7-day");
    expect(container.textContent).not.toContain("Subscribe");
    expect(button("Retry")).not.toBeNull();
    expect(container.textContent).not.toContain("$12");
    await act(async () => button("Retry").click());
    expect(state.rpc.mock.calls.some(([procedure]) => procedure === "billing/checkout")).toBe(
      false,
    );
  });
  it.each([false, true])(
    "keeps configured checkout available when interval formatting is unsupported (trial: %s)",
    async (trialAvailable) => {
      status = unpaid({ trialAvailable });
      const NumberFormat = Intl.NumberFormat;
      const unsupportedUnit = vi.fn();
      const formatter = vi.spyOn(Intl, "NumberFormat").mockImplementation(function (
        this: Intl.NumberFormat,
        locales,
        options,
      ) {
        if (options?.style === "unit") {
          unsupportedUnit();
          throw new RangeError("Unsupported unit formatter");
        }
        return new NumberFormat(locales, options);
      });
      try {
        await render();
        expect(unsupportedUnit).toHaveBeenCalled();
        expect(container.textContent).not.toContain("$12");
        expect(container.textContent).not.toContain("month");
        const label = trialAvailable ? "Start 7-day free trial" : "Subscribe";
        expect(button(label).disabled).toBe(false);
        await act(async () => button(label).click());
        expect(
          state.rpc.mock.calls.filter(([procedure]) => procedure === "billing/checkout"),
        ).toHaveLength(1);
        expect(state.openURL).toHaveBeenCalledExactlyOnceWith(
          "https://billing.example.test/session",
        );
      } finally {
        formatter.mockRestore();
      }
    },
  );
  it("coalesces foreground events and retries once per pending request", async () => {
    await render();
    const response = deferred<BillingStatus>();
    state.rpc.mockImplementation(async (procedure: string) =>
      procedure === "me" ? me : procedure === "billing/status" ? response.promise : { spaces: [] },
    );
    await act(async () => {
      for (const listener of state.activeListeners) {
        listener("active");
        listener("active");
      }
      button("Retry").click();
    });
    expect(statusCalls()).toHaveLength(2);
    expect(statusCalls()[1]?.[1]).toEqual({ refresh: true });
    await act(async () => response.resolve(unpaid({ access: true, state: "active" })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
  it("retains a denial and error when provider refresh fails", async () => {
    await render();
    state.rpc.mockImplementation(async (procedure: string) => {
      if (procedure === "me") return me;
      if (procedure === "billing/status")
        throw { status: 503, data: { reason: "billing_unavailable" } };
      return { spaces: [] };
    });
    await foreground();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(button("Retry").disabled).toBe(false);
  });
  it.each(["endpoint", "session", "space", "space-aba"])(
    "ignores stale status after %s changes",
    async (boundary) => {
      const old = deferred<BillingStatus>();
      state.rpc.mockImplementation(async (procedure: string) =>
        procedure === "me" ? me : procedure === "billing/status" ? old.promise : { spaces: [] },
      );
      await render();
      state.rpc.mockImplementation(async (procedure: string) =>
        procedure === "me"
          ? me
          : procedure === "billing/status"
            ? unpaid({ access: true })
            : { spaces: [] },
      );
      if (boundary === "endpoint")
        await changeScope({ apiBase: "https://other.example.test", apiGeneration: 1 });
      else if (boundary === "session") await changeScope({ sessionGeneration: 1 });
      else if (boundary === "space")
        await changeScope({ spaceId: "space-b", spaceGeneration: 1, selectionSeq: 1 });
      else {
        await changeScope({ spaceId: "space-b", spaceGeneration: 1, selectionSeq: 1 });
        await changeScope({ spaceId: "space-a", spaceGeneration: 2, selectionSeq: 2 });
      }
      state.rpc.mockImplementation(async (procedure: string) =>
        procedure === "me"
          ? me
          : procedure === "billing/status"
            ? unpaid({ access: true })
            : { spaces: [] },
      );
      await act(async () => old.resolve(unpaid()));
      // Every prior scoped instance stays dead, even if its Space id is selected again.

      expect(container.querySelector('[role="dialog"]')).toBeNull();
    },
  );
  it("submits only once for same-tick taps and opens a current provider URL", async () => {
    await render();
    const checkout = deferred<{ url: string }>();
    state.rpc.mockImplementation(async (procedure: string) =>
      procedure === "billing/checkout" ? checkout.promise : me,
    );
    await act(async () => {
      button("Start 7-day free trial").click();
      button("Start 7-day free trial").click();
    });
    expect(
      state.rpc.mock.calls.filter(([procedure]) => procedure === "billing/checkout"),
    ).toHaveLength(1);
    await act(async () => checkout.resolve({ url: "https://billing.example.test/checkout" }));
    expect(state.openURL).toHaveBeenCalledExactlyOnceWith("https://billing.example.test/checkout");
    expect(
      state.rpc.mock.calls.find(([procedure]) => procedure === "billing/checkout")?.[2],
    ).toMatchObject({ requestContext: { headers: { "x-rakazo-space-id": "space-a" } } });
  });
  it("never opens an old checkout URL after an account change", async () => {
    await render();
    const checkout = deferred<{ url: string }>();
    state.rpc.mockImplementation(async (procedure: string) =>
      procedure === "billing/checkout"
        ? checkout.promise
        : procedure === "me"
          ? me
          : unpaid({ access: true }),
    );
    await act(async () => button("Start 7-day free trial").click());
    await changeScope({ sessionGeneration: 1 });
    await act(async () => checkout.resolve({ url: "https://billing.example.test/old" }));
    expect(state.openURL).not.toHaveBeenCalled();
  });
  it.each(["javascript:alert(1)", "https://user:secret@billing.example.test/"])(
    "rejects unsafe external URL %s",
    async (url) => {
      await render();
      state.rpc.mockResolvedValueOnce({ url });
      await act(async () => button("Start 7-day free trial").click());
      expect(state.openURL).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Could not open billing");
    },
  );
  it("keeps the page after external opening fails", async () => {
    await render();
    state.openURL.mockRejectedValueOnce(new Error("native open failed"));
    await act(async () => button("Start 7-day free trial").click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(button("Retry").disabled).toBe(false);
  });
  it("does not navigate after a superseded logout", async () => {
    await render();
    state.signOut.mockResolvedValueOnce(false);
    await act(async () => button("Sign out").click());
    expect(state.signIn).not.toHaveBeenCalled();
  });
  it("leaves read-only chats and Stop reachable without changing access, and reopens on402", async () => {
    await render();
    const calls = statusCalls().length;
    await act(async () => button("Back to chats").click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(status.access).toBe(false);
    expect(statusCalls()).toHaveLength(calls);
    await act(async () => {
      for (const listener of state.deniedListeners) listener();
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(status.access).toBe(false);
  });
  it("lets existing no-Space recovery handle an initial403 without declaring unpaid", async () => {
    state.rpc.mockRejectedValueOnce({ status: 403, code: "FORBIDDEN" });
    await render();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(statusCalls()).toHaveLength(0);
  });
  it("keeps invitations and Space recovery reachable after membership is revoked", async () => {
    await render();
    state.rpc.mockRejectedValueOnce({ status: 403, code: "FORBIDDEN" });
    await foreground();
    expect(container.textContent).toContain("This Space is unavailable");
    expect(container.textContent).toContain("Contact your organization owner for an invitation");
    expect(container.textContent).not.toContain("Start 7-day");
  });
  it("opens the current owner's portal outside the app", async () => {
    status = unpaid({ state: "canceled", hasCustomer: true });
    await render();
    await act(async () => button("Manage billing").click());
    expect(
      state.rpc.mock.calls.find(([procedure]) => procedure === "billing/portal")?.[2],
    ).toMatchObject({ requestContext: { headers: { "x-rakazo-space-id": "space-a" } } });
    expect(state.openURL).toHaveBeenCalledWith("https://billing.example.test/session");
  });
  it("navigates only after its own successful logout receipt", async () => {
    await render();
    state.signOut.mockImplementationOnce(async () => {
      state.scope.sessionGeneration += 1;
      return true;
    });
    await act(async () => button("Sign out").click());
    expect(state.signIn).toHaveBeenCalledOnce();
  });
  it("keeps a native Space selection failure on the recovery page", async () => {
    await render();
    state.selectSpace.mockRejectedValueOnce(new Error("storage failed"));
    const chooser = container.querySelector(
      'select[aria-label="Switch Space"]',
    ) as HTMLSelectElement;
    await act(async () => {
      chooser.value = "space-b";
      chooser.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(state.selectSpace).toHaveBeenCalledExactlyOnceWith("space-b");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(button("Retry").disabled).toBe(false);
  });
  it("does not open a billing URL after returning to chats while checkout waits", async () => {
    await render();
    const checkout = deferred<{ url: string }>();
    state.rpc.mockImplementation(async (procedure: string) =>
      procedure === "billing/checkout" ? checkout.promise : me,
    );
    await act(async () => button("Start 7-day free trial").click());
    await act(async () => button("Back to chats").click());
    await act(async () => checkout.resolve({ url: "https://billing.example.test/old" }));
    expect(state.openURL).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
  it.each([
    ["previously-active", "server"],
    ["previously-active", "network"],
    ["no-snapshot", "server"],
    ["no-snapshot", "network"],
  ])(
    "shows independent recovery after402 plus unavailable status for %s with %s failure",
    async (initial, failure) => {
      if (initial === "previously-active")
        status = unpaid({
          access: true,
          state: "active",
          hasCustomer: true,
          trialAvailable: false,
        });
      else state.capabilities.mockRejectedValueOnce(new Error("offline"));
      await render();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      state.rpc.mockImplementation(async (procedure: string) => {
        if (procedure === "me") return me;
        if (procedure === "billing/status") {
          if (failure === "network") throw new Error("offline");
          throw { status: 503, data: { reason: "billing_unavailable" } };
        }
        return { spaces: [] };
      });
      await act(async () => {
        for (const listener of state.deniedListeners) listener();
      });
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(button("Retry").disabled).toBe(false);
      expect(button("Back to chats")).not.toBeNull();
      expect(container.textContent).not.toContain("Subscribe");
      expect(container.textContent).not.toContain("Start 7-day");
      expect(container.textContent).not.toContain("Manage billing");
      expect(container.textContent).not.toContain("$12");
      expect(
        state.rpc.mock.calls.some(
          ([procedure]) => procedure === "billing/checkout" || procedure === "billing/portal",
        ),
      ).toBe(false);
      state.rpc.mockImplementation(async (procedure: string) =>
        procedure === "me"
          ? me
          : procedure === "billing/status"
            ? unpaid({ access: true, state: "active" })
            : { spaces: [] },
      );
      await foreground();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  it("does not open a checkout URL after the recovery component unmounts in the same scope", async () => {
    await render();
    const checkout = deferred<{ url: string }>();
    state.rpc.mockImplementation(async (procedure: string) =>
      procedure === "billing/checkout" ? checkout.promise : me,
    );
    await act(async () => button("Start 7-day free trial").click());
    await act(async () => root.render(<span>Unrelated screen</span>));
    await act(async () => checkout.resolve({ url: "https://billing.example.test/old" }));
    expect(state.openURL).not.toHaveBeenCalled();
  });

  it("does not resurrect checkout ownership after a recovery-route A to B to A", async () => {
    await render();
    const checkout = deferred<{ url: string }>();
    state.rpc.mockImplementation(async (procedure: string) =>
      procedure === "billing/checkout"
        ? checkout.promise
        : procedure === "me"
          ? me
          : procedure === "billing/status"
            ? unpaid()
            : { spaces: [] },
    );
    await act(async () => button("Start 7-day free trial").click());
    state.pathname = "/server";
    await render();
    state.pathname = "/";
    await render();
    await act(async () => checkout.resolve({ url: "https://billing.example.test/old" }));
    expect(state.openURL).not.toHaveBeenCalled();
  });

  it("discards a pending checkout URL when foreground refresh confirms access", async () => {
    await render();
    const checkout = deferred<{ url: string }>();
    state.rpc.mockImplementation(async (procedure: string) =>
      procedure === "billing/checkout"
        ? checkout.promise
        : procedure === "me"
          ? me
          : unpaid({ access: true, state: "active" }),
    );
    await act(async () => button("Start 7-day free trial").click());
    await foreground();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => checkout.resolve({ url: "https://billing.example.test/old" }));
    expect(state.openURL).not.toHaveBeenCalled();
  });
});
