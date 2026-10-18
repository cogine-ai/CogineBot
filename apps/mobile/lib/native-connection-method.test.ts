import type { NativeConfigStatus } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { nativeConnectionMethodLabel } from "./native-connection-method";

const base: NativeConfigStatus = {
  id: "fixture",
  appId: "slack",
  label: "Company application",
  ownership: "byo",
  credentialKind: "oauth",
  enabled: true,
  configured: true,
  revision: 1,
  callbackUri: "https://instance.example.test/callback",
  executionLocation: "instance",
};
const t = (message: string) => message;
it.each([
  ["slack", "bot", "Bot"],
  ["slack", "user", "User"],
  ["linear", "app", "Application"],
  ["linear", "user", "User"],
] as const)("same-name %s OAuth method keeps the %s actor visible", (appId, actor, label) => {
  expect(nativeConnectionMethodLabel({ ...base, appId, actor }, appId, t)).toBe(
    `Your application · Company application · Account authorization · ${label}`,
  );
});
it("same-name OAuth actors produce different labels", () => {
  expect(nativeConnectionMethodLabel({ ...base, actor: "bot" }, "slack", t)).not.toBe(
    nativeConnectionMethodLabel({ ...base, actor: "user" }, "slack", t),
  );
  expect(
    nativeConnectionMethodLabel({ ...base, appId: "linear", actor: "app" }, "linear", t),
  ).not.toBe(nativeConnectionMethodLabel({ ...base, appId: "linear", actor: "user" }, "linear", t));
});
