import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { changedPaths, planForEnvironment, routeChangedPaths } from "./ci-router.mjs";

const laneNames = ["static", "build", "unit", "shell", "integration", "web", "marketing"];
const script = fileURLToPath(new URL("./ci-router.mjs", import.meta.url));

function selected(result) {
  return laneNames.filter((name) => result[name]);
}

function repository(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "ci-router-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  const write = (file, content = "fixture\n") => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), content);
  };
  const commit = (message = "fixture") => {
    git("add", "--all");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "CI fixture");
  git("config", "user.email", "fixture@example.test");
  write("README.md");
  const initial = commit();
  return { cwd, git, write, commit, initial };
}

test("narrow documentation changes run repository checks only", () => {
  const result = routeChangedPaths(["README.zh-CN.md", "docs/self-host.md", "docs/media/view.png"]);
  assert.deepEqual(selected(result), []);
  assert.equal(result.has_checks, false);
  assert.deepEqual(result.matrix.include, [
    { check: "No application changes", lane: "none", shard: "", timeout: 5 },
  ]);
});

test("marketing changes build marketing without product tests", () => {
  assert.deepEqual(selected(routeChangedPaths(["apps/www/src/pages/index.astro"])), ["marketing"]);
});

test("marketing API, middleware and fetch helpers retain existing functional tests", () => {
  for (const file of [
    "apps/www/api/waitlist.ts",
    "apps/www/src/pages/api/signup.ts",
    "apps/www/src/components/form.test.ts",
    "apps/www/public/service-worker.js",
    "apps/www/src/waitlist.ts",
    "apps/www/src/middleware.ts",
    "apps/www/vercel.json",
    "apps/www/src/github.ts",
    "apps/www/src/github.test.ts",
    "apps/www/package.json",
  ]) {
    assert.deepEqual(selected(routeChangedPaths([file])), ["static", "unit", "marketing"], file);
  }
});

test("web changes retain the complete web lanes", () => {
  assert.deepEqual(selected(routeChangedPaths(["apps/web/src/App.tsx"])), [
    "static",
    "build",
    "unit",
    "integration",
    "web",
  ]);
});

test("deployment and every shell suite select static and shell", () => {
  for (const file of [
    "infra/compose/deploy-main.sh",
    "infra/compose/docker-compose.yml",
    "scripts/backup.sh",
    "scripts/restore.sh",
    "packages/testkit/src/deploy-script.test.ts",
    "packages/testkit/src/firewall-script.test.ts",
    "packages/testkit/src/backup-scripts.test.ts",
    "packages/testkit/src/compose.backup.test.ts",
    "packages/testkit/src/compose-installer-smoke.test.ts",
  ]) {
    assert.deepEqual(selected(routeChangedPaths([file])), ["static", "unit", "shell"], file);
  }
});

test("recognized mixed changes use the union of required lanes", () => {
  assert.deepEqual(
    selected(
      routeChangedPaths(["docs/self-host.md", "apps/www/index.astro", "infra/compose/a.sh"]),
    ),
    ["static", "unit", "shell", "marketing"],
  );
});

test("shared, configuration, native, and unrecognized changes retain all checks", () => {
  for (const file of [
    "packages/core/src/run.ts",
    "package.json",
    "pnpm-lock.yaml",
    ".github/workflows/repository-ci.yml",
    "scripts/ci-router.mjs",
    "apps/mobile/app/index.tsx",
    "apps/desktop/src/main.ts",
    "docs/example.ts",
    "new-area/file.md",
    "apps/api/src/diagram-script.test.ts",
  ]) {
    assert.deepEqual(selected(routeChangedPaths(["README.md", file])), laneNames, file);
  }
});

