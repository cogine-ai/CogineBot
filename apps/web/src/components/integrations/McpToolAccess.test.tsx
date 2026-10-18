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
  expect(container.querySelector<HTMLInputElement>("input")?.checked).toBe(false);
  await act(async () => container.querySelector<HTMLInputElement>("input")?.click());
  await act(async () => button("Save tool access").click());
  expect(save).toHaveBeenCalledWith({
    id: "server",
    revision: 4,
    allowAllTools: true,
    allowedTools: [],
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
