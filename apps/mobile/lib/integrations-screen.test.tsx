// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Integrations from "../app/(settings)/integrations";
import McpSettings from "../app/(settings)/mcp";
import { ConnectorIcon } from "../components/connector-icon";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  current: true,
  scope: vi.fn(),
  persisted: vi.fn(),
  focused: true,
  alert: vi.fn(),
  params: {} as { app?: string | string[]; botId?: string | string[]; accountOnly?: string },
  lastBot: "",
  importEpoch: 0,
  scopeChanged: undefined as (() => void) | undefined,
}));
vi.mock("expo-router", () => ({
  router: { push: vi.fn() },
  useLocalSearchParams: () => state.params,
  Stack: { Screen: () => null },
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    useEffect(() => {
      if (state.focused) return callback();
    }, [callback, state.focused]);
  },
}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: async () => ({
    apiBase: "https://example.test",
    headers: {},
    sessionGeneration: 1,
  }),
}));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({ epoch: state.importEpoch, spaceId: "space-a" }),
  isMobileScopeCurrent: (scope: { epoch: number }) => scope.epoch === state.importEpoch,
  subscribeMobileScope: (changed: () => void) => {
    state.scopeChanged = changed;
    return () => {
      state.scopeChanged = undefined;
    };
  },
}));
vi.mock("./integrations-cache", () => ({
  integrationsCacheScope: state.scope,
  persistedIntegrationsCacheScope: state.persisted,
  isIntegrationsScopeCurrent: () => state.current,
  readIntegrationsCache: state.read,
  writeIntegrationsCache: state.write,
}));
vi.mock("./last-bot", () => ({ loadLastBotId: async () => state.lastBot }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
}));
vi.mock("../components/row-accessories", () => ({ Chevron: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    value,
    onValueChange,
  }: {
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={value}
      onChange={(event) => onValueChange(event.target.checked)}
    />
  ),
}));
vi.mock("../components/native-segmented-control", () => ({
  NativeSegmentedControl: ({
    options,
    onChange,
  }: {
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
  }) => (
    <div>
      {options.map((option) => (
        <button type="button" key={option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  ),
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
    onChange: (key: string) => void;
  }) => (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {choices.map((choice) => (
        <option key={choice.key} value={choice.key}>
          {choice.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("react-native-svg", () => ({
  SvgUri: ({ uri, onError }: { uri: string; onError: () => void }) =>
    createElement("svg", { "data-uri": uri, onClick: onError }),
}));
vi.mock("react-native", () => {
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  );
  return {
    View,
    ScrollView: View,
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
      <button type="button" onClick={onPress}>
        {children}
      </button>
    ),
    TextInput: ({
      placeholder,
      value,
      onChangeText,
      onEndEditing,
      editable,
    }: {
      placeholder?: string;
      value?: string;
      onChangeText?: (value: string) => void;
      onEndEditing?: () => void;
      editable?: boolean;
    }) => (
      <input
        disabled={editable === false}
        onBlur={onEndEditing}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChangeText?.(event.target.value)}
      />
    ),
    Image: ({ source, onError }: { source: { uri: string }; onError: () => void }) =>
      createElement("img", { src: source.uri, onError }),
    StyleSheet: { create: (styles: unknown) => styles },
    useWindowDimensions: () => ({ width: 390 }),
    Alert: { alert: state.alert },
    Linking: { openURL: vi.fn() },
  };
});

const item = {
  connectorId: "test",
  slug: "example",
  name: "Example app",
  logo: "https://example.test/logo.svg",
  connected: true,
  noAuth: false,
};
const account = {
  id: "account-a",
  connectorId: "test",
  provider: "example",
  displayName: "Example",
  status: "connected",
  capabilities: [],
  createdAt: "2026-01-01",
};
let root: Root;
let container: HTMLDivElement;
let resolveCatalog: (items: (typeof item)[]) => void;
let rejectCatalog: (error: Error) => void;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.current = true;
  state.params = {};
  state.lastBot = "";
  state.focused = true;
  state.importEpoch = 0;
  state.scopeChanged = undefined;
  state.scope.mockReset().mockResolvedValue({ userId: "user-a", spaceId: "space-a" });
  state.persisted.mockReset().mockResolvedValue(null);
  state.read.mockReset().mockReturnValue(null);
  state.write.mockReset();
  state.alert.mockReset();
  const pending = new Promise<(typeof item)[]>((resolve, reject) => {
    resolveCatalog = resolve;
    rejectCatalog = reject;
  });
  state.rpc
    .mockReset()
    .mockImplementation((proc: string) =>
      proc === "connections/catalog"
        ? pending
        : Promise.resolve(proc === "connections/list" ? [account] : []),
    );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
async function render(node: ReactNode = <Integrations />) {
  await act(async () => root.render(node));
}

async function press(label: string) {
  const button = [...container.querySelectorAll("button")].find((row) => row.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

async function fillSource(placeholder: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
  expect(input, placeholder).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("reviews accepted and rejected OpenAPI operations before explicit installation", async () => {
  const original = state.rpc.getMockImplementation()!;
  const install = {
    id: "install-one",
    name: "Example API",
    kind: "api",
    source: "https://example.test/spec.yaml",
    secretConfigured: false,
    config: {},
    version: "1.0.0",
    digest: "digest",
    createdAt: "2026-01-01",
  };
  let installed = false;
  const preview = {
    status: "ready",
    target: "https://service.example.test",
    operations: [{ id: "listItems", method: "GET", path: "/items", readOnly: true }],
    diagnostics: [{ scope: "operation", code: "external_reference", operationId: "unsafeInput" }],
    counts: { discovered: 2, accepted: 1, rejected: 1, omittedDiagnostics: 0 },
    reviewToken: "review-one",
    expiresAt: "2027-01-01T00:00:00.000Z",
  };
  state.rpc.mockImplementation((proc: string) => {
    if (proc === "capabilities/list") return Promise.resolve(installed ? [install] : []);
    if (proc === "capabilities/confirmOpenApi") {
      installed = true;
      return Promise.resolve({ status: "installed", replayed: false, install });
    }
    return proc === "capabilities/previewOpenApi" ? Promise.resolve(preview) : original(proc);
  });
  await render();
  await act(async () => resolveCatalog([]));
  await press("Advanced");
  await press("Add OpenAPI");
  await fillSource("Display name", "Example API");
  await fillSource("https://example.com/openapi.json", "https://example.test/spec.yaml");
  await press("Preview");
  expect(container.textContent).toContain("listItems");
  expect(container.textContent).toContain("unsafeInput");
  expect(container.textContent).toContain("External references are not supported.");
  expect(state.rpc.mock.calls.some(([proc]) => proc === "capabilities/install")).toBe(false);
  expect(state.rpc.mock.calls.some(([proc]) => proc === "capabilities/confirmOpenApi")).toBe(false);
  await press("Add");
  expect(state.rpc).toHaveBeenCalledWith(
    "capabilities/confirmOpenApi",
    expect.objectContaining({
      name: "Example API",
      source: "https://example.test/spec.yaml",
      reviewToken: "review-one",
    }),
    expect.anything(),
  );
  expect(container.textContent).toContain("Example API");
});

it.each(["composio", "pipedream"])(
  "native-first unconfigured source defaults to available %s in the rendered chooser",
  async (broker) => {
    const original = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((proc: string) =>
      proc === "connections/list" ? Promise.resolve([]) : original(proc),
    );
    await render();
    const native = {
      ...item,
      connectorId: "native",
      slug: "gmail",
      name: "Gmail",
      connected: false,
      connectable: false,
    };
    const available = {
      ...item,
      connectorId: broker,
      slug: "gmail",
      name: "Gmail",
      connected: false,
    };
    await act(async () => resolveCatalog([native, available]));
    const add = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Add",
    );
    expect(add).toBeDefined();
    await act(async () => add!.click());
    const choice = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Connection source"]',
    )!;
    expect(choice.value).toBe(JSON.stringify([broker, "gmail"]));
    expect([...choice.options].map((option) => option.value)).toContain(
      JSON.stringify(["native", "gmail"]),
    );
    await act(async () => {
      choice.value = JSON.stringify(["native", "gmail"]);
      choice.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(choice.value).toBe(JSON.stringify(["native", "gmail"]));
  },
);

it("keeps Search visible and shows rows on a cold load until the first success", async () => {
  await render();
  expect(container.querySelector('input[placeholder="Search apps"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="integrations-loading"]')?.children).toHaveLength(8);
  await act(async () => resolveCatalog([item]));
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
  expect(container.textContent).toContain("Example appConnectedManage");
  expect(state.write).toHaveBeenCalledWith(expect.anything(), {
    catalog: [item],
    connections: [account],
  });
});
it("paints the cached list and Added state before replacing it in the background", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  expect(container.textContent).toContain("Example appConnectedManage");
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
  await act(async () => resolveCatalog([{ ...item, name: "Refreshed app" }]));
  expect(container.textContent).toContain("Refreshed appConnectedManage");
});
it("keeps cached rows after a refresh failure and offers Retry", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  await act(async () => rejectCatalog(new Error("Unavailable")));
  expect(container.textContent).toContain("Example appConnectedManage");
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  );
  expect(retry).toBeDefined();
  state.rpc.mockImplementation((proc: string) =>
    Promise.resolve(
      proc === "connections/catalog" ? [item] : proc === "connections/list" ? [account] : [],
    ),
  );
  await act(async () => retry?.click());
  expect(container.textContent).not.toContain("Retry");
});
it("offers Retry on a cold failure without leaving a loading placeholder", async () => {
  await render();
  await act(async () => rejectCatalog(new Error("Unavailable")));
  expect(container.textContent).toContain("Retry");
  expect(container.querySelector('[data-testid="integrations-loading"]')).toBeNull();
});
it("ignores a refresh after its scope changes", async () => {
  await render();
  state.current = false;
  state.scope.mockRejectedValue(new Error("session changed"));
  await act(async () => resolveCatalog([item]));
  expect(container.textContent).not.toContain("Example app");
  expect(state.write).not.toHaveBeenCalled();
});
it.each(["https://example.test/logo.svg?version=1", "https://example.test/logo.SVG#icon"])(
  "renders SVG catalog artwork with SvgUri: %s",
  async (logo) => {
    await render(<ConnectorIcon name="Example" logo={logo} size={32} />);
    expect(container.querySelector("svg")?.getAttribute("data-uri")).toBe(logo);
    expect(container.querySelector("img")).toBeNull();
    await act(async () =>
      container.querySelector("svg")?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(container.textContent).toBe("E");
    await render(<ConnectorIcon name="Example" logo="https://example.test/new.svg" />);
    expect(container.querySelector("svg")).not.toBeNull();
  },
);
it("renders raster artwork with Image and falls back after failure", async () => {
  await render(<ConnectorIcon name="Example" logo="https://example.test/logo.png" />);
  expect(container.querySelector("img")?.getAttribute("src")).toContain("logo.png");
  await act(async () => container.querySelector("img")?.dispatchEvent(new Event("error")));
  expect(container.textContent).toBe("E");
});
it("falls back for absent logos and empty names", async () => {
  await render(<ConnectorIcon name=" example" logo={null} />);
  expect(container.textContent).toBe("E");
  await render(<ConnectorIcon name=" " />);
  expect(container.textContent).toBe("?");
});

it("persists a rename before a pending stale refresh can overwrite it", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  const added = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Manage",
  );
  await act(async () => added?.click());
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Renamed",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  state.rpc.mockImplementation((proc: string) =>
    proc === "connections/rename"
      ? Promise.resolve({ ...account, displayName: "Renamed" })
      : Promise.resolve([]),
  );
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(state.write).toHaveBeenLastCalledWith(expect.anything(), {
    catalog: [item],
    connections: [{ ...account, displayName: "Renamed" }],
  });
  await act(async () => resolveCatalog([item]));
  expect(container.querySelector("input")?.value).toBe("Renamed");
  expect(state.write).toHaveBeenCalledTimes(1);
});

it.each(["Disconnect", "Uninstall source"])(
  "confirms and persists a local revoke after %s even when its final read fails",
  async (action) => {
    state.read.mockReturnValue({ catalog: [item], connections: [account] });
    await render();
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Manage")
        ?.click(),
    );
    let reads = 0;
    state.rpc.mockImplementation((proc: string) => {
      if (proc === "connections/list")
        return ++reads <= 2 ? Promise.resolve([account]) : Promise.reject(new Error("Unavailable"));
      return Promise.resolve([]);
    });
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === action)
        ?.click(),
    );
    expect(state.rpc.mock.calls.some(([proc]) => proc === "connections/revoke")).toBe(false);
    await act(async () => state.alert.mock.lastCall?.[2]?.at(-1)?.onPress());
    expect(state.write).toHaveBeenLastCalledWith(expect.anything(), {
      catalog: [{ ...item, connected: false }],
      connections: [{ ...account, status: "revoked" }],
    });
  },
);

it("persists a completed connection before refreshing", async () => {
  state.read.mockReturnValue({ catalog: [{ ...item, connected: false }], connections: [] });
  await render();
  state.rpc.mockImplementation((proc: string) => {
    if (proc === "connections/begin")
      return Promise.resolve({ connectionId: account.id, authorizationUrl: null });
    if (proc === "connections/complete") return Promise.resolve(account);
    if (proc === "connections/catalog") return Promise.reject(new Error("Unavailable"));
    return Promise.resolve([]);
  });
  const add = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Add",
  );
  await act(async () => add?.click());
  expect(state.write).toHaveBeenLastCalledWith(expect.anything(), {
    catalog: [item],
    connections: [account],
  });
  expect(container.textContent).toContain("Example appConnectedManage");
});

it.each(["1", undefined])(
  "completes account setup without preview notifications only in accountOnly=%s",
  async (accountOnly) => {
    state.params = { accountOnly };
    state.lastBot = "unrelated-last-bot";
    state.read.mockReturnValue({ catalog: [{ ...item, connected: false }], connections: [] });
    await render();
    state.rpc.mockImplementation((procedure: string) => {
      if (procedure === "connections/begin")
        return Promise.resolve({ connectionId: account.id, authorizationUrl: null });
      if (procedure === "connections/complete") return Promise.resolve(account);
      if (procedure === "connections/catalog") return Promise.reject(new Error("Unavailable"));
      return Promise.resolve([]);
    });
    const add = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Add",
    )!;
    expect(add).not.toBeUndefined();
    await act(async () => add.click());
    expect(state.rpc.mock.calls.some(([procedure]) => procedure === "connections/complete")).toBe(
      true,
    );
    const notifications = state.rpc.mock.calls.filter(
      ([procedure]) => procedure === "onboarding/appConnected",
    );
    expect(notifications).toHaveLength(accountOnly === "1" ? 0 : 1);
    expect(container.textContent).toContain("Example appConnectedManage");
  },
);

