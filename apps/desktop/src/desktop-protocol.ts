import { execFile, spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DesktopScheme } from "./desktop-environment.js";
import { writePrivateFile } from "./setup-store.js";

const execFileAsync = promisify(execFile);

export interface DesktopProtocolInstall {
  scheme: DesktopScheme;
  name: string;
  appId: string;
  executable: string;
}

export type ProtocolCommand = (command: string, args: string[]) => Promise<string>;

export async function runProtocolCommand(
  command: string,
  args: string[],
  env = process.env,
  lockFd?: number,
): Promise<string> {
  if (lockFd !== undefined) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env,
        windowsHide: true,
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe", lockFd],
      });
      const chunks: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
      let bytes = 0;
      for (const name of ["stdout", "stderr"] as const) {
        child[name]!.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            child.kill();
            reject(new Error("Desktop protocol command output is too large."));
          } else chunks[name].push(chunk);
        });
      }
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(Buffer.concat(chunks.stdout).toString("utf8").trim());
        else {
          const detail = Buffer.concat(chunks.stderr).toString("utf8").trim();
          reject(new Error(detail || `Desktop protocol command failed (${code}).`));
        }
      });
    });
  }
  const { stdout } = await execFileAsync(command, args, {
    timeout: 15_000,
    windowsHide: true,
    env,
  });
  return stdout.trim();
}

/** AppImage's original file is stable; the executable under APPDIR is temporary. */
export function linuxProtocolExecutable(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.APPIMAGE && env.APPDIR) {
    const relative = path.relative(env.APPDIR, executable);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      return env.APPIMAGE;
  }
  return executable;
}

export function protocolAction(args: readonly string[]) {
  const actions = (["register", "unregister", "check"] as const).filter((action) =>
    args.includes(`--coginebot-${action}-protocol`),
  );
  if (actions.length > 1) throw new Error("Choose one protocol registration action.");
  return actions[0];
}

/** Desktop Entry string escaping happens before Exec argument unquoting. */
export function desktopExecArgument(value: string): string {
  if (/[\r\n\0=]/.test(value)) throw new Error("Unsupported desktop launcher path.");
  return `"${value
    .replaceAll("\\", "\\\\\\\\")
    .replace(/["`$]/g, (character) => `\\\\${character}`)
    .replaceAll("%", "%%")}"`;
}

