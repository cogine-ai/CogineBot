// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Messaging from "../app/(settings)/messaging";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  epoch: 0,
  spaceId: "space-a",
  listeners: new Set<() => void>(),
  focused: true,
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => () => void) =>
    useEffect(() => (state.focused ? callback() : undefined), [callback, state.focused]),
}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: async (spaceId: string) => ({
    apiBase: "https://example.test",
    headers: { "x-rakazo-space-id": spaceId },
  }),
}));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({ spaceId: state.spaceId, epoch: state.epoch }),
  isMobileScopeCurrent: (scope: { epoch: number }) => scope.epoch === state.epoch,
  mobileScopeKey: () => String(state.epoch),
  subscribeMobileScope: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
vi.mock("./i18n", () => ({
  dateLocaleForUi: () => "en-US",
  useI18n: () => ({
    t: (text: string, values?: Record<string, string>) =>
      text.replace(/\{(\w+)\}/g, (all, key) => values?.[key] ?? all),
  }),
}));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: (factory: () => unknown) => factory(),
  useMobileTokens: () => ({ destructive: "red" }),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
    editable,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    accessibilityLabel: string;
    editable: boolean;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      disabled={!editable}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({
    label,
    value,
    choices,
    onChange,
    disabled,
  }: {
    label: string;
    value: string;
    choices: { key: string; label: string }[];
    onChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {choices.map((choice) => (
        <option key={choice.key} value={choice.key}>
          {choice.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
    busy,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
  }) => (
    <button type="button" disabled={disabled || busy} onClick={onPress}>
      {label}
    </button>
  ),
}));

let root: Root;
let host: HTMLDivElement;
let conversation: Record<string, unknown>;
let channelStatus: string;
let connectionStatus: string;
let incoming: boolean;
let linked: boolean;
function render() {
  return act(async () => root.render(<Messaging />));
}
function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
  expect(button, label).toBeDefined();
  return act(async () => button!.click());
}
function choose(label: string, value: string) {
  return act(async () => {
    const node = host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function input(label: string, value: string) {
  return act(async () => {
    const node = host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.epoch = 0;
  state.spaceId = "space-a";
  state.focused = true;
  state.rpc.mockReset();
  state.listeners.clear();
  channelStatus = "invited";
  connectionStatus = "pending";
  incoming = true;
  linked = true;
  conversation = {
    id: "conversation-a",
    botId: "bot-a",
    spaceId: "space-a",
    provider: "synthetic",
    displayName: "Synthetic room",
    participantNames: [],
    teamChatAmbientEnabled: null,
    teamChatRules: null,
    automatedSenderPolicies: {},
    automatedSenders: [{ id: "sender-a", name: "Synthetic sender" }],
  };
  state.rpc.mockImplementation(async (proc: string, body: Record<string, unknown>) => {
    if (proc === "messaging/status")
      return {
        enabled: true,
        providers: ["synthetic"],
        identities: linked
          ? [
              {
                id: "identity-a",
                botId: "bot-a",
                botName: "Bot A",
                address: "synthetic",
                provider: "synthetic",
              },
            ]
          : [],
      };
    if (proc === "bots/listArchived") return [];
    if (proc === "bots/list")
      return [
        {
          id: "bot-a",
          name: "Bot A",
          teamChatRules: "Default guidance",
          teamChatAmbientEnabled: true,
        },
      ];
    if (proc === "spaces/list")
      return { current: { id: state.spaceId, externalConversations: [conversation] } };
    if (proc === "messaging/channels/list")
      return [
        {
          id: "membership-a",
          identityId: "identity-a",
          provider: "synthetic",
          name: "Synthetic channel",
          status: channelStatus,
        },
      ];
    if (proc === "messaging/connections/list")
      return [
        {
          id: "connection-a",
          peerOwnerLabel: "Synthetic owner",
          peerBotName: "Synthetic peer",
          incoming,
          status: connectionStatus,
          requestVersion: 7,
        },
      ];
    if (proc === "messaging/identities/unlink") linked = false;
    if (proc === "messaging/channels/respond")
      channelStatus = body.accept ? "approved" : "declined";
    if (proc === "messaging/channels/leave") channelStatus = "left";
    if (proc === "messaging/connections/respond")
      connectionStatus = body.accept ? "approved" : "declined";
    if (proc === "messaging/connections/revoke") connectionStatus = "revoked";
    if (proc === "externalConversations/updatePolicy") conversation = { ...conversation, ...body };
    if (proc === "messaging/link/start")
      return { code: "FAKE-CODE", expiresAt: new Date(Date.now() + 600000).toISOString() };
    return {};
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("opens identity management, reads unlink back, and shows binding guidance for the selected bot", async () => {
  await render();
  await click("Unlink");
  expect(host.textContent).toContain("No chat apps linked yet.");
  await choose("Bot to link", "bot-a");
  await click("Link a chat app");
  expect(host.textContent).toContain("FAKE-CODE");
  expect(state.rpc).toHaveBeenCalledWith(
    "messaging/link/start",
    { botId: "bot-a" },
    expect.objectContaining({
      requestContext: expect.objectContaining({ headers: { "x-rakazo-space-id": "space-a" } }),
    }),
  );
  await choose("Bot to link", "");
  expect(host.textContent).not.toContain("FAKE-CODE");
});
it.each([true, false])(
  "handles channel and incoming connection decisions (%s), leave and revoke",
  async (accept) => {
    await render();
    await click(accept ? "Approve" : "Decline");
    expect(state.rpc).toHaveBeenCalledWith(
      "messaging/channels/respond",
      { membershipId: "membership-a", accept },
      expect.anything(),
    );
    if (accept) await click("Leave");
    await click(accept ? "Approve" : "Decline");
    expect(state.rpc).toHaveBeenCalledWith(
      "messaging/connections/respond",
      { connectionId: "connection-a", requestVersion: 7, accept },
      expect.anything(),
    );
    if (accept) await click("Revoke");
  },
);
it("allows an outgoing pending invitation to be revoked but not accepted", async () => {
  channelStatus = "left";
  incoming = false;
  await render();
  expect([...host.querySelectorAll("button")].some((node) => node.textContent === "Approve")).toBe(
    false,
  );
  await click("Revoke");
  expect(connectionStatus).toBe("revoked");
});
it("preserves null inheritance, explicit empty guidance, sender modes and default restoration", async () => {
  await render();
  await choose("External conversation", "conversation-a");
  await click("Save");
  expect(conversation).toMatchObject({
    teamChatAmbientEnabled: null,
    teamChatRules: null,
    automatedSenderPolicies: {},
  });
  await choose("Listening", "mentions");
  await input("Room guidance", "");
  for (const mode of ["ignore", "rollup", "action", "user"]) {
    await choose("Synthetic sender", mode);
    if (mode === "rollup") {
      await input("Synthetic sender rollup hours", "0");
      expect(
        [...host.querySelectorAll("button")].find((node) => node.textContent === "Save")!.disabled,
      ).toBe(true);
      await input("Synthetic sender rollup hours", "720");
    }
    await click("Save");
    expect(conversation).toMatchObject({
      externalConversationId: "conversation-a",
      teamChatAmbientEnabled: false,
      teamChatRules: "",
      automatedSenderPolicies: {
        "sender-a": { mode, ...(mode === "rollup" ? { rollupHours: 720 } : {}) },
      },
    });
  }
  await choose("Listening", "inherit");
  await click("Use default guidance");
  await choose("Synthetic sender", "default");
  await click("Save");
  expect(conversation).toMatchObject({
    teamChatAmbientEnabled: null,
    teamChatRules: null,
    automatedSenderPolicies: {},
  });
});
it("drops pending results and drafts on Space change and refreshes on re-entry", async () => {
  await render();
  await choose("External conversation", "conversation-a");
  await input("Room guidance", "Old draft");
  let resolve!: (value: unknown) => void;
  state.rpc.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await choose("Bot to link", "bot-a");
  await click("Link a chat app");
  await act(async () => {
    state.epoch++;
    state.spaceId = "space-b";
    for (const listener of state.listeners) listener();
  });
  await act(async () =>
    resolve({ code: "STALE-CODE", expiresAt: new Date(Date.now() + 600000).toISOString() }),
  );
  expect(host.textContent).not.toContain("STALE-CODE");
  expect(host.querySelector('input[aria-label="Room guidance"]')).toBeNull();
  state.focused = false;
  await render();
  state.focused = true;
  await render();
  await choose("External conversation", "conversation-a");
  expect((host.querySelector('input[aria-label="Room guidance"]') as HTMLInputElement).value).toBe(
    "Default guidance",
  );
});

it.each(["permission", "network"])(
  "recovers from a %s failure without replaying a mutation",
  async (kind) => {
    await render();
    state.rpc.mockRejectedValueOnce(new Error(kind));
    await click("Unlink");
    expect(host.textContent).toContain("Couldn't update messaging settings");
    await click("Retry");
    expect(host.textContent).not.toContain("Couldn't update messaging settings");
    expect(
      state.rpc.mock.calls.filter(([proc]) => proc === "messaging/identities/unlink"),
    ).toHaveLength(1);
    await click("Unlink");
    expect(host.textContent).toContain("No chat apps linked yet.");
  },
);

it("filters only the identity view by Space, including archived bots, while preserving owned cross-Space channel and opaque connection metadata", async () => {
  const original = state.rpc.getMockImplementation()!;
  const identities = [
    {
      id: "identity-a",
      botId: "bot-a",
      botName: "Bot A",
      provider: "synthetic",
      address: "address-in-a",
    },
    {
      id: "identity-archived",
      botId: "bot-archived",
      botName: "Archived A",
      provider: "synthetic",
      address: "address-archived-a",
    },
    {
      id: "identity-c",
      botId: "bot-c",
      botName: "Owned other Space",
      provider: "synthetic",
      address: "address-in-c",
    },
  ];
  state.rpc.mockImplementation(
    async (proc: string, body: Record<string, unknown>, options: unknown) => {
      if (proc === "messaging/status")
        return { enabled: true, providers: ["synthetic"], identities };
      if (proc === "bots/list")
        return state.spaceId === "space-a"
          ? [{ id: "bot-a", name: "Bot A", archivedAt: null }]
          : [{ id: "bot-c", name: "Owned other Space", archivedAt: null }];
      if (proc === "bots/listArchived")
        return state.spaceId === "space-a"
          ? [{ id: "bot-archived", name: "Archived A", archivedAt: "2026-01-01T00:00:00Z" }]
          : [];
      if (proc === "messaging/channels/list")
        return [
          {
            id: "membership-c",
            identityId: "identity-c",
            provider: "synthetic",
            name: "Owned cross-Space channel",
            status: "invited",
          },
        ];
      if (proc === "messaging/connections/list")
        return [
          {
            id: "connection-c",
            peerBotName: "agent",
            peerOwnerLabel: "owner",
            incoming: false,
            status: "pending",
            requestVersion: 3,
          },
        ];
      return original(proc, body, options);
    },
  );
  await render();
  expect(host.textContent).toContain("address-in-a");
  expect(host.textContent).toContain("address-archived-a");
  expect(host.textContent).not.toContain("address-in-c");
  expect(host.textContent).toContain("Owned cross-Space channel");
  const choices = [...host.querySelectorAll('select[aria-label="Bot to link"] option')].map(
    (option) => option.textContent,
  );
  expect(choices).toEqual(["Choose a bot…", "Bot A"]);
  await click("Approve");
  expect(state.rpc).toHaveBeenCalledWith(
    "messaging/channels/respond",
    { membershipId: "membership-c", accept: true },
    expect.anything(),
  );
  await click("Revoke");
  expect(state.rpc).toHaveBeenCalledWith(
    "messaging/connections/revoke",
    { connectionId: "connection-c", requestVersion: 3 },
    expect.anything(),
  );
  await act(async () => {
    state.epoch++;
    state.spaceId = "space-c";
    for (const listener of state.listeners) listener();
  });
  expect(host.textContent).toContain("address-in-c");
  expect(host.textContent).not.toContain("address-in-a");
  expect(host.textContent).not.toContain("address-archived-a");
});
