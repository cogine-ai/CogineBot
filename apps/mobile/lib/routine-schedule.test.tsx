// @vitest-environment jsdom

import type { CronPreset } from "@rakazo/core";
import { cronFromPreset, defaultCronPreset } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RoutineSchedule } from "../components/routine-schedule";
import { activateUiLocale, resetI18nForTests } from "./i18n";
import { UI_LOCALES } from "./ui-locale";

type MenuProps = {
  value: string;
  choices: { key: string; label: string }[];
  onChange: (key: string) => void;
};
const state = vi.hoisted(() => ({ menus: new Map<string, MenuProps>() }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TextInput: () => null,
}));
vi.mock("./native", () => ({ native: {} }));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: (props: MenuProps) => {
    state.menus.set(props.value, props);
    return null;
  },
}));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetI18nForTests();
  state.menus.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each(UI_LOCALES)(
  "localizes menu labels in %s without changing selection keys or cron",
  async (locale) => {
    const value = { ...defaultCronPreset(), time: "12:15 AM" };
    const onChange = vi.fn();
    await act(async () =>
      root.render(<RoutineSchedule value={value} onChange={onChange} disabled={false} />),
    );
    await act(async () => {
      activateUiLocale(locale);
    });
    const menu = state.menus.get(value.time)!;
    const clocks = [
      ["6:00 AM", 6, 0],
      ["7:00 AM", 7, 0],
      ["8:00 AM", 8, 0],
      ["9:00 AM", 9, 0],
      ["12:00 PM", 12, 0],
      ["3:00 PM", 15, 0],
      ["6:00 PM", 18, 0],
      ["9:00 PM", 21, 0],
      ["12:15 AM", 0, 15],
    ] as const;
    expect(menu.value).toBe(value.time);
    expect(menu.choices.map((choice) => choice.key)).toEqual(clocks.map(([key]) => key));
    for (const [key, hour, minute] of clocks) {
      expect(menu.choices.find((choice) => choice.key === key)?.label).toBe(
        new Intl.DateTimeFormat(locale, {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "UTC",
        }).format(new Date(Date.UTC(2000, 0, 1, hour, minute))),
      );
      menu.onChange(key);
      const changed = onChange.mock.lastCall![0] as CronPreset;
      expect(changed).toEqual({ ...value, time: key });
      expect(cronFromPreset(changed)).toBe(`${minute} ${hour} * * *`);
    }
  },
);
