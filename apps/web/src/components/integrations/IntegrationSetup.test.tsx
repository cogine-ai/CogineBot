// @vitest-environment jsdom
import type { InputHTMLAttributes, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  setTools: vi.fn(),
  oauth: vi.fn(),
  search: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: { mcp: { servers: api }, capabilities: { catalogSearch: api.search } },
}));
vi.mock("../../lib/mcp-connect", () => ({ connectMcpOauth: api.oauth }));
vi.mock("./NativeApplicationSetup", () => ({ NativeApplicationSetup: () => null }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: "submit" | "button";
  }) => (
    <button type={type ?? "button"} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));

import { IntegrationSetup } from "./IntegrationSetup";

let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  api.list.mockResolvedValue([
    { id: "server", endpoint: "https://tools.example.test/mcp", revision: 3 },
  ]);
  api.search.mockResolvedValue({
    results: [
      { name: "Fixture", surfaces: [{ kind: "mcp", source: "https://tools.example.test/mcp" }] },
    ],
  });
  api.setTools.mockResolvedValue({});
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
});
async function fill(label: string, value: string) {
  await act(async () => {
    const input = node.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it.each(["cancelled", "disconnect_required", "unknown_future_result"])(
  "does not share tools or claim connection for %s",
  async (result) => {
    api.oauth.mockResolvedValue(result);
    const connected = vi.fn();
    await act(async () => root.render(<IntegrationSetup onServerConnected={connected} />));
    await fill("Search apps", "fixture");
    await act(async () =>
      node
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await act(async () => node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () =>
      [...node.querySelectorAll("button")].find((b) => b.textContent === "Connect")!.click(),
    );
    expect(api.oauth).toHaveBeenCalledWith("server");
    expect(api.setTools).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
    expect([...node.querySelectorAll("button")].some((b) => b.textContent === "Connected")).toBe(
      false,
    );
  },
);
it.each(["connected", "already_connected", "authorization_not_requested"])(
  "shares only after a successful %s result",
  async (result) => {
    api.oauth.mockResolvedValue(result);
    const connected = vi.fn();
    await act(async () => root.render(<IntegrationSetup onServerConnected={connected} />));
    await fill("Server URL", "https://tools.example.test/mcp");
    await act(async () => node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () =>
      [...node.querySelectorAll("button")].find((b) => b.textContent === "Connect")!.click(),
    );
    expect(api.setTools).toHaveBeenCalledWith({
      id: "server",
      revision: 3,
      allowAllTools: true,
      allowedTools: [],
    });
    expect(connected).toHaveBeenCalledWith("server");
  },
);

it("does not share or claim a connection when authorization fails", async () => {
  api.oauth.mockRejectedValue(new Error("Synthetic authorization failure"));
  const connected = vi.fn();
  await act(async () => root.render(<IntegrationSetup onServerConnected={connected} />));
  await fill("Server URL", "https://tools.example.test/mcp");
  await act(async () => node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () =>
    [...node.querySelectorAll("button")]
      .find((button) => button.textContent === "Connect")!
      .click(),
  );
  expect(api.setTools).not.toHaveBeenCalled();
  expect(connected).not.toHaveBeenCalled();
  expect(node.querySelector('[role="alert"]')).not.toBeNull();
});
