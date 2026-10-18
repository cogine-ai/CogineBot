import type { NativeRequest } from "./action.js";
import { NativeActionError } from "./action.js";
import { enterpriseBase, isEnterpriseApp } from "./enterprise/metadata.js";
import { googleServiceBase, isGoogleNativeApp } from "./google.js";
import { isMicrosoftApp, MICROSOFT_GRAPH_BASE } from "./microsoft/metadata.js";

/** The authenticated account chooses the API, never a model-supplied URL or service name. */
export function nativeServiceBase(
  app: string,
  endpoint?: string,
  service?: NativeRequest["service"],
  verifiedTenant?: string | null,
  region?: string,
): string {
  if (app === "dropbox") {
    if (service === "dropbox-content") return "https://content.dropboxapi.com";
    if (!service) return "https://api.dropboxapi.com";
  }
  if (app === "telegram-bot") {
    if (service === "telegram-file") return "https://api.telegram.org/file";
    if (!service) return "https://api.telegram.org";
  }
  if (isGoogleNativeApp(app) && (!service || service === "drive" || service === "drive-upload"))
    return googleServiceBase(app, service);
  if (service)
    throw new NativeActionError("invalid_input", "This API is unavailable to the application.");
  if (app === "notion") return "https://api.notion.com";
  if (app === "knowai" && endpoint) return endpoint;
  if (app === "github") return "https://api.github.com";
  if (app === "linear") return "https://api.linear.app";
  if (app === "slack") return "https://slack.com/api";
  if (isMicrosoftApp(app)) return MICROSOFT_GRAPH_BASE;
  if (app === "gitlab") {
    const url = new URL(endpoint ?? "https://gitlab.com");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new NativeActionError(
        "not_configured",
        "GitLab requires an administrator-configured HTTPS origin.",
      );
    return `${url.origin}/api/v4`;
  }
  if (app === "jira" || app === "confluence") {
    if (!verifiedTenant || !/^[A-Za-z0-9-]{1,128}$/.test(verifiedTenant))
      throw new NativeActionError("authorization_required", "Select the verified Atlassian site.");
    return `https://api.atlassian.com/ex/${app}/${verifiedTenant}`;
  }
  if (app === "todoist") return "https://api.todoist.com/api/v1";
  if (app === "trello") return "https://api.trello.com/1";
  if (app === "asana") return "https://app.asana.com/api/1.0";
  if (app === "clickup") return "https://api.clickup.com";
  if (app === "airtable") return "https://api.airtable.com";
  if (app === "hubspot") return "https://api.hubapi.com";
  if (app === "figma") return "https://api.figma.com";
  if (app === "discord") return "https://discord.com/api/v10";
  if (isEnterpriseApp(app)) return enterpriseBase(app, region);
  throw new NativeActionError("not_configured", "This native API authority is unavailable.");
}
