import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSdkDependencies } from "../scripts/check-sdk-dependencies.mjs";

const roots: string[] = [];

function fixture(installed: Record<string, string | null> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "sdk-dependencies-"));
  roots.push(root);
  const manifest = {
    dependencies: { expo: "57.0.27", react: "19.2.3", "expo-font": "57.0.4" },
  };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  for (const [name, declared] of Object.entries(manifest.dependencies)) {
    const version = name in installed ? installed[name] : declared;
    if (version === null) continue;
    const dir = path.join(root, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  }
  writeFileSync(
    path.join(root, "node_modules/expo/bundledNativeModules.json"),
    JSON.stringify({ react: "19.2.3", "expo-font": "~57.0.4" }),
  );
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe("pinned Expo SDK dependency validation", () => {
  it("checks the bundled native map and the installed pinned SDK without networking", () => {
    expect(checkSdkDependencies(fixture())).toEqual({
      sdkVersion: "57.0.27",
      checked: 3,
      issues: [],
    });
  });

  it("rejects an installed native module outside the SDK range", () => {
    const result = checkSdkDependencies(fixture({ "expo-font": "58.0.0" }));
    expect(result.issues).toContain("expo-font: installed 58.0.0, SDK expects ~57.0.4");
  });

  it("rejects a stale installation even when its patch is SDK compatible", () => {
    const result = checkSdkDependencies(fixture({ "expo-font": "57.0.5" }));
    expect(result.issues).toEqual(["expo-font: installed 57.0.5 does not match declared 57.0.4"]);
  });

  it("rejects a missing installed native module", () => {
    expect(checkSdkDependencies(fixture({ "expo-font": null })).issues).toEqual([
      "expo-font: installed package is missing or invalid",
    ]);
  });

  it("rejects an installed SDK that differs from the declared version", () => {
    const result = checkSdkDependencies(fixture({ expo: "57.0.28" }));
    expect(result.issues).toContain("expo: installed 57.0.28, SDK expects 57.0.27");
  });

  it("fails closed when the bundled map is unavailable", () => {
    const root = fixture();
    rmSync(path.join(root, "node_modules/expo/bundledNativeModules.json"));
    expect(() => checkSdkDependencies(root)).toThrow();
  });

  it("fails closed when the bundled map is empty", () => {
    const root = fixture();
    writeFileSync(path.join(root, "node_modules/expo/bundledNativeModules.json"), "{}");
    expect(() => checkSdkDependencies(root)).toThrow("Pinned Expo dependency map is invalid");
  });
});
