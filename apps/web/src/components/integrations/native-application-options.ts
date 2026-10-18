import type { NativeAppId, NativeConfigEditable, NativeConfigInput } from "@rakazo/contracts";
import { NATIVE_REMAINING_APPLICATIONS, remainingNativeProfile } from "@rakazo/contracts";

export const NATIVE_APPLICATIONS: readonly { id: NativeAppId; name: string }[] = [
  { id: "coginex", name: "CogineX" },
  { id: "knowai", name: "Knowai" },
  { id: "google-calendar", name: "Google Calendar" },
  { id: "gmail", name: "Gmail" },
  { id: "google-drive", name: "Google Drive" },
  { id: "google-docs", name: "Google Docs" },
  { id: "google-sheets", name: "Google Sheets" },
  { id: "google-slides", name: "Google Slides" },
  { id: "google-tasks", name: "Google Tasks" },
  { id: "notion", name: "Notion" },
  { id: "github", name: "GitHub" },
  { id: "linear", name: "Linear" },
  { id: "slack", name: "Slack" },
  ...NATIVE_REMAINING_APPLICATIONS,
];
export const GOOGLE_SCOPE_PREFIX = "https://www.googleapis.com/auth/";
export function nativeGmailCallbackAudience(callbackUri: string): string {
  return new URL("/api/connectors/events/gmail", callbackUri).toString();
}
export const GOOGLE_DEFAULT_SCOPES: Partial<Record<NativeAppId, readonly string[]>> = {
  "google-calendar": [
    "calendar.calendarlist.readonly",
    "calendar.events.readonly",
    "calendar.freebusy",
  ],
  gmail: ["gmail.readonly"],
  "google-drive": ["drive.file"],
  "google-docs": ["documents.readonly"],
  "google-sheets": ["spreadsheets.readonly"],
  "google-slides": ["presentations.readonly"],
  "google-tasks": ["tasks.readonly"],
};
export type NativeApplicationDraft = Omit<NativeConfigInput, "knowledgeBaseIds" | "targetIds"> & {
  hasClientSecret: boolean;
  hasVerificationToken?: boolean;
  hasEncryptionKey?: boolean;
  knowledgeBaseIdsText: string;
  targetIdsText: string;
};
export function freshNativeApplication(appId: NativeAppId): NativeApplicationDraft {
  const google = GOOGLE_DEFAULT_SCOPES[appId];
  const profile = remainingNativeProfile(appId);
  return {
    appId,
    label: "",
    ownership: "byo",
    enabled: true,
    credentialKind: profile
      ? profile.credentialKinds[0]!
      : appId === "coginex"
        ? "mcp_oauth"
        : appId === "knowai"
          ? "machine_key"
          : appId === "github" || appId === "linear"
            ? "personal_token"
            : appId === "slack"
              ? "bot_token"
              : "oauth",
    ...(profile ? { actor: profile.actors[0] } : {}),
    ...(appId === "feishu-lark" ? { region: "feishu" as const } : {}),
    ...(google || ["github", "linear", "slack"].includes(appId)
      ? { actor: appId === "slack" ? "bot" : "user" }
      : {}),
    scopes: profile
      ? [...profile.defaultScopes]
      : google
        ? ["openid", "email", ...google.map((scope) => GOOGLE_SCOPE_PREFIX + scope)]
        : appId === "slack"
          ? ["channels:read"]
          : [],
    capabilities: profile?.defaultCapabilities
      ? [...profile.defaultCapabilities]
      : appId === "knowai"
        ? ["retrieve"]
        : appId === "notion"
          ? ["read_content"]
          : [],
    knowledgeBaseIdsText: "",
    targetIdsText: "",
    hasClientSecret: false,
  };
}
export function draftNativeApplication(value: NativeConfigEditable): NativeApplicationDraft {
  return {
    id: value.id,
    expectedRevision: value.revision,
    appId: value.appId,
    label: value.label,
    ownership: value.ownership,
    enabled: value.enabled,
    credentialKind: value.credentialKind,
    endpoint: value.endpoint,
    clientId: value.clientId,
    scopes: [...value.scopes],
    capabilities: [...value.capabilities],
    tenantId: value.tenantId,
    actor: value.actor,
    region: value.region,
    agentId: value.agentId,
    targetIdsText: (value.targetIds ?? []).join(", "),
    githubAppId: value.githubAppId,
    githubInstallationId: value.githubInstallationId,
    ...(value.googleWatch ? { googleWatch: { ...value.googleWatch } } : {}),
    knowledgeBaseIdsText: value.knowledgeBaseIds.join(", "),
    hasClientSecret: value.hasClientSecret,
    hasVerificationToken: value.hasVerificationToken,
    hasEncryptionKey: value.hasEncryptionKey,
  };
}
export function nativeApplicationInput(draft: NativeApplicationDraft): NativeConfigInput {
  return {
    ...(draft.id ? { id: draft.id, expectedRevision: draft.expectedRevision } : {}),
    appId: draft.appId,
    label: draft.label.trim(),
    ownership: draft.ownership,
    enabled: draft.enabled,
    credentialKind: draft.credentialKind,
    ...(draft.endpoint?.trim() ? { endpoint: draft.endpoint.trim() } : {}),
    ...(draft.clientId?.trim() ? { clientId: draft.clientId.trim() } : {}),
    ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
    ...(draft.credentialKind === "oauth" && ["feishu-lark", "wecom"].includes(draft.appId)
      ? {
          ...(draft.verificationToken ? { verificationToken: draft.verificationToken } : {}),
          ...(draft.encryptionKey ? { encryptionKey: draft.encryptionKey } : {}),
        }
      : {}),
    scopes: [...draft.scopes],
    capabilities: [...draft.capabilities],
    knowledgeBaseIds: [
      ...new Set(
        draft.knowledgeBaseIdsText
          .split(/[,\n]/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ],
    ...(draft.tenantId?.trim() ? { tenantId: draft.tenantId.trim() } : {}),
    ...(draft.actor ? { actor: draft.actor } : {}),
    ...(draft.appId === "feishu-lark" && draft.region ? { region: draft.region } : {}),
    ...(draft.agentId?.trim() && ["feishu-lark", "dingtalk", "wecom"].includes(draft.appId)
      ? { agentId: draft.agentId.trim() }
      : {}),
    ...(["telegram-bot", "discord"].includes(draft.appId)
      ? {
          targetIds: [
            ...new Set(
              draft.targetIdsText
                .split(/[,\n]/)
                .map((value) => value.trim())
                .filter(Boolean),
            ),
          ],
        }
      : {}),
    ...(draft.githubAppId?.trim() ? { githubAppId: draft.githubAppId.trim() } : {}),
    ...(draft.githubInstallationId?.trim()
      ? { githubInstallationId: draft.githubInstallationId.trim() }
      : {}),
    ...(draft.appId === "gmail" && draft.googleWatch
      ? { googleWatch: { ...draft.googleWatch } }
      : {}),
  };
}
export function changeNativeCredential(
  draft: NativeApplicationDraft,
  kind: NativeConfigInput["credentialKind"],
): NativeApplicationDraft {
  const profile = remainingNativeProfile(draft.appId);
  const actor = profile
    ? ["feishu-lark", "dingtalk", "wecom"].includes(draft.appId)
      ? kind === "machine_key" || draft.appId === "wecom"
        ? "app"
        : "user"
      : draft.appId === "hubspot" && kind === "personal_token"
        ? "app"
        : profile.actors.includes(draft.actor as never)
          ? draft.actor
          : profile.actors[0]
    : draft.appId === "github"
      ? kind === "github_app_installation"
        ? "installation"
        : "user"
      : draft.appId === "linear"
        ? kind === "oauth" && draft.actor === "app"
          ? "app"
          : "user"
        : draft.appId === "slack"
          ? kind === "bot_token"
            ? "bot"
            : kind === "personal_token"
              ? "user"
              : draft.actor === "user"
                ? "user"
                : "bot"
          : draft.actor;
  return {
    ...draft,
    credentialKind: kind,
    actor,
    clientId: undefined,
    clientSecret: undefined,
    verificationToken: undefined,
    encryptionKey: undefined,
    ...(kind === "github_app_installation"
      ? {}
      : { githubAppId: undefined, githubInstallationId: undefined }),
    ...(draft.appId === "slack" && actor === "bot"
      ? { scopes: draft.scopes.filter((scope) => scope !== "search:read"), capabilities: [] }
      : {}),
    ...(draft.appId === "linear" ? { scopes: kind === "oauth" ? ["read"] : [] } : {}),
  };
}

export function nativeApplicationCredentialKinds(
  appId: NativeAppId,
): readonly NativeConfigInput["credentialKind"][] {
  const profile = remainingNativeProfile(appId);
  if (profile) return profile.credentialKinds;
  if (appId === "notion") return ["oauth", "internal_token", "personal_token"];
  if (appId === "github") return ["personal_token", "github_app_installation", "oauth"];
  if (appId === "linear") return ["personal_token", "oauth"];
  if (appId === "slack") return ["bot_token", "personal_token", "oauth"];
  return [freshNativeApplication(appId).credentialKind];
}
export function nativeApplicationActors(
  draft: NativeApplicationDraft,
): readonly NonNullable<NativeConfigInput["actor"]>[] {
  const profile = remainingNativeProfile(draft.appId);
  if (profile)
    return ["feishu-lark", "dingtalk", "wecom"].includes(draft.appId)
      ? draft.credentialKind === "machine_key" || draft.appId === "wecom"
        ? ["app"]
        : ["user"]
      : draft.appId === "hubspot" && draft.credentialKind === "personal_token"
        ? ["app"]
        : profile.actors;
  if (draft.appId === "github")
    return draft.credentialKind === "github_app_installation" ? ["installation"] : ["user"];
  if (draft.appId === "linear")
    return draft.credentialKind === "oauth" ? ["user", "app"] : ["user"];
  if (draft.appId === "slack")
    return draft.credentialKind === "bot_token"
      ? ["bot"]
      : draft.credentialKind === "personal_token"
        ? ["user"]
        : ["bot", "user"];
  return draft.actor ? [draft.actor] : [];
}
export function nativeOwnerSuppliesCredential(draft: NativeApplicationDraft): boolean {
  return (
    (["feishu-lark", "dingtalk", "wecom"].includes(draft.appId) &&
      draft.credentialKind === "machine_key") ||
    (["telegram-bot", "discord"].includes(draft.appId) && draft.ownership === "official")
  );
}
