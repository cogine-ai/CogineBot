import { spawn } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, Platform } from "electron-builder";
import { parseDesktopDevelopment } from "../dist/desktop-environment.js";
import { developmentBuildConfiguration } from "../dist/development-build.js";
import { writePrivateFile } from "../dist/setup-store.js";

const desktopRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = await realpath(path.resolve(desktopRoot, "../.."));
const output = path.join(desktopRoot, "out-dev");
const manifest = path.join(output, "launch.json");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

async function run(executable, args, extraEnv = {}) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: desktopRoot,
      env: { ...env, ...extraEnv },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (code === 2) throw new Error("Quit CogineBot Dev before changing its registration.");
  if (code !== 0) throw new Error("The development launcher could not complete the command.");
}

async function readLauncher() {
  const launcher = JSON.parse(await readFile(manifest, "utf8"));
  const development = parseDesktopDevelopment(launcher.development);
  const executable = await realpath(launcher.executable);
  const relative = path.relative(await realpath(output), executable);
  if (
    development.workspaceRoot !== workspaceRoot ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("Register this workspace before removing its launcher.");
  return executable;
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!["start", "register", "unregister"].includes(action))
    throw new Error("Choose start, register, or unregister.");
  if (action === "unregister") {
    if (args.length) throw new Error("Unregister does not take a Vite address.");
    const executable = await readLauncher();
    await run(executable, ["--coginebot-unregister-protocol"]);
    return;
  }
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--vite-url"))
    throw new Error("Use --vite-url with a local Vite address.");
  const development = parseDesktopDevelopment({
    workspaceRoot,
    viteUrl: args[1] ?? "http://localhost:5173",
  });
  if (action === "start") {
    const { default: electron } = await import("electron");
    await run(electron, ["."], {
      COGINEBOT_DESKTOP_DEVELOPMENT: JSON.stringify(development),
    });
    return;
  }
  // Refuse a routine rebuild before touching a launcher's files while it is running.
  let previous;
  try {
    previous = await readLauncher();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (previous) await run(previous, ["--coginebot-check-protocol"]);
  await mkdir(output, { recursive: true });
  const { build: base } = JSON.parse(
    await readFile(path.join(desktopRoot, "package.json"), "utf8"),
  );
  const configFile = path.join(output, "build-config.json");
  await writePrivateFile(
    configFile,
    JSON.stringify({
      ...developmentBuildConfiguration(development, output, base),
      afterPack: path.join(desktopRoot, "scripts/development-after-pack.mjs"),
    }),
  );
  await build({
    projectDir: desktopRoot,
    targets: Platform.current().createTarget(["dir"]),
    publish: "never",
    config: configFile,
  });
  const { executable } = JSON.parse(
    await readFile(path.join(output, "build-receipt.json"), "utf8"),
  );
  if (!executable) throw new Error("The development launcher was not built.");
  await run(executable, ["--coginebot-register-protocol"]);
  await writePrivateFile(manifest, JSON.stringify({ development, executable }));
}

await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
