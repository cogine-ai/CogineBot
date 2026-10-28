import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs the page-browser navigation protocol regressions", () => {
  const result = spawnSync(
    "python3",
    [
      fileURLToPath(
        new URL(
          "../../../infra/sandboxes/computer/test_page_browser_navigation.py",
          import.meta.url,
        ),
      ),
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
