// @vitest-environment jsdom
import type { McpServer, PluginInstallReceipt, PluginPreview } from "@rakazo/contracts";
import type { EffectCallback, ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  rpc: vi.fn(),
  context: vi.fn(),
  openURL: vi.fn(),
  navigate: vi.fn(),
  focusCleanup: undefined as undefined | (() => void),
  space: "space-a" as string | null,
  session: 1,
  generation: 1,
  listeners: new Set<() => void>(),
}));
vi.mock("./api", () => ({ rpc: api.rpc, captureApiRequestContext: api.context }));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({
    apiBase: "https://api.example.test",
    spaceId: api.space,
    sessionGeneration: api.session,
    spaceGeneration: api.generation,
  }),
  isMobileScopeCurrent: (scope: {
    spaceId: string;
    sessionGeneration: number;
    spaceGeneration: number;
  }) =>
    scope.spaceId === api.space &&
    scope.sessionGeneration === api.session &&
    scope.spaceGeneration === api.generation,
  subscribeMobileScope: (listener: () => void) => {
    api.listeners.add(listener);
    return () => api.listeners.delete(listener);
  },
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: EffectCallback) =>
    useEffect(() => {
      const cleanup = callback();
      api.focusCleanup = typeof cleanup === "function" ? cleanup : undefined;
      return cleanup;
    }, [callback]),
  useRouter: () => ({ push: api.navigate }),
}));
vi.mock("react-native", () => ({
  Linking: { openURL: api.openURL },
  ScrollView: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement("div", { "data-testid": testID }, children),
  View: ({
    children,
    testID,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityLabel?: string;
  }) => createElement("div", { "data-testid": testID, "aria-label": accessibilityLabel }, children),
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
    createElement("div", { role: accessibilityRole }, children),
  TextInput: ({
    value,
    editable,
    onChangeText,
    accessibilityLabel,
  }: {
    value: string;
    editable?: boolean;
    onChangeText: (value: string) => void;
    accessibilityLabel?: string;
  }) =>
    createElement("input", {
      value,
      disabled: editable === false,
      "aria-label": accessibilityLabel,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    busy,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    busy?: boolean;
    onPress: () => void;
  }) =>
    createElement(
      "button",
      { type: "button", disabled: disabled || busy, onClick: onPress },
      label,
    ),
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) =>
      key.replace(/\{(\w+)\}/g, (match, name: string) => values?.[name] ?? match),
  }),
  t: (key: string, values?: Record<string, string>) =>
    key.replace(/\{(\w+)\}/g, (match, name: string) => values?.[name] ?? match),
}));
vi.mock("./native", () => ({ native: {}, useThemedStyles: <T,>(factory: () => T) => factory() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));

import Plugins from "../app/(settings)/plugins";

function listing(
  owned: PluginInstallReceipt[] = [],
  managed: { receipt: PluginInstallReceipt; ownerName: string | null }[] = [],
) {
  return { owned, managed };
}

const preview: PluginPreview = {
  source: `https://github.com/example/plugin/tree/${"a".repeat(40)}`,
  sourceSha: "a".repeat(40),
  digest: `sha256:${"b".repeat(64)}`,
  format: "agent-plugins",
  name: "Research plugin",
  description: "Synthetic instructions",
  version: null,
  skills: [
    { name: "research", description: "Research a topic", content: "Complete raw instructions" },
  ],
  mcpServers: [
    {
      name: "Research service",
      transport: "sse",
      endpoint: "https://service.example.test/events",
      headerKeys: [],
    },
  ],
  skipped: [
    { kind: "mcp_stdio", name: "Local command", reason: "Local commands are not imported" },
  ],
};
const receipt: PluginInstallReceipt = {
  id: "install-one",
  clientNonce: "nonce-installed",
  source: preview.source,
  sourceSha: preview.sourceSha,
  digest: preview.digest,
  name: preview.name,
  status: "installed",
  revision: 1,
  installedAt: "2026-11-01T00:00:00.000Z",
  skills: [{ id: "skill-one", name: "research" }],
  mcpServers: [],
};
let root: Root;
let node: HTMLDivElement;
beforeEach(async () => {
  vi.clearAllMocks();
  api.openURL.mockResolvedValue(undefined);
  api.space = "space-a";
  api.session = 1;
  api.generation = 1;
  api.listeners.clear();
  api.context.mockImplementation(async () => ({
    apiBase: "https://api.example.test",
    sessionGeneration: api.session,
    headers: { "x-rakazo-space-id": api.space },
  }));
  api.rpc.mockImplementation(async (procedure: string, input: { clientNonce?: string }) => {
    if (procedure === "plugins/list") return listing([]);
    if (procedure === "plugins/preview") return preview;
    if (procedure === "plugins/install") return { ...receipt, clientNonce: input.clientNonce };
    return { ...receipt, status: "removed", revision: 3 };
  });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root.render(<Plugins />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});
function button(label: string) {
  const found = Array.from(node.querySelectorAll("button")).find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
async function input(value: string) {
  await act(async () => {
    const field = node.querySelector<HTMLInputElement>('input[aria-label="Plugin GitHub URL"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}
async function openPreview() {
  await input("https://github.com/example/plugin");
  await click("Preview");
}

it("projects the reviewed instructions, endpoints and unsupported components through the actual native route", async () => {
  await openPreview();
  await click("View instructions");
  expect(node.textContent).toContain("Complete raw instructions");
  expect(node.textContent).toContain("https://service.example.test/events");
  expect(node.textContent).toContain("Local commands are not imported");
  expect(api.rpc.mock.calls.filter((call) => call[0] === "plugins/install")).toHaveLength(0);
  await click("Install plugin");
  const write = api.rpc.mock.calls.find((call) => call[0] === "plugins/install")!;
  expect(write[1]).toMatchObject({
    source: preview.source,
    sourceSha: preview.sourceSha,
    digest: preview.digest,
  });
  expect(write[2]).toMatchObject({
    timeoutMs: 35_000,
    skipSpaceAuthRecovery: true,
    requestContext: { headers: { "x-rakazo-space-id": "space-a" } },
  });
  expect(node.textContent).toContain("Installed");
});

it("retains a nonce through unknown reply, read-only check and explicit retry", async () => {
  const normal = api.rpc.getMockImplementation()!;
  let calls = 0;
  api.rpc.mockImplementation(async (procedure, value, options) => {
    if (procedure === "plugins/install" && calls++ === 0) throw new Error("reply lost");
    return normal(procedure, value, options);
  });
  await openPreview();
  await click("Install plugin");
  expect(node.textContent).toContain("Could not confirm installation.");
  await click("Check status");
  await click("Retry");
  const writes = api.rpc.mock.calls.filter((call) => call[0] === "plugins/install");
  expect(writes).toHaveLength(2);
  expect(writes[0]?.[1]).toEqual(writes[1]?.[1]);
});

it("invalidates preview and aborts requests across a Space ABA change", async () => {
  const normal = api.rpc.getMockImplementation()!;
  let resolve!: (value: PluginPreview) => void;
  api.rpc.mockImplementation((procedure, value, options) =>
    procedure === "plugins/preview"
      ? new Promise((done) => {
          resolve = done;
        })
      : normal(procedure, value, options),
  );
  await input("https://github.com/example/old");
  await click("Preview");
  const request = api.rpc.mock.calls.find((call) => call[0] === "plugins/preview")!;
  await act(async () => {
    api.space = "space-b";
    api.generation += 1;
    for (const listener of api.listeners) listener();
  });
  await act(async () => {
    api.space = "space-a";
    api.generation += 1;
    for (const listener of api.listeners) listener();
  });
  await input("https://github.com/example/new");
  await act(async () => resolve(preview));
  expect((request[2] as { signal: AbortSignal }).signal.aborted).toBe(true);
  expect(node.querySelector<HTMLInputElement>('input[aria-label="Plugin GitHub URL"]')!.value).toBe(
    "https://github.com/example/new",
  );
  expect(node.querySelector('[data-testid="plugin-preview"]')).toBeNull();
});

it("uses explicit confirmation and a fresh cleanup revision", async () => {
  const normal = api.rpc.getMockImplementation()!;
  let row: PluginInstallReceipt = receipt;
  api.rpc.mockImplementation(async (procedure, value, options) => {
    if (procedure === "plugins/list") return listing([row]);
    if (procedure === "plugins/uninstall") {
      row = {
        ...row,
        status: row.status === "installed" ? "cleanup_failed" : "removed",
        revision: row.revision + 2,
      };
      return row;
    }
    return normal(procedure, value, options);
  });
  await click("Refresh");
  await click("Remove plugin");
  expect(api.rpc.mock.calls.filter((call) => call[0] === "plugins/uninstall")).toHaveLength(0);
  await click("Confirm removal");
  expect(node.textContent).toContain("Cleanup incomplete");
  await click("Retry cleanup");
  const writes = api.rpc.mock.calls.filter((call) => call[0] === "plugins/uninstall");
  expect(writes[1]?.[1]).toEqual({ installId: receipt.id, expectedRevision: 3 });
  expect(node.textContent).toContain("No plugins installed");
});

it("shows installing and failed receipts without treating either as a successful installation", async () => {
  const normal = api.rpc.getMockImplementation()!;
  let pending: PluginInstallReceipt | null = null;
  api.rpc.mockImplementation(async (procedure, input, options) => {
    if (procedure === "plugins/install") {
      pending = {
        ...receipt,
        clientNonce: input.clientNonce,
        status: "installing" as const,
        installedAt: null,
      };
      return pending;
    }
    if (procedure === "plugins/list") return listing(pending ? [pending] : []);
    return normal(procedure, input, options);
  });
  await openPreview();
  await click("Install plugin");
  expect(node.textContent).toContain("Installation pending.");
  expect(
    Array.from(node.querySelectorAll("button")).some((item) => item.textContent === "Retry"),
  ).toBe(false);
  pending = { ...pending!, status: "failed", revision: 2 };
  await click("Check status");
  expect(node.textContent).toContain("Installation failed.");
  expect(api.rpc.mock.calls.filter((call) => call[0] === "plugins/install")).toHaveLength(1);
});

it("resolves an implicit Space once and pins every plugin request to that receipt", async () => {
  const normal = api.rpc.getMockImplementation()!;
  api.rpc.mockImplementation(async (procedure, input, options) =>
    procedure === "me"
      ? { userId: "user-a", spaceId: "space-resolved" }
      : normal(procedure, input, options),
  );
  await act(async () => {
    api.space = null;
    api.generation += 1;
    for (const listener of api.listeners) listener();
  });
  const list = api.rpc.mock.calls.filter((call) => call[0] === "plugins/list").at(-1)!;
  expect(list[2]).toMatchObject({
    requestContext: { headers: { "x-rakazo-space-id": "space-resolved" } },
  });
  await openPreview();
  await click("Install plugin");
  const install = api.rpc.mock.calls.find((call) => call[0] === "plugins/install")!;
  expect(install[2]).toMatchObject({
    requestContext: { headers: { "x-rakazo-space-id": "space-resolved" } },
  });
});

it.each(["cleanup_failed", "uninstalling"] as const)(
  "retries %s for the selected plugin without borrowing a different confirmation",
  async (status) => {
    const normal = api.rpc.getMockImplementation()!;
    const second = {
      ...receipt,
      id: "install-two",
      name: "Second plugin",
      clientNonce: "second-nonce",
      status,
      revision: 3,
    };
    api.rpc.mockImplementation(async (procedure, input, options) => {
      if (procedure === "plugins/list") return listing([receipt, second]);
      if (procedure === "plugins/uninstall") return { ...second, status: "removed", revision: 5 };
      return normal(procedure, input, options);
    });
    await click("Refresh");
    await click("Remove plugin");
    await click("Retry cleanup");
    const write = api.rpc.mock.calls.find((call) => call[0] === "plugins/uninstall")!;
    expect(write[1]).toEqual({ installId: second.id, expectedRevision: 3 });
  },
);

it("explicitly confirms cleanup of a persisted pending receipt after reopening", async () => {
  const normal = api.rpc.getMockImplementation()!;
  const pending = { ...receipt, status: "installing" as const, installedAt: null };
  api.rpc.mockImplementation(async (procedure, input, options) => {
    if (procedure === "plugins/list") return listing([pending]);
    if (procedure === "plugins/uninstall") return { ...pending, status: "removed", revision: 3 };
    return normal(procedure, input, options);
  });
  await click("Refresh");
  expect(node.textContent).toContain("Installation pending.");
  await click("Remove plugin");
  expect(api.rpc.mock.calls.filter((call) => call[0] === "plugins/uninstall")).toHaveLength(0);
  await click("Confirm removal");
  const write = api.rpc.mock.calls.find((call) => call[0] === "plugins/uninstall")!;
  expect(write[1]).toEqual({ installId: pending.id, expectedRevision: 1 });
  expect(node.textContent).toContain("No plugins installed");
  expect(api.rpc.mock.calls.filter((call) => call[0] === "plugins/install")).toHaveLength(0);
});

it("settles the current pending review after confirmed cleanup without replaying installation", async () => {
  const normal = api.rpc.getMockImplementation()!;
  let pending: PluginInstallReceipt | null = null;
  api.rpc.mockImplementation(async (procedure, input, options) => {
    if (procedure === "plugins/install") {
      pending = {
        ...receipt,
        clientNonce: input.clientNonce,
        status: "installing" as const,
        installedAt: null,
      };
      return pending;
    }
    if (procedure === "plugins/uninstall") return { ...pending!, status: "removed", revision: 3 };
    return normal(procedure, input, options);
  });
  await openPreview();
  await click("Install plugin");
  await click("Remove plugin");
  await click("Confirm removal");
  expect(node.textContent).toContain("This installation was removed.");
  expect(node.textContent).not.toContain("Installation pending.");
  expect(api.rpc.mock.calls.filter((call) => call[0] === "plugins/install")).toHaveLength(1);
  expect(api.rpc.mock.calls.filter((call) => call[0] === "plugins/uninstall")).toHaveLength(1);
});

it("disables unrelated cleanup while an installation acknowledgement is unknown", async () => {
  const normal = api.rpc.getMockImplementation()!;
  const pending = {
    ...receipt,
    clientNonce: "old-nonce",
    status: "installing" as const,
    installedAt: null,
  };
  api.rpc.mockImplementation(async (procedure, input, options) => {
    if (procedure === "plugins/list") return listing([pending]);
    if (procedure === "plugins/install") throw new Error("reply lost");
    return normal(procedure, input, options);
  });
  await click("Refresh");
  expect(button("Remove plugin").disabled).toBe(false);
  await openPreview();
  await click("Install plugin");
  expect(button("Remove plugin").disabled).toBe(true);
  await click("Remove plugin");
  expect(api.rpc.mock.calls.filter((call) => call[0] === "plugins/uninstall")).toHaveLength(0);
  await click("Check status");
  expect(button("Remove plugin").disabled).toBe(true);
  expect(api.rpc.mock.calls.filter((call) => call[0] === "plugins/uninstall")).toHaveLength(0);
});

it.each(["Alex", null])(
  "lets an owner confirm removal of a member installation attributed to %s",
  async (ownerName) => {
    const normal = api.rpc.getMockImplementation()!;
    const managed = {
      ...receipt,
      id: "member-install",
      clientNonce: "member-nonce",
      name: "Member plugin",
    };
    api.rpc.mockImplementation(async (procedure, input, options) => {
      if (procedure === "plugins/list") return listing([], [{ receipt: managed, ownerName }]);
      if (procedure === "plugins/uninstall") return { ...managed, status: "removed", revision: 3 };
      return normal(procedure, input, options);
    });
    await click("Refresh");
    expect(node.textContent).toContain(`Installed by ${ownerName ?? "Another member"}`);
    await openPreview();
    await click("Remove plugin");
    expect(api.rpc.mock.calls.filter((call) => call[0] === "plugins/uninstall")).toHaveLength(0);
    await click("Confirm removal");
    const write = api.rpc.mock.calls.find((call) => call[0] === "plugins/uninstall")!;
    expect(write[1]).toEqual({ installId: managed.id, expectedRevision: 1 });
    expect(node.textContent).not.toContain("Member plugin");
    expect(button("Install plugin")).toBeDefined();
    expect(api.rpc.mock.calls.filter((call) => call[0] === "plugins/install")).toHaveLength(0);
  },
);

it("shows a member only owned installations after management rights disappear", async () => {
  const normal = api.rpc.getMockImplementation()!;
  const managed = {
    ...receipt,
    id: "member-install",
    clientNonce: "member-nonce",
    name: "Member plugin",
  };
  let canManage = true;
  api.rpc.mockImplementation(async (procedure, input, options) => {
    if (procedure === "plugins/list")
      return listing([receipt], canManage ? [{ receipt: managed, ownerName: "Alex" }] : []);
    return normal(procedure, input, options);
  });
  await click("Refresh");
  const row = node.querySelector('[aria-label="Member plugin"]')!;
  await act(async () => (row.querySelector("button")! as HTMLButtonElement).click());
  canManage = false;
  await click("Refresh");
  expect(node.textContent).not.toContain("Member plugin");
  expect(node.textContent).not.toContain("Installed by");
  expect(api.rpc.mock.calls.filter((call) => call[0] === "plugins/uninstall")).toHaveLength(0);
});

it("does not restore a revoked member row when cleanup replies after a concurrent refresh", async () => {
  const normal = api.rpc.getMockImplementation()!;
  const managed = {
    ...receipt,
    id: "member-install",
    clientNonce: "member-nonce",
    name: "Member plugin",
  };
  let resolveRead!: (value: ReturnType<typeof listing>) => void;
  let resolveWrite!: (value: PluginInstallReceipt) => void;
  let reading = false;
  api.rpc.mockImplementation((procedure, input, options) => {
    if (procedure === "plugins/list")
      return reading
        ? new Promise((done) => {
            resolveRead = done;
          })
        : Promise.resolve(listing([], [{ receipt: managed, ownerName: "Alex" }]));
    if (procedure === "plugins/uninstall")
      return new Promise((done) => {
        resolveWrite = done;
      });
    return normal(procedure, input, options);
  });
  await click("Refresh");
  reading = true;
  await click("Refresh");
  await click("Remove plugin");
  await click("Confirm removal");
  await act(async () => resolveRead(listing()));
  await act(async () => resolveWrite({ ...managed, status: "cleanup_failed", revision: 3 }));
  expect(node.textContent).not.toContain("Member plugin");
  expect(node.textContent).not.toContain("Installed by");
  expect(node.textContent).toContain("No plugins installed");
  expect(api.rpc.mock.calls.filter((call) => call[0] === "plugins/uninstall")).toHaveLength(1);
});

const setupServer = {
  id: "mcp-one",
  spaceId: "space-a",
  slug: "research",
  name: "Research service",
  description: "",
  transport: "sse" as const,
  endpoint: "https://service.example.test/events",
  command: null,
  args: [],
  envKeys: [],
  headerKeys: ["Authorization", "X-Workspace"],
  hasSecret: true,
  oauthStatus: "none" as const,
  enabled: false,
  allowAllTools: false,
  allowedTools: [],
  revision: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
async function fillField(label: string, value: string) {
  await act(async () => {
    const field = node.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("opens a discovered entry in the pinned native review without installing or enabling", async () => {
  const normal = api.rpc.getMockImplementation()!;
  api.rpc.mockImplementation(async (procedure, input, options) =>
    procedure === "plugins/search"
      ? {
          entries: [
            {
              id: "registry-one",
              name: "Research listing",
              description: "Registry description",
              source: "https://github.com/example/discovered",
              installedSource: "https://github.com/example/discovered",
              registry: "Cursor",
              keywords: [],
            },
          ],
          nextCursor: null,
          unavailableRegistries: [],
          skippedEntries: 0,
        }
      : normal(procedure, input, options),
  );
  await fillField("Search plugins", "research");
  await click("Search");
  await click("Preview Research listing");
  const previewCall = api.rpc.mock.calls.find((call) => call[0] === "plugins/preview")!;
  expect(previewCall[1]).toEqual({ source: "https://github.com/example/discovered" });
  expect(node.textContent).toContain("Research a topic");
  expect(
    api.rpc.mock.calls.filter(
      (call) => call[0] === "plugins/install" || call[0] === "mcp/servers/update",
    ),
  ).toHaveLength(0);
});
it("uses native credential entry and external OAuth with explicit status readback", async () => {
  const normal = api.rpc.getMockImplementation()!;
  let current: McpServer = setupServer;
  api.rpc.mockImplementation(async (procedure, input, options) => {
    if (procedure === "plugins/list")
      return listing([
        {
          ...receipt,
          mcpServers: [
            {
              id: current.id,
              name: current.name,
              endpoint: setupServer.endpoint,
              transport: setupServer.transport,
            },
          ],
        },
      ]);
    if (procedure === "mcp/servers/list") return [current];
    if (procedure === "mcp/servers/update") {
      current = { ...current, enabled: input.connection.enabled, revision: current.revision + 1 };
      return current;
    }
    if (procedure === "integrationSetup/get")
      return {
        canConfigure: true,
        needsSetup: false,
        providers: [],
        webUrl: "https://web.example.test/integrations/setup",
      };
    if (procedure === "mcp/oauth/begin")
      return {
        status: "authorization_required",
        sessionId: "mobile-session",
        authorizationUrl: "https://auth.example.test/authorize",
      };
    return normal(procedure, input, options);
  });
  await click("Refresh");
  await click("Set up connections");
  await click("Enable connection");
  let update = api.rpc.mock.calls.find((call) => call[0] === "mcp/servers/update")!;
  expect(update[1]).toEqual({ id: setupServer.id, connection: { revision: 1, enabled: true } });
  await click("Edit credentials");
  await fillField("Authorization", "fake-mobile-secret");
  await click("Save credentials");
  update = api.rpc.mock.calls.filter((call) => call[0] === "mcp/servers/update").at(-1)!;
  expect(update[1]).toEqual({
    id: setupServer.id,
    connection: {
      revision: 2,
      enabled: true,
      headerUpdates: { Authorization: "fake-mobile-secret" },
    },
  });
  expect(node.querySelector('input[aria-label="Authorization"]')).toBeNull();
  await click("Sign in");
  expect(api.openURL).toHaveBeenCalledWith("https://auth.example.test/authorize");
  const begin = api.rpc.mock.calls.find((call) => call[0] === "mcp/oauth/begin")!;
  expect(begin[1]).toEqual({
    serverId: setupServer.id,
    redirectUri: "https://web.example.test/mcp/oauth/callback",
  });
  expect(begin[2]).toMatchObject({
    skipSpaceAuthRecovery: true,
    requestContext: { headers: { "x-rakazo-space-id": "space-a" } },
  });
  expect(node.textContent).toContain("Could not confirm sign-in.");
  expect(node.textContent).not.toContain("Connected");
  current = { ...current, oauthStatus: "connected" };
  await click("Check status");
  expect(node.textContent).toContain("Connected");
  await click("Tool access");
  expect(api.navigate).toHaveBeenCalledWith("/mcp");
});
it("does not expose managed member connection credentials on the native route", async () => {
  const normal = api.rpc.getMockImplementation()!;
  api.rpc.mockImplementation(async (procedure, input, options) =>
    procedure === "plugins/list"
      ? listing(
          [],
          [
            {
              receipt: {
                ...receipt,
                mcpServers: [
                  {
                    id: setupServer.id,
                    name: setupServer.name,
                    endpoint: setupServer.endpoint,
                    transport: setupServer.transport,
                  },
                ],
              },
              ownerName: "Alex",
            },
          ],
        )
      : normal(procedure, input, options),
  );
  await click("Refresh");
  expect(node.textContent).toContain("Installed by Alex");
  expect(node.textContent).not.toContain("Set up connections");
});

it("accepts an explicitly named native header when the imported server has no header keys", async () => {
  const normal = api.rpc.getMockImplementation()!;
  const current = { ...setupServer, headerKeys: [] };
  api.rpc.mockImplementation(async (procedure, input, options) => {
    if (procedure === "plugins/list")
      return listing([
        {
          ...receipt,
          mcpServers: [
            {
              id: current.id,
              name: current.name,
              endpoint: setupServer.endpoint,
              transport: setupServer.transport,
            },
          ],
        },
      ]);
    if (procedure === "mcp/servers/list") return [current];
    if (procedure === "mcp/servers/update")
      return { ...current, revision: 2, headerKeys: ["X-Api-Key"] };
    return normal(procedure, input, options);
  });
  await click("Refresh");
  await click("Set up connections");
  await click("Add header");
  await fillField("Header name", "X-Api-Key");
  await fillField("Header value", "fake-native-key");
  await click("Save credentials");
  const write = api.rpc.mock.calls.find((call) => call[0] === "mcp/servers/update")!;
  expect(write[1]).toEqual({
    id: current.id,
    connection: { revision: 1, enabled: false, headerUpdates: { "X-Api-Key": "fake-native-key" } },
  });
  expect(node.querySelector('input[aria-label="Header value"]')).toBeNull();
});

it("clears native credential forms on route blur while its screen remains mounted", async () => {
  const normal = api.rpc.getMockImplementation()!;
  const current = { ...setupServer, headerKeys: [] };
  api.rpc.mockImplementation(async (procedure, input, options) => {
    if (procedure === "plugins/list")
      return listing([
        {
          ...receipt,
          mcpServers: [
            {
              id: current.id,
              name: current.name,
              endpoint: current.endpoint,
              transport: current.transport,
            },
          ],
        },
      ]);
    if (procedure === "mcp/servers/list") return [current];
    return normal(procedure, input, options);
  });
  await click("Refresh");
  await click("Set up connections");
  await click("Add header");
  await fillField("Header name", "X-Api-Key");
  await fillField("Header value", "fake-unsaved-native");
  await act(async () => api.focusCleanup?.());
  expect(node.querySelector('[data-testid="github-plugin-installs"]')).not.toBeNull();
  expect(node.querySelector('input[aria-label="Header value"]')).toBeNull();
  expect(node.querySelector('[data-testid="plugin-server-setup"]')).toBeNull();
  expect(api.rpc.mock.calls.filter((call) => call[0] === "mcp/servers/update")).toHaveLength(0);
});

it("distinguishes unavailable registry results from a healthy empty catalog", async () => {
  const normal = api.rpc.getMockImplementation()!;
  let unavailableRegistries = ["Cursor", "xAI"];
  api.rpc.mockImplementation(async (procedure, input, options) =>
    procedure === "plugins/search"
      ? { entries: [], nextCursor: null, unavailableRegistries, skippedEntries: 0 }
      : normal(procedure, input, options),
  );
  await click("Search");
  expect(node.textContent).toContain("Some registries are unavailable.");
  expect(node.textContent).not.toContain("No plugins found");
  unavailableRegistries = [];
  await click("Search");
  expect(node.textContent).toContain("No plugins found");
  expect(node.textContent).not.toContain("Some registries are unavailable.");
});
