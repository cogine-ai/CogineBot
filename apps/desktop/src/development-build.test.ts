import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Configuration } from "electron-builder";
import { describe, expect, it } from "vitest";
import { resolveDesktopEnvironment } from "./desktop-environment.js";
import { developmentBuildConfiguration } from "./development-build.js";

describe("development launcher package", () => {
  it("resolves a standalone development package without inheriting installed protocols or publishing", async () => {
    const project = path.resolve(import.meta.dirname, "..");
    const base = JSON.parse(await readFile(path.join(project, "package.json"), "utf8")).build;
    const directory = await mkdtemp(path.join(tmpdir(), "desktop-build-config-"));
    const config = developmentBuildConfiguration(
      { workspaceRoot: "/workspace/one", viteUrl: "http://localhost:5173" },
      "/workspace/one/out-dev",
      base,
    );
    const file = path.join(directory, "development.json");
    const desktop = createRequire(path.join(project, "package.json"));
    const builder = createRequire(desktop.resolve("electron-builder"));
    const { getConfig, validateConfiguration } = builder(
      "app-builder-lib/out/util/config/config.js",
    );
    let effective: Configuration;
    try {
      await writeFile(file, JSON.stringify(config));
      effective = await getConfig(project, file, null);
      await validateConfiguration(effective, { isEnabled: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(effective.protocols).toEqual([
      { name: "CogineBot Dev", schemes: ["coginebot-dev"], role: "Viewer" },
    ]);
    expect(effective.publish).toBeNull();
    expect(effective.extraResources).toEqual([]);
    expect(effective.mac).toMatchObject({ identity: null, notarize: false });
    expect(effective.win).toMatchObject({ signAndEditExecutable: false });
    const env = resolveDesktopEnvironment({
      packaged: true,
      metadata: config.extraMetadata?.coginebotDevelopment,
    });
    expect(env.appId).toBe(config.appId);
    expect(env.development?.workspaceRoot).toBe("/workspace/one");
    expect(env.scheme).toBe("coginebot-dev");
  });
});