it("paints persisted cached rows while identity is pending or offline", async () => {
  state.persisted.mockResolvedValue({ userId: "user-a", spaceId: "space-a" });
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  let rejectIdentity!: (error: Error) => void;
  state.scope.mockReturnValue(
    new Promise((_, reject) => {
      rejectIdentity = reject;
    }),
  );
  await render();
  expect(container.textContent).toContain("Example appConnectedManage");
  expect(state.rpc).not.toHaveBeenCalled();
  await act(async () => rejectIdentity(new Error("offline")));
  expect(container.textContent).toContain("Example appConnectedManage");
  expect(container.textContent).toContain("Retry");
});

it("rebuilds a stale space and continues refreshing while the screen stays open", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  state.current = false;
  state.scope.mockImplementation(async () => {
    state.current = true;
    return { userId: "user-a", spaceId: "space-b" };
  });
  state.read.mockReturnValue(null);
  state.rpc.mockImplementation((proc: string) =>
    Promise.resolve(
      proc === "connections/catalog" ? [{ ...item, name: "Recovered app", connected: false }] : [],
    ),
  );
  await act(async () => resolveCatalog([item]));
  expect(state.scope).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("Example app");
  expect(container.textContent).toContain("Recovered appAdd");
  expect(state.write).toHaveBeenLastCalledWith(
    { userId: "user-a", spaceId: "space-b" },
    {
      catalog: [{ ...item, name: "Recovered app", connected: false }],
      connections: [],
    },
  );
});

