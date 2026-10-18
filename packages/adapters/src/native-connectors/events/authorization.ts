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
