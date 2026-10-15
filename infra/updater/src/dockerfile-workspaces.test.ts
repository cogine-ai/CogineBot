import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");

describe("the updater image's production workspace dependencies", () => {
  it("copies the full runtime dependency closure before the filtered install", () => {
    const dockerfile = readFileSync(path.join(repoRoot, "infra/updater/Dockerfile"), "utf8");
    const beforeInstall = dockerfile.split("RUN corepack enable")[0] ?? "";
    const copied = new Map<string, PackageManifest>();
    for (const match of beforeInstall.matchAll(/^COPY ((?:packages|infra)\/\S+) \1$/gm)) {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, match[1] ?? "", "package.json"), "utf8"),
      ) as PackageManifest;
      copied.set(manifest.name, manifest);
    }

    const pending = ["@rakazo/updater"];
    const checked = new Set<string>();
    while (pending.length > 0) {
      const name = pending.pop() as string;
      if (checked.has(name)) continue;
      checked.add(name);
      const manifest = copied.get(name);
      expect(manifest, `${name} must be copied before pnpm's production install`).toBeDefined();
      for (const [dependency, version] of Object.entries({
        ...manifest?.dependencies,
        ...manifest?.optionalDependencies,
      })) {
        if (version.startsWith("workspace:")) pending.push(dependency);
      }
    }
  });
});
