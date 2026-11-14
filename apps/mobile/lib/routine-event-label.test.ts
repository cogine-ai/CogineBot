import { NATIVE_ROUTINE_EVENT_KINDS } from "@rakazo/core/routine-native-events";
import { afterEach, expect, it } from "vitest";
import { resetI18nForTests } from "./i18n";
import { routineEventLabel } from "./routine-event-label";
import { errorText } from "./user-error";

afterEach(() => resetI18nForTests("en"));
it.each(["zh-CN", "de", "ru"] as const)("translates every dynamic event label in %s", (locale) => {
  resetI18nForTests("en");
  const english = NATIVE_ROUTINE_EVENT_KINDS.map(routineEventLabel);
  resetI18nForTests(locale);
  NATIVE_ROUTINE_EVENT_KINDS.forEach((kind, index) => {
    expect(routineEventLabel(kind)).not.toBe(english[index]);
    expect(routineEventLabel(kind)).not.toBe(kind);
  });
});

it.each(["zh-CN", "de", "ru"] as const)("translates conflicting save recovery in %s", (locale) => {
  const error = new Error("Save intent changed. Restore the previous save and retry.");
  resetI18nForTests("en");
  const english = errorText(error);
  resetI18nForTests(locale);
  expect(errorText(error)).not.toBe(english);
  expect(errorText(error)).not.toBe(error.message);
});
