// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, Suspense, startTransition } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptDeviceTimezone } from "./account-timezone";
import { AccountTimezone } from "./account-timezone-settings";
import type { MobileMe } from "./api";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  capture: vi.fn(),
  owner: 1,
  change: vi.fn(),
}));
vi.mock("./api", () => ({ rpc: mocks.rpc, captureApiRequestContext: mocks.capture }));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({
    apiBase: "https://api.example.test",
    apiGeneration: mocks.owner,
    sessionGeneration: mocks.owner,
    spaceId: "space-a",
  }),
  isMobileScopeCurrent: (owner: { apiGeneration: number }) => owner.apiGeneration === mocks.owner,
}));
vi.mock("react-native", () => ({
  View: ({
    children,
    pointerEvents,
    accessibilityState,
  }: {
    children?: ReactNode;
    pointerEvents?: string;
    accessibilityState?: { busy?: boolean };
  }) =>
    createElement(
      "div",
      { "data-pointer-events": pointerEvents, "aria-busy": accessibilityState?.busy },
      children,
    ),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) =>
    createElement("section", null, children),
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({
    label,
    value,
    choices,
    onChange,
  }: {
    label: string;
    value: string;
    choices: { key: string; label: string }[];
    onChange: (value: string) => void;
  }) =>
    createElement(
      "select",
      {
        "aria-label": label,
        value,
        onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      },
      ...choices.map((choice) =>
        createElement("option", { key: choice.key, value: choice.key }, choice.label),
      ),
    ),
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({ destructive: "error" }) }));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { t, useI18n: () => ({ t }) };
});

