import type { NativeRoutineEventSpec } from "@rakazo/contracts";

const google = (values: string[]) =>
  values.map((scope) => `https://www.googleapis.com/auth/${scope}`);
/** One authorization predicate for enrollment and every subsequent source request. */
export function nativeEventReadPermitted(
  spec: NativeRoutineEventSpec,
  scopes: readonly string[],
  capabilities: readonly string[],
  principal: Record<string, unknown>,
): boolean {
  const any = (values: readonly string[]) => values.some((scope) => scopes.includes(scope));
  switch (spec.kind) {
    case "sharepoint.list_item.changed":
      return any(["Sites.Read.All", "Sites.ReadWrite.All", "Sites.Selected"]);
    case "excel.range.changed":
      return any(["Files.ReadWrite"]);
    case "planner.task.changed":
      return any(["Tasks.Read", "Tasks.ReadWrite", "Group.Read.All", "Group.ReadWrite.All"]);
    case "teams.channel_message.created":
      return any(["ChannelMessage.Read.All"]) && any(["Channel.ReadBasic.All"]);
    case "feishu.calendar_event.changed":
    case "dingtalk.calendar_event.changed":
    case "wecom.schedule.changed": {
      const provider = spec.kind.startsWith("feishu.") ? "feishu-lark" : spec.kind.split(".")[0];
      if (
        principal.provider !== provider ||
        !["app", "user"].includes(String(principal.actorType)) ||
        !["oauth", "machine_key"].includes(String(principal.credentialType)) ||
        typeof principal.tenantId !== "string" ||
        !principal.tenantId ||
        typeof principal.appId !== "string" ||
        !principal.appId
      )
        return false;
      if (spec.kind === "wecom.schedule.changed" && principal.actorType !== "app") return false;
      if (spec.kind === "feishu.calendar_event.changed") {
        if (!["feishu", "lark"].includes(String(principal.region))) return false;
        const accepted = ["calendar:calendar:readonly", "calendar:calendar"];
        const configured = principal.configuredScopes;
        return principal.actorType === "user"
          ? any(accepted)
          : Array.isArray(configured) && accepted.some((scope) => configured.includes(scope));
      }
      return true;
    }
    case "telegram.pinned_message.changed":
    case "discord.channel_message.created":
    case "discord.command.invoked":
      return (
        principal.actorType === "bot" &&
        principal.credentialType === "bot_token" &&
        principal.scopeAuthority === "provider_enforced" &&
        typeof principal.boundSpaceId === "string" &&
        capabilities.includes(spec.kind === "discord.command.invoked" ? "commands" : "read")
      );
  }
  if (spec.kind.startsWith("calendar."))
    return any(
      google(["calendar.events.readonly", "calendar.events", "calendar.readonly", "calendar"]),
    );
  if (spec.kind.startsWith("gmail.")) return any(google(["gmail.readonly", "gmail.modify"]));
  if (spec.kind.startsWith("drive."))
    return any(google(["drive.file", "drive.metadata.readonly", "drive.readonly", "drive"]));
  if (spec.kind.startsWith("slack.")) {
    if (principal.tokenType !== "bot" || typeof principal.teamId !== "string") return false;
    return spec.kind === "slack.app_mention"
      ? scopes.includes("app_mentions:read")
      : spec.kind === "slack.app_dm"
        ? scopes.includes("im:history")
        : any(["channels:history", "groups:history"]);
  }
  return (
    capabilities.includes("read_content") &&
    (spec.kind !== "notion.comment_changed" || capabilities.includes("read_comments"))
  );
}

export function onlyDriveFileScope(scopes: readonly string[]): boolean {
  return (
    scopes.includes("https://www.googleapis.com/auth/drive.file") &&
    !google(["drive", "drive.readonly", "drive.metadata.readonly"]).some((scope) =>
      scopes.includes(scope),
    )
  );
}