export function linuxProtocolEntry(install: DesktopProtocolInstall): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${install.name}`,
    `Exec=${desktopExecArgument(install.executable)} %u`,
    "Terminal=false",
    "Categories=Utility;",
    `MimeType=x-scheme-handler/${install.scheme};`,
    `X-CogineBot-AppId=${install.appId}`,
    "",
  ].join("\n");
}

export function linuxProtocolPaths(
  install: DesktopProtocolInstall,
  env: NodeJS.ProcessEnv = process.env,
) {
  const config = env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  const applications = path.join(
    env.XDG_DATA_HOME || path.join(homedir(), ".local/share"),
    "applications",
  );
  const desktops = (env.XDG_CURRENT_DESKTOP ?? "")
    .split(":")
    .filter((desktop) => /^[a-z0-9_-]+$/i.test(desktop))
    .map((desktop) => desktop.toLowerCase());
  return {
    filename: `${install.scheme}.desktop`,
    file: path.join(applications, `${install.scheme}.desktop`),
    lockFile: path.join(applications, ".coginebot-protocols.lock"),
    associations: [
      path.join(config, "mimeapps.list"),
      path.join(applications, "mimeapps.list"),
      ...desktops.flatMap((desktop) => [
        path.join(config, `${desktop}-mimeapps.list`),
        path.join(applications, `${desktop}-mimeapps.list`),
      ]),
    ],
  };
}

/** All our schemes update shared mimeapps files; keep one kernel lock across them. */
async function withLinuxProtocolLock<T>(
  paths: ReturnType<typeof linuxProtocolPaths>,
  update: (fd: number) => Promise<T>,
): Promise<T> {
  await mkdir(path.dirname(paths.lockFile), { recursive: true });
  const lock = await open(paths.lockFile, "a", 0o600);
  try {
    // flock inherits the same open file description on fd 3. The parent retains
    // the lock after the short helper exits, including across awaited writes.
    const result = spawnSync("flock", ["-xn", "3"], {
      stdio: ["ignore", "ignore", "pipe", lock.fd],
      timeout: 15_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Desktop link registration is busy. Try again.");
    return await update(lock.fd);
  } finally {
    // Keep the coordination inode; closing releases the kernel lock even on
    // process termination, without a stale PID file or unlink/rebind race.
    await lock.close();
  }
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function registerLinuxProtocol(
  install: DesktopProtocolInstall,
  options: { explicit: boolean; env?: NodeJS.ProcessEnv; run?: ProtocolCommand },
): Promise<void> {
  const paths = linuxProtocolPaths(install, options.env);
  return withLinuxProtocolLock(paths, async (fd) => {
    // A registry writer retains the lock even if this Electron process exits.
    const run =
      options.run ?? ((command, args) => runProtocolCommand(command, args, options.env, fd));
    const mime = `x-scheme-handler/${install.scheme}`;
    const current = await run("xdg-mime", ["query", "default", mime]);
    // An ordinary launch keeps the person's existing OS handler choice.
    if (!options.explicit && current && current !== paths.filename) return;
    const old = await readOptional(paths.file);
    if (
      old !== null &&
      !old.includes(`\nX-CogineBot-AppId=${install.appId}\n`) &&
      !(
        options.explicit &&
        install.scheme === "coginebot-dev" &&
        /\nX-CogineBot-AppId=ai\.cogine\.coginebot\.desktop\.dev-[a-f0-9]{12}\n/.test(old)
      )
    )
      throw new Error("Another application owns that desktop launcher.");
    await mkdir(path.dirname(paths.file), { recursive: true });
    await writePrivateFile(paths.file, linuxProtocolEntry(install));
    await run("xdg-mime", ["default", paths.filename, mime]);
  });
}

/** Remove only this handler from its protocol, retaining other keys and handlers. */
export function removeProtocolAssociation(
  contents: string,
  mime: string,
  filename: string,
): string {
  let section = "";
  return contents
    .split(/(?<=\n)/)
    .map((line) => {
      const body = line.replace(/\r?\n$/, "");
      const header = /^\[([^\]]+)\]\s*$/.exec(body);
      if (header) section = header[1] ?? "";
      if (!["Default Applications", "Added Associations", "Removed Associations"].includes(section))
        return line;
      const equals = body.indexOf("=");
      if (equals < 0 || body.slice(0, equals).trim() !== mime) return line;
      const entries = body
        .slice(equals + 1)
        .split(";")
        .filter(Boolean);
      if (!entries.includes(filename)) return line;
      const kept = entries.filter((entry) => entry !== filename);
      if (kept.length === 0) return "";
      const newline = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
      return `${body.slice(0, equals + 1)}${kept.join(";")};${newline}`;
    })
    .join("");
}

export async function unregisterLinuxProtocol(
  install: DesktopProtocolInstall,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  const paths = linuxProtocolPaths(install, env);
  return withLinuxProtocolLock(paths, async () => {
    const expected = linuxProtocolEntry(install);
    if ((await readOptional(paths.file)) !== expected) return false;
    for (const file of new Set(paths.associations)) {
      const contents = await readOptional(file);
      if (contents === null) continue;
      const next = removeProtocolAssociation(
        contents,
        `x-scheme-handler/${install.scheme}`,
        paths.filename,
      );
      if (next === contents) continue;
      const mode = (await stat(file)).mode & 0o777;
      await writePrivateFile(file, next);
      await chmod(file, mode);
    }
    // Check ownership again before deleting, including a launcher rebound by
    // another workspace or edited outside this application.
    if ((await readOptional(paths.file)) !== expected) return false;
    await unlink(paths.file);
    return true;
  });
}
