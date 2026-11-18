import type { Configuration } from "electron-builder";
import type { DesktopDevelopment } from "./desktop-environment.js";
import { desktopDevelopmentId, parseDesktopDevelopment } from "./desktop-environment.js";

/** Reuse the normal desktop package with an explicit, non-publishing development identity. */
export function developmentBuildConfiguration(
  input: DesktopDevelopment,
  output: string,
): Configuration {
  const development = parseDesktopDevelopment(input);
  return {
    appId: desktopDevelopmentId(development.workspaceRoot),
    productName: "CogineBot Dev",
    directories: { output },
    extraMetadata: {
      name: "coginebot-desktop-dev",
      productName: "CogineBot Dev",
      coginebotDevelopment: development,
    },
    protocols: [{ name: "CogineBot Dev", schemes: ["coginebot-dev"], role: "Viewer" }],
    extraResources: [],
    publish: [],
    mac: { identity: null, notarize: false },
    win: { executableName: "CogineBot Dev" },
    linux: { executableName: "coginebot-dev" },
  };
}