it("keeps sources loading when a rename cancels the catalog refresh", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  let resolveSources!: (value: unknown[]) => void;
  const sources = new Promise<unknown[]>((resolve) => {
    resolveSources = resolve;
  });
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc: string) =>
    proc === "capabilities/list" ? sources : original(proc),
  );
  await render();
  await act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Manage")?.click(),
  );
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Renamed",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  state.rpc.mockImplementation((proc: string) =>
    proc === "connections/rename"
      ? Promise.resolve({ ...account, displayName: "Renamed" })
      : original(proc),
  );
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await act(async () => resolveCatalog([item]));
  await act(async () =>
    resolveSources([
      { id: "source-a", name: "Installed source", kind: "mcp", source: "https://example.test/mcp" },
    ]),
  );
  await act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Back")?.click(),
  );
  await act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Advanced")?.click(),
  );
  expect(container.textContent).toContain("Installed source");
  expect(container.textContent).not.toContain("No custom sources installed.");
  expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Remove")).toBe(
    true,
  );
});

it("refreshes a different space on focus return and rejects the blurred refresh", async () => {
  state.read.mockReturnValue({ catalog: [item], connections: [account] });
  await render();
  state.focused = false;
  await render();
  await act(async () => resolveCatalog([{ ...item, name: "Late old app" }]));
  expect(container.textContent).not.toContain("Late old app");
  state.current = false;
  state.scope.mockImplementation(async () => {
    state.current = true;
    return { userId: "user-a", spaceId: "space-b" };
  });
  state.read.mockReturnValue(null);
  let resolveNew!: (items: (typeof item)[]) => void;
  const pending = new Promise<(typeof item)[]>((resolve) => {
    resolveNew = resolve;
  });
  state.rpc.mockImplementation((proc: string) =>
    proc === "connections/catalog" ? pending : Promise.resolve([]),
  );
  state.focused = true;
  await render();
  expect(container.textContent).not.toContain("Example app");
  expect(container.querySelector('[data-testid="integrations-loading"]')).not.toBeNull();
  await act(async () => resolveNew([{ ...item, name: "New space app", connected: false }]));
  expect(container.textContent).toContain("New space appAdd");
  expect(state.scope).toHaveBeenCalledTimes(2);
});

