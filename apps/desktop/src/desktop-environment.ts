import { createHash } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";

export type DesktopScheme = "coginebot" | "coginebot-dev";

export interface DesktopDevelopment {
  workspaceRoot: string;
  viteUrl: string;
}

export interface DesktopEnvironment {
  name: string;
  appId: string;
  scheme: DesktopScheme;
  development: DesktopDevelopment | null;
}

export function parseDesktopDevelopment(value: unknown): DesktopDevelopment {
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid desktop development configuration.");
  const { workspaceRoot, viteUrl } = value as Record<string, unknown>;
  if (
    typeof workspaceRoot !== "string" ||
    !(path.isAbsolute(workspaceRoot) || path.win32.isAbsolute(workspaceRoot)) ||
    typeof viteUrl !== "string"
  )
    throw new Error("Invalid desktop development configuration.");
  let url: URL;
  try {
    url = new URL(viteUrl);
  } catch {
    throw new Error("Choose a local Vite address.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (
    !loopback ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Choose a local Vite address.");
  return { workspaceRoot, viteUrl: url.origin };
}

/** Each workspace owns its launcher, profile and instance. */
export function desktopDevelopmentId(workspaceRoot: string): string {
  const id = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
  return `ai.cogine.coginebot.desktop.dev-${id}`;
}

export function resolveDesktopEnvironment(input: {
  packaged: boolean;
  metadata?: unknown;
  developmentConfig?: string;
}): DesktopEnvironment {
  // A normal installed build never changes identity because of a developer's shell.
  const raw =
    input.metadata !== undefined
      ? input.metadata
      : !input.packaged && input.developmentConfig
        ? JSON.parse(input.developmentConfig)
        : undefined;
  if (raw === undefined)
    return {
      name: "CogineBot",
      appId: "ai.cogine.coginebot.desktop",
      scheme: "coginebot",
      development: null,
    };
  const development = parseDesktopDevelopment(raw);
  return {
    name: "CogineBot Dev",
    appId: desktopDevelopmentId(development.workspaceRoot),
    scheme: "coginebot-dev",
    development,
  };
}

export function desktopProfileRoot(
  environment: DesktopEnvironment,
  appData: string,
  isolatedRoot?: string,
): string | null {
  if (environment.development)
    return path.join(isolatedRoot ?? appData, "CogineBot Dev", environment.appId);
  return isolatedRoot ?? null;
}
