import type { NativeAppId, NativeConfigEditable, NativeConfigInput } from "@rakazo/contracts";

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
  "google-drive": ["drive.metadata.readonly"],
  "google-docs": ["documents.readonly"],
  "google-sheets": ["spreadsheets.readonly"],
  "google-slides": ["presentations.readonly"],
  "google-tasks": ["tasks.readonly"],
};
export type NativeApplicationDraft = Omit<NativeConfigInput, "knowledgeBaseIds"> & {
  hasClientSecret: boolean;
  knowledgeBaseIdsText: string;
};
export function freshNativeApplication(appId: NativeAppId): NativeApplicationDraft {
  const google = GOOGLE_DEFAULT_SCOPES[appId];
  return {
    appId,
    label: "",
    ownership: "byo",
    enabled: true,
    credentialKind:
      appId === "coginex"
        ? "mcp_oauth"
        : appId === "knowai"
          ? "machine_key"
          : appId === "github" || appId === "linear"
            ? "personal_token"
            : appId === "slack"
              ? "bot_token"
              : "oauth",
    ...(google || ["github", "linear", "slack"].includes(appId)
      ? { actor: appId === "slack" ? "bot" : "user" }
      : {}),
    scopes: google
      ? ["openid", "email", ...google.map((scope) => GOOGLE_SCOPE_PREFIX + scope)]
      : appId === "slack"
        ? ["channels:read"]
        : [],
    capabilities: appId === "knowai" ? ["retrieve"] : appId === "notion" ? ["read_content"] : [],
    knowledgeBaseIdsText: "",
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
    githubAppId: value.githubAppId,
    githubInstallationId: value.githubInstallationId,
    ...(value.googleWatch ? { googleWatch: { ...value.googleWatch } } : {}),
    knowledgeBaseIdsText: value.knowledgeBaseIds.join(", "),
    hasClientSecret: value.hasClientSecret,
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
  const actor =
    draft.appId === "github"
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
    ...(kind === "github_app_installation"
      ? {}
      : { githubAppId: undefined, githubInstallationId: undefined }),
    ...(draft.appId === "slack" && actor === "bot"
      ? { scopes: draft.scopes.filter((scope) => scope !== "search:read"), capabilities: [] }
      : {}),
    ...(draft.appId === "linear" ? { scopes: kind === "oauth" ? ["read"] : [] } : {}),
  };
}