it.each(["rename", "revoke", "uninstall", "connect"])(
  "rejects a late %s result after an in-place space recovery",
  async (action) => {
    state.read.mockReturnValue({ catalog: [item], connections: [account] });
    await render();
    await act(async () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Manage")?.click(),
    );
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const original = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((proc: string) => {
      if (
        proc === "connections/rename" ||
        proc === "connections/revoke" ||
        proc === "connections/complete"
      )
        return pending;
      if (proc === "connections/begin")
        return Promise.resolve({ connectionId: account.id, authorizationUrl: null });
      return original(proc);
    });
    if (action === "rename") {
      const input = container.querySelector("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "Old space rename",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    } else {
      const label =
        action === "revoke"
          ? "Disconnect"
          : action === "uninstall"
            ? "Uninstall source"
            : "Add account";
      await act(async () =>
        [...container.querySelectorAll("button")].find((b) => b.textContent === label)?.click(),
      );
    }
    if (action === "revoke" || action === "uninstall")
      await act(async () => state.alert.mock.lastCall?.[2]?.at(-1)?.onPress());
    expect(state.rpc).toHaveBeenCalledWith(
      action === "rename"
        ? "connections/rename"
        : action === "connect"
          ? "connections/complete"
          : "connections/revoke",
      expect.anything(),
    );
    state.current = false;
    state.scope.mockImplementation(async () => {
      state.current = true;
      return { userId: "user-a", spaceId: "space-b" };
    });
    state.read.mockReturnValue(null);
    state.rpc.mockImplementation((proc: string) =>
      Promise.resolve(
        proc === "connections/catalog"
          ? [{ ...item, name: "New space app", connected: false }]
          : [],
      ),
    );
    await act(async () => resolveCatalog([item]));
    expect(container.textContent).toContain("New space appAdd");
    const writes = state.write.mock.calls.length;
    await act(async () => finish({ ...account, displayName: "Old space rename" }));
    expect(state.write).toHaveBeenCalledTimes(writes);
    expect(state.write).toHaveBeenLastCalledWith(
      { userId: "user-a", spaceId: "space-b" },
      {
        catalog: [{ ...item, name: "New space app", connected: false }],
        connections: [],
      },
    );
    expect(container.textContent).not.toContain("Old space rename");
  },
);

it("ignores an old focus identity error after the new focus succeeds", async () => {
  let failIdentity!: (reason: Error) => void;
  const pending = new Promise((_, reject) => {
    failIdentity = reject;
  });
  state.scope.mockReturnValueOnce(pending);
  await render();
  state.focused = false;
  await render();
  state.scope.mockResolvedValue({ userId: "user-a", spaceId: "space-b" });
  state.rpc.mockImplementation((proc: string) =>
    Promise.resolve(
      proc === "connections/catalog" ? [{ ...item, name: "New space app", connected: false }] : [],
    ),
  );
  state.focused = true;
  await render();
  expect(container.textContent).toContain("New space appAdd");
  await act(async () => failIdentity(new Error("Old focus failed")));
  expect(container.textContent).not.toContain("Old focus failed");
  expect(container.textContent).not.toContain("Retry");
  expect(container.textContent).toContain("New space appAdd");
});

it("retries MCP server identity after an initial failure instead of leaving Reload inert", async () => {
  state.scope.mockRejectedValueOnce(new Error("Unavailable"));
  state.rpc.mockResolvedValue([]);
  await render(<McpSettings />);
  expect(container.textContent).toContain("Unavailable");
  state.scope.mockResolvedValue({ userId: "user-a", spaceId: "space-a" });
  state.rpc.mockResolvedValue([
    { id: "server-a", name: "Fixture", revision: 2, allowAllTools: false, allowedTools: [] },
  ]);
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Reload settings")
      ?.click(),
  );
  expect(state.scope).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Fixture");
  expect(container.textContent).not.toContain("Unavailable");
});