test("unsafe paths and empty comparisons cannot suppress checks", () => {
  assert.deepEqual(selected(routeChangedPaths([])), laneNames);
  for (const file of [
    "",
    "/apps/www/page.astro",
    "apps/www/../web/file.ts",
    "apps/www//page.astro",
    "apps/www/./page.astro",
    "apps/www/page\n.astro",
    "apps/www/page\0.astro",
    "apps\\www\\page.astro",
    "C:/apps/www/page.astro",
    "-apps/www/page.astro",
  ]) {
    assert.deepEqual(selected(routeChangedPaths([file])), laneNames, JSON.stringify(file));
  }
});

test("full matrix preserves all partitions and execution limits", () => {
  const result = routeChangedPaths(["package.json"]);
  assert.equal(result.has_checks, true);
  assert.equal(result.matrix.include.length, 11);
  const entries = result.matrix.include;
  assert.deepEqual(
    entries.filter(({ lane }) => lane === "integration").map(({ shard }) => shard),
    ["1/2", "2/2"],
  );
  assert.deepEqual(
    entries.filter(({ lane }) => lane === "web").map(({ shard }) => shard),
    ["1/3", "2/3", "3/3"],
  );
  assert.deepEqual(
    entries.filter(({ lane }) => lane.startsWith("shell-")).map(({ lane }) => lane),
    ["shell-deploy", "shell-other"],
  );
  for (const entry of entries) {
    assert.equal(typeof entry.check, "string");
    assert.equal(typeof entry.shard, "string");
    const expected =
      entry.lane === "web"
        ? 25
        : entry.lane === "unit"
          ? 30
          : ["integration", "shell-deploy"].includes(entry.lane)
            ? 20
            : 15;
    assert.equal(entry.timeout, expected);
  }
});

test("PR comparison uses merge-base, excluding unrelated base-only commits", (t) => {
  const repo = repository(t);
  repo.git("checkout", "--quiet", "-b", "feature");
  repo.write("apps/web/src/App.tsx");
  const head = repo.commit();
  repo.git("checkout", "--quiet", "main");
  repo.write("packages/core/src/base-only.ts");
  const base = repo.commit();
  assert.deepEqual(changedPaths({ cwd: repo.cwd, base, head }), ["apps/web/src/App.tsx"]);
  assert.deepEqual(
    selected(
      planForEnvironment(
        { GITHUB_EVENT_NAME: "pull_request", CI_ROUTER_BASE: base, CI_ROUTER_HEAD: head },
        repo.cwd,
      ),
    ),
    ["static", "build", "unit", "integration", "web"],
  );
});

test("rename retains both old and new paths, including deleted shared code", (t) => {
  const repo = repository(t);
  repo.write("packages/core/src/moved.ts");
  const base = repo.commit();
  mkdirSync(path.join(repo.cwd, "docs"));
  renameSync(
    path.join(repo.cwd, "packages/core/src/moved.ts"),
    path.join(repo.cwd, "docs/moved.md"),
  );
  const head = repo.commit();
  const files = changedPaths({ cwd: repo.cwd, base, head });
  assert.deepEqual(files.sort(), ["docs/moved.md", "packages/core/src/moved.ts"]);
  assert.deepEqual(selected(routeChangedPaths(files)), laneNames);
});

test("deleted web files still select web checks", (t) => {
  const repo = repository(t);
  repo.write("apps/web/src/deleted.ts");
  const base = repo.commit();
  rmSync(path.join(repo.cwd, "apps/web/src/deleted.ts"));
  const head = repo.commit();
  assert.deepEqual(changedPaths({ cwd: repo.cwd, base, head }), ["apps/web/src/deleted.ts"]);
  assert.equal(
    planForEnvironment(
      { GITHUB_EVENT_NAME: "pull_request", CI_ROUTER_BASE: base, CI_ROUTER_HEAD: head },
      repo.cwd,
    ).web,
    true,
  );
});

