// @vitest-environment jsdom

import { PAGE_TITLE_MAX_LENGTH } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement, Fragment } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTextEditDialog } from "../components/profile-edit-dialog";

type Action = { text: string; style?: string; onPress?: (value?: string) => void };
type Submit = { nativeEvent: { text: string } };
const native = vi.hoisted(() => ({
  platform: { OS: "ios" },
  ownerCurrent: true,
  prompt:
    vi.fn<
      (
        label: string,
        error: string | undefined,
        actions: Action[],
        style: string,
        draft: string,
      ) => void
    >(),
  change: (_value: string) => {},
  submit: (_event: Submit) => {},
}));

vi.mock("react-native", () => ({
  Alert: { prompt: native.prompt },
  Platform: native.platform,
  Modal: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children, accessibilityRole }: { children: ReactNode; accessibilityRole?: string }) =>
    createElement("p", { role: accessibilityRole }, children),
  TextInput: ({
    value,
    maxLength,
    onChangeText,
    onSubmitEditing,
  }: {
    value: string;
    maxLength: number;
    onChangeText: (value: string) => void;
    onSubmitEditing: (event: Submit) => void;
  }) => {
    native.change = onChangeText;
    native.submit = onSubmitEditing;
    return createElement("input", { value, maxLength, readOnly: true });
  },
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (message: string, values?: { count: number }) =>
      values ? message.replace("{count}", String(values.count)) : message,
  }),
}));
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));

const onCommit = vi.fn();
function Probe() {
  const edit = useTextEditDialog("Rename", PAGE_TITLE_MAX_LENGTH, () => native.ownerCurrent);
  return createElement(
    Fragment,
    null,
    createElement(
      "button",
      { type: "button", onClick: () => edit.ask("Original title", onCommit) },
      "Open",
    ),
    edit.dialog,
  );
}

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onCommit.mockClear();
  native.prompt.mockClear();
  native.platform.OS = "ios";
  native.ownerCurrent = true;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  act(() => button!.click());
}
function open() {
  act(() => root.render(createElement(Probe)));
  click("Open");
}
function prompt() {
  const [label, error, actions, style, draft] = native.prompt.mock.calls.at(-1)!;
  return { label, error, actions, style, draft };
}
function saveAction() {
  return prompt().actions.find((action) => action.text === "Save")!.onPress!;
}
function save(value?: string) {
  act(() => saveAction()(value));
}

it("accepts the exact normalized limit on iOS with surrounding whitespace and an intact emoji", () => {
  open();
  expect(prompt()).toMatchObject({ label: "Rename", style: "plain-text", draft: "Original title" });
  const title = `${"a".repeat(PAGE_TITLE_MAX_LENGTH - 2)}😀`;
  save(`  \t${title}\n  `);
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(title);
  expect(native.prompt).toHaveBeenCalledOnce();
});

it("shows the limit and keeps the full draft after an overlength iOS save", () => {
  open();
  const stale = saveAction();
  const draft = `${"a".repeat(PAGE_TITLE_MAX_LENGTH - 1)}😀`;
  save(draft);
  expect(onCommit).not.toHaveBeenCalled();
  expect(prompt()).toMatchObject({
    error: `Use ${PAGE_TITLE_MAX_LENGTH} characters or fewer`,
    draft,
  });
  act(() => stale(draft));
  expect(native.prompt).toHaveBeenCalledTimes(2);
  const corrected = saveAction();
  act(() => {
    corrected("  New\t\n name  ");
    corrected("Another name");
  });
  expect(onCommit).toHaveBeenCalledExactlyOnceWith("New name");
});

it.each([
  { draft: "  \u0000\u2029\t", error: "Enter a name" },
  { draft: "Broken \ud800", error: "Use a valid name" },
])("shows $error and lets the user cancel without committing", ({ draft, error }) => {
  open();
  save(draft);
  expect(prompt()).toMatchObject({ error, draft });
  const cancel = prompt().actions.find((action) => action.text === "Cancel");
  const canceledSave = saveAction();
  expect(cancel?.style).toBe("cancel");
  act(() => {
    cancel?.onPress?.();
    canceledSave("Would rename");
  });
  expect(onCommit).not.toHaveBeenCalled();
  expect(native.prompt).toHaveBeenCalledTimes(2);
});

it("does not treat a missing iOS callback value as a rename", () => {
  open();
  save();
  expect(onCommit).not.toHaveBeenCalled();
});

it.each(["scope change", "unmount", "replacement"])(
  "ignores an old native callback after %s",
  (boundary) => {
    open();
    const stale = saveAction();
    if (boundary === "scope change") native.ownerCurrent = false;
    else if (boundary === "unmount") act(() => root.render(null));
    else click("Open");
    act(() => {
      stale("  ");
      stale("Would rename");
    });
    expect(native.prompt).toHaveBeenCalledTimes(boundary === "replacement" ? 2 : 1);
    expect(onCommit).not.toHaveBeenCalled();
  },
);

it("keeps the Android dialog open for validation and clears the error on edit", () => {
  native.platform.OS = "android";
  open();
  expect(container.querySelector("input")?.maxLength).toBe(PAGE_TITLE_MAX_LENGTH);
  act(() => native.change("  "));
  click("Save");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Enter a name");
  expect(onCommit).not.toHaveBeenCalled();
  act(() => native.change("  New\t name  "));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  const submit = native.submit;
  act(() => {
    submit({ nativeEvent: { text: "  New\t name  " } });
    submit({ nativeEvent: { text: "Another name" } });
  });
  expect(onCommit).toHaveBeenCalledExactlyOnceWith("New name");
  expect(container.querySelector("input")).toBeNull();
  expect(native.prompt).not.toHaveBeenCalled();
});

it("uses the Android IME's current text before a batched edit renders", () => {
  native.platform.OS = "android";
  open();
  act(() => {
    native.change("  ");
    native.submit({ nativeEvent: { text: "  " } });
  });
  expect(container.querySelector("input")?.value).toBe("  ");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Enter a name");
  expect(onCommit).not.toHaveBeenCalled();
  act(() => {
    native.change("  Latest name  ");
    native.submit({ nativeEvent: { text: "  Latest name  " } });
  });
  expect(onCommit).toHaveBeenCalledExactlyOnceWith("Latest name");
});
