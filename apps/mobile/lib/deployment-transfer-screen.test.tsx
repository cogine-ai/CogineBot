// @vitest-environment jsdom

import type { DeploymentTransferStatus, DeploymentTransferStatusInput } from "@rakazo/contracts";
import { deploymentTransferStatusPath } from "@rakazo/core";
import type { EffectCallback, ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copied, deferred, snapshot, targetScope } from "./deployment-transfer.test-helpers.js";

const api = vi.hoisted(() => ({
  request: vi.fn(),
  open: vi.fn(),
  alert: vi.fn(),
  generation: 1,
  current: true,
  focused: true,
  listeners: new Set<() => void>(),
}));
vi.mock("./deployment-transfer-client", () => ({
  mobileDeploymentTransferClient: async (_scope: unknown, isMounted: () => boolean) => {
    const generation = api.generation;
    const isCurrent = () => isMounted() && api.current && generation === api.generation;
    return {
      isCurrent,
      request: api.request,
      pageUrl: (
        value: DeploymentTransferStatus | null,
        recovery: DeploymentTransferStatusInput | null,
      ) => {
        const side = value?.side ?? (recovery && "side" in recovery ? recovery.side : null);
        const input = value ? { transferId: value.transferId } : recovery;
        return side && input
          ? `https://target.example.test${deploymentTransferStatusPath(side, input)}`
          : null;
      },
    };
  },
}));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({
    apiBase: "https://target.example.test",
    apiGeneration: api.generation,
    sessionGeneration: api.generation,
    spaceId: "target-space",
    spaceGeneration: api.generation,
    selectionSeq: api.generation,
  }),
  mobileScopeKey: () => String(api.generation),
  subscribeMobileScope: (listener: () => void) => {
    api.listeners.add(listener);
    return () => api.listeners.delete(listener);
  },
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: EffectCallback) =>
    useEffect(() => (api.focused ? callback() : undefined), [callback, api.focused]),
}));
vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement("div", { "data-testid": testID }, children),
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
    createElement("span", { role: accessibilityRole }, children),
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText(value: string): void;
    accessibilityLabel: string;
  }) =>
    createElement("input", {
      value,
      "aria-label": accessibilityLabel,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
  StyleSheet: { create: <T,>(value: T) => value },
  Linking: { openURL: api.open },
  Alert: { alert: api.alert },
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress(): void;
  }) => createElement("button", { type: "button", disabled, onClick: onPress }, label),
}));
vi.mock("./native", () => ({ native: {} }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

import { NativeDeploymentTransferTools } from "../components/deployment-transfer-tools";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const created = () =>
  snapshot({ side: "target", phase: "created", localScope: targetScope, source: null });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  api.current = true;
  api.focused = true;
  api.generation = 1;
  host = document.createElement("div");
  root = createRoot(host);
  api.open.mockResolvedValue(undefined);
  api.request.mockImplementation(async (method) => (method === "transfer/recent" ? [] : created()));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<NativeDeploymentTransferTools botId="target-bot" />));
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find((entry) => entry.textContent === label)!;
}
async function start() {
  await render();
  await act(async () => button("Receive passwords and API keys").click());
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "https://source.example.test",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Create receiver").click());
}
it("creates only metadata and continues pairing in a protected browser page", async () => {
  await start();
  await act(async () => button("Continue in browser").click());
  expect(api.open).toHaveBeenCalledExactlyOnceWith(
    `https://target.example.test/transfers/receive/${"a".repeat(43)}`,
  );
  expect(api.request.mock.calls.map(([method]) => method)).toEqual(["transfer/start"]);
  expect(button("Copy approved credentials")).toBeUndefined();
  expect(button("Approve this transfer")).toBeUndefined();
});
it("keeps an unknown initial receipt on status reads without another create", async () => {
  api.request.mockImplementation(async (method) => {
    if (method === "transfer/start") throw new Error("lost reply");
    return null;
  });
  await start();
  await act(async () => button("Check status").click());
  expect(host.textContent).toContain("No receipt yet.");
  expect(button("Create receiver")).toBeUndefined();
  expect(api.request.mock.calls.filter(([method]) => method === "transfer/start")).toHaveLength(1);
});
it("restores the same pending intent after blur without another write", async () => {
  const reply = deferred<DeploymentTransferStatus>();
  api.request.mockImplementation(async (method) =>
    method === "transfer/start" ? reply.promise : created(),
  );
  await start();
  await act(async () => {
    api.focused = false;
    root.render(<NativeDeploymentTransferTools botId="target-bot" />);
  });
  reply.resolve(created());
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    api.focused = true;
    root.render(<NativeDeploymentTransferTools botId="target-bot" />);
  });
  expect(api.request.mock.calls.filter(([method]) => method === "transfer/start")).toHaveLength(1);
  expect(api.request.mock.calls.filter(([method]) => method === "transfer/status")).toHaveLength(1);
});
it("drops a late response across an origin/session/Space ABA", async () => {
  const reply = deferred<DeploymentTransferStatus>();
  api.request.mockReturnValue(reply.promise);
  await start();
  await act(async () => {
    api.generation += 2;
    for (const listener of api.listeners) listener();
  });
  reply.resolve({
    ...created(),
    target: { ...created().target, origin: "https://late.example.test" },
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(host.textContent).not.toContain("late.example.test");
  expect(api.open).not.toHaveBeenCalled();
});
it("rejects a protected field before it can enter the native screen", async () => {
  api.request.mockResolvedValue({ ...created(), token: "PLANTED_PRIVATE_TOKEN" });
  await start();
  expect(host.innerHTML).not.toContain("PLANTED_PRIVATE_TOKEN");
  expect(host.textContent).toContain("Check status");
});
it("keeps accepted items visible in an expired read-only receipt", async () => {
  const expired = snapshot({
    side: "target",
    phase: "expired",
    localScope: targetScope,
    items: [copied],
  });
  api.request.mockImplementation(async (method) => {
    if (method === "transfer/recent") {
      const { transferId, side, phase, revision, expiresAt, localScope, source, target } = expired;
      return [{ transferId, side, phase, revision, expiresAt, localScope, source, target }];
    }
    return expired;
  });
  await render();
  await act(async () => button("Receive passwords and API keys").click());
  await act(async () => button("Recent transfers").click());
  await act(async () => button(expired.source!.origin).click());
  expect(host.textContent).toContain("Expired");
  expect(host.textContent).toContain("Copied");
  expect(button("Stop transfer")).toBeUndefined();
  expect(button("Copy approved credentials")).toBeUndefined();
  expect(api.request.mock.calls.some(([method]) => method === "transfer/commit")).toBe(false);
});

it("does not let a confirmation opened for one receipt cancel a newly selected receipt", async () => {
  const a = created();
  const b = {
    ...created(),
    transferId: "b".repeat(43),
    source: { ...snapshot().source!, origin: "https://another.example.test" },
  };
  api.request.mockImplementation(async (method, input) => {
    if (method === "transfer/recent") {
      const { transferId, side, phase, revision, expiresAt, localScope, source, target } = b;
      return [{ transferId, side, phase, revision, expiresAt, localScope, source, target }];
    }
    if (method === "transfer/status" && input.transferId === b.transferId) return b;
    return a;
  });
  await start();
  await act(async () => button("Stop transfer").click());
  const oldConfirm = api.alert.mock.calls[0]![2][1].onPress;
  await act(async () => button("Recent transfers").click());
  await act(async () => button(b.source!.origin).click());
  await act(async () => oldConfirm());
  expect(api.request.mock.calls.some(([method]) => method === "transfer/cancel")).toBe(false);
  await act(async () => button("Stop transfer").click());
  await act(async () => api.alert.mock.calls[1]![2][1].onPress());
  expect(api.request.mock.calls.filter(([method]) => method === "transfer/cancel")).toHaveLength(1);
  expect(
    api.request.mock.calls.find(([method]) => method === "transfer/cancel")![1].transferId,
  ).toBe(b.transferId);
});
it("offers explicit cleanup retry for unknown stopped items without another copy", async () => {
  api.request.mockResolvedValue(
    snapshot({
      side: "target",
      phase: "cancelled",
      localScope: targetScope,
      items: [copied, { ...copied, itemKey: "pending-cleanup", status: "unknown" }],
    }),
  );
  await start();
  await act(async () => button("Retry stopping").click());
  await act(async () => api.alert.mock.calls[0]![2][1].onPress());
  expect(api.request.mock.calls.filter(([method]) => method === "transfer/cancel")).toHaveLength(1);
  expect(api.request.mock.calls.some(([method]) => method === "transfer/commit")).toBe(false);
  expect(host.textContent).toContain(`${copied.name} · Copied`);
});
it.each(["modified", "removed", undefined] as const)(
  "keeps copied history with current target observation %s",
  async (targetState) => {
    api.request.mockResolvedValue(
      snapshot({
        side: "target",
        phase: "expired",
        localScope: targetScope,
        writeRevokedReason: "restore",
        items: [{ ...copied, ...(targetState ? { targetState } : {}) }],
      }),
    );
    await start();
    expect(host.textContent).toContain(`${copied.name} · Copied`);
    expect(host.textContent).toContain(
      "Write authorization expired. Existing results can still be checked.",
    );
    expect(host.textContent).toContain(
      targetState === "modified"
        ? "Changed at target"
        : targetState === "removed"
          ? "Removed at target"
          : "Target status not confirmed",
    );
    expect(button("Stop transfer")).toBeUndefined();
  },
);

it("allows explicit cleanup of expired unknown items while keeping restore revocation read-only", async () => {
  const items = [copied, { ...copied, itemKey: "pending-cleanup", status: "unknown" as const }];
  api.request.mockResolvedValue(
    snapshot({ side: "target", phase: "expired", localScope: targetScope, items }),
  );
  await start();
  await act(async () => button("Retry stopping").click());
  await act(async () => api.alert.mock.calls[0]![2][1].onPress());
  expect(api.request.mock.calls.filter(([method]) => method === "transfer/cancel")).toHaveLength(1);
  api.request.mockResolvedValue(
    snapshot({
      side: "target",
      phase: "expired",
      localScope: targetScope,
      writeRevokedReason: "restore",
      revision: 3,
      items,
    }),
  );
  await act(async () => button("Check status").click());
  expect(button("Retry stopping")).toBeUndefined();
  expect(api.request.mock.calls.some(([method]) => method === "transfer/commit")).toBe(false);
});