test("NUL-delimited Git output preserves spaces and rejects control-character paths", (t) => {
  const repo = repository(t);
  repo.write("apps/www/src/with space.astro");
  const head = repo.commit();
  assert.deepEqual(changedPaths({ cwd: repo.cwd, base: repo.initial, head }), [
    "apps/www/src/with space.astro",
  ]);
  repo.write("apps/www/src/with\nnewline.astro");
  const unsafeHead = repo.commit();
  assert.deepEqual(
    selected(
      planForEnvironment(
        {
          GITHUB_EVENT_NAME: "pull_request",
          CI_ROUTER_BASE: repo.initial,
          CI_ROUTER_HEAD: unsafeHead,
        },
        repo.cwd,
      ),
    ),
    laneNames,
  );
});

test("push, manual, and unrecognized events always run every lane", () => {
  for (const event of ["push", "workflow_dispatch", "pull_request_target", "", undefined]) {
    assert.deepEqual(selected(planForEnvironment({ GITHUB_EVENT_NAME: event })), laneNames);
  }
});

test("missing ancestry, missing references, malformed events, and empty diffs retain all checks", (t) => {
  const repo = repository(t);
  for (const env of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "pull_request", CI_ROUTER_BASE: "missing" },
    {
      GITHUB_EVENT_NAME: "pull_request",
      CI_ROUTER_BASE: repo.initial,
      CI_ROUTER_HEAD: repo.initial,
    },
  ]) {
    assert.deepEqual(selected(planForEnvironment(env, repo.cwd)), laneNames);
  }
  repo.write("event.json", "{malformed");
  assert.deepEqual(
    selected(
      planForEnvironment(
        { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: path.join(repo.cwd, "event.json") },
        repo.cwd,
      ),
    ),
    laneNames,
  );
  repo.git("checkout", "--quiet", "--orphan", "unrelated");
  repo.write("docs/unrelated.md");
  const unrelated = repo.commit();
  assert.deepEqual(
    selected(
      planForEnvironment(
        {
          GITHUB_EVENT_NAME: "pull_request",
          CI_ROUTER_BASE: repo.initial,
          CI_ROUTER_HEAD: unrelated,
        },
        repo.cwd,
      ),
    ),
    laneNames,
  );
});

test("base-ref fallback compares the checked-out PR head", (t) => {
  const repo = repository(t);
  repo.git("update-ref", "refs/remotes/origin/main", repo.initial);
  repo.write("infra/compose/removed.sh");
  const base = repo.commit();
  repo.git("update-ref", "refs/remotes/origin/main", base);
  rmSync(path.join(repo.cwd, "infra/compose/removed.sh"));
  repo.commit();
  assert.deepEqual(
    selected(
      planForEnvironment({ GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" }, repo.cwd),
    ),
    ["static", "unit", "shell"],
  );
});

test("GitHub PR payload resolves actual head SHA and publishes usable workflow outputs", (t) => {
  const repo = repository(t);
  repo.git("checkout", "--quiet", "-b", "feature");
  repo.write("apps/www/src/pages/index.astro");
  const head = repo.commit();
  repo.git("checkout", "--quiet", "main");
  const eventPath = path.join(repo.cwd, "event.json");
  writeFileSync(
    eventPath,
    JSON.stringify({ pull_request: { base: { sha: repo.initial }, head: { sha: head } } }),
  );
  const outputPath = path.join(repo.cwd, "output.txt");
  const summaryPath = path.join(repo.cwd, "summary.md");
  execFileSync(process.execPath, [script], {
    cwd: repo.cwd,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      CI_ROUTER_BASE: "",
      CI_ROUTER_HEAD: "",
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
    },
  });
  const outputs = Object.fromEntries(
    readFileSync(outputPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  assert.equal(outputs.marketing, "true");
  assert.equal(outputs.unit, "false");
  assert.equal(outputs.has_checks, "true");
  assert.deepEqual(
    JSON.parse(outputs.matrix).include.map(({ lane }) => lane),
    ["marketing"],
  );
  assert.match(readFileSync(summaryPath, "utf8"), /Selected checks: marketing/);
});
