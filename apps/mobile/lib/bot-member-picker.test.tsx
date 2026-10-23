// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileBot } from "./api";

const nativeChanges = new Map<string, (value: boolean) => void>();
vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(value: T) => value },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
    editable = true,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    accessibilityLabel?: string;
    editable?: boolean;
  }) => (
    <input
      aria-label={accessibilityLabel}
      disabled={!editable}
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("./native", () => ({
  native: { fill: "fill" },
  useMobileTokens: () => ({
    foreground: "text",
    mutedForeground: "muted",
    border: "border",
    primary: "primary",
    primaryForeground: "background",
  }),
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (value: string, params?: Record<string, unknown>) =>
      value.replace(/\{(\w+)\}/g, (_, key) => String(params?.[key] ?? key)),
  }),
}));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => <span /> }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    disabled,
    value,
    onValueChange,
  }: {
    accessibilityLabel: string;
    disabled?: boolean;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => {
    nativeChanges.set(accessibilityLabel, onValueChange);
    return (
      <input
        type="checkbox"
        aria-label={accessibilityLabel}
        disabled={disabled}
        checked={value}
        onChange={() => onValueChange(!value)}
      />
    );
  },
}));

import { BotMemberPicker } from "../components/bot-member-picker";

const bots = [
  { id: "one", name: "Researcher", title: "Market analyst" },
  { id: "two", name: "Writer", title: "Editor" },
  { id: "three", name: "Planner", title: "Travel coordinator" },
].map((bot) => ({ ...bot, color: "blue", status: "idle", archivedAt: null }) as MobileBot);
let root: Root;
let container: HTMLDivElement;
function Harness({
  initiallyExpanded = false,
  disabled = false,
  choices = bots,
  initial = ["one", "two"],
  changed = () => undefined,
}: {
  initiallyExpanded?: boolean;
  disabled?: boolean;
  choices?: MobileBot[];
  initial?: string[];
  changed?: (value: string[]) => void;
}) {
  const [selected, setSelected] = useState(initial);
  return (
    <BotMemberPicker
      bots={choices}
      selected={selected}
      onChange={(value) => {
        changed(value);
        setSelected(value);
      }}
      disabled={disabled}
      initiallyExpanded={initiallyExpanded}
    />
  );
}
function button(name: string) {
  const found = [...container.querySelectorAll("button")].find((row) => row.textContent === name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function fill(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter bots"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  nativeChanges.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("starts with selected members and filters expanded names or titles case insensitively", async () => {
  await act(async () => root.render(<Harness />));
  expect(container.textContent).not.toContain("Planner");
  await click("Show all");
  await fill(" COORDINATOR ");
  expect(container.textContent).toContain("Planner");
  expect(container.textContent).not.toContain("Researcher");
  await fill("rEsEaRcH");
  expect(container.textContent).toContain("Researcher");
  expect(container.textContent).not.toContain("Planner");
});
it("keeps deselections visible when collapsed even with an active filter", async () => {
  const changed = vi.fn();
  await act(async () => root.render(<Harness changed={changed} />));
  await click("Show all");
  await act(async () => nativeChanges.get("Planner")?.(true));
  await act(async () => nativeChanges.get("Writer")?.(false));
  await fill("no match");
  await click("Show selected");
  expect(container.textContent).toContain("Writer");
  expect(container.textContent).toContain("Planner");
  await act(async () => nativeChanges.get("Writer")?.(true));
  expect(changed).toHaveBeenLastCalledWith(["one", "three", "two"]);
});
it("locks all controls and ignores a native callback while disabled", async () => {
  const changed = vi.fn();
  await act(async () => root.render(<Harness initiallyExpanded disabled changed={changed} />));
  expect(button("Show selected").disabled).toBe(true);
  expect(
    container.querySelector<HTMLInputElement>('input[aria-label="Filter bots"]')?.disabled,
  ).toBe(true);
  await act(async () => nativeChanges.get("Planner")?.(true));
  await act(async () => nativeChanges.get("Writer")?.(false));
  expect(changed).not.toHaveBeenCalled();
});
it("allows ten members and refuses an eleventh without blocking deselection", async () => {
  const choices = Array.from({ length: 11 }, (_, index) => ({
    ...bots[0]!,
    id: `bot-${index + 1}`,
    name: `Member ${index + 1}`,
  }));
  const changed = vi.fn();
  await act(async () =>
    root.render(
      <Harness
        initiallyExpanded
        choices={choices}
        initial={choices.slice(0, 9).map((bot) => bot.id)}
        changed={changed}
      />,
    ),
  );
  await act(async () => nativeChanges.get("Member 10")?.(true));
  expect(changed).toHaveBeenLastCalledWith([
    "bot-1",
    "bot-2",
    "bot-3",
    "bot-4",
    "bot-5",
    "bot-6",
    "bot-7",
    "bot-8",
    "bot-9",
    "bot-10",
  ]);
  await act(async () => nativeChanges.get("Member 11")?.(true));
  expect(changed).toHaveBeenCalledTimes(1);
  await act(async () => nativeChanges.get("Member 3")?.(false));
  expect(changed).toHaveBeenLastCalledWith([
    "bot-1",
    "bot-2",
    "bot-4",
    "bot-5",
    "bot-6",
    "bot-7",
    "bot-8",
    "bot-9",
    "bot-10",
  ]);
});
it("starts creation expanded and clears history when a new editor mounts", async () => {
  await act(async () => root.render(<Harness initiallyExpanded />));
  expect(container.querySelector('[aria-label="Filter bots"]')).not.toBeNull();
  await act(async () => nativeChanges.get("Planner")?.(true));
  await click("Show selected");
  await act(async () => root.render(<Harness key="next-session" />));
  expect(container.textContent).not.toContain("Planner");
});
