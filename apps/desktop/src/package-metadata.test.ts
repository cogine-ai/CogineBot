import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
) as {
  name?: string;
  productName?: string;
  version?: string;
  build?: {
    productName?: string;
    appId?: string;
    extraMetadata?: { name?: string };
    mac?: { icon?: string };
    nsis?: { artifactName?: string };
    linux?: { executableName?: string };
    publish?: { provider: string; owner: string; repo: string }[];
  };
};

describe("desktop package metadata", () => {
  it("shares the customer-facing name between Electron and electron-builder", () => {
    expect(packageJson.productName).toBe("CogineBot");
    expect(packageJson.build?.productName).toBeUndefined();
  });

  it("uses CogineBot packaging and update ownership", () => {
    expect(packageJson.name).toBe("@rakazo/desktop");
    expect(packageJson.build?.extraMetadata?.name).toBe("coginebot-desktop");
    expect(packageJson.build?.appId).toBe("ai.cogine.coginebot.desktop");
    expect(packageJson.build?.mac?.icon).toBe("../../packages/ui-tokens/assets/CogineBot.icon");
    expect(packageJson.build?.linux?.executableName).toBe("coginebot");
    expect(packageJson.build?.publish).toEqual([
      { provider: "github", owner: "cogine-ai", repo: "CogineBot" },
    ]);
  });

  it("uses one GitHub-safe Windows installer name on disk and in the update feed", () => {
    const require = createRequire(import.meta.url);
    const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
    const { AppInfo } = builderRequire("app-builder-lib");
    const { expandMacro } = builderRequire("app-builder-lib/out/util/macroExpander.js");
    const { computeSafeArtifactNameIfNeeded } = builderRequire(
      "app-builder-lib/out/platformPackager.js",
    );
    const { NsisTarget } = builderRequire("app-builder-lib/out/targets/nsis/NsisTarget.js");
    const appInfo = new AppInfo({ metadata: packageJson, config: packageJson.build });
    const artifact = expandMacro(packageJson.build?.nsis?.artifactName, "x64", appInfo, {
      ext: "exe",
    });
    const safeArtifactName = computeSafeArtifactNameIfNeeded(artifact, () => {
      throw new Error("The configured installer name must not need a GitHub fallback");
    });
    expect(artifact).toBe(`CogineBot-Setup-${packageJson.version}.exe`);
    // gh uploads the physical basename; a separate safe name would change the GitHub feed URL.
    expect(safeArtifactName).toBeNull();

    const defaultPattern = NsisTarget.prototype.installerFilenamePattern.call({
      isPortable: false,
      shouldBuildUniversalInstaller: true,
    });
    const oldArtifact = expandMacro(defaultPattern, "x64", appInfo, {
      ext: "exe",
    });
    expect(computeSafeArtifactNameIfNeeded(oldArtifact, () => "unexpected-fallback")).toBe(
      artifact,
    );
    expect(oldArtifact).not.toBe(artifact);
  });
});
