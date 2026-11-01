// @vitest-environment jsdom
import type { PluginInstallReceipt, PluginPreview } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  preview: vi.fn(),
  install: vi.fn(),
  list: vi.fn(),
  uninstall: vi.fn(),
  space: "space-a",
  generation: 1,
  session: 1,
  listeners: new Set<() => void>(),
}));
vi.mock("../../lib/rpc", () => ({
  createSpaceRpc: () => ({
    plugins: {
      preview: api.preview,
      install: api.install,
      list: api.list,
      uninstall: api.uninstall,
    },
  }),
  currentRpcSessionGeneration: () => api.session,
  currentSpaceSelectionGeneration: () => api.generation,
  selectedSpaceId: () => api.space,
  isRpcRecoveryScopeCurrent: (scope: {
    spaceId: string;
    sessionGeneration: number;
    selectionGeneration: number;
  }) =>
    scope.spaceId === api.space &&
    scope.sessionGeneration === api.session &&
    scope.selectionGeneration === api.generation,
  subscribeSelectedSpace: (listener: () => void) => {
    api.listeners.add(listener);
    return () => api.listeners.delete(listener);
  },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + (index ? values[index - 1] : "") + part, ""),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

import { PluginInstallsPanel } from "./PluginInstallsPanel";

const preview: PluginPreview = {
  source: `https://github.com/example/plugin/tree/${"a".repeat(40)}`,
  sourceSha: "a".repeat(40),
  digest: `sha256:${"b".repeat(64)}`,
  format: "agent-plugins",
  name: "Research plugin",
  description: "Synthetic instructions",
  version: null,
  skills: [
    {
      name: "research",
      description: "Find material",
      content: "---\nname: research\n---\n<script>do not execute</script>\nFull instructions",
    },
  ],
  mcpServers: [
    {
      name: "Research service",
      transport: "streamable_http",
      endpoint: "https://service.example.test/mcp",
      headerKeys: ["Authorization"],
    },
  ],
  skipped: [
    { kind: "mcp_stdio", name: "Local command", reason: "Local commands are not imported" },
  ],
};
const receipt: PluginInstallReceipt = {
  id: "install-one",
  clientNonce: "",
  source: preview.source,
  sourceSha: preview.sourceSha,
  digest: preview.digest,
  name: preview.name,
  status: "installed",
  revision: 1,
  installedAt: "2026-11-01T00:00:00.000Z",
  skills: [{ id: "skill-one", name: "research" }],
  mcpServers: [
    {
      id: "mcp-one",
      name: "Research service",
      endpoint: preview.mcpServers[0]!.endpoint,
      transport: "streamable_http",
    },
  ],
};
let root: Root;
let node: HTMLDivElement;
beforeEach(async () => {
  vi.clearAllMocks();
  api.space = "space-a";
  api.generation = 1;
  api.session = 1;
  api.listeners.clear();
  api.preview.mockResolvedValue(preview);
  api.list.mockResolvedValue([]);
  api.install.mockImplementation(async (input: { clientNonce: string }) => ({
    ...receipt,
    clientNonce: input.clientNonce,
  }));
  api.uninstall.mockResolvedValue({
    ...receipt,
    clientNonce: "nonce-installed",
    status: "removed",
    revision: 3,
  });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => {
    root.render(<PluginInstallsPanel ownerKey="owner-a" spaceId="space-a" onClose={() => {}} />);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});
function button(label: string) {
  const found = Array.from(node.querySelectorAll("button")).find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
async function input(value: string) {
  await act(async () => {
    const field = node.querySelector("input")!;
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

it("shows complete plain-text instructions, actual endpoint and skipped components before installation", async () => {
  await openPreview();
  expect(node.textContent).toContain("https://service.example.test/mcp");
  expect(node.textContent).toContain("Local commands are not imported");
  const instructions = node.querySelector("pre")!;
  expect(instructions.textContent).toBe(preview.skills[0]?.content);
  expect(node.querySelector("script")).toBeNull();
  expect(api.install).not.toHaveBeenCalled();
  await click("Install plugin");
  expect(api.install).toHaveBeenCalledWith(
    expect.objectContaining({
      source: preview.source,
      sourceSha: preview.sourceSha,
      digest: preview.digest,
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(node.textContent).toContain("Installed");
});

it("requires an explicit status check after a lost install reply and keeps its request nonce", async () => {
  api.install.mockRejectedValueOnce(new Error("reply lost"));
  await openPreview();
  await click("Install plugin");
  expect(node.textContent).toContain("Could not confirm installation.");
  expect(
    Array.from(node.querySelectorAll("button")).some((item) => item.textContent === "Retry"),
  ).toBe(false);
  await click("Check status");
  await click("Retry");
  expect(api.install.mock.calls[0]?.[0]).toEqual(api.install.mock.calls[1]?.[0]);
});

it("keeps one mutation for same-tick double clicks", async () => {
  let resolve!: (value: PluginInstallReceipt) => void;
  api.install.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await openPreview();
  const installButton = button("Install plugin");
  await act(async () => {
    installButton.click();
    installButton.click();
  });
  expect(api.install).toHaveBeenCalledTimes(1);
  const submitted = api.install.mock.calls[0]?.[0] as { clientNonce: string };
  await act(async () => resolve({ ...receipt, clientNonce: submitted.clientNonce }));
});

it("does not reset the draft on an unrelated parent rerender", async () => {
  await input("https://github.com/example/draft");
  await act(async () =>
    root.render(<PluginInstallsPanel ownerKey="owner-a" spaceId="space-a" onClose={() => {}} />),
  );
  expect(node.querySelector("input")!.value).toBe("https://github.com/example/draft");
});

it("aborts a late preview across Space A to B to A and preserves the new draft", async () => {
  let resolve!: (value: PluginPreview) => void;
  api.preview.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await input("https://github.com/example/old");
  await click("Preview");
  const options = api.preview.mock.calls[0]?.[1] as { signal: AbortSignal };
  await act(async () => {
    api.space = "space-b";
    api.generation += 1;
    root.render(<PluginInstallsPanel ownerKey="owner-a" spaceId="space-b" onClose={() => {}} />);
  });
  await act(async () => {
    api.space = "space-a";
    api.generation += 1;
    root.render(<PluginInstallsPanel ownerKey="owner-a" spaceId="space-a" onClose={() => {}} />);
  });
  await input("https://github.com/example/new");
  await act(async () => resolve(preview));
  expect(options.signal.aborted).toBe(true);
  expect(node.querySelector("input")!.value).toBe("https://github.com/example/new");
  expect(node.querySelector('[data-testid="plugin-preview"]')).toBeNull();
});

it("does not adopt a late install receipt after the account changes", async () => {
  let resolve!: (value: PluginInstallReceipt) => void;
  api.install.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await openPreview();
  await click("Install plugin");
  const submitted = api.install.mock.calls[0]?.[0] as { clientNonce: string };
  await act(async () => {
    api.session += 1;
    root.render(<PluginInstallsPanel ownerKey="owner-b" spaceId="space-a" onClose={() => {}} />);
  });
  await act(async () => resolve({ ...receipt, clientNonce: submitted.clientNonce }));
  expect(node.textContent).toContain("No plugins installed");
  expect(node.querySelector('[data-testid="plugin-preview"]')).toBeNull();
});

it("confirms removal and retries failed cleanup using the latest receipt", async () => {
  const installed = { ...receipt, clientNonce: "nonce-installed" };
  api.list.mockResolvedValue([installed]);
  await click("Refresh");
  await click("Remove plugin");
  expect(api.uninstall).not.toHaveBeenCalled();
  api.uninstall.mockResolvedValueOnce({ ...installed, status: "cleanup_failed", revision: 3 });
  await click("Confirm removal");
  expect(node.textContent).toContain("Cleanup incomplete");
  api.uninstall.mockResolvedValueOnce({ ...installed, status: "removed", revision: 5 });
  await click("Retry cleanup");
  expect(api.uninstall.mock.calls[1]?.[0]).toEqual({
    installId: installed.id,
    expectedRevision: 3,
  });
  expect(node.textContent).toContain("No plugins installed");
});

it("keeps durable installation in progress check-only and renders a failed outcome without claiming success", async () => {
  let pending: PluginInstallReceipt | null = null;
  api.install.mockImplementation(async (value: { clientNonce: string }) => {
    pending = {
      ...receipt,
      clientNonce: value.clientNonce,
      status: "installing",
      installedAt: null,
    };
    return pending;
  });
  api.list.mockImplementation(async () => (pending ? [pending] : []));
  await openPreview();
  await click("Install plugin");
  expect(node.textContent).toContain("Installation pending.");
  expect(
    Array.from(node.querySelectorAll("button")).some((item) => item.textContent === "Retry"),
  ).toBe(false);
  expect(
    Array.from(node.querySelectorAll("span")).some((item) => item.textContent === "Installed"),
  ).toBe(false);
  pending = { ...pending!, status: "failed", revision: 2 };
  await click("Check status");
  expect(node.textContent).toContain("Installation failed.");
  expect(api.install).toHaveBeenCalledTimes(1);
  await click("Preview again");
  expect(button("Install plugin")).toBeDefined();
});

it("never uses another plugin's pending confirmation when retrying cleanup", async () => {
  const first = { ...receipt, clientNonce: "first-nonce" };
  const second = {
    ...receipt,
    id: "install-two",
    name: "Second plugin",
    clientNonce: "second-nonce",
    status: "cleanup_failed",
    revision: 3,
  };
  api.list.mockResolvedValue([first, second]);
  api.uninstall.mockResolvedValue({ ...second, status: "removed", revision: 5 });
  await click("Refresh");
  await click("Remove plugin");
  await click("Retry cleanup");
  expect(api.uninstall).toHaveBeenCalledWith(
    { installId: "install-two", expectedRevision: 3 },
    expect.anything(),
  );
});

it("explicitly confirms cleanup of a persisted pending receipt after reopening", async () => {
  const pending = {
    ...receipt,
    clientNonce: "nonce-installed",
    status: "installing",
    installedAt: null,
  };
  api.list.mockResolvedValue([pending]);
  api.uninstall.mockResolvedValue({ ...pending, status: "removed", revision: 3 });
  await click("Refresh");
  expect(node.textContent).toContain("Installation pending.");
  await click("Remove plugin");
  expect(api.uninstall).not.toHaveBeenCalled();
  await click("Confirm removal");
  expect(api.uninstall).toHaveBeenCalledWith(
    { installId: pending.id, expectedRevision: 1 },
    expect.anything(),
  );
  expect(node.textContent).toContain("No plugins installed");
  expect(api.install).not.toHaveBeenCalled();
});

it("settles the current pending review after confirmed cleanup without replaying installation", async () => {
  let pending: PluginInstallReceipt | null = null;
  api.install.mockImplementation(async (value: { clientNonce: string }) => {
    pending = {
      ...receipt,
      clientNonce: value.clientNonce,
      status: "installing",
      installedAt: null,
    };
    return pending;
  });
  api.uninstall.mockImplementation(async () => ({ ...pending!, status: "removed", revision: 3 }));
  await openPreview();
  await click("Install plugin");
  await click("Remove plugin");
  await click("Confirm removal");
  expect(node.textContent).toContain("This installation was removed.");
  expect(node.textContent).not.toContain("Installation pending.");
  expect(api.install).toHaveBeenCalledTimes(1);
  expect(api.uninstall).toHaveBeenCalledTimes(1);
});

it("disables unrelated cleanup while an installation acknowledgement is unknown", async () => {
  const pending = { ...receipt, clientNonce: "old-nonce", status: "installing", installedAt: null };
  api.list.mockResolvedValue([pending]);
  await click("Refresh");
  expect(button("Remove plugin").disabled).toBe(false);
  api.install.mockRejectedValueOnce(new Error("reply lost"));
  await openPreview();
  await click("Install plugin");
  expect(button("Remove plugin").disabled).toBe(true);
  await click("Remove plugin");
  expect(api.uninstall).not.toHaveBeenCalled();
  await click("Check status");
  expect(button("Remove plugin").disabled).toBe(true);
  expect(api.uninstall).not.toHaveBeenCalled();
});
