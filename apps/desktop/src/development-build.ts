import type { Configuration } from "electron-builder";
import type { DesktopDevelopment } from "./desktop-environment.js";
import { desktopDevelopmentId, parseDesktopDevelopment } from "./desktop-environment.js";

/** Reuse the normal desktop package with an explicit, non-publishing development identity. */
export function developmentBuildConfiguration(
  input: DesktopDevelopment,
  output: string,
  base: Configuration,
): Configuration {
  const development = parseDesktopDevelopment(input);
  return {
    ...base,
    extends: null,
    appId: desktopDevelopmentId(development.workspaceRoot),
    productName: "CogineBot Dev",
    directories: { ...base.directories, output },
    extraMetadata: {
      ...base.extraMetadata,
      name: "coginebot-desktop-dev",
      productName: "CogineBot Dev",
      coginebotDevelopment: development,
    },
    protocols: [{ name: "CogineBot Dev", schemes: ["coginebot-dev"], role: "Viewer" }],
    extraResources: [],
    publish: null,
    mac: { ...base.mac, identity: null, notarize: false },
    win: { ...base.win, executableName: "CogineBot Dev", signAndEditExecutable: false },
    linux: { ...base.linux, executableName: "coginebot-dev" },
  };
}
