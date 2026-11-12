import { isPageShareDocumentPath } from "@rakazo/contracts";

const OAUTH_POPUP_NAMES = new Set([
  "rakazo-app-connect",
  "rakazo-mcp-oauth",
  "rakazo-sso-oauth",
  "rakazo-model-oauth",
  "rakazo-plugin-connect",
]);

export function shouldOpenInAppPopup(
  appOrigin: string | null,
  childUrl: string,
  frameName: string,
) {
  let target: URL;
  try {
    target = new URL(childUrl);
  } catch {
    return false;
  }

  if (childUrl === "about:blank" && frameName === "rakazo-sso-oauth") return true;
  if (frameName === "coginebot-slack-oauth")
    return (
      childUrl === "about:blank" ||
      (target.origin === "https://slack.com" &&
        target.pathname === "/oauth/v2/authorize" &&
        !target.username &&
        !target.password)
    );

  const isHttp = target.protocol === "http:" || target.protocol === "https:";
  if (appOrigin !== null && target.origin === appOrigin)
    return isHttp && !isPageShareDocumentPath(target.pathname);
  return target.protocol === "https:" && OAUTH_POPUP_NAMES.has(frameName);
}

/** Keep auth cookies in the parent app's server-specific session. */
export function oauthPopupSessionPreferences(partition: string | null) {
  return {
    preload: "",
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    ...(partition === null ? {} : { partition }),
  };
}
