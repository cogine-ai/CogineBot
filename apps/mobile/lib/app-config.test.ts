import { readFileSync } from "node:fs";
import type { ConfigContext } from "expo/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mobileConfig from "../app.config";

const baseConfig = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")).expo;
const projectId = "12345678-1234-4123-8123-123456789abc";

function config() {
  return mobileConfig({ config: baseConfig } as ConfigContext);
}

beforeEach(() => {
  vi.stubEnv("EAS_BUILD_PROFILE", "");
  vi.stubEnv("EXPO_OWNER", "");
  vi.stubEnv("EAS_PROJECT_ID", "");
  vi.stubEnv("EXPO_PUBLIC_API_URL", "");
});

afterEach(() => vi.unstubAllEnvs());

describe("mobile release configuration", () => {
  it("keeps local source development independent from Expo release accounts", () => {
    const result = config();
    expect(result.name).toBe("CogineBot");
    expect(result.slug).toBe("coginebot");
    expect(result.scheme).toBe("coginebot");
    expect(result.ios?.bundleIdentifier).toBe("ai.cogine.coginebot");
    expect(result.android?.package).toBe("ai.cogine.coginebot");
    expect(result.owner).toBeUndefined();
    expect(result.extra?.eas?.projectId).toBeUndefined();
    expect(result.updates?.url).toBeUndefined();
    expect(result.runtimeVersion).toEqual({ policy: "appVersion" });
  });

  it.each(["production", "android-apk", "preview"])(
    "blocks a %s distribution without its own Expo project",
    (profile) => {
      vi.stubEnv("EAS_BUILD_PROFILE", profile);
      vi.stubEnv("EXPO_PUBLIC_API_URL", "https://app.example.test");
      expect(config).toThrow("EXPO_OWNER and EAS_PROJECT_ID");
    },
  );

  it.each([
    { owner: "example-owner", project: "" },
    { owner: "", project: projectId },
    { owner: "example-owner", project: "not-a-project-id" },
  ])("rejects incomplete or invalid Expo ownership configuration: %j", ({ owner, project }) => {
    vi.stubEnv("EXPO_OWNER", owner);
    vi.stubEnv("EAS_PROJECT_ID", project);
    expect(config).toThrow(/EXPO_OWNER|EAS_PROJECT_ID/);
  });

  it("uses one self-owned project for EAS builds, push tokens, and compatible OTA updates", () => {
    vi.stubEnv("EAS_BUILD_PROFILE", "production");
    vi.stubEnv("EXPO_OWNER", "example-owner");
    vi.stubEnv("EAS_PROJECT_ID", projectId);
    vi.stubEnv("EXPO_PUBLIC_API_URL", "https://app.example.test");
    const result = config();
    expect(result.owner).toBe("example-owner");
    expect(result.extra?.eas?.projectId).toBe(projectId);
    expect(result.updates?.url).toBe(`https://u.expo.dev/${projectId}`);
    expect(result.runtimeVersion).toEqual({ policy: "appVersion" });
  });

  it.each(["", "not-a-url", "http://app.example.test"])(
    "keeps the release API HTTPS requirement for %j",
    (url) => {
      vi.stubEnv("EAS_BUILD_PROFILE", "production");
      vi.stubEnv("EXPO_OWNER", "example-owner");
      vi.stubEnv("EAS_PROJECT_ID", projectId);
      vi.stubEnv("EXPO_PUBLIC_API_URL", url);
      expect(config).toThrow(/EXPO_PUBLIC_API_URL/);
    },
  );
});
