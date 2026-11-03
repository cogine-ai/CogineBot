// @vitest-environment jsdom
import type { McpServer } from "@rakazo/contracts";
import type { ChangeEventHandler, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { McpToolAccess } from "./McpToolAccess";

const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { mcp: { servers: { setTools: save } } } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FieldGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: { children: ReactNode; htmlFor: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Switch: ({
    id,
    checked,
    disabled,
    onCheckedChange,
  }: {
    id: string;
    checked: boolean;
    disabled: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
  Textarea: ({
    id,
    value,
    onChange,
  }: {
    id: string;
    value: string;
    onChange: ChangeEventHandler<HTMLTextAreaElement>;
  }) => <textarea id={id} value={value} onChange={onChange} />,
}));
const server = {
  id: "server",
  revision: 4,
  allowAllTools: false,
  allowedTools: [],
  verbatimResults: false,
} as unknown as McpServer;
const container = document.createElement("div");
const root = createRoot(container);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await act(async () => root.render(null));
  save.mockReset();
});
function button(name: string) {
  return [...container.querySelectorAll("button")].find((node) => node.textContent === name)!;
}
it("requires an explicit save and uses the reviewed server revision without old assignments", async () => {
  save.mockResolvedValue({ ...server, revision: 5, allowAllTools: true });
  const onSaved = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<McpToolAccess server={server} onSaved={onSaved} />));
  expect(save).not.toHaveBeenCalled();
  await act(async () => button("Tool access").click());
  expect(container.querySelector<HTMLInputElement>("#mcp-tools-server")?.checked).toBe(false);
  await act(async () => container.querySelector<HTMLInputElement>("#mcp-tools-server")?.click());
  await act(async () => button("Save tool access").click());
  expect(save).toHaveBeenCalledWith({
    id: "server",
    revision: 4,
    allowAllTools: true,
    allowedTools: [],
    verbatimResults: false,
  });
  expect(onSaved).toHaveBeenCalledOnce();
});
it("blocks saving when OAuth or another update changes the server revision", async () => {
  const onSaved = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<McpToolAccess server={server} onSaved={onSaved} />));
  await act(async () => button("Tool access").click());
  await act(async () =>
    root.render(<McpToolAccess server={{ ...server, revision: 5 }} onSaved={onSaved} />),
  );
  expect(button("Save tool access").disabled).toBe(true);
  await act(async () => button("Save tool access").click());
  expect(save).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Server changed");
});

it("echoes the saved whole-result preference and explicitly turns it off without widening tool access", async () => {
  const configured = { ...server, allowedTools: ["lookup"], verbatimResults: true };
  save.mockResolvedValue({ ...configured, revision: 5, verbatimResults: false });
  const onSaved = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<McpToolAccess server={configured} onSaved={onSaved} />));
  await act(async () => button("Tool access").click());
  const preference = container.querySelector<HTMLInputElement>("#mcp-verbatim-server")!;
  expect(preference.checked).toBe(true);
  await act(async () => preference.click());
  expect(save).not.toHaveBeenCalled();
  await act(async () => button("Save tool access").click());
  expect(save).toHaveBeenCalledWith({
    id: "server",
    revision: 4,
    allowAllTools: false,
    allowedTools: ["lookup"],
    verbatimResults: false,
  });
  expect(onSaved).toHaveBeenCalledOnce();
});

it("discards an unsaved whole-result draft when tool access is closed", async () => {
  const onSaved = vi.fn();
  await act(async () =>
    root.render(<McpToolAccess server={{ ...server, verbatimResults: true }} onSaved={onSaved} />),
  );
  await act(async () => button("Tool access").click());
  await act(async () => container.querySelector<HTMLInputElement>("#mcp-verbatim-server")?.click());
  expect(container.querySelector<HTMLInputElement>("#mcp-verbatim-server")?.checked).toBe(false);
  await act(async () => button("Tool access").click());
  expect(container.querySelector("#mcp-verbatim-server")).toBeNull();
  expect(save).not.toHaveBeenCalled();
  await act(async () => button("Tool access").click());
  expect(container.querySelector<HTMLInputElement>("#mcp-verbatim-server")?.checked).toBe(true);
  expect(onSaved).not.toHaveBeenCalled();
});

it("preserves the whole-result draft after a failed save and blocks it after a revision change", async () => {
  const configured = { ...server, verbatimResults: true };
  const onSaved = vi.fn();
  save.mockRejectedValue(new Error("Fixture save rejected"));
  await act(async () => root.render(<McpToolAccess server={configured} onSaved={onSaved} />));
  await act(async () => button("Tool access").click());
  await act(async () => container.querySelector<HTMLInputElement>("#mcp-verbatim-server")?.click());
  await act(async () => button("Save tool access").click());
  expect(container.querySelector<HTMLInputElement>("#mcp-verbatim-server")?.checked).toBe(false);
  expect(button("Save tool access").disabled).toBe(false);
  expect(container.textContent).toContain("Fixture save rejected");
  expect(onSaved).not.toHaveBeenCalled();
  await act(async () =>
    root.render(<McpToolAccess server={{ ...configured, revision: 5 }} onSaved={onSaved} />),
  );
  expect(button("Save tool access").disabled).toBe(true);
  await act(async () => button("Save tool access").click());
  expect(save).toHaveBeenCalledTimes(1);
});
