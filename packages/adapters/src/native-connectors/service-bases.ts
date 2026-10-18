import { NativeActionError } from "./action.js";
import { googleServiceBase, isGoogleNativeApp } from "./google.js";

/** The authenticated account chooses the API, never a model-supplied URL or service name. */
export function nativeServiceBase(
  app: string,
  endpoint?: string,
  service?: "drive" | "drive-upload",
): string {
  if (isGoogleNativeApp(app)) return googleServiceBase(app, service);
  if (service)
    throw new NativeActionError("invalid_input", "This API is unavailable to the application.");
  if (app === "notion") return "https://api.notion.com";
  if (app === "knowai" && endpoint) return endpoint;
  if (app === "github") return "https://api.github.com";
  if (app === "linear") return "https://api.linear.app";
  if (app === "slack") return "https://slack.com/api";
  throw new NativeActionError("not_configured", "This native API authority is unavailable.");
}
