import { spawn } from "node:child_process";
import { once } from "node:events";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComputerDiskProbeOutcomeSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  capturedWorkspaceDiskFull,
  workspaceDiskProbe,
  workspaceWrite,
} from "./workspace-disk-probe.js";

async function fixture<T>(test: (root: string) => Promise<T>) {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-diagnosis-"));
  try {
    return await test(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function python(
  script: string,
  args: string[],
  options: { stdin?: string; disconnect?: boolean; budget?: number } = {},
) {
  const child = spawn("python3", ["-I", "-S", "-c", script, ...args], {
    timeout: 5_000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr += text;
  });
  if (options.stdin !== undefined || options.disconnect) child.stdin.end(options.stdin);
  if (options.budget !== undefined) child.stdin.write(`${options.budget}\n`);
  const [code] = (await once(child, "close")) as [number];
  return { code, stdout, stderr };
}

describe.runIf(process.platform === "linux")("managed Linux workspace scanner", () => {
  it("returns volume capacity and bounded selected workspace metadata", () =>
    fixture(async (root) => {
      const make = (name: string) => path.join(root, name);
      await mkdir(make("bots/selected/nested/deeper/too-far"), { recursive: true });
      await mkdir(make("bots/other"), { recursive: true });
      await mkdir(make("bots/selected/secrets"), { recursive: true });
      await writeFile(make("bots/other/other.txt"), "another Bot");
      await writeFile(make("bots/selected/nested/report.txt"), "report file");
      await writeFile(make("bots/selected/a.txt"), "01");
      await writeFile(make("bots/selected/项目.txt"), "x");
      await writeFile(make("bots/selected/nested/deeper/too-far/file.txt"), "deep-only");
      await writeFile(make("bots/selected/.env"), "placeholder");
      await writeFile(make("bots/selected/secrets/key.txt"), "placeholder");
      await writeFile(make("bots/selected/STATE.SQLITE3"), "placeholder");
      await symlink(make("bots/other"), make("bots/selected/link"));
      await link(make("bots/other/other.txt"), make("bots/selected/hardlink.txt"));

      const result = await python(workspaceDiskProbe, [root, "selected"], { budget: 2000 });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(ComputerDiskProbeOutcomeSchema.parse(JSON.parse(result.stdout))).toEqual({
        status: "available",
        data: {
          volume: {
            totalBytes: expect.any(Number),
            availableBytes: expect.any(Number),
            availableInodes: expect.any(Number),
          },
          partial: true,
          candidates: [
            { path: "nested/report.txt", logicalBytes: 11 },
            { path: "a.txt", logicalBytes: 2 },
            { path: "项目.txt", logicalBytes: 1 },
          ],
        },
      });
    }));

  it("refuses a symlink in the workspace root or in the Team ancestry", () =>
    fixture(async (root) => {
      await mkdir(path.join(root, "target-bots", "selected"), { recursive: true });
      await symlink(path.join(root, "target-bots"), path.join(root, "bots"));
      await symlink(root, path.join(root, "linked-home"));
      for (const home of [root, path.join(root, "linked-home")]) {
        const result = await python(workspaceDiskProbe, [home, "selected"], { budget: 2000 });
        expect(JSON.parse(result.stdout)).toEqual({ status: "unavailable" });
      }
    }));

  it("caps results and makes omitted candidates explicit", () =>
    fixture(async (root) => {
      await Promise.all(
        Array.from({ length: 110 }, (_, index) =>
          writeFile(path.join(root, `entry-${index.toString().padStart(3, "0")}.txt`), "fixture"),
        ),
      );
      const result = await python(workspaceDiskProbe, [root, ""], { budget: 2000 });
      const output = ComputerDiskProbeOutcomeSchema.parse(JSON.parse(result.stdout));
      expect(output.status).toBe("available");
      if (output.status !== "available") return;
      expect(output.data.candidates).toHaveLength(100);
      expect(output.data.candidates[0]?.path).toBe("entry-000.txt");
      expect(output.data.candidates[99]?.path).toBe("entry-099.txt");
      expect(output.data.partial).toBe(true);
    }));

  it("terminates on the scanner deadline or input disconnect even in a stalled scan", () =>
    fixture(async (root) => {
      const blocked = `import os, time\nos.scandir = lambda *_: time.sleep(30)\n${workspaceDiskProbe}`;
      expect((await python(blocked, [root, ""], { budget: 50 })).code).toBe(124);
      const notStarted = `import os\ndef unexpected(*args, **kwargs): raise RuntimeError("traversed before authorization")\nos.open = unexpected\n${workspaceDiskProbe}`;
      expect(await python(notStarted, [root, ""], { disconnect: true })).toEqual({
        code: 125,
        stdout: "",
        stderr: "",
      });
    }));

  it("returns partial diagnostics when escaped names exceed the wire budget", () =>
    fixture(async (root) => {
      const deep = path.join(root, '"'.repeat(200), '"'.repeat(200));
      await mkdir(deep, { recursive: true });
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          writeFile(path.join(deep, `${'"'.repeat(100)}${i}.txt`), "fixture"),
        ),
      );
      const result = await python(workspaceDiskProbe, [root, ""], { budget: 2000 });
      const output = ComputerDiskProbeOutcomeSchema.parse(JSON.parse(result.stdout));
      expect(output.status).toBe("available");
      if (output.status !== "available") return;
      expect(output.data.candidates.length).toBeGreaterThan(0);
      expect(output.data.candidates.length).toBeLessThan(100);
      expect(output.data.partial).toBe(true);
      expect(Buffer.byteLength(result.stdout)).toBeLessThan(64 * 1024);
    }));

  it("accepts a fragmented startup budget", () =>
    fixture(async (root) => {
      const fragmented = `import os\nread = os.read\nos.read = lambda fd, size: read(fd, min(size, 1))\n${workspaceDiskProbe}`;
      const result = await python(fragmented, [root, ""], { budget: 2000 });
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "available" });
    }));
});

describe("managed workspace write failure receipts", () => {
  it.runIf(process.platform === "linux").each([
    [28, true],
    [13, false],
  ])("recognizes actual writer errno %s on the mounted workspace", (errno, recognized) =>
    fixture(async (root) => {
      const script = `import os\ndef fail(*args, **kwargs): raise OSError(${errno}, "synthetic")\nos.mkdir = fail\n${workspaceWrite}`;
      const outcome = await python(script, [root, "nested/notes.txt", "0"], { stdin: "" });
      expect(capturedWorkspaceDiskFull(outcome)).toBe(recognized);
    }),
  );

  it("does not classify stdout, tracebacks, or unknown exit codes as a receipt", () => {
    expect(
      capturedWorkspaceDiskFull({ code: 0, stdout: "workspace-write:ENOSPC:v1\n", stderr: "" }),
    ).toBe(false);
    expect(capturedWorkspaceDiskFull({ code: 77, stdout: "", stderr: "ENOSPC" })).toBe(false);
    expect(
      capturedWorkspaceDiskFull({
        code: 77,
        stdout: "workspace-write:ENOSPC:v1\n",
        stderr: "extra",
      }),
    ).toBe(false);
  });
});
