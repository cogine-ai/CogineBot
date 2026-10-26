import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { browserProfilePathForScreen } from "@rakazo/core/node/desktop-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { LinuxDesktop } from "./linux-desktop.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "linux-open-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const runtime = path.join(root, "runtime");
  const workspace = path.join(root, "workspace Ω #%");
  for (const directory of [bin, runtime, workspace]) mkdirSync(directory);
  const record = path.join(root, "opened.json");
  const launcher = path.join(bin, "browser");
  writeFileSync(
    launcher,
    [
      "#!/usr/bin/env python3",
      "import json, os, sys",
      "with open(os.environ['OPEN_RECORD'], 'w') as output:",
      "    json.dump({'argv': sys.argv[1:], 'profile': os.environ.get('CHROME_USER_DATA_DIR')}, output)",
      "",
    ].join("\n"),
  );
  chmodSync(launcher, 0o755);
  writeFileSync(path.join(bin, "xdg-open"), '#!/bin/sh\nprintf xdg >"$OPEN_RECORD"\n');
  chmodSync(path.join(bin, "xdg-open"), 0o755);
  const env = {
    homeDir: root,
    workspaceDir: workspace,
    browserProfilesDir: path.join(root, "profiles"),
    displayStart: 1,
  };
  const commands: string[] = [];
  const desktop = new LinuxDesktop({
    environment: async () => env,
    run: async (_computer, command) => {
      commands.push(command);
      if (command.includes("RAKAZO_DESKTOP="))
        return { code: 0, stdout: "RAKAZO_DESKTOP=0:view-token\n" };
      const result = spawnSync(
        "bash",
        [
          "-eu",
          "-c",
          command
            .replaceAll("/tmp/rakazo/browser-launch-1", launcher)
            .replaceAll("/tmp/rakazo", runtime),
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            OPEN_RECORD: record,
          },
          encoding: "utf8",
          timeout: 5_000,
        },
      );
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
    screenUrl: async () => "http://screen.example",
  });
  const context = {
    operationId: "test",
    traceId: "test",
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    screenLeaseId: "run:1",
    signal: new AbortController().signal,
  } as AdapterContext;
  const computer = {
    id: "computer-1",
    botId: "bot-1",
    kind: "e2b",
    providerRef: "test",
  } as ComputerRef;
  return { desktop, context, computer, env, commands, record, workspace };
}

it.each(["notes Ω #%.html", "nested/日本語 name.html"])(
  "opens workspace file %s in the bound browser with an unambiguous file URL",
  async (requested) => {
    const f = fixture();
    await f.desktop.act(
      f.computer,
      { actions: [{ kind: "open", path: requested }], observe: false },
      f.context,
    );
    const result = await vi.waitFor(() => {
      const recorded = readFileSync(f.record, "utf8");
      return {
        recorded,
        opened:
          recorded === "xdg" ? null : (JSON.parse(recorded) as { argv: string[]; profile: string }),
      };
    });
    const { recorded } = result;
    expect(recorded, "the existing browser launcher handles the file").not.toBe("xdg");
    const opened = result.opened!;
    expect(opened.argv).toHaveLength(1);
    const url = new URL(opened.argv[0]!);
    expect(url.protocol).toBe("file:");
    expect(url.hash).toBe("");
    expect(fileURLToPath(url, { windows: false })).toBe(path.posix.join(f.workspace, requested));
    expect(url.href).toContain("%23%25");
    expect(opened.profile).toBe(browserProfilePathForScreen("bot-1", f.env));
  },
);

it("forwards an HTTP URL unchanged through the same browser launcher", async () => {
  const f = fixture();
  const url = "https://example.test/a%20b#part";
  await f.desktop.act(
    f.computer,
    { actions: [{ kind: "open", path: url }], observe: false },
    f.context,
  );
  const opened = await vi.waitFor(
    () => JSON.parse(readFileSync(f.record, "utf8")) as { argv: string[] },
  );
  expect(opened.argv).toEqual([url]);
});

it("rejects workspace traversal before dispatching an open command", async () => {
  const f = fixture();
  await expect(
    f.desktop.act(
      f.computer,
      { actions: [{ kind: "open", path: "../outside.html" }], observe: false },
      f.context,
    ),
  ).rejects.toThrow("Path escapes the computer workspace");
  expect(f.commands).toHaveLength(1);
});