it("keeps the selected MCP server visible while saving the exact reviewed revision", async () => {
  const server = {
    id: "server-a",
    name: "Fixture",
    revision: 2,
    allowAllTools: false,
    allowedTools: [],
  };
  let finish!: (value: unknown) => void;
  state.rpc.mockImplementation((proc: string) =>
    proc === "mcp/servers/setTools"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve([server]),
  );
  await render(<McpSettings />);
  await act(async () => {
    const picker = container.querySelector("select")!;
    picker.value = "server-a";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Save tool access")
      ?.click(),
  );
  expect(state.rpc).toHaveBeenCalledWith("mcp/servers/setTools", {
    id: "server-a",
    revision: 2,
    allowAllTools: false,
    allowedTools: [],
  });
  expect(container.textContent).toContain("Fixture");
  expect(container.textContent).not.toContain("No MCP servers yet.");
  await act(async () => finish({ ...server, revision: 3 }));
  expect(container.textContent).toContain("Tool access saved.");
});

it("a Native route hint selects the exact live Native app without starting account authorization", async () => {
  state.params = { app: "google-calendar", botId: "card-bot" };
  await render();
  const native = {
    ...item,
    connectorId: "native",
    slug: "google-calendar",
    name: "Google Calendar",
    connected: false,
  };
  await act(async () => resolveCatalog([{ ...native, connectorId: "composio" }, native]));
  expect(state.rpc).toHaveBeenCalledWith("connections/tools", {
    connectorId: "native",
    provider: "google-calendar",
  });
  expect(container.querySelector('input[placeholder="Search apps"]')).toBeNull();
  expect(container.textContent).toContain("Google Calendar");
  expect(
    state.rpc.mock.calls.some(
      ([proc]) => proc === "connections/begin" || proc === "nativeConnectors/begin",
    ),
  ).toBe(false);
});

it.each([{ app: "notion" }, { app: "unknown-app" }, { app: ["google-calendar"] }])(
  "ignores an unavailable or invalid app route hint: $app",
  async ({ app }) => {
    state.params = { app, botId: "card-bot" };
    await render();
    await act(async () =>
      resolveCatalog([
        {
          ...item,
          connectorId: "native",
          slug: "google-calendar",
          name: "Google Calendar",
          connected: false,
        },
      ]),
    );
    expect(container.querySelector('input[placeholder="Search apps"]')).not.toBeNull();
    expect(
      state.rpc.mock.calls.some(
        ([proc]) =>
          proc === "connections/tools" ||
          proc === "connections/begin" ||
          proc === "nativeConnectors/begin",
      ),
    ).toBe(false);
  },
);

const importPreview = {
  status: "ready",
  target: "https://service.example.test",
  operations: [{ id: "listItems", method: "GET", path: "/items", readOnly: true }],
  diagnostics: [],
  counts: { discovered: 1, accepted: 1, rejected: 0, omittedDiagnostics: 0 },
  reviewToken: "review-kept",
  expiresAt: "2027-01-01T00:00:00Z",
};
function importDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function beginImport() {
  await render();
  await act(async () => resolveCatalog([]));
  await press("Advanced");
  await press("Add OpenAPI");
  await fillSource("Display name", "Example API");
  await fillSource("https://example.com/openapi.json", "https://example.test/spec.yaml");
  await press("No authentication");
  await fillSource("Bearer token", "initial-secret");
}

it("keeps a new native credential after a delayed preview for the edited draft", async () => {
  const original = state.rpc.getMockImplementation()!;
  const wait = importDeferred<typeof importPreview>();
  state.rpc.mockImplementation((proc: string) =>
    proc === "capabilities/previewOpenApi" ? wait.promise : original(proc),
  );
  await beginImport();
  await press("Preview");
  await fillSource("Bearer token", "new-secret");
  await act(async () => wait.resolve(importPreview));
  expect(container.querySelector('[data-testid="openapi-import-review"]')).toBeNull();
  expect(
    container.querySelector<HTMLInputElement>('input[placeholder="Bearer token"]')?.value,
  ).toBe("new-secret");
});

it("keeps a reopened native source form when an earlier confirmation returns", async () => {
  const original = state.rpc.getMockImplementation()!;
  const wait = importDeferred<unknown>();
  state.rpc.mockImplementation((proc: string) =>
    proc === "capabilities/previewOpenApi"
      ? Promise.resolve(importPreview)
      : proc === "capabilities/confirmOpenApi"
        ? wait.promise
        : original(proc),
  );
  await beginImport();
  await press("Preview");
  await press("Add");
  await press("Close");
  await press("Add OpenAPI");
  await fillSource("Display name", "New draft");
  await press("No authentication");
  await fillSource("Bearer token", "new-secret");
  await act(async () =>
    wait.resolve({
      status: "installed",
      replayed: false,
      install: {
        id: "install-one",
        kind: "api",
        name: "Old API",
        source: "https://example.test/spec.yaml",
        config: {},
        version: null,
        digest: null,
        secretConfigured: true,
        createdAt: "2026-01-01",
      },
    }),
  );
  expect(
    container.querySelector<HTMLInputElement>('input[placeholder="Display name"]')?.value,
  ).toBe("New draft");
  expect(
    container.querySelector<HTMLInputElement>('input[placeholder="Bearer token"]')?.value,
  ).toBe("new-secret");
  expect(container.textContent).not.toContain("Old API");
});

it("uses a read-only receipt check and keeps the original native retry token", async () => {
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc: string) =>
    proc === "capabilities/previewOpenApi"
      ? Promise.resolve(importPreview)
      : proc === "capabilities/confirmOpenApi"
        ? Promise.reject(new Error("Lost response"))
        : proc === "capabilities/openApiReceipt"
          ? Promise.resolve({ status: "pending", diagnostics: [] })
          : original(proc),
  );
  await beginImport();
  await press("Preview");
  await press("Add");
  expect(container.textContent).toContain("Could not confirm installation.");
  await press("Check status");
  expect(state.rpc).toHaveBeenCalledWith(
    "capabilities/openApiReceipt",
    { reviewToken: "review-kept" },
    expect.anything(),
  );
  expect(
    state.rpc.mock.calls.filter(([proc]) => proc === "capabilities/confirmOpenApi"),
  ).toHaveLength(1);
  await press("Retry");
  const confirms = state.rpc.mock.calls.filter(([proc]) => proc === "capabilities/confirmOpenApi");
  expect(confirms).toHaveLength(2);
  expect(confirms[1]![1]).toEqual(confirms[0]![1]);
  expect(
    state.rpc.mock.calls.filter(([proc]) => proc === "capabilities/previewOpenApi"),
  ).toHaveLength(1);
});

