// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act, createContext, useContext, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => {
  const Open = createContext(false);
  return {
    BotAvatar: () => <span />,
    cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Popover: ({ open, children }: { open: boolean; children: ReactNode }) => (
      <Open.Provider value={open}>{children}</Open.Provider>
    ),
    PopoverTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    PopoverContent: ({ children }: { children: ReactNode }) =>
      useContext(Open) ? <div>{children}</div> : null,
  };
});

import { ChatRecipients } from "./chat-recipients";

const bots = [
  { id: "one", name: "Researcher", title: "Market analyst" },
  { id: "two", name: "Writer", title: "Travel coordinator" },
].map((bot) => ({ ...bot, archivedAt: null, color: "blue", status: "idle" }) as Bot);
let root: Root;
let container: HTMLDivElement;
function Harness({ disabled = false, initial = [] }: { disabled?: boolean; initial?: string[] }) {
  const [selected, setSelected] = useState(initial);
  return (
    <ChatRecipients
      bots={bots}
      selectedBotIds={selected}
      onSelectedBotIdsChange={setSelected}
      disabled={disabled}
    />
  );
}
async function render(node: ReactNode) {
  await act(async () => root.render(node));
}
async function fill(value: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("finds a recipient by case-insensitive name or title without changing first-message selection", async () => {
  await render(<Harness />);
  await fill("  COORDINATOR  ");
  const options = [...container.querySelectorAll('[role="option"]')];
  expect(options.map((row) => row.textContent)).toEqual(["Writer"]);
  await act(async () => (options[0] as HTMLButtonElement).click());
  expect(container.querySelector('[data-testid="recipient-chip-two"]')).not.toBeNull();
  await fill("rEsEaRcH");
  expect([...container.querySelectorAll('[role="option"]')].map((row) => row.textContent)).toEqual([
    "Researcher",
  ]);
});
it("preserves selected chips and blocks every recipient change while saving", async () => {
  await render(<Harness disabled initial={["one", "two"]} />);
  expect(container.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
  const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove Writer"]')!;
  expect(remove.disabled).toBe(true);
  await act(async () => remove.click());
  expect(container.querySelector('[data-testid="recipient-chip-two"]')).not.toBeNull();
});
