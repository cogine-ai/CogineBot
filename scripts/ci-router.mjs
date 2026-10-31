import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const laneNames = ["static", "build", "unit", "shell", "integration", "web", "marketing"];
const shellFiles = new Set([
  "scripts/backup.sh",
  "scripts/restore.sh",
  "packages/testkit/src/deploy-script.test.ts",
  "packages/testkit/src/backup-scripts.test.ts",
  "packages/testkit/src/compose.backup.test.ts",
  "packages/testkit/src/compose-installer-smoke.test.ts",
]);
const rootDocuments = new Set([
  "README.md",
  "README.zh-CN.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "UPSTREAM.md",
  "THIRD_PARTY_NOTICES.md",
  "LICENSE",
]);

function plan(lanes, reason) {
  const selected = new Set(lanes);
  const result = Object.fromEntries(laneNames.map((name) => [name, selected.has(name)]));
  const include = [];
  const add = (check, lane, timeout, shard = "") => include.push({ check, lane, shard, timeout });
  if (result.static) add("Lint and typecheck", "static", 15);
  if (result.build) add("Web production build", "build", 15);
  if (result.marketing) add("Marketing production build", "marketing", 15);
  if (result.unit) add("Default offline unit tests", "unit", 20);
  if (result.shell) {
    add("Deployment shell tests", "shell-deploy", 20);
    add("Other shell tests", "shell-other", 15);
  }
  if (result.integration) {
    for (let shard = 1; shard <= 2; shard += 1) {
      add(`Official PostgreSQL integration (${shard}/2)`, "integration", 20, `${shard}/2`);
    }
  }
  if (result.web) {
    for (let shard = 1; shard <= 3; shard += 1) {
      add(`Selected fake web E2E (${shard}/3)`, "web", 25, `${shard}/3`);
    }
  }
  return {
    ...result,
    has_checks: include.length > 0,
    matrix: {
      include: include.length
        ? include
        : [{ check: "No application changes", lane: "none", shard: "", timeout: 5 }],
    },
    reason,
  };
}

function fullPlan(reason) {
  return plan(laneNames, reason);
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });
}

function safePath(file) {
  return (
    typeof file === "string" &&
    file.length > 0 &&
    !file.includes("\\") &&
    !hasControlCharacters(file) &&
    !file.startsWith("/") &&
    !file.startsWith("-") &&
    !/^[a-z]:/iu.test(file) &&
    file.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function routeChangedPaths(files) {
  if (files.length === 0) return fullPlan("Empty PR comparison; all checks retained.");
  const lanes = new Set();
  const categories = new Set();
  for (const file of files) {
    if (!safePath(file)) return fullPlan("Unrecognized PR path; all checks retained.");
    if (
      rootDocuments.has(file) ||
      /^docs\/.+\.(?:md|png|jpe?g|webp|gif|svg|mp4)$/u.test(file) ||
      file === ".github/PULL_REQUEST_TEMPLATE.md"
    ) {
      categories.add("documentation");
    } else if (file.startsWith("apps/www/")) {
      lanes.add("marketing");
      categories.add("marketing");
    } else if (
      file.startsWith("infra/compose/") ||
      shellFiles.has(file) ||
      /^packages\/testkit\/src\/[^/]+-script\.test\.ts$/u.test(file)
    ) {
      lanes.add("static");
      lanes.add("shell");
      lanes.add("unit");
      categories.add("deployment and shell");
    } else if (file.startsWith("apps/web/")) {
      for (const lane of ["static", "build", "unit", "integration", "web"]) lanes.add(lane);
      categories.add("web");
    } else {
      return fullPlan("Shared, configuration, or unclassified changes; all checks retained.");
    }
  }
  return plan(lanes, `PR changes: ${[...categories].join(", ")}.`);
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function changedPaths({ cwd, base, head }) {
  const commit = (ref) => {
    if (typeof ref !== "string" || ref.length === 0 || hasControlCharacters(ref)) {
      throw new Error("Missing or invalid comparison reference");
    }
    return git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])
      .toString("utf8")
      .trim();
  };
  const headCommit = commit(head);
  const mergeBase = git(cwd, ["merge-base", commit(base), headCommit])
    .toString("utf8")
    .trim();
  // Disabling rename detection retains both the deleted source and added destination.
  const output = git(cwd, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    mergeBase,
    headCommit,
    "--",
  ]);
  if (output.length === 0) return [];
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(output);
  if (!decoded.endsWith("\0")) throw new Error("Incomplete Git path output");
  return decoded.slice(0, -1).split("\0");
}

export function planForEnvironment(env = process.env, cwd = process.cwd()) {
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    return fullPlan("Main, manual, or unrecognized event; all checks retained.");
  }
  try {
    const event = env.GITHUB_EVENT_PATH
      ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
      : {};
    const base =
      env.CI_ROUTER_BASE ||
      event.pull_request?.base?.sha ||
      (env.GITHUB_BASE_REF ? `refs/remotes/origin/${env.GITHUB_BASE_REF}` : "");
    const head = env.CI_ROUTER_HEAD || event.pull_request?.head?.sha || "HEAD";
    return routeChangedPaths(changedPaths({ cwd, base, head }));
  } catch {
    return fullPlan("PR comparison unavailable; all checks retained.");
  }
}

function main() {
  const env = process.env;
  const result = planForEnvironment(env);
  const selected = laneNames.filter((name) => result[name]);
  const summary = `${result.reason}\nSelected checks: ${selected.join(", ") || "repository only"}.\n`;
  console.log(summary.trim());
  if (env.GITHUB_OUTPUT) {
    const outputs = [...laneNames, "has_checks"].map((name) => `${name}=${result[name]}`);
    outputs.push(`matrix=${JSON.stringify(result.matrix)}`);
    appendFileSync(env.GITHUB_OUTPUT, `${outputs.join("\n")}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### CI selection\n\n${summary}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
