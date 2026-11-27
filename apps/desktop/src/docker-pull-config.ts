import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { RunDockerResult } from "./docker-cli.js";
import { writePrivateFile } from "./setup-store.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Retry a pull with the reported missing helpers removed from a temporary Docker config. */
export async function retryPullWithoutMissingHelpers(
  result: RunDockerResult,
  options: { cwd: string; env: NodeJS.ProcessEnv; platform: string; signal: AbortSignal },
  pull: (env: Record<string, string>) => Promise<RunDockerResult>,
): Promise<RunDockerResult | null> {
  const missing = new Set(
    Array.from(
      `${result.stdout}\n${result.stderr}`.matchAll(
        /error getting credentials - err: exec: "docker-credential-([^"\r\n]+)": executable file not found in (?:\$PATH|%PATH%)/g,
      ),
      (match) => match[1],
    ),
  );
  if (missing.size === 0 || options.signal.aborted) return null;

  const { cwd, env, platform } = options;
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  const source = path.resolve(cwd, env.DOCKER_CONFIG || path.join(home, ".docker"));
  let directory: string | undefined;
  try {
    const config: unknown = JSON.parse(await readFile(path.join(source, "config.json"), "utf8"));
    if (!isObject(config)) return null;
    let changed = false;
    if (typeof config.credsStore === "string" && missing.has(config.credsStore)) {
      delete config.credsStore;
      changed = true;
    }
    if (isObject(config.credHelpers)) {
      for (const [registry, helper] of Object.entries(config.credHelpers)) {
        if (typeof helper !== "string" || !missing.has(helper)) continue;
        delete config.credHelpers[registry];
        changed = true;
      }
    }
    if (!changed || options.signal.aborted) return null;

    // An empty login record prevents Docker from auto-detecting another helper.
    if (
      !config.credsStore &&
      !Object.keys(config.credHelpers ?? {}).length &&
      !Object.keys(config.auths ?? {}).length
    ) {
      config.auths = { "https://index.docker.io/v1/": {} };
    }

    directory = await mkdtemp(path.join(tmpdir(), "coginebot-docker-"));
    for (const name of ["contexts", "cli-plugins"]) {
      const target = path.join(source, name);
      const info = await stat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (info?.isDirectory()) {
        await symlink(
          target,
          path.join(directory, name),
          platform === "win32" ? "junction" : "dir",
        );
      }
    }
    await writePrivateFile(path.join(directory, "config.json"), JSON.stringify(config));
  } catch {
    // Keep the first pull's diagnostic if preparing a retry fails.
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    return null;
  }

  try {
    if (options.signal.aborted) return null;
    return await pull({
      DOCKER_CONFIG: directory,
      DOCKER_CERT_PATH: env.DOCKER_CERT_PATH || source,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
