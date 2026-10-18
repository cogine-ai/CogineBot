import type { NativeConfigStatus } from "@rakazo/contracts";
import { expect, it } from "vitest";
import {
  nativeApplicationName,
  nativeConnectionMethodLabel,
  nativeCredentialLabel,
} from "./native-connection-method";

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

it.each([
  ["telegram-bot", "Telegram bot token"],
  ["discord", "Discord bot token"],
] as const)("%s uses its own token label", (appId, label) => {
  expect(nativeCredentialLabel(appId, "bot_token", t)).toBe(label);
  expect(nativeCredentialLabel(appId, "bot_token", t)).not.toContain("Slack");
});
it("HubSpot static application identity is visible and is not called a personal credential", () => {
  const label = nativeConnectionMethodLabel(
    { ...base, appId: "hubspot", credentialKind: "personal_token", actor: "app" },
    "hubspot",
    t,
  );
  expect(label).toContain("Private app token");
  expect(label).toContain("Application");
  expect(label).not.toContain("Personal access token");
});
it("all 37 application names are available in mobile account connection", async () => {
  const { NativeAppIdSchema } = await import("@rakazo/contracts");
  expect(NativeAppIdSchema.options).toHaveLength(37);
  for (const app of NativeAppIdSchema.options) expect(nativeApplicationName(app)).toBeTruthy();
  expect(nativeApplicationName("outlook-mail")).toBe("Outlook Mail");
  expect(nativeApplicationName("feishu-lark")).toBe("飞书 / Lark");
});
