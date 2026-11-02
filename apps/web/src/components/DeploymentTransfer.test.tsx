// @vitest-environment jsdom

import type { DeploymentTransfer, DeploymentTransferState } from "@rakazo/core";
import { initialDeploymentTransferState } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  candidate,
  copied,
  deferred,
  plan,
  snapshot,
  sourceIdentity,
  targetScope,
} from "../lib/deployment-transfer.test-helpers.js";
import { DeploymentTransferReview, DeploymentTransferTools } from "./DeploymentTransfer";

const tools = vi.hoisted(() => ({ start: vi.fn(), status: vi.fn(), makeClient: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  currentRpcSessionGeneration: () => 1,
  currentSpaceSelectionGeneration: () => 1,
  createSpaceRpc: (...args: unknown[]) => {
    tools.makeClient(...args);
    return { transfer: { start: tools.start, status: tools.status } };
  },
}));
vi.mock("../lib/client-id", () => ({ newClientId: () => "request-one" }));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      Array.isArray(parts)
        ? parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "")
        : (parts as { message: string }).message,
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<ComponentProps<"button">, "onChange"> & {
    checked: boolean;
    onCheckedChange(checked: boolean): void;
  }) => (
    <button
      {...props}
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const manager = {
  select: vi.fn(),
  propose: vi.fn(),
  decide: vi.fn(),
  previewTarget: vi.fn(),
  approve: vi.fn(),
  confirmCopy: vi.fn(),
  checkStatus: vi.fn(),
  cancel: vi.fn(),
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/app");
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
async function render(patch: Partial<DeploymentTransferState>) {
  await act(async () =>
    root.render(
      <DeploymentTransferReview
        state={{ ...initialDeploymentTransferState, ...patch }}
        manager={manager as unknown as DeploymentTransfer}
      />,
    ),
  );
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find((entry) => entry.textContent === label)!;
}
it("keeps existing targets and blocks approval until changed decisions are reviewed again", async () => {
  const value = snapshot({
    side: "target",
    phase: "previewed",
    localScope: targetScope,
    plan,
    planDigest: "d".repeat(64),
    canApprove: true,
  });
  await render({ snapshot: value, decisions: { [candidate.itemKey]: "keep" } });
  const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await act(async () => toggle.click());
  expect(manager.decide).toHaveBeenCalledWith(candidate.itemKey, "overwrite");
  await render({ snapshot: value, decisions: { [candidate.itemKey]: "overwrite" }, dirty: true });
  expect(button("Approve this transfer").disabled).toBe(true);
  await act(async () => button("Update review").click());
  expect(manager.previewTarget).toHaveBeenCalledTimes(1);
});
it("shows both exact deployment identities and never renders protected login fields", async () => {
  const protectedAuth = {
    type: "login",
    username: "PLANTED_LOGIN",
    password: "PLANTED_PASSWORD",
  } as never;
  await render({
    snapshot: snapshot({
      phase: "ready",
      planDigest: "d".repeat(64),
      canCommit: true,
      plan: {
        ...plan,
        items: [{ ...plan.items[0]!, source: { ...candidate, auth: protectedAuth } }],
      },
    }),
  });
  expect(host.textContent).toContain("b".repeat(64));
  expect(host.textContent).toContain("c".repeat(64));
  expect(host.textContent).toContain("Source owner");
  expect(host.textContent).toContain("Target owner");
  expect(host.innerHTML).not.toContain("PLANTED_");
  expect(manager.confirmCopy).not.toHaveBeenCalled();
  await act(async () => button("Copy approved credentials").click());
  expect(manager.confirmCopy).toHaveBeenCalledTimes(1);
});
it("renders only a bounded reason for retained protected resources", async () => {
  await render({
    snapshot: snapshot({
      side: "target",
      phase: "previewed",
      localScope: targetScope,
      plan: {
        ...plan,
        items: [{ ...plan.items[0]!, canOverwrite: false, reason: "source_resource_shared" }],
      },
    }),
  });
  expect(host.textContent).toContain("Target retained to protect the source.");
  expect(host.querySelector('[role="switch"]')).toBeNull();
});
it("locks uncertain writes and offers a status read instead of another copy", async () => {
  await render({
    snapshot: snapshot({ phase: "ready", plan, planDigest: "d".repeat(64), canCommit: true }),
    request: "unknown",
    recovery: { transferId: "a".repeat(43) },
    error: "unavailable",
  });
  expect(host.querySelector("h2")?.textContent).toBe("Status not confirmed");
  expect(button("Copy approved credentials").disabled).toBe(true);
  await act(async () => button("Check status").click());
  expect(manager.checkStatus).toHaveBeenCalledTimes(1);
  expect(manager.confirmCopy).not.toHaveBeenCalled();
});
it("stops only unsent items after a separate confirmation and retains accepted receipts", async () => {
  await render({ snapshot: snapshot({ phase: "partial", items: [copied] }) });
  await act(async () => button("Stop transfer").click());
  expect(host.textContent).toContain("Received items stay at the target.");
  await act(async () => button("Stop unsent items").click());
  expect(manager.cancel).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain(`${copied.name} · Copied`);
});
it("keeps expired results readable without another write control", async () => {
  await render({ snapshot: snapshot({ phase: "expired", items: [copied] }) });
  expect(host.textContent).toContain("Expired");
  expect(host.textContent).toContain("Copied");
  expect(button("Copy approved credentials")).toBeUndefined();
  expect(button("Check status")).toBeDefined();
});

it("offers an explicit stop retry while a cancelled receipt still has an unknown item", async () => {
  await render({
    snapshot: snapshot({
      phase: "cancelled",
      items: [copied, { ...copied, itemKey: "uncertain", status: "unknown" }],
    }),
  });
  await act(async () => button("Retry stopping").click());
  await act(async () => button("Stop unsent items").click());
  expect(manager.cancel).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain(`${copied.name} · Copied`);
});

it("invalidates an open stop confirmation when the receipt changes", async () => {
  await render({ snapshot: snapshot({ phase: "partial", items: [copied] }) });
  await act(async () => button("Stop transfer").click());
  const staleConfirm = button("Stop unsent items");
  await render({
    snapshot: snapshot({ transferId: "b".repeat(43), phase: "partial", items: [copied] }),
  });
  expect(button("Stop unsent items")).toBeUndefined();
  await act(async () => staleConfirm.click());
  expect(manager.cancel).not.toHaveBeenCalled();
  await act(async () => button("Stop transfer").click());
  await act(async () => button("Stop unsent items").click());
  expect(manager.cancel).toHaveBeenCalledTimes(1);
});
it.each(["modified", "removed"] as const)(
  "keeps copied history and reports the target as %s",
  async (targetState) => {
    await render({
      snapshot: snapshot({ phase: "completed", items: [{ ...copied, targetState }] }),
    });
    expect(host.textContent).toContain(`${copied.name} · Copied`);
    expect(host.textContent).toContain(
      targetState === "modified" ? "Changed at target" : "Removed at target",
    );
    expect(host.textContent).not.toContain("Target status not confirmed");
  },
);
it("separates restored write revocation and copied history from an unconfirmed current target", async () => {
  await render({
    snapshot: snapshot({ phase: "expired", writeRevokedReason: "restore", items: [copied] }),
  });
  expect(host.textContent).toContain(
    "Write authorization expired. Existing results can still be checked.",
  );
  expect(host.textContent).toContain(`${copied.name} · Copied`);
  expect(host.textContent).toContain("Target status not confirmed");
  expect(host.textContent).not.toContain("Changed at target");
  expect(button("Copy approved credentials")).toBeUndefined();
});

it("allows a distinct explicit cleanup of expired unknown items without resuming copy", async () => {
  const items = [copied, { ...copied, itemKey: "pending-cleanup", status: "unknown" as const }];
  await render({ snapshot: snapshot({ phase: "expired", items }) });
  expect(button("Copy approved credentials")).toBeUndefined();
  await act(async () => button("Retry stopping").click());
  await act(async () => button("Stop unsent items").click());
  expect(manager.cancel).toHaveBeenCalledTimes(1);
  await render({ snapshot: snapshot({ phase: "expired", writeRevokedReason: "restore", items }) });
  expect(button("Retry stopping")).toBeUndefined();
});

let navigate: ReturnType<typeof useNavigate>;
let path = "";
function NavigationProbe() {
  navigate = useNavigate();
  path = useLocation().pathname;
  return null;
}
const currentScope = () => true;
async function renderTools(spaceId = targetScope.spaceId, isCurrent = currentScope) {
  await act(async () =>
    root.render(
      <BrowserRouter>
        <NavigationProbe />
        <DeploymentTransferTools
          botId={targetScope.botId}
          spaceId={spaceId}
          isCurrent={isCurrent}
        />
      </BrowserRouter>,
    ),
  );
}
async function startReceiver() {
  await act(async () => button("Receive passwords and API keys").click());
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      sourceIdentity.origin,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(button("Create receiver").disabled).toBe(false);
  await act(async () => button("Create receiver").click());
}
const received = () => snapshot({ side: "target", phase: "created", localScope: targetScope });

it.each([false, true])(
  "retains a pending receiver across pathname changes (navigation ABA: %s)",
  async (aba) => {
    const pending = deferred<ReturnType<typeof snapshot>>();
    tools.start.mockReturnValueOnce(pending.promise);
    await renderTools();
    await startReceiver();
    const signal = tools.start.mock.calls[0]![1].signal as AbortSignal;
    const previousNavigate = navigate;
    await act(async () => navigate("/app/another"));
    expect(navigate).not.toBe(previousNavigate);
    if (aba) await act(async () => navigate("/app"));
    expect(tools.makeClient).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    await act(async () => pending.resolve(received()));
    expect(host.textContent).toContain("Waiting for the source");
    expect(path).toBe(`/transfers/receive/${"a".repeat(43)}`);
    expect(tools.start).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
  },
);

it.each(["space", "authority"])("disposes an old receiver through a real %s ABA", async (kind) => {
  const pending = deferred<ReturnType<typeof snapshot>>();
  tools.start.mockReturnValueOnce(pending.promise);
  await renderTools();
  await startReceiver();
  const signal = tools.start.mock.calls[0]![1].signal as AbortSignal;
  if (kind === "space") await renderTools("other-space");
  else await renderTools(targetScope.spaceId, () => false);
  await renderTools();
  expect(signal.aborted).toBe(true);
  const before = path;
  await act(async () => pending.resolve(received()));
  expect(host.textContent).not.toContain("Waiting for the source");
  expect(path).toBe(before);
  expect(tools.start).toHaveBeenCalledTimes(1);
});

it("aborts an outstanding status read when closed and opens a fresh receiver without a late navigation", async () => {
  tools.start.mockResolvedValueOnce(received());
  await renderTools();
  await startReceiver();
  const pending = deferred<ReturnType<typeof snapshot>>();
  tools.status.mockReturnValueOnce(pending.promise);
  await act(async () => button("Check status").click());
  const signal = tools.status.mock.calls[0]![1].signal as AbortSignal;
  await act(async () => button("Receive passwords and API keys").click());
  expect(signal.aborted).toBe(true);
  const before = path;
  await act(async () => pending.resolve(received()));
  expect(path).toBe(before);
  expect(host.querySelector("input")).toBeNull();
  await act(async () => button("Receive passwords and API keys").click());
  expect(tools.makeClient).toHaveBeenCalledTimes(2);
  expect(host.querySelector("input")).not.toBeNull();
  expect(host.textContent).not.toContain("Waiting for the source");
});
