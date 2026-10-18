import type { NativeAppConfig } from "@rakazo/db";
import { NativeActionError } from "../action.js";
import { NativeConfigSettingsSchema } from "../config.js";

export const WORK_MANAGEMENT_METADATA = {
  gitlab: {
    name: "GitLab",
    scopes: ["read_user", "read_api", "api"],
    authKinds: ["oauth", "personal_token"],
    actor: "user",
    endpoint:
      "administrator configured HTTPS GitLab origin; defaults to https://gitlab.com; no model URL",
    identityScopes: ["read_user"],
    tenantSelection: false,
  },
  jira: {
    name: "Jira Cloud",
    scopes: ["read:me", "read:jira-user", "read:jira-work", "write:jira-work", "offline_access"],
    authKinds: ["oauth"],
    actor: "user",
    endpoint: "https://api.atlassian.com/ex/jira/{verified cloudId}",
    identityScopes: ["read:me"],
    tenantSelection: true,
  },
  confluence: {
    name: "Confluence Cloud",
    scopes: [
      "read:me",
      "read:space:confluence",
      "search:confluence",
      "read:content-details:confluence",
      "read:page:confluence",
      "write:page:confluence",
      "read:comment:confluence",
      "write:comment:confluence",
      "read:attachment:confluence",
      "offline_access",
    ],
    authKinds: ["oauth"],
    actor: "user",
    endpoint: "https://api.atlassian.com/ex/confluence/{verified cloudId}",
    identityScopes: ["read:me"],
    tenantSelection: true,
  },
  todoist: {
    name: "Todoist",
    scopes: ["data:read", "data:read_write", "task:add"],
    authKinds: ["oauth", "personal_token"],
    actor: "user",
    endpoint: "https://api.todoist.com/api/v1",
    identityScopes: ["data:read", "data:read_write"],
    tenantSelection: false,
  },
  trello: {
    name: "Trello",
    scopes: ["read:member:trello", "read:board:trello", "write:board:trello", "offline_access"],
    authKinds: ["oauth"],
    actor: "user",
    endpoint: "https://api.trello.com/1",
    identityScopes: ["read:member:trello"],
    tenantSelection: false,
  },
  asana: {
    name: "Asana",
    scopes: [
      "users:read",
      "workspaces:read",
      "projects:read",
      "tasks:read",
      "tasks:write",
      "stories:read",
      "stories:write",
      "default",
    ],
    defaultScopes: [
      "users:read",
      "workspaces:read",
      "projects:read",
      "tasks:read",
      "tasks:write",
      "stories:read",
      "stories:write",
    ],
    authKinds: ["oauth", "personal_token"],
    actor: "user",
    endpoint: "https://app.asana.com/api/1.0",
    identityScopes: ["users:read"],
    tenantSelection: false,
  },
} as const;
export type WorkManagementApp = keyof typeof WORK_MANAGEMENT_METADATA;
export function isWorkManagementApp(app: string): app is WorkManagementApp {
  return Object.hasOwn(WORK_MANAGEMENT_METADATA, app);
}

/** Validated administrator configuration only. Private networks still need the existing explicit transport policy. */
export function gitlabOrigin(config: NativeAppConfig): string {
  const endpoint = NativeConfigSettingsSchema.parse(config.config).endpoint ?? "https://gitlab.com";
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new NativeActionError("not_configured", "Enter a GitLab HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new NativeActionError(
      "not_configured",
      "GitLab must use a fixed HTTPS origin without a path or credentials.",
    );
  return url.origin;
}
export function workManagementBase(
  config: NativeAppConfig,
  verifiedTenant?: string | null,
): string {
  if (config.appId === "gitlab") return `${gitlabOrigin(config)}/api/v4`;
  if (config.appId === "jira" || config.appId === "confluence") {
    const tenant = verifiedTenant;
    if (!tenant || !/^[A-Za-z0-9-]{1,128}$/.test(tenant))
      throw new NativeActionError("authorization_required", "Select a verified Atlassian site.");
    return `https://api.atlassian.com/ex/${config.appId}/${tenant}`;
  }
  if (config.appId === "todoist") return "https://api.todoist.com/api/v1";
  if (config.appId === "trello") return "https://api.trello.com/1";
  if (config.appId === "asana") return "https://app.asana.com/api/1.0";
  throw new NativeActionError("invalid_input", "Unsupported work management application.");
}
