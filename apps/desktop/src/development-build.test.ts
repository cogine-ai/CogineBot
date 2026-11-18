import { describe, expect, it } from "vitest";
import { resolveDesktopEnvironment } from "./desktop-environment.js";
import { developmentBuildConfiguration } from "./development-build.js";

describe("development launcher package", () => {
  it("declares only the development protocol and keeps publishing and signing out of registration", () => {
    const config = developmentBuildConfiguration(
      { workspaceRoot: "/workspace/one", viteUrl: "http://localhost:5173" },
      "/workspace/one/out-dev",
    );
    expect(config.protocols).toEqual([
      { name: "CogineBot Dev", schemes: ["coginebot-dev"], role: "Viewer" },
    ]);
    expect(config.publish).toEqual([]);
    expect(config.extraResources).toEqual([]);
    expect(config.mac).toMatchObject({ identity: null, notarize: false });
    const env = resolveDesktopEnvironment({
      packaged: true,
      metadata: config.extraMetadata?.coginebotDevelopment,
    });
    expect(env.appId).toBe(config.appId);
    expect(env.development?.workspaceRoot).toBe("/workspace/one");
    expect(env.scheme).toBe("coginebot-dev");
  });
});
