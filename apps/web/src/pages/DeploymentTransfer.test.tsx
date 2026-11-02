// @vitest-environment jsdom

import type { DeploymentTransferStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { candidate, deferred, plan, snapshot } from "../lib/deployment-transfer.test-helpers.js";

const api = vi.hoisted(() => ({
  selection: 1,
  selected: null as string | null,
  listeners: new Set<() => void>(),
  list: vi.fn(),
  preview: vi.fn(),
  status: vi.fn(),
  commit: vi.fn(),
  makeClient: vi.fn(),
  path: "",
  navigate: undefined as ((path: string) => void) | undefined,
  onLayout: undefined as ((path: string) => void) | undefined,
}));
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
  }: ComponentProps<"button"> & { checked: boolean; onCheckedChange(value: boolean): void }) => (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));
vi.mock("../components/ListboxSelect", () => ({
  ListboxSelect: ({
    label,
    value,
    options,
    onChange,
  }: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onChange(value: string): void;
  }) => (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../lib/rpc", () => ({
  currentRpcSessionGeneration: () => 1,
  currentSpaceSelectionGeneration: () => api.selection,
  selectedSpaceId: () => api.selected,
  subscribeSelectedSpace: (listener: () => void) => {
    api.listeners.add(listener);
    return () => api.listeners.delete(listener);
  },
  createSpaceRpc: (...args: unknown[]) => {
    api.makeClient(...args);
    return {
      bots: { list: api.list },
      transfer: { preview: api.preview, status: api.status, commit: api.commit },
    };
  },
}));
vi.mock("../lib/client-id", () => ({ newClientId: () => "request-one" }));

import { DeploymentTransferPage } from "./DeploymentTransfer";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const invitation = (locator = "a".repeat(43)) =>
  `/transfers/source?targetOrigin=https%3A%2F%2Ftarget.example.test&locator=${locator}`;
function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  api.path = location.pathname + location.search;
  api.navigate = (path) => navigate(path, { replace: true });
  useLayoutEffect(() => api.onLayout?.(api.path), [location]);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  api.selection = 1;
  api.selected = null;
  api.onLayout = undefined;
  window.history.replaceState({}, "", "/");
  host = document.createElement("div");
  root = createRoot(host);
  api.list.mockResolvedValue([{ id: "source-bot", name: "Source research" }]);
  api.preview.mockResolvedValue(snapshot());
  api.status.mockResolvedValue(snapshot());
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
async function renderAt(path: string) {
  window.history.replaceState({}, "", path);
  await act(async () =>
    root.render(
      <BrowserRouter useTransitions={false}>
        <DeploymentTransferPage />
        <Probe />
      </BrowserRouter>,
    ),
  );
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find((entry) => entry.textContent === label)!;
}
async function chooseSource() {
  const select = host.querySelector("select")!;
  await act(async () => {
    select.value = "source-bot";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("keeps the same controller across the pre-dispatch history replacement and successful source id", async () => {
  const reply = deferred<DeploymentTransferStatus>();
  api.preview.mockReturnValue(reply.promise);
  await renderAt(invitation());
  expect(api.preview).not.toHaveBeenCalled();
  await chooseSource();
  await act(async () => button("Review credentials").click());
  expect(window.location.pathname).toBe("/transfers/source/request/request-one");
  expect(api.path).toBe(invitation());
  expect(api.makeClient).toHaveBeenCalledTimes(1);
  expect(api.preview.mock.calls[0]![1].signal.aborted).toBe(false);
  await act(async () => reply.resolve(snapshot()));
  expect(api.path).toBe(`/transfers/source/${"a".repeat(43)}`);
  expect(api.makeClient).toHaveBeenCalledTimes(1);
  expect(api.status).not.toHaveBeenCalled();
  expect(host.textContent).toContain(candidate.name);
});
it("restores a pending address with status only and keeps a null result uncertain", async () => {
  api.status.mockResolvedValue(null);
  await renderAt("/transfers/receive/request/original-nonce");
  expect(api.status).toHaveBeenCalledWith(
    { clientNonce: "original-nonce", side: "target" },
    expect.any(Object),
  );
  expect(host.textContent).toContain("No receipt yet.");
  expect(api.preview).not.toHaveBeenCalled();
  expect(api.commit).not.toHaveBeenCalled();
  await act(async () => button("Check status").click());
  expect(api.status).toHaveBeenCalledTimes(2);
});
it("restores a known source intent after login clears ambient Space without starting copy", async () => {
  api.status.mockResolvedValue(
    snapshot({
      phase: "ready",
      plan,
      planDigest: "d".repeat(64),
      commitNonce: "original-batch",
      canCommit: true,
    }),
  );
  await renderAt(`/transfers/source/${"a".repeat(43)}`);
  expect(api.makeClient.mock.calls[0]![0]).toBeNull();
  expect(api.status).toHaveBeenCalledWith({ transferId: "a".repeat(43) }, expect.any(Object));
  expect(button("Copy approved credentials")).toBeDefined();
  expect(api.commit).not.toHaveBeenCalled();
  expect(api.preview).not.toHaveBeenCalled();
});
it("invalidates an old writer when the owner opens a genuinely different invitation", async () => {
  const reply = deferred<DeploymentTransferStatus>();
  api.preview.mockReturnValue(reply.promise);
  await renderAt(invitation());
  await chooseSource();
  await act(async () => button("Review credentials").click());
  const signal = api.preview.mock.calls[0]![1].signal as AbortSignal;
  await act(async () => api.navigate!(invitation("b".repeat(43))));
  expect(signal.aborted).toBe(true);
  expect(api.makeClient).toHaveBeenCalledTimes(2);
  await act(async () => reply.resolve(snapshot()));
  expect(api.path).toBe(invitation("b".repeat(43)));
  expect(host.textContent).not.toContain(candidate.name);
  expect(api.preview).toHaveBeenCalledTimes(1);
});

it("invalidates an in-flight existing intent before passive effects when another receipt opens", async () => {
  const a = "a".repeat(43);
  const b = "b".repeat(43);
  const oldReply = deferred<DeploymentTransferStatus>();
  const newReply = deferred<DeploymentTransferStatus>();
  api.status.mockImplementation((input) =>
    input.transferId === a ? oldReply.promise : newReply.promise,
  );
  await renderAt(`/transfers/source/${a}`);
  const isOldCurrent = api.makeClient.mock.calls[0]![1] as () => boolean;
  expect(isOldCurrent()).toBe(true);
  let checkedBeforePassive = false;
  api.onLayout = (path) => {
    if (path === `/transfers/source/${b}`) {
      checkedBeforePassive = true;
      expect(isOldCurrent()).toBe(false);
      expect(host.textContent).not.toContain(candidate.name);
    }
  };
  await act(async () => api.navigate!(`/transfers/source/${b}`));
  expect(checkedBeforePassive).toBe(true);
  await act(async () => oldReply.resolve(snapshot()));
  expect(api.path).toBe(`/transfers/source/${b}`);
  expect(host.textContent).not.toContain(candidate.name);
  await act(async () => newReply.resolve(snapshot({ transferId: b, candidates: [] })));
  expect(api.path).toBe(`/transfers/source/${b}`);
});
