import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../../.github/workflows/repository-ci.yml", import.meta.url),
  "utf8",
);
const mobileJob = workflow.split("\n  publish-mobile-update:\n")[1]!;
const publishingConfiguration = {
  EXPO_OWNER: "example-owner",
  EAS_PROJECT_ID: "12345678-1234-4123-8123-123456789abc",
  EXPO_PUBLIC_API_URL: "https://app.example.test",
  EXPO_TOKEN: "synthetic-token",
};
const configurationNames = Object.keys(publishingConfiguration);

function runScript(step: string): string {
  const block = mobileJob.split(`      - name: ${step}\n`)[1]!.split("\n      - ")[0]!;
  return block.match(/ {8}run: \|\n([\s\S]*)/)![1]!.replace(/^ {10}/gm, "");
}

describe("production mobile OTA workflow", () => {
  let directory: string;
  let repository: string;
  let easCalls: string;
  let bin: string;

  function git(...args: string[]): string {
    return execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  }

  function commit(file: string): string {
    const filename = path.join(repository, file);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, "synthetic fixture\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release@example.test",
      "commit",
      "-m",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  }

  function execute(script: string, environment: Record<string, string> = {}) {
    const output = path.join(directory, "output");
    const summary = path.join(directory, "summary");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const result = spawnSync("bash", ["-c", script], {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        EXPO_OWNER: "",
        EAS_PROJECT_ID: "",
        EXPO_PUBLIC_API_URL: "",
        EXPO_TOKEN: "",
        GITHUB_SHA: git("rev-parse", "HEAD"),
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        EAS_TEST_CALLS: easCalls,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        ...environment,
      },
    });
    return {
      status: result.status,
      stderr: result.stderr,
      output: readFileSync(output, "utf8"),
      summary: readFileSync(summary, "utf8"),
      calls: readFileSync(easCalls, "utf8"),
    };
  }

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "coginebot-ota-test-"));
    repository = path.join(directory, "repository");
    mkdirSync(repository);
    bin = path.join(directory, "bin");
    mkdirSync(bin);
    easCalls = path.join(directory, "eas-calls");
    writeFileSync(easCalls, "");
    writeFileSync(
      path.join(bin, "eas"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$EAS_TEST_CALLS"\n',
      { mode: 0o755 },
    );
    git("init", "-b", "main");
    commit("README.md");
    git("remote", "add", "origin", path.join(repository, ".git"));
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("only publishes after all read-only checks pass on a main push", () => {
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(mobileJob).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(mobileJob).toContain("needs: result");
    expect(workflow).toContain("needs: [repository, checks, screenshots]");
    expect(mobileJob).toMatch(/EXPO_OWNER: \$\{\{ vars\.EXPO_OWNER \}\}/);
    expect(mobileJob).toMatch(/EAS_PROJECT_ID: \$\{\{ vars\.EAS_PROJECT_ID \}\}/);
    expect(mobileJob).toContain("EAS_BUILD_PROFILE: production");
    expect(mobileJob).toMatch(/EXPO_PUBLIC_API_URL: \$\{\{ vars\.EXPO_PUBLIC_API_URL \}\}/);
    expect(mobileJob).toContain("if: steps.mobile.outputs.configured == 'true'");
    expect(mobileJob).not.toMatch(/contents:\s*write|packages:\s*write/);
  });

  it("finishes running main workflows and serializes production publications", () => {
    expect(workflow).toMatch(
      /queue: \$\{\{ github\.ref == 'refs\/heads\/main' && 'max' \|\| 'single' \}\}\n {2}cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}/,
    );
    expect(workflow).toMatch(/cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}/);
    expect(mobileJob).toContain(
      "group: mobile-production-update\n      queue: max\n      cancel-in-progress: false",
    );
  });

  it.each(["", " \t\n"])("reports an unconfigured mobile publisher without publishing", (value) => {
    const result = execute(
      runScript("Check mobile publishing configuration"),
      Object.fromEntries(configurationNames.map((name) => [name, value])),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("configured=false\n");
    expect(result.summary).toContain("Mobile publishing is not configured");
    expect(result.calls).toBe("");
  });

  it.each(Array.from({ length: 14 }, (_, index) => index + 1))(
    "fails instead of silently skipping partial mobile configuration: %i",
    (mask) => {
      const environment = Object.fromEntries(
        Object.entries(publishingConfiguration).filter((_, index) => mask & (1 << index)),
      );
      const result = execute(runScript("Check mobile publishing configuration"), environment);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Mobile publishing is partially configured");
      expect(result.output).not.toContain("configured=true");
      expect(result.calls).toBe("");
    },
  );

  it("enables publishing only when all four project settings are present", () => {
    const result = execute(
      runScript("Check mobile publishing configuration"),
      publishingConfiguration,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("configured=true\n");
    expect(result.summary).toBe("");
    expect(result.calls).toBe("");
  });

  it("gates all EAS setup and publishing steps without classifying a per-push diff", () => {
    const configuredSteps = mobileJob.split("      - uses: pnpm/action-setup@")[1]!;
    const steps = configuredSteps.split(/\n {6}- (?:name:|uses:)/);
    expect(steps).toHaveLength(6);
    for (const step of steps) {
      expect(step).toContain("if: steps.mobile.outputs.configured == 'true'");
    }
    expect(mobileJob).not.toMatch(/BEFORE_SHA|github\.event\.before|git diff|native-sensitive/);
  });

  it.each([
    "apps/mobile/app/thread.tsx",
    "packages/ui-tokens/src/tokens.ts",
    "apps/mobile/app.json",
  ])("publishes the latest whole main bundle after an intermediate change to %s", (file) => {
    commit(file);
    const head = commit("docs/guide.md");
    const result = execute(runScript("Publish production update"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toBe(
      `update --platform all --channel production --environment production --message ${head} --non-interactive\n`,
    );
  });

  it("does not let an older revision overwrite the current main update", () => {
    const before = git("rev-parse", "HEAD");
    commit("apps/mobile/app/thread.tsx");
    const result = execute(runScript("Publish production update"), { GITHUB_SHA: before });
    expect(result.status, result.stderr).toBe(0);
    expect(result.summary).toContain("older revision cannot overwrite a newer production update");
    expect(result.calls).toBe("");
  });

  it("fails without publishing when the current main cannot be verified", () => {
    git("remote", "remove", "origin");
    const result = execute(runScript("Publish production update"));
    expect(result.status).not.toBe(0);
    expect(result.calls).toBe("");
  });
});

describe("CI result gate", () => {
  const resultJob = workflow.split("\n  result:\n")[1]!.split("\n  publish-mobile-update:")[0]!;
  const script = resultJob.split("        run: |\n")[1]!.replace(/^ {10}/gm, "");
  const passing = {
    REPOSITORY_RESULT: "success",
    CHECKS_SELECTED: "true",
    CHECKS_RESULT: "success",
    SCREENSHOTS_SELECTED: "true",
    SCREENSHOTS_RESULT: "success",
  };
  function gate(environment: Record<string, string> = {}) {
    return spawnSync("bash", ["-c", script], {
      env: { ...process.env, ...passing, ...environment },
      encoding: "utf8",
    }).status;
  }

  it("accepts all selected checks and intentional documentation-only skips", () => {
    expect(resultJob).toContain("if: always()");
    expect(gate()).toBe(0);
    expect(
      gate({
        CHECKS_SELECTED: "false",
        CHECKS_RESULT: "skipped",
        SCREENSHOTS_SELECTED: "false",
        SCREENSHOTS_RESULT: "skipped",
      }),
    ).toBe(0);
  });

  it.each(["REPOSITORY_RESULT", "CHECKS_RESULT", "SCREENSHOTS_RESULT"])(
    "rejects unsuccessful selected dependency %s",
    (dependency) => {
      for (const status of ["failure", "cancelled", "skipped"]) {
        expect(gate({ [dependency]: status }), `${dependency}: ${status}`).not.toBe(0);
      }
    },
  );
});