const me = {
  userId: "user-a",
  spaceId: "space-a",
  timezone: null,
  defaultModel: "keep-model",
} as MobileMe;
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("native account timezone", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.owner = 1;
    mocks.capture.mockResolvedValue({
      apiBase: "https://api.example.test",
      headers: { authorization: "Bearer fake", "x-rakazo-space-id": "space-a" },
      sessionGeneration: 1,
    });
    mocks.rpc.mockResolvedValue({ ...me, timezone: "Asia/Taipei" });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("adopts the actual valid device zone only for an unset authenticated account", async () => {
    const spy = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ timeZone: "Asia/Taipei" } as Intl.ResolvedDateTimeFormatOptions);
    await expect(adoptDeviceTimezone(me, () => true)).resolves.toBe("Asia/Taipei");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "preferences/adoptTimezone",
      { timezone: "Asia/Taipei" },
      expect.objectContaining({
        requestContext: expect.objectContaining({ sessionGeneration: 1 }),
      }),
    );
    expect(spy).toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledWith(null);
  });
  it.each(["UTC", "America/New_York", undefined])(
    "never adopts over a saved choice or a legacy response: %s",
    async (timezone) => {
      await expect(adoptDeviceTimezone({ ...me, timezone }, () => true)).resolves.toBeUndefined();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it.each(["", "not/a-zone", "+05:30"])(
    "does not turn an invalid device zone into a persisted UTC choice: %s",
    async (timeZone) => {
      vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
        timeZone,
      } as Intl.ResolvedDateTimeFormatOptions);
      await expect(adoptDeviceTimezone(me, () => true)).resolves.toBeUndefined();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it("does not persist after the API or session changed while capturing the request", async () => {
    const context = pending<unknown>();
    mocks.capture.mockReturnValue(context.promise);
    const adoption = adoptDeviceTimezone(me, () => true);
    mocks.owner += 2;
    context.resolve({ apiBase: "https://api.example.test", headers: {}, sessionGeneration: 1 });
    await expect(adoption).resolves.toBeUndefined();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(["different user", "session ABA", "superseded read"])(
    "ignores an adoption response from a %s",
    async (kind) => {
      const request = pending<MobileMe>();
      mocks.rpc.mockReturnValue(request.promise);
      let active = true;
      const adoption = adoptDeviceTimezone(me, () => active);
      await Promise.resolve();
      if (kind === "session ABA") mocks.owner += 2;
      if (kind === "superseded read") active = false;
      request.resolve({
        ...me,
        userId: kind === "different user" ? "user-b" : "user-a",
        timezone: "UTC",
      });
      await expect(adoption).resolves.toBeUndefined();
    },
  );

  it("shows explicit UTC and merges only the edited timezone", async () => {
    mocks.rpc.mockResolvedValue({
      ...me,
      spaceId: "space-b",
      defaultModel: "foreign-model",
      timezone: "America/New_York",
    });
    await act(async () =>
      root.render(<AccountTimezone me={{ ...me, timezone: "UTC" }} onChange={mocks.change} />),
    );
    const select = container.querySelector("select")!;
    expect(select.value).toBe("UTC");
    await act(async () => {
      select.value = "America/New_York";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "preferences/update",
      { timezone: "America/New_York" },
      expect.objectContaining({ requestContext: expect.any(Object) }),
    );
    expect(mocks.change.mock.calls).toEqual([["America/New_York"]]);
    expect(mocks.capture).toHaveBeenCalledWith(null);
  });

  it.each(["unmount", "session ABA", "different user"])(
    "ignores a timezone save after %s",
    async (kind) => {
      const request = pending<MobileMe>();
      mocks.rpc.mockReturnValue(request.promise);
      await act(async () =>
        root.render(<AccountTimezone me={{ ...me, timezone: "UTC" }} onChange={mocks.change} />),
      );
      await act(async () => {
        const select = container.querySelector("select")!;
        select.value = "America/New_York";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      if (kind === "unmount") await act(async () => root.render(null));
      if (kind === "session ABA") mocks.owner += 2;
      if (kind === "different user")
        await act(async () =>
          root.render(
            <AccountTimezone
              me={{ ...me, userId: "user-b", timezone: "UTC" }}
              onChange={mocks.change}
            />,
          ),
        );
      await act(async () => request.resolve({ ...me, timezone: "America/New_York" }));
      expect(mocks.change).not.toHaveBeenCalled();
    },
  );

  it("keeps the last choice when saving fails, then allows retry", async () => {
    mocks.rpc.mockRejectedValueOnce(new Error("Could not save timezone"));
    await act(async () =>
      root.render(<AccountTimezone me={{ ...me, timezone: "UTC" }} onChange={mocks.change} />),
    );
    const choose = () => {
      const select = container.querySelector("select")!;
      select.value = "America/New_York";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    await act(async () => choose());
    expect(container.textContent).toContain("Could not save timezone");
    expect(mocks.change).not.toHaveBeenCalled();
    await act(async () => choose());
    expect(mocks.change).toHaveBeenCalledWith("Asia/Taipei");
  });

  it("keeps the committed picker usable after a different user's suspended render is discarded", async () => {
    const request = pending<MobileMe>();
    const never = pending<void>();
    const suspended = vi.fn();
    mocks.rpc.mockReturnValueOnce(request.promise);
    function SuspendAfter({ suspend }: { suspend: boolean }) {
      if (suspend) {
        suspended();
        throw never.promise;
      }
      return null;
    }
    const screen = (userId: string, suspend = false) => (
      <Suspense fallback={<span>Loading</span>}>
        <AccountTimezone me={{ ...me, userId, timezone: "UTC" }} onChange={mocks.change} />
        <SuspendAfter suspend={suspend} />
      </Suspense>
    );
    await act(async () => root.render(screen("user-a")));
    await act(async () => {
      const select = container.querySelector("select")!;
      select.value = "America/New_York";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector('[data-pointer-events="none"]')).not.toBeNull();
    await act(async () => startTransition(() => root.render(screen("user-b", true))));
    expect(suspended).toHaveBeenCalled();
    expect(container.textContent).not.toContain("Loading");
    expect(container.querySelector("select")).not.toBeNull();
    await act(async () => request.resolve({ ...me, timezone: "America/New_York" }));
    expect(mocks.change).toHaveBeenCalledExactlyOnceWith("America/New_York");
    expect(container.querySelector('[data-pointer-events="auto"]')).not.toBeNull();
    // Discard that uncommitted transition, then use the still-committed account again.
    await act(async () => root.render(screen("user-a")));
    await act(async () => {
      const select = container.querySelector("select")!;
      select.value = "Asia/Taipei";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("hides editing when an older server omits the preference", async () => {
    await act(async () =>
      root.render(<AccountTimezone me={{ ...me, timezone: undefined }} onChange={mocks.change} />),
    );
    expect(container.querySelector("select")).toBeNull();
  });
});
