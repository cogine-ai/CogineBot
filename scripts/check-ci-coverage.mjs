import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function files(lane) {
  const output = execFileSync("pnpm", ["exec", "vitest", "list", "--filesOnly", "--json"], {
    env: { ...process.env, CI_TEST_LANE: lane },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(output)
    .map(({ file }) => file)
    .sort();
}

// Discover through Vitest itself, so include/exclude behavior and newly added tests
// are checked instead of duplicating the config's glob matching here.
const baseline = files("");
const lanes = ["unit", "shell-deploy", "shell-other"].map((lane) => {
  const selected = files(lane);
  assert.ok(selected.length > 0, `Empty CI test lane: ${lane}`);
  console.log(`${lane}: ${selected.length} test files`);
  return selected;
});
const combined = lanes.flat().sort();
assert.equal(new Set(combined).size, combined.length, "CI lanes overlap");
assert.deepEqual(combined, baseline, "CI lanes must cover the complete default test suite");
console.log(`CI partition preserves all ${baseline.length} default test files exactly once.`);
