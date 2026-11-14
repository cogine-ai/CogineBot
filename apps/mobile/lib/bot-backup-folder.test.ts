import {
  agentBackupFileGroups,
  agentBackupPreview,
  encodeAgentBackup,
} from "@rakazo/core/agent-backup";
import { strToU8, zipSync } from "fflate";
import { beforeEach, expect, it, vi } from "vitest";
import type { BackupFolderAccess } from "./bot-backup-folder";
import { pickBotBackupFolder } from "./bot-backup-folder";

const nativePlatform = vi.hoisted(() => ({ os: "ios" }));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return nativePlatform.os;
    },
  },
}));
beforeEach(() => {
  nativePlatform.os = "ios";
});

vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));

function fixture(files: Record<string, string>) {
  const bytes = Object.fromEntries(
    Object.entries(files).map(([path, text]) => [path, strToU8(text)]),
  );
  const access = {
    pick: vi.fn<BackupFolderAccess["pick"]>().mockResolvedValue({
      session: "selection",
      entries: Object.entries(bytes).map(([path, data]) => ({ path, size: data.length })),
    }),
    read: vi
      .fn<BackupFolderAccess["read"]>()
      .mockImplementation(async (_id, path, max) => [...bytes[path]!.slice(0, max)]),
    verify: vi.fn<BackupFolderAccess["verify"]>().mockResolvedValue(undefined),
    close: vi.fn<BackupFolderAccess["close"]>().mockResolvedValue(undefined),
  };
  return { access, bytes };
}

it.each(["openclaw", "hermes"])(
  "matches %s archive content, selections and dependency warnings",
  async (agent) => {
    const root = `.${agent}`;
    const { access, bytes } = fixture({
      [`${root}/SOUL.md`]: "Review synthetic reports.",
      [`${root}/MEMORY.md`]: "A synthetic note.",
      [`${root}/skills/report/SKILL.md`]:
        "---\nname: report\ndescription: Review reports.\n---\nRead the rows.",
      [`${root}/skills/report/.dependency`]: "A hidden companion.",
      [`${root}/skills/standalone/SKILL.md`]:
        "---\nname: standalone\ndescription: Review text.\n---\nRead text.",
      [`${root}/.env`]: "FAKE_KEY=fixture-only",
    });
    const selected = await pickBotBackupFolder(() => true, access);
    expect(selected).not.toBeNull();
    const archive = encodeAgentBackup(zipSync(bytes));
    expect(agentBackupFileGroups(selected!.source)).toEqual(agentBackupFileGroups(archive));
    expect(agentBackupFileGroups(selected!.source)?.unavailable).toContainEqual({
      path: "skills/report/SKILL.md",
      reason: "missingSkillFiles",
    });
    for (const memory of [true, false]) {
      const folderPreview = agentBackupPreview(selected!.source, memory);
      const archivePreview = agentBackupPreview(archive, memory);
      expect(folderPreview.backupOmissions).toEqual(archivePreview.backupOmissions);
      // ZIP record order is not semantic; folder inventories are sorted by path.
      const canonical = (source: string) => {
        const value = JSON.parse(source);
        value.files.sort((a: { path: string }, b: { path: string }) =>
          a.path.localeCompare(b.path),
        );
        return value;
      };
      expect(canonical(folderPreview.source)).toEqual(canonical(archivePreview.source));
    }
    expect(access.read.mock.calls.map((call) => call[1])).not.toContain(`${root}/.env`);
    expect(access.read.mock.calls.map((call) => call[1])).not.toContain(
      `${root}/skills/report/.dependency`,
    );
    selected!.dispose();
    selected!.dispose();
    expect(access.close).toHaveBeenCalledExactlyOnceWith("selection");
  },
);

it("returns cancellation without publishing or reading a source", async () => {
  const { access } = fixture({});
  access.pick.mockResolvedValue(null);
  expect(await pickBotBackupFolder(() => true, access)).toBeNull();
  expect(access.read).not.toHaveBeenCalled();
  expect(access.close).not.toHaveBeenCalled();
});

it("rejects builds without the native module", async () => {
  await expect(pickBotBackupFolder(() => true)).rejects.toThrow("folder_unavailable");
});

it.each(["permission_revoked", "incomplete_inventory", "provider_unavailable"])(
  "rejects %s instead of treating it as cancellation",
  async (reason) => {
    const { access } = fixture({});
    access.pick.mockRejectedValue(new Error(reason));
    await expect(pickBotBackupFolder(() => true, access)).rejects.toThrow(reason);
  },
);

it.each([".hermes/SOUL.md", ".hermes/config.yaml", ".hermes/cron/jobs.json"])(
  "rejects unreadable %s, including optional projection inputs",
  async (path) => {
    const { access } = fixture({ ".hermes/SOUL.md": "Synthetic text.", [path]: "{}" });
    const read = access.read.getMockImplementation()!;
    access.read.mockImplementation(async (...args) => {
      if (args[1] === path) throw new Error("permission_revoked");
      return read(...args);
    });
    await expect(pickBotBackupFolder(() => true, access)).rejects.toThrow("permission_revoked");
    expect(access.close).toHaveBeenCalledOnce();
  },
);

