import { closeSettingsSheet, isSettingsLink } from "../lib/settings-sheet";

/** A link to a screen outside settings closes the settings sheet first, so the screen opens on
 * the root stack instead of over the sheet. Settings links open inside the sheet. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  // The auth-session listener receives the original URL. Navigation must not retain
  // authorization codes in route params/history, or attempt a cold-start exchange.
  try {
    const url = new URL(path, "coginebot:///");
    if (
      url.protocol === "coginebot:" &&
      url.pathname === "/mcp" &&
      (url.searchParams.has("code") ||
        url.searchParams.has("state") ||
        url.searchParams.has("error"))
    )
      return "/mcp";
  } catch {
    /* Ordinary relative route. */
  }
  if (!isSettingsLink(path)) closeSettingsSheet();
  return path;
}
