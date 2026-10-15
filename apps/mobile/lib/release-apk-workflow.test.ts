import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/release-android-apk.yml"),
  "utf8",
);
const easConfig = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../eas.json"), "utf8"),
) as {
  build: Record<string, { extends?: string; android?: { buildType?: string } }>;
};

describe("Android APK release workflow", () => {
  it("has one active company release workflow", () => {
    expect(
      existsSync(
        path.resolve(
          import.meta.dirname,
          "../../../.github/upstream-workflows/release-android-apk.yml",
        ),
      ),
    ).toBe(false);
  });

  it("only runs on demand from main with release credentials", () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n\n/m);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("cache: pnpm");
    expect(workflow).toMatch(/EXPO_OWNER: \$\{\{ vars\.EXPO_OWNER \}\}/);
    expect(workflow).toMatch(/EAS_PROJECT_ID: \$\{\{ vars\.EAS_PROJECT_ID \}\}/);
  });

  it("pins every third-party action to an immutable commit", () => {
    const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference, reference).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("builds a production-channel APK and never takes the desktop updater's latest release", () => {
    expect(easConfig.build["android-apk"]).toEqual({
      extends: "production",
      android: { buildType: "apk" },
    });
    expect(workflow).toContain("--profile android-apk");
    expect(workflow).toMatch(/EXPO_PUBLIC_API_URL: \$\{\{ vars\.EXPO_PUBLIC_API_URL \}\}/);
    expect(workflow).toContain("--latest=false");
    expect(workflow).toContain("$RUNNER_TEMP/coginebot.apk");
    expect(workflow).not.toContain("rakazo.apk");
    expect(workflow).not.toContain("gh release delete");
    expect(readFileSync(path.resolve(import.meta.dirname, "../app.config.ts"), "utf8")).toContain(
      '"android-apk"',
    );
  });
});
