import type { NativeAppId, NativeConfigStatus } from "@rakazo/contracts";
import { NATIVE_REMAINING_APPLICATIONS } from "@rakazo/contracts";

/** Short account-source label; actors remain visible even when sources share a name. */
export function nativeConnectionMethodLabel(
  entry: NativeConfigStatus,
  appId: NativeAppId,
  t: (message: string) => string,
): string {
  const kind =
    entry.credentialKind === "machine_key"
      ? ["feishu-lark", "dingtalk", "wecom"].includes(appId)
        ? t("App credentials")
        : t("Machine API key")
      : entry.credentialKind === "internal_token"
        ? t("Internal integration")
        : entry.credentialKind === "personal_token"
          ? appId === "linear"
            ? t("Personal API key")
            : appId === "slack"
              ? t("User token")
              : appId === "hubspot"
                ? t("Private app token")
                : t("Personal access token")
          : entry.credentialKind === "bot_token"
            ? t("Bot token")
            : entry.credentialKind === "github_app_installation"
              ? t("GitHub App installation")
              : t("Account authorization");
  const actor = entry.actor
    ? entry.actor === "installation"
      ? t("App installation")
      : entry.actor === "bot"
        ? t("Bot")
        : entry.actor === "app"
          ? t("Application")
          : t("User")
    : undefined;
  return [
    entry.ownership === "official" ? t("Official application") : t("Your application"),
    entry.label,
    kind,
    actor,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function nativeApplicationName(appId: NativeAppId): string {
  const old: Partial<Record<NativeAppId, string>> = {
    coginex: "CogineX",
    knowai: "Knowai",
    "google-calendar": "Google Calendar",
    gmail: "Gmail",
    "google-drive": "Google Drive",
    "google-docs": "Google Docs",
    "google-sheets": "Google Sheets",
    "google-slides": "Google Slides",
    "google-tasks": "Google Tasks",
    notion: "Notion",
    github: "GitHub",
    linear: "Linear",
    slack: "Slack",
  };
  return old[appId] ?? NATIVE_REMAINING_APPLICATIONS.find((app) => app.id === appId)?.name ?? appId;
}
export function nativeCredentialLabel(
  appId: NativeAppId,
  kind: NativeConfigStatus["credentialKind"] | undefined,
  t: (message: string) => string,
): string {
  if (kind === "machine_key") return t("Machine API key");
  if (kind === "internal_token") return t("Internal integration token");
  if (kind === "bot_token")
    return appId === "telegram-bot"
      ? t("Telegram bot token")
      : appId === "discord"
        ? t("Discord bot token")
        : t("Slack bot token");
  if (appId === "linear") return t("Linear API key");
  if (appId === "slack") return t("Slack user token");
  if (appId === "hubspot") return t("HubSpot private app token");
  return t("Personal access token");
}
