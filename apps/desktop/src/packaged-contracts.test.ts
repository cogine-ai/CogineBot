import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const desktop = path.resolve(import.meta.dirname, "..");
const contracts = path.resolve(desktop, "../../packages/contracts");
const require = createRequire(path.join(desktop, "package.json"));

function javascriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(file) : entry.name.endsWith(".js") ? [file] : [];
  });
}

it("loads compiled desktop contract imports from a packaged dependency layout", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "coginebot-packaged-contracts-"));
  try {
    const dist = path.join(fixture, "dist");
    const compiled = spawnSync(
      process.execPath,
      [
        path.join(path.dirname(require.resolve("typescript/package.json")), "bin/tsc"),
        "-p",
        path.join(desktop, "tsconfig.json"),
        "--outDir",
        dist,
      ],
      { encoding: "utf8" },
    );
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);

    const imports = new Set<string>();
    for (const file of javascriptFiles(dist)) {
      for (const match of readFileSync(file, "utf8").matchAll(
        /\b(?:from\s*|import\s*\(\s*)["'](@rakazo\/contracts[^"']*)["']/g,
      )) {
        imports.add(match[1]!);
      }
    }
    expect(imports.size).toBeGreaterThan(0);
    const packaged = path.join(fixture, "node_modules/@rakazo/contracts");
    cpSync(path.join(contracts, "src"), path.join(packaged, "src"), { recursive: true });
    cpSync(path.join(contracts, "package.json"), path.join(packaged, "package.json"));
    const loaded = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await Promise.all(${JSON.stringify([...imports])}.map((specifier) => import(specifier)))`,
      ],
      { cwd: fixture, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
    );
    expect(loaded.status, loaded.stderr).toBe(0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 20_000);
