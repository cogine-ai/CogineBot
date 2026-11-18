import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopDevelopmentId } from "./desktop-environment.js";
import {
  desktopExecArgument,
  linuxProtocolEntry,
  linuxProtocolExecutable,
  linuxProtocolPaths,
  protocolAction,
  registerLinuxProtocol,
  removeProtocolAssociation,
  unregisterLinuxProtocol,
} from "./desktop-protocol.js";

const roots: string[] = [];
const install = {
  scheme: "coginebot-dev" as const,
  name: "CogineBot Dev",
  appId: desktopDevelopmentId("/workspace/one"),
  executable: "/workspace/one/out/CogineBot Dev",
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-protocol-"));
  roots.push(root);
  const env = {
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
  };
  const paths = linuxProtocolPaths(install, env);
  await mkdir(path.dirname(paths.file), { recursive: true });
  await mkdir(env.XDG_CONFIG_HOME, { recursive: true });
  return { root, env, paths };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop protocol registration", () => {
  it("registers an explicit development launcher with the selected executable", async () => {
    const f = await fixture();
    const run = vi.fn(async () => "");
    await registerLinuxProtocol(install, { env: f.env, explicit: true, run });
    expect(await readFile(f.paths.file, "utf8")).toContain(
      'Exec="/workspace/one/out/CogineBot Dev" %u',
    );
    expect(run).toHaveBeenLastCalledWith("xdg-mime", [
      "default",
      "coginebot-dev.desktop",
      "x-scheme-handler/coginebot-dev",
    ]);
  });

  it("keeps a person's different installed handler during an ordinary launch", async () => {
    const f = await fixture();
    const prod = {
      ...install,
      scheme: "coginebot" as const,
      appId: "ai.cogine.coginebot.desktop",
      name: "CogineBot",
    };
    const run = vi.fn(async () => "chosen.desktop");
    await registerLinuxProtocol(prod, { env: f.env, explicit: false, run });
    await expect(readFile(linuxProtocolPaths(prod, f.env).file)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("rebinds the development entry and prevents the old workspace removing it", async () => {
    const f = await fixture();
    const run = vi.fn(async () => "coginebot-dev.desktop");
    await registerLinuxProtocol(install, { env: f.env, explicit: true, run });
    const next = {
      ...install,
      appId: desktopDevelopmentId("/workspace/two"),
      executable: "/workspace/two/out/CogineBot Dev",
    };
    await registerLinuxProtocol(next, { env: f.env, explicit: true, run });
    const current = await readFile(f.paths.file, "utf8");
    expect(current).toContain("/workspace/two/out/CogineBot Dev");
    expect(await unregisterLinuxProtocol(install, f.env)).toBe(false);
    expect(await readFile(f.paths.file, "utf8")).toBe(current);
    expect(await unregisterLinuxProtocol(next, f.env)).toBe(true);
  });

  it("does not overwrite an unrelated desktop entry or remove a manually edited launcher", async () => {
    const f = await fixture();
    await writeFile(f.paths.file, "[Desktop Entry]\nName=Another application\n");
    const run = vi.fn(async () => "");
    await expect(
      registerLinuxProtocol(install, { env: f.env, explicit: true, run }),
    ).rejects.toThrow("Another application");
    expect(run).toHaveBeenCalledOnce();
    const edited = linuxProtocolEntry(install).replace("/workspace/one", "/workspace/edited");
    await writeFile(f.paths.file, edited);
    expect(await unregisterLinuxProtocol(install, f.env)).toBe(false);
    expect(await readFile(f.paths.file, "utf8")).toBe(edited);
  });

  it("removes only its development associations and retains other schemes, handlers and permissions", async () => {
    const f = await fixture();
    await writeFile(f.paths.file, linuxProtocolEntry(install));
    const file = path.join(f.env.XDG_CONFIG_HOME, "mimeapps.list");
    const contents =
      "# Keep this\r\n[Default Applications]\r\nx-scheme-handler/cogine=work.desktop;\r\nx-scheme-handler/coginebot=installed.desktop;\r\nx-scheme-handler/coginebot-dev=foreign.desktop;coginebot-dev.desktop;\r\n[Added Associations]\r\nx-scheme-handler/coginebot-dev=coginebot-dev.desktop;\r\n";
    await writeFile(file, contents, { mode: 0o644 });
    expect(await unregisterLinuxProtocol(install, f.env)).toBe(true);
    expect(await readFile(file, "utf8")).toBe(
      contents
        .replace("foreign.desktop;coginebot-dev.desktop;", "foreign.desktop;")
        .replace("x-scheme-handler/coginebot-dev=coginebot-dev.desktop;\r\n", ""),
    );
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    await expect(readFile(f.paths.file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await unregisterLinuxProtocol(install, f.env)).toBe(false);
  });

  it("does not alter a key in an unrelated section", () => {
    const contents = "[Other]\nx-scheme-handler/coginebot-dev=coginebot-dev.desktop;\n";
    expect(
      removeProtocolAssociation(
        contents,
        "x-scheme-handler/coginebot-dev",
        "coginebot-dev.desktop",
      ),
    ).toBe(contents);
  });

  it("uses the original AppImage only when this executable belongs to its extraction", () => {
    const env = { APPIMAGE: "/downloads/CogineBot.AppImage", APPDIR: "/tmp/extracted" };
    expect(linuxProtocolExecutable("/tmp/extracted/coginebot", env)).toBe(env.APPIMAGE);
    expect(linuxProtocolExecutable("/tmp/extracted-other/dev", env)).toBe(
      "/tmp/extracted-other/dev",
    );
    expect(linuxProtocolExecutable("/workspace/dev", env)).toBe("/workspace/dev");
  });

  it("escapes reserved executable characters without making the URL an argument template", () => {
    const encoded = desktopExecArgument('/workspace/100% $money/"quoted"/`literal`/back\\slash');
    expect(encoded).toContain("100%%");
    expect(encoded).toContain("\\\\$");
    expect(encoded).toContain('\\\\"');
    expect(encoded).toContain("\\\\`");
    expect(encoded).toContain("\\\\\\\\");
    expect(() => desktopExecArgument("/workspace/line\ncommand")).toThrow();
  });

  it("requires a standalone registration flag rather than interpreting link contents", () => {
    expect(protocolAction(["--coginebot-register-protocol"])).toBe("register");
    expect(protocolAction(["--coginebot-check-protocol"])).toBe("check");
    expect(protocolAction(["--coginebot-unregister-protocol"])).toBe("unregister");
    expect(protocolAction(["coginebot-dev://bot/?--coginebot-register-protocol"])).toBeUndefined();
    expect(() =>
      protocolAction(["--coginebot-register-protocol", "--coginebot-unregister-protocol"]),
    ).toThrow();
  });
});
