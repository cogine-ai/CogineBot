// @vitest-environment jsdom
import type { ChangeEventHandler, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { mcp: { servers: api } } }));
vi.mock("../lib/mcp-connect", () => ({ MCP_OAUTH_CHANNEL: "fixture", connectMcpOauth: vi.fn() }));
vi.mock("../components/integrations/McpToolAccess", () => ({ McpToolAccess: () => null }));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));
vi.mock("@rakazo/ui-web", async () => {
  const { createElement } = await import("react");
  const container = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    ...Object.fromEntries(
      [
        "Badge",
        "Card",
        "CardContent",
        "CardHeader",
        "CardTitle",
        "Dialog",
        "DialogClose",
        "DialogContent",
        "DialogHeader",
        "DialogTitle",
        "Field",
        "FieldGroup",
        "Tabs",
        "TabsList",
        "TabsTrigger",
      ].map((name) => [name, container]),
    ),
    FieldLabel: ({ children, htmlFor }: { children: ReactNode; htmlFor: string }) =>
      createElement("label", { htmlFor }, children),
    Button: ({
      children,
      onClick,
      disabled,
    }: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) => createElement("button", { type: "button", onClick, disabled }, children),
    Input: ({
      id,
      type,
      value,
      onChange,
    }: {
      id?: string;
      type?: string;
      value?: string;
      onChange?: ChangeEventHandler<HTMLInputElement>;
    }) => createElement("input", { id, type, value, onChange }),
    Switch: ({
      id,
      checked,
      disabled,
      onCheckedChange,
    }: {
      id: string;
      checked: boolean;
      disabled?: boolean;
      onCheckedChange: (value: boolean) => void;
    }) =>
      createElement("input", {
        id,
        type: "checkbox",
        checked,
        disabled,
        onChange: (event: { target: HTMLInputElement }) => onCheckedChange(event.target.checked),
      }),
  };
});

import { McpServersOverlay } from "./McpServersOverlay";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  api.list.mockReset().mockResolvedValue([]);
  api.create.mockReset().mockResolvedValue({ id: "fixture-server" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      close() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<McpServersOverlay onClose={() => {}} />));
}
async function fill(id: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`#${id}`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function add() {
  const button = [...host.querySelectorAll("button")].find(
    (node) => node.textContent === "Add server",
  )!;
  await act(async () => button.click());
}
async function configure() {
  await fill("mcp-name", "Fixture docs");
  await fill("mcp-endpoint", "https://mcp.example.test/mcp");
}

it("starts whole results off and sends the explicit default when adding a server", async () => {
  await render();
  expect(host.querySelector<HTMLInputElement>("#mcp-verbatim-results")?.checked).toBe(false);
  await configure();
  await add();
  expect(api.create).toHaveBeenCalledWith(
    expect.objectContaining({
      slug: "fixture-docs",
      transport: "streamable_http",
      verbatimResults: false,
    }),
  );
});

it("adds an opted-in server then resets the next server's whole-result draft", async () => {
  await render();
  await configure();
  await act(async () => host.querySelector<HTMLInputElement>("#mcp-verbatim-results")?.click());
  expect(api.create).not.toHaveBeenCalled();
  await add();
  expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ verbatimResults: true }));
  expect(host.querySelector<HTMLInputElement>("#mcp-verbatim-results")?.checked).toBe(false);
  expect(host.querySelector<HTMLInputElement>("#mcp-name")?.value).toBe("");
});

it("keeps a failed whole-result creation draft for correction", async () => {
  api.create.mockRejectedValue(new Error("Fixture save rejected"));
  await render();
  await configure();
  await act(async () => host.querySelector<HTMLInputElement>("#mcp-verbatim-results")?.click());
  await add();
  expect(host.textContent).toContain("Fixture save rejected");
  expect(host.querySelector<HTMLInputElement>("#mcp-verbatim-results")?.checked).toBe(true);
  expect(host.querySelector<HTMLInputElement>("#mcp-name")?.value).toBe("Fixture docs");
});

it("does not save an abandoned creation draft and reopens with whole results off", async () => {
  await render();
  await configure();
  await act(async () => host.querySelector<HTMLInputElement>("#mcp-verbatim-results")?.click());
  await act(async () => root.render(null));
  expect(api.create).not.toHaveBeenCalled();
  await render();
  expect(host.querySelector<HTMLInputElement>("#mcp-verbatim-results")?.checked).toBe(false);
});
