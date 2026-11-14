// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RoutineRunTime } from "../components/routine-run-time";
import { activateUiLocale, resetI18nForTests } from "./i18n";
import { UI_LOCALES } from "./ui-locale";

type PickerProps = {
  mode?: string;
  locale?: string;
  value: Date;
  onValueChange: (event: unknown, date: Date) => void;
  onDismiss: () => void;
};
const state = vi.hoisted(() => ({ os: "android", props: {} as PickerProps }));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return state.os;
    },
  },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@expo/ui/community/datetime-picker", () => ({
  default: (props: PickerProps) => {
    state.props = props;
    return <div data-testid="picker" />;
  },
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
let container: HTMLDivElement;
let root: Root;
const change = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.os = "android";
  resetI18nForTests();
  change.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("requires Android date then time confirmation before changing the instant", async () => {
  await act(async () =>
    root.render(<RoutineRunTime value="" onChange={change} disabled={false} />),
  );
  await act(async () => container.querySelector("button")!.click());
  expect(state.props.mode).toBe("date");
  // The locked Expo Android picker does not support a locale override.
  expect(state.props.locale).toBeUndefined();
  const day = new Date("2099-03-04T12:00:00Z");
  await act(async () => state.props.onValueChange({}, day));
  expect(state.props.mode).toBe("time");
  expect(state.props.value).toEqual(day);
  expect(change).not.toHaveBeenCalled();
  const instant = new Date("2099-03-04T14:30:00Z");
  await act(async () => state.props.onValueChange({}, instant));
  expect(change).toHaveBeenCalledWith(instant.toISOString());
  expect(container.querySelector('[data-testid="picker"]')).toBeNull();
});
it("canceling the Android time dialog does not arm the date", async () => {
  await act(async () =>
    root.render(<RoutineRunTime value="" onChange={change} disabled={false} />),
  );
  await act(async () => container.querySelector("button")!.click());
  await act(async () => state.props.onValueChange({}, new Date("2099-03-04T12:00:00Z")));
  await act(async () => state.props.onDismiss());
  expect(change).not.toHaveBeenCalled();
});
it("commits the iOS date and time only on Done", async () => {
  state.os = "ios";
  await act(async () =>
    root.render(<RoutineRunTime value="" onChange={change} disabled={false} />),
  );
  await act(async () => container.querySelector("button")!.click());
  expect(state.props.mode).toBe("datetime");
  const instant = new Date("2099-03-04T14:30:00Z");
  await act(async () => state.props.onValueChange({}, instant));
  expect(change).not.toHaveBeenCalled();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Done")!
      .click(),
  );
  expect(change).toHaveBeenCalledWith(instant.toISOString());
});

it.each(UI_LOCALES)(
  "passes %s into the open iOS picker and responds to language changes",
  async (locale) => {
    state.os = "ios";
    const instant = "2099-03-04T14:30:00.000Z";
    await act(async () =>
      root.render(<RoutineRunTime value={instant} onChange={change} disabled={false} />),
    );
    await act(async () => container.querySelector("button")!.click());
    await act(async () => {
      activateUiLocale(locale);
    });
    expect(state.props.locale).toBe(locale);
    expect(state.props.value.toISOString()).toBe(instant);
    expect(state.props.mode).toBe("datetime");
    expect(change).not.toHaveBeenCalled();
  },
);
