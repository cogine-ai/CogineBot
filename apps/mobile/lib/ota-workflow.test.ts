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

function runScript(step: string): string {
  const block = mobileJob.split(`      - name: ${step}\n`)[1]!.split("\n      - ")[0]!;
  return block.match(/ {8}run: \|\n([\s\S]*)/)![1]!.replace(/^ {10}/gm, "");
}

describe("production mobile OTA workflow", () => {
  let directory: string;
  let repository: string;

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

  function execute(script: string, before: string, head: string) {
    const output = path.join(directory, "output");
    const summary = path.join(directory, "summary");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const result = spawnSync("bash", ["-c", script], {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        BEFORE_SHA: before,
        GITHUB_SHA: head,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return { output: readFileSync(output, "utf8"), summary: readFileSync(summary, "utf8") };
  }

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "coginebot-ota-test-"));
    repository = path.join(directory, "repository");
    mkdirSync(repository);
    git("init", "-b", "main");
    commit("README.md");
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("only publishes after all read-only checks pass on a main push", () => {
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(mobileJob).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(mobileJob).toContain("needs: checks");
    expect(mobileJob).toMatch(/EXPO_OWNER: \$\{\{ vars\.EXPO_OWNER \}\}/);
    expect(mobileJob).toMatch(/EAS_PROJECT_ID: \$\{\{ vars\.EAS_PROJECT_ID \}\}/);
    expect(mobileJob).toContain("EAS_BUILD_PROFILE: production");
    expect(mobileJob).toMatch(/EXPO_PUBLIC_API_URL: \$\{\{ vars\.EXPO_PUBLIC_API_URL \}\}/);
    expect(mobileJob).toContain("if: steps.ota.outputs.publish == 'true'");
    expect(mobileJob).not.toMatch(/contents:\s*write|packages:\s*write/);
  });

  it.each([
    "apps/mobile/app/thread.tsx",
    "apps/mobile/lib/endpoint.ts",
    "packages/chat-ui/src/thread.css",
  ])("allows compatible bundle changes: %s", (file) => {
    const before = git("rev-parse", "HEAD");
    const head = commit(file);
    expect(
      execute(runScript("Check whether the change is safe for OTA"), before, head).output,
    ).toBe("publish=true\n");
  });

  it.each(["apps/mobile/app.json", "apps/mobile/assets/icon.png", "pnpm-lock.yaml"])(
    "blocks native-sensitive changes: %s",
    (file) => {
      const before = git("rev-parse", "HEAD");
      commit(file);
      const head = commit("apps/mobile/app/thread.tsx");
      expect(
        execute(runScript("Check whether the change is safe for OTA"), before, head).output,
      ).toBe("publish=false\n");
    },
  );

  it("does not publish a partial range when the push base cannot be resolved", () => {
    const head = commit("apps/mobile/app/thread.tsx");
    const result = execute(
      runScript("Check whether the change is safe for OTA"),
      "0000000000000000000000000000000000000000",
      head,
    );
    expect(result.output).toBe("publish=false\n");
    expect(result.summary).toContain("will not publish a partial-range update");
  });

  it("does not let an older revision overwrite the current main update", () => {
    const before = git("rev-parse", "HEAD");
    commit("apps/mobile/app/thread.tsx");
    git("remote", "add", "origin", path.join(repository, ".git"));
    const result = execute(runScript("Publish production update"), before, before);
    expect(result.summary).toContain("older revision cannot overwrite a newer production update");
  });
});
