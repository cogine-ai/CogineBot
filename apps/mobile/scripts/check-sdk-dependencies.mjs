import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** Validate installed native modules against the map shipped in the pinned Expo SDK. */
export function checkSdkDependencies(projectRoot) {
  const pkg = readJson(path.join(projectRoot, "package.json"));
  const installedManifest = (name) => path.join(projectRoot, "node_modules", name, "package.json");
  const expo = readJson(installedManifest("expo"));
  const bundled = readJson(path.join(projectRoot, "node_modules/expo/bundledNativeModules.json"));
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  if (
    typeof declared.expo !== "string" ||
    !bundled ||
    typeof bundled !== "object" ||
    Array.isArray(bundled) ||
    !Object.keys(bundled).length
  ) {
    throw new Error("Pinned Expo dependency map is invalid");
  }
  const expected = { ...bundled, expo: declared.expo };
  const issues = [];
  let checked = 0;
  for (const [name, declaredRange] of Object.entries(declared)) {
    if (!(name in expected)) continue;
    checked++;
    try {
      // Read pnpm's direct package link; some native packages hide package.json in exports.
      const installed = readJson(installedManifest(name)).version;
      if (!semver.satisfies(installed, declaredRange, { includePrerelease: true })) {
        issues.push(`${name}: installed ${installed} does not match declared ${declaredRange}`);
      }
      if (!semver.satisfies(installed, expected[name], { includePrerelease: true })) {
        issues.push(`${name}: installed ${installed}, SDK expects ${expected[name]}`);
      }
    } catch {
      issues.push(`${name}: installed package is missing or invalid`);
    }
  }
  return { sdkVersion: expo.version, checked, issues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { sdkVersion, checked, issues } = checkSdkDependencies(projectRoot);
  if (issues.length) {
    for (const issue of issues) console.error(issue);
    process.exitCode = 1;
  } else {
    console.log(`Expo ${sdkVersion} bundled SDK validation passed (${checked} packages).`);
  }
}
