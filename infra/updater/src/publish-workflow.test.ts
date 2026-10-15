import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowText = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/publish-server-image.yml"),
  "utf8",
);
interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  "runs-on"?: string;
  strategy?: { matrix?: { arch?: string[]; include?: Array<Record<string, string>> } };
  steps?: Array<{ name?: string; run?: string; with?: { flavor?: string; tags?: string } }>;
}

const workflow = parse(workflowText) as {
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: {
    validate: WorkflowJob;
    build: WorkflowJob;
    "publication-policy": WorkflowJob;
    publish: WorkflowJob;
  };
};

function runPublicationPolicy(options: {
  tag: string;
  refType?: string;
  tags?: string[];
  releases?: string[];
  tagsExit?: number;
  releasesExit?: number;
}) {
  const directory = mkdtempSync(path.join(tmpdir(), "coginebot-image-policy-"));
  try {
    const output = path.join(directory, "output");
    const calls = path.join(directory, "calls");
    writeFileSync(output, "");
    writeFileSync(calls, "");
    writeFileSync(path.join(directory, "tags"), (options.tags ?? [options.tag]).join("\n"));
    writeFileSync(path.join(directory, "releases"), (options.releases ?? []).join("\n"));
    writeFileSync(
      path.join(directory, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$POLICY_FIXTURES/calls"
case "$*" in
  *'/tags?per_page=100'*)
    cat "$POLICY_FIXTURES/tags"
    exit "$POLICY_TAGS_EXIT"
    ;;
  *'/releases?per_page=100'*)
    cat "$POLICY_FIXTURES/releases"
    exit "$POLICY_RELEASES_EXIT"
    ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o700 },
    );
    const script = workflow.jobs["publication-policy"].steps?.find(
      (step) => step.name === "Validate stable aliases before publishing",
    )?.run;
    expect(script).toBeTypeOf("string");
    const result = spawnSync("bash", ["-c", script ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
        GITHUB_REPOSITORY: "example/project",
        GITHUB_OUTPUT: output,
        RELEASE_REF_TYPE: options.refType ?? "tag",
        RELEASE_TAG: options.tag,
        POLICY_FIXTURES: directory,
        POLICY_TAGS_EXIT: String(options.tagsExit ?? 0),
        POLICY_RELEASES_EXIT: String(options.releasesExit ?? 0),
      },
    });
    return {
      status: result.status,
      output: readFileSync(output, "utf8"),
      calls: readFileSync(calls, "utf8"),
      stderr: result.stderr,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("server image publish workflow", () => {
  it("builds every architecture natively instead of emulating arm64", () => {
    expect(workflowText).not.toContain("setup-qemu-action");
    const build = workflow.jobs.build;
    expect(build["runs-on"]).toContain("matrix.runner");
    expect(build.strategy?.matrix?.arch).toEqual(["amd64", "arm64"]);
    const runners = Object.fromEntries(
      (build.strategy?.matrix?.include ?? [])
        .filter((entry) => entry.arch !== undefined)
        .map((entry) => [entry.arch, entry.runner]),
    );
    expect(runners).toEqual({ amd64: "ubuntu-latest", arm64: "ubuntu-24.04-arm" });
  });

  it("publishes one verified multi-arch manifest per image after both builds", () => {
    const publish = workflow.jobs.publish;
    expect(publish.needs).toEqual(["build", "publication-policy"]);
    expect(workflow.jobs["publication-policy"].needs).toBe("build");
    expect(workflowText).toContain("push-by-digest=true");
    expect(workflowText).toContain("docker buildx imagetools create");
    expect(workflowText).toContain("for want in linux/amd64 linux/arm64");
    expect(workflowText).toContain("actions/attest-build-provenance@");
  });

  it("serializes tag publications and gives every image one stable-alias decision", () => {
    expect(workflow.concurrency.group).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(workflow.concurrency.group).toContain("&& 'stable' || github.ref");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    const metadata = workflow.jobs.publish.steps?.find((step) => step.with?.tags !== undefined);
    expect(metadata?.with?.flavor).toBe("latest=false");
    expect(metadata?.with?.tags).toContain(
      `type=semver,pattern=v{{major}}.{{minor}},enable=\${{ needs.publication-policy.outputs.stable == 'true' }}`,
    );
    expect(metadata?.with?.tags).toContain(
      `type=raw,value=latest,enable=\${{ needs.publication-policy.outputs.stable == 'true' }}`,
    );
  });

  it("allows the first stable publication and a current-version retry", () => {
    for (const releases of [[], ["v0.2.1"]]) {
      const result = runPublicationPolicy({ tag: "v0.2.1", releases });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe("stable=true\n");
      expect(result.calls).toContain("--paginate repos/example/project/tags?per_page=100");
      expect(result.calls).toContain("--paginate repos/example/project/releases?per_page=100");
    }
  });

  it("orders versions numerically and excludes nonstable tags", () => {
    const result = runPublicationPolicy({
      tag: "v0.2.10",
      tags: ["v0.2.9", "v0.2.10", "v99.0.0-rc.1", "vgarbage", "v1.2"],
      releases: ["v0.2.9"],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("stable=true\n");
  });

  it("rejects an old run even before the newer tag has a GitHub release", () => {
    const result = runPublicationPolicy({
      tag: "v0.2.9",
      tags: ["v0.2.9", "v0.2.10"],
      releases: [],
    });
    expect(result.status).toBe(1);
    expect(result.output).not.toContain("stable=true");
    expect(result.stderr).toContain("newest stable repository tag");
  });

  it("rejects a version below a published release even when the newer tag is gone", () => {
    const result = runPublicationPolicy({ tag: "v0.2.1", releases: ["v0.2.2"] });
    expect(result.status).toBe(1);
    expect(result.output).not.toContain("stable=true");
    expect(result.stderr).toContain("older than a published stable release");
  });

  it.each([
    { tag: "main", refType: "branch" },
    { tag: "v0.3.0-rc.1" },
    { tag: "v0.3.0-rc.1+build.4" },
  ])("keeps main and valid prereleases off stable aliases: $tag", (options) => {
    const result = runPublicationPolicy(options);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("stable=false\n");
    expect(result.calls).toBe("");
  });

  it.each(["vgarbage", "v1.2", "v01.2.3", "v1.2.3-rc..1", "v1.2.3-01", "v1.2.3+build"])(
    "rejects malformed or noncanonical stable tags before any alias is changed: %s",
    (tag) => {
      const result = runPublicationPolicy({ tag });
      expect(result.status).toBe(1);
      expect(result.output).not.toContain("stable=true");
      expect(result.calls).toBe("");
    },
  );

  it.each([{ tagsExit: 1 }, { releasesExit: 1 }])(
    "fails closed when a GitHub version listing fails: %j",
    (failure) => {
      const result = runPublicationPolicy({ tag: "v0.2.1", ...failure });
      expect(result.status).toBe(1);
      expect(result.output).not.toContain("stable=true");
    },
  );

  it("fails closed when the current stable tag is absent from the repository listing", () => {
    const result = runPublicationPolicy({ tag: "v0.2.1", tags: [] });
    expect(result.status).toBe(1);
    expect(result.output).not.toContain("stable=true");
  });

  it("keeps pull requests read-only and every action pinned to a commit", () => {
    const validate = workflow.jobs.validate;
    const build = workflow.jobs.build;
    const publish = workflow.jobs.publish;
    expect(validate.if).toBe("github.event_name == 'pull_request'");
    expect(build.if).toBe("github.event_name != 'pull_request'");
    expect(publish.if).toBe("github.event_name != 'pull_request'");
    expect(workflowText).toContain("push: false");
    for (const match of workflowText.matchAll(/uses:\s+([^\s#]+)/g)) {
      expect(match[1], match[1]).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
