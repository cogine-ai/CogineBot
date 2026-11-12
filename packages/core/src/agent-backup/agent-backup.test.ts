import { gzipSync, strToU8, zipSync } from "fflate";
import { expect, it } from "vitest";
import { encodeAgentBackup, readBotImportBytes } from "./index.js";

function tar(files: Record<string, string>, links: Record<string, string> = {}): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [path, text] of Object.entries({ ...files, ...links })) {
    const link = links[path];
    const isLink = link !== undefined;
    const content = strToU8(isLink ? "" : text);
    const header = new Uint8Array(512);
    header.set(strToU8(path));
    header.set(strToU8(content.length.toString(8).padStart(11, "0")), 124);
    header.fill(32, 148, 156);
    header[156] = isLink ? 50 : 48;
    if (isLink) header.set(strToU8(link), 157);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(strToU8(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
    chunks.push(header, content, new Uint8Array((512 - (content.length % 512)) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const archive = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  return gzipSync(archive);
}

it("reads an OpenClaw manifest and keeps the workspace ahead of managed skills", () => {
  const root = "backup/payload/posix";
  const backup = tar({
    "backup/manifest.json": JSON.stringify({
      schemaVersion: 1,
      archiveRoot: "backup",
      assets: [
        { kind: "state", archivePath: "payload/posix/state" },
        { kind: "workspace", archivePath: "payload/posix/workspace" },
      ],
    }),
    [`${root}/state/.env`]: "NEVER_UPLOAD_THIS_VALUE",
    [`${root}/state/skills/review/SKILL.md`]: "managed",
    [`${root}/workspace/SOUL.md`]: "Workspace persona",
    [`${root}/workspace/skills/review/SKILL.md`]: "selected",
    [`${root}/workspace/skills/review/references/checklist.md`]: "local only",
  });
  const result = JSON.parse(encodeAgentBackup(backup));
  expect(result.source).toBe("openclaw");
  expect(result.files).toEqual([
    { path: "SOUL.md", content: "Workspace persona" },
    { path: "skills/review/SKILL.md", content: "selected" },
  ]);
  expect(result.incompleteSkills).toEqual(["skills/review/SKILL.md"]);
});

it("reads Hermes ZIP notes without exposing config, credentials, and chat history", () => {
  const backup = zipSync({
    "config.yaml": strToU8("fixture key"),
    "auth.json": strToU8("fixture auth"),
    "memories/MEMORY.md": strToU8("One\n§\nTwo\n"),
    "sessions/history.md": strToU8("fixture history"),
  });
  expect(JSON.parse(readBotImportBytes(backup))).toMatchObject({
    source: "hermes",
    files: [{ path: "memories/MEMORY.md", content: "One\n§\nTwo\n" }],
  });
});

it("rejects a selected ZIP entry with a checksum or local path mismatch", () => {
  const backup = zipSync({ "HERMES.md": strToU8("Fixture instructions") });
  const checksum = backup.slice();
  const view = new DataView(checksum.buffer);
  const directory = view.getUint32(checksum.length - 6, true);
  view.setUint32(directory + 16, 0, true);
  expect(() => encodeAgentBackup(checksum)).toThrow("could not be read");
  const localName = backup.slice();
  localName[30] = 0x58;
  expect(() => encodeAgentBackup(localName)).toThrow("could not be read");
});

it("refuses ambiguous homes, unsafe paths, excessive expansion, and oversized text", () => {
  for (const files of [
    { ".openclaw/SOUL.md": "One", ".hermes/SOUL.md": "Two" },
    { "HERMES.md": "One", "../escape.md": "Two" },
    { "HERMES.md": "One", "ignored.bin": "x".repeat(4 * 1024 * 1024) },
    { "HERMES.md": "x".repeat(100_001) },
  ]) {
    const zipped = zipSync(
      Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
    );
    expect(() => encodeAgentBackup(zipped)).toThrow();
  }
});

it("does not silently pick one of multiple archived workspaces", () => {
  const backup = tar({
    "backup/manifest.json": JSON.stringify({
      schemaVersion: 1,
      archiveRoot: "backup",
      assets: [
        { kind: "state", archivePath: "state" },
        { kind: "workspace", archivePath: "first" },
        { kind: "workspace", archivePath: "second" },
      ],
    }),
    "backup/state/openclaw.json": "{}",
    "backup/first/SOUL.md": "First Bot",
    "backup/second/SOUL.md": "Second Bot",
  });
  expect(() => encodeAgentBackup(backup)).toThrow("could not be read");
});

it.each(["workspace", "custom-main"])(
  "does not replace internal %s with an external workspace",
  (folder) => {
    const backup = tar({
      "backup/manifest.json": JSON.stringify({
        schemaVersion: 1,
        assets: [
          { kind: "state", archivePath: "state" },
          { kind: "workspace", archivePath: "external" },
        ],
        ...(folder === "custom-main"
          ? { paths: { workspaceDirs: ["/state/custom-main", "/external"] } }
          : {}),
      }),
      [`backup/state/${folder}/SOUL.md`]: "Original Bot",
      "backup/external/SOUL.md": "Other Bot",
    });
    expect(() => encodeAgentBackup(backup)).toThrow("could not be read");
  },
);

it("lists linked Skill dependencies without reading their target or runtime file content", () => {
  const path = "skills/review/SKILL.md";
  const root = ".openclaw/workspace/";
  const backup = tar(
    { [`${root}${path}`]: "See ./guide.md", [`${root}TOOLS.md`]: "LOCAL_RUNTIME_TEXT" },
    { [`${root}skills/review/guide.md`]: "../../private.md" },
  );
  const source = encodeAgentBackup(backup);
  expect(source).not.toContain("LOCAL_RUNTIME_TEXT");
  expect(source).not.toContain("private.md");
  expect(JSON.parse(source)).toMatchObject({ incompleteSkills: [path] });
});
