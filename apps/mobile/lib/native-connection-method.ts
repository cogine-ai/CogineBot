import type { NativeAppId, NativeConfigStatus } from "@rakazo/contracts";

/** Short account-source label; actors remain visible even when sources share a name. */
export function nativeConnectionMethodLabel(
  entry: NativeConfigStatus,
  appId: NativeAppId,
  t: (message: string) => string,
): string {
  const kind =
    entry.credentialKind === "machine_key"
      ? t("Machine API key")
      : entry.credentialKind === "internal_token"
        ? t("Internal integration")
        : entry.credentialKind === "personal_token"
          ? appId === "linear"
            ? t("Personal API key")
            : appId === "slack"
              ? t("User token")
              : t("Personal access token")
          : entry.credentialKind === "bot_token"
            ? t("Bot token")
            : entry.credentialKind === "github_app_installation"
              ? t("GitHub App installation")
              : t("Account authorization");
  const actor =
    entry.credentialKind === "oauth" && entry.actor
      ? entry.actor === "bot"
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
