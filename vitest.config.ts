import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// CI separates shell integration work without changing the default local suite.
const lane = process.env.CI_TEST_LANE;
if (lane && !["unit", "shell-deploy", "shell-other"].includes(lane)) {
  throw new Error(`Unknown CI_TEST_LANE: ${lane}`);
}
const deployTests = "packages/testkit/src/deploy-script.test.ts";
const shellTests = [
  "packages/testkit/src/*-script.test.ts",
  "packages/testkit/src/backup-scripts.test.ts",
  "packages/testkit/src/compose*.test.ts",
];

export default defineConfig({
  resolve: {
    alias: [
      {
        // The published dist keeps JSX inside .js files, which vite cannot parse;
        // tests load the package's shipped TypeScript source instead.
        find: /^@ronradtke\/react-native-markdown-display$/,
        replacement: fileURLToPath(
          new URL(
            "./packages/chat-ui/node_modules/@ronradtke/react-native-markdown-display/src/index.tsx",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@lingui\/core\/macro$/,
        replacement: fileURLToPath(
          new URL("./packages/testkit/src/lingui-core-macro.ts", import.meta.url),
        ),
      },
      // Native-only transitive deps of the renderer contain uncompiled Flow
      // source; stub them out in tests (they never render anyway).
      ...["react-native-fit-image", "@react-native-vector-icons/material-design-icons"].map(
        (dep) => ({
          find: new RegExp(`^${dep.replace(/[/]/g, "\\/")}$`),
          replacement: fileURLToPath(
            new URL("./packages/chat-ui/src/native-test-stubs.tsx", import.meta.url),
          ),
        }),
      ),
    ],
  },
  test: {
    // Load the markdown renderer's shipped TypeScript source through vite so
    // react-native can be mocked in node tests.
    server: { deps: { inline: [/react-native-markdown-display/] } },
    environment: "node",
    setupFiles: ["./packages/testkit/src/pin-test-env.ts"],
    include:
      lane === "shell-deploy"
        ? [deployTests]
        : lane === "shell-other"
          ? shellTests
          : [
              ".agents/skills/pr-watch/*.test.ts",
              "packages/*/src/**/*.test.{ts,tsx}",
              "infra/sandboxes/supervisor/src/**/*.test.ts",
              "infra/updater/src/**/*.test.ts",
              "apps/desktop/src/**/*.test.ts",
              "apps/web/src/**/*.test.{ts,tsx}",
              "apps/mobile/lib/**/*.test.{ts,tsx}",
              "apps/mobile/plugins/**/*.test.js",
              "apps/api/src/**/*.test.ts",
              "apps/worker/src/**/*.test.ts",
              "apps/www/src/**/*.test.ts",
            ],
    exclude: lane === "unit" ? shellTests : lane === "shell-other" ? [deployTests] : undefined,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