it("closes the reviewed native credential on an actor or Space epoch change", async () => {
  const original = state.rpc.getMockImplementation()!;
  const wait = importDeferred<typeof importPreview>();
  state.rpc.mockImplementation((proc: string) =>
    proc === "capabilities/previewOpenApi" ? wait.promise : original(proc),
  );
  await beginImport();
  await press("Preview");
  await act(async () => {
    state.importEpoch += 2;
    state.scopeChanged?.();
  });
  await act(async () => wait.resolve(importPreview));
  expect(container.querySelector('[data-testid="openapi-import-review"]')).toBeNull();
  expect(container.querySelector('input[placeholder="Bearer token"]')).toBeNull();
});

it("ignores a native preview when its screen loses focus", async () => {
  const original = state.rpc.getMockImplementation()!;
  const wait = importDeferred<typeof importPreview>();
  state.rpc.mockImplementation((proc: string) =>
    proc === "capabilities/previewOpenApi" ? wait.promise : original(proc),
  );
  await beginImport();
  await press("Preview");
  state.focused = false;
  await render();
  await act(async () => wait.resolve(importPreview));
  expect(container.querySelector('[data-testid="openapi-import-review"]')).toBeNull();
});

it("locks the submitted native credential while a receipt is unknown", async () => {
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc: string) =>
    proc === "capabilities/previewOpenApi"
      ? Promise.resolve(importPreview)
      : proc === "capabilities/confirmOpenApi"
        ? Promise.reject(new Error("Lost response"))
        : original(proc),
  );
  await beginImport();
  await press("Preview");
  await press("Add");
  expect(
    container.querySelector<HTMLInputElement>('input[placeholder="Bearer token"]')?.disabled,
  ).toBe(true);
  expect(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent === "Check status" && !button.disabled,
    ),
  ).toBe(true);
});
