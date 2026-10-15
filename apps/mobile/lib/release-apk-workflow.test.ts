import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

// Execute the workflow's Bash against an offline GitHub Releases double, including failures
// between separate asset API calls. No API request or Expo build runs in this suite.
describe("rolling APK asset replacement", () => {
  let directory: string;
  let stateFile: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "coginebot-apk-release-"));
    const bin = path.join(directory, "bin");
    mkdirSync(bin);
    stateFile = path.join(directory, "state.json");
    writeFileSync(path.join(directory, "coginebot.apk"), "PK synthetic APK");
    writeFileSync(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      path.join(bin, "gh"),
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const filename = process.env.APK_TEST_STATE;
const state = JSON.parse(fs.readFileSync(filename, "utf8"));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(filename, JSON.stringify(state));
const fail = () => { save(); process.exit(1); };
state.calls.push(args);
if (args[0] === "release") {
  if (args[1] === "upload") {
    if (state.failure === "upload") fail();
    state.assets.push({ id: 2, name: path.basename(args[3]), bytes: "new" });
  }
} else if (args[0] === "api") {
  const endpoint = args.find((arg) => arg.startsWith("repos/"));
  const method = args[args.indexOf("-X") + 1];
  if (endpoint.endsWith("/releases/tags/android")) {
    process.stdout.write(JSON.stringify(state.assets));
  } else if (endpoint.includes("/releases/assets/")) {
    const id = Number(endpoint.split("/").at(-1));
    const asset = state.assets.find((item) => item.id === id);
    if (method === "DELETE") {
      if (state.failure === "cleanup") fail();
      state.assets = state.assets.filter((item) => item.id !== id);
    } else {
      const name = args.find((arg) => arg.startsWith("name=")).slice(5);
      if (id === 1 && name.includes("previous") && state.failure === "backup") fail();
      if (id === 2 && name === "coginebot.apk") {
        state.promotions++;
        if (["promotion", "rollback"].includes(state.failure) ||
            (state.failure === "transient" && state.promotions === 1)) fail();
      }
      if (id === 1 && name === "coginebot.apk" && state.failure === "rollback") fail();
      if (!asset || state.assets.some((item) => item.id !== id && item.name === name)) fail();
      asset.name = name;
    }
  }
}
save();
`,
      { mode: 0o755 },
    );
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function execute(failure = "", previous = true) {
    writeFileSync(
      stateFile,
      JSON.stringify({
        failure,
        promotions: 0,
        calls: [],
        assets: previous ? [{ id: 1, name: "coginebot.apk", bytes: "previous" }] : [],
      }),
    );
    const step = workflow.split("      - name: Publish rolling release\n")[1]!;
    const script = step.match(/ {8}run: \|\n([\s\S]*)/)![1]!.replace(/^ {10}/gm, "");
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(directory, "bin")}${path.delimiter}${process.env.PATH}`,
        APK_TEST_STATE: stateFile,
        RUNNER_TEMP: directory,
        RELEASE_TAG: "android",
        VERSION: "1.0.5",
        VERSION_CODE: "15",
        GITHUB_RUN_ID: "100",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_REPOSITORY: "example/project",
        GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      },
    });
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
      assets: { id: number; name: string; bytes: string }[];
      calls: string[][];
      promotions: number;
    };
    return { ...result, ...state };
  }

  it.each(["upload", "backup", "promotion"])(
    "keeps the previous canonical APK when %s fails",
    (failure) => {
      const result = execute(failure);
      expect(result.status).not.toBe(0);
      expect(result.assets).toContainEqual({ id: 1, name: "coginebot.apk", bytes: "previous" });
      expect(result.calls.some((call) => call.includes("DELETE"))).toBe(false);
      expect(result.calls.some((call) => call.some((arg) => arg.includes("/git/refs/")))).toBe(
        false,
      );
    },
  );

  it("retains the previous bytes and reports manual recovery if rollback also fails", () => {
    const result = execute("rollback");
    expect(result.status).not.toBe(0);
    expect(result.assets).toContainEqual({
      id: 1,
      name: "coginebot-previous-100-1.apk",
      bytes: "previous",
    });
    expect(result.stderr).toContain("previous APK is retained as asset 1");
    expect(result.calls.some((call) => call.includes("DELETE"))).toBe(false);
  });

  it.each(["", "transient"])("promotes the APK before deleting the old asset (%s)", (failure) => {
    const result = execute(failure);
    expect(result.status, result.stderr).toBe(0);
    expect(result.assets).toEqual([{ id: 2, name: "coginebot.apk", bytes: "new" }]);
    const promoted = result.calls.findLastIndex(
      (call) => call.includes("name=coginebot.apk") && call.some((arg) => arg.endsWith("/2")),
    );
    expect(result.calls.findIndex((call) => call.includes("DELETE"))).toBeGreaterThan(promoted);
  });

  it("keeps a usable new APK and retained backup if cleanup fails", () => {
    const result = execute("cleanup");
    expect(result.status, result.stderr).toBe(0);
    expect(result.assets).toHaveLength(2);
    expect(result.assets).toContainEqual({ id: 2, name: "coginebot.apk", bytes: "new" });
    expect(result.stderr).toContain("previous APK remains as coginebot-previous-100-1.apk");
  });

  it("publishes when a rolling release has no previous canonical asset", () => {
    const result = execute("", false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.assets).toEqual([{ id: 2, name: "coginebot.apk", bytes: "new" }]);
    expect(result.calls.some((call) => call.includes("DELETE"))).toBe(false);
  });
});