it.each(["short read", "grown file", "changed inventory", "stale scope"])(
  "does not publish %s",
  async (reason) => {
    const { access } = fixture({ ".openclaw/SOUL.md": "Synthetic text." });
    let current = true;
    if (reason === "short read") access.read.mockResolvedValue([65]);
    if (reason === "grown file") access.read.mockResolvedValue([...strToU8("Synthetic text.! ")]);
    if (reason === "changed inventory") access.verify.mockRejectedValue(new Error("changed"));
    if (reason === "stale scope")
      access.verify.mockImplementation(async () => {
        current = false;
      });
    await expect(pickBotBackupFolder(() => current, access)).rejects.toThrow();
    expect(access.close).toHaveBeenCalledOnce();
  },
);

it("releases a folder picked after its editor was closed", async () => {
  const { access } = fixture({ ".openclaw/SOUL.md": "Synthetic text." });
  let current = true;
  const result = await access.pick({ entries: 2000, fileBytes: 400000, readBytes: 4194304 });
  access.pick.mockImplementation(async () => {
    current = false;
    return result;
  });
  await expect(pickBotBackupFolder(() => current, access)).rejects.toThrow("scope_changed");
  expect(access.read).not.toHaveBeenCalled();
  expect(access.close).toHaveBeenCalledOnce();
});

it.each(["entry count", "file size", "total size", "duplicate path"])(
  "enforces shared %s limits before publishing",
  async (kind) => {
    const files =
      kind === "total size"
        ? Object.fromEntries(
            Array.from({ length: 12 }, (_, i) => [`.hermes/memories/${i}.md`, "a".repeat(399999)]),
          )
        : { ".openclaw/SOUL.md": "Synthetic text." };
    const { access } = fixture(files);
    const result = (await access.pick({ entries: 2000, fileBytes: 400000, readBytes: 4194304 }))!;
    if (kind === "entry count")
      result.entries = Array.from({ length: 2001 }, (_, i) => ({
        path: `.openclaw/${i}`,
        size: 0,
      }));
    if (kind === "file size") result.entries[0]!.size = 400001;
    if (kind === "duplicate path") result.entries.push({ ...result.entries[0]! });
    access.pick.mockResolvedValue(result);
    await expect(pickBotBackupFolder(() => true, access)).rejects.toThrow();
    expect(access.read).not.toHaveBeenCalled();
    expect(access.close).toHaveBeenCalledOnce();
  },
);

it("keeps credential reads opt-in and refuses revoked access or disposed sessions", async () => {
  const { access } = fixture({
    ".hermes/SOUL.md": "Synthetic text.",
    ".hermes/config.yaml":
      "model: { provider: openai-api, default: gpt-4.1, key_env: FIXTURE_KEY }",
    ".hermes/.env": "FIXTURE_KEY=synthetic-placeholder",
  });
  const selected = (await pickBotBackupFolder(() => true, access))!;
  expect(selected.source).not.toContain("synthetic-placeholder");
  expect(access.read.mock.calls.map((call) => call[1])).not.toContain(".hermes/.env");
  const model = { provider: "openai", modelId: "gpt-4.1" };
  expect(await selected.readKey(model)).toBe("synthetic-placeholder");
  access.verify.mockRejectedValueOnce(new Error("permission_revoked"));
  await expect(selected.readKey(model)).rejects.toThrow("permission_revoked");
  selected.dispose();
  await expect(selected.readKey(model)).rejects.toThrow("folder_closed");
});

it.each([false, true])(
  "fails closed on successful Android cursor results (hidden subtree omitted: %s)",
  async (omitHidden) => {
    const allFiles = {
      ".openclaw/SOUL.md": "Synthetic review bot.",
      ".openclaw/skills/report/SKILL.md":
        "---\nname: report\ndescription: Review reports.\n---\nRead rows.",
      ".openclaw/skills/report/.hidden/data.txt": "Dependency fixture.",
    };
    const files = { ...allFiles };
    if (omitHidden)
      delete (files as Record<string, string>)[".openclaw/skills/report/.hidden/data.txt"];
    const { access } = fixture(files);
    // Successful stable partial cursors have no reliable completeness signal. Neither
    // a second successful scan nor a full-looking cursor may authorize this backend.
    access.verify.mockResolvedValue(undefined);
    const full = encodeAgentBackup(zipSync(fixture(allFiles).bytes));
    expect(agentBackupFileGroups(full)?.unavailable).toContainEqual({
      path: "skills/report/SKILL.md",
      reason: "missingSkillFiles",
    });
    if (omitHidden) {
      const partial = encodeAgentBackup(zipSync(fixture(files).bytes));
      expect(agentBackupFileGroups(partial)?.skills).toContain("skills/report/SKILL.md");
    }
    nativePlatform.os = "android";
    await expect(pickBotBackupFolder(() => true, access)).rejects.toThrow(
      "folder_inventory_unverifiable",
    );
    expect(access.pick).toHaveBeenCalledOnce();
    expect(access.read).not.toHaveBeenCalled();
    expect(access.close).toHaveBeenCalledExactlyOnceWith("selection");
  },
);
