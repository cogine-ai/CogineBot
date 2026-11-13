import { BOT_PACKAGE_MAX_BYTES } from "@rakazo/contracts";
import { gzipSync, strToU8, zipSync } from "fflate";
import { expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseSkillMd } from "../agent-skill.js";
import {
  agentBackupFileGroups,
  agentBackupPreview,
  agentBackupSelectableGroups,
  encodeAgentBackup,
  encodeAgentBackupFolder,
  readBotImportBytes,
  renameBackupSkill,
} from "./index.js";

function folderEntry(path: string, text: string | Uint8Array = "", size?: number) {
  const bytes = typeof text === "string" ? strToU8(text) : text;
  return { path, size: size ?? bytes.length, read: vi.fn(async () => bytes) };
}

it("reads only the selected workspace and flags Skill dependencies by name", async () => {
  const soul = folderEntry(".openclaw/workspace-reports/SOUL.md", "\uFEFFReview rows.\r\n");
  const skill = folderEntry(
    ".openclaw/workspace-reports/skills/report/SKILL.md",
    "---\nname: report\ndescription: Read a report.\n---\nCheck each row.\n",
  );
  const localOnly = [
    folderEntry(".openclaw/.env", "fixture secret", 9_000_000),
    folderEntry(".openclaw/cron/jobs.json", "fixture jobs"),
    folderEntry(".openclaw/workspace-reports/HEARTBEAT.md", "fixture runtime"),
    folderEntry(
      ".openclaw/workspace-reports/skills/report/references/table.md",
      "fixture reference",
    ),
    folderEntry(".openclaw/SOUL.md", "home persona"),
    folderEntry(".openclaw/skills/report/SKILL.md", "managed Skill"),
  ];
  const config = folderEntry(
    ".openclaw/openclaw.json",
    "{ agents: { defaults: { model: 'openai/gpt-4.1' } } }",
  );
  const result = JSON.parse(
    await encodeAgentBackupFolder([soul, skill, config, ...localOnly], () => true),
  );
  expect(result).toMatchObject({
    source: "openclaw",
    files: [
      { path: "HEARTBEAT.md", content: "" },
      { path: "SOUL.md", content: "\uFEFFReview rows.\r\n" },
      { path: "skills/report/SKILL.md" },
    ],
    incompleteSkills: ["skills/report/SKILL.md"],
    routineOmissions: [{ path: "cron/jobs.json", reason: "routineOwner" }],
    model: "unavailable",
  });
  expect(config.read).toHaveBeenCalledOnce();
  expect(soul.read).toHaveBeenCalledExactlyOnceWith(soul.size + 1);
  expect(skill.read).toHaveBeenCalledOnce();
  for (const file of localOnly) expect(file.read).not.toHaveBeenCalled();
});

it("projects only the Hermes model from a folder or archive and sends it after selection", async () => {
  const config = [
    "model:",
    "  provider: gemini",
    "  default: gemini-2.5-pro",
    "  base_url: ''",
    "  api_key: fixture-value",
    "mcp_servers:",
    "  fixture: { url: 'https://example.test/synthetic' }",
  ].join("\n");
  const source = await encodeAgentBackupFolder(
    [
      folderEntry("profile/HERMES.md", "Review sources."),
      folderEntry("profile/config.yaml", config),
    ],
    () => true,
  );
  const archive = encodeAgentBackup(
    zipSync({
      "HERMES.md": strToU8("Review sources."),
      "config.yaml": strToU8(config),
    }),
  );
  const model = { provider: "google", modelId: "gemini-2.5-pro" };
  for (const backup of [source, archive]) {
    expect(JSON.parse(backup).model).toEqual(model);
    expect(backup).not.toContain("fixture-value");
    expect(backup).not.toContain("example.test");
    expect(JSON.parse(agentBackupPreview(backup, false).source)).not.toHaveProperty("model");
    expect(JSON.parse(agentBackupPreview(backup, false, [], [], true).source).model).toEqual(model);
    const modelOnly = agentBackupPreview(backup, false, ["HERMES.md"], [], true);
    expect(JSON.parse(modelOnly.source)).toMatchObject({ files: [], model });
  }
});

it.each([
  ["model: { default: { provider: openai, model: gpt-4.1 } }", "openai"],
  ["model: { provider: auto, model: { provider: openai, default: gpt-4.1 } }", "openai"],
  ["model: { provider: azure, default: { provider: openai, model: gpt-4.1 } }", "azure"],
  ["model: { name: { provider: openai, model: gpt-4.1 } }", "openai"],
  ["model: gpt-4.1\nprovider: openai", "openai"],
  ["model: { provider: openai, default: { model: '  ', default: old }, name: gpt-4.1 }", "openai"],
  ["model: { provider: openai, default: gpt-4.1, model: old, name: older }", "openai"],
])("normalizes a supported Hermes model preference (%s)", (config, provider) => {
  const backup = encodeAgentBackup(
    zipSync({
      "HERMES.md": strToU8("Review sources."),
      "config.yaml": strToU8(config),
    }),
  );
  expect(JSON.parse(backup).model).toEqual({ provider, modelId: "gpt-4.1" });
});

it.each([
  ["anthropic", "anthropic/claude-opus-4.6", "claude-opus-4-6"],
  ["anthropic", "anthropic:claude-opus-4.6", "claude-opus-4-6"],
  ["anthropic", "other/claude-opus-4.6", "other/claude-opus-4.6"],
  ["openai-codex", "openai:gpt-4.1", "gpt-4.1"],
  ["openrouter", "anthropic/claude-opus-4.6", "anthropic/claude-opus-4.6"],
  ["deepseek", "deepseek:deepseek-chat", "deepseek-flash"],
  ["deepseek", "deepseek-reasoner", "deepseek-flash"],
  ["xiaomi", "xiaomi/MiMo-V2.5-Pro", "mimo-v2.5-pro"],
])("keeps the provider's model naming convention (%s %s)", (provider, value, modelId) => {
  const config = `model: { provider: ${provider}, default: '${value}' }`;
  const backup = encodeAgentBackup(
    zipSync({ "HERMES.md": strToU8("Read this."), "config.yaml": strToU8(config) }),
  );
  expect(JSON.parse(backup).model).toEqual({ provider, modelId });
});

it.each([
  "model: { provider: openrouter, default: anthropic/claude-opus-4.6, base_url: 'https://openrouter.ai/api/v1/' }",
  "base_url: 'https://openrouter.ai/api/v1'\nmodel: { provider: openrouter, default: anthropic/claude-opus-4.6 }",
])("projects a saved canonical endpoint without copying the address (%s)", (config) => {
  const backup = encodeAgentBackup(
    zipSync({ "HERMES.md": strToU8("Read this."), "config.yaml": strToU8(config) }),
  );
  expect(JSON.parse(backup).model).toEqual({
    provider: "openrouter",
    modelId: "anthropic/claude-opus-4.6",
  });
  expect(backup).not.toContain("openrouter.ai");
});

it("omits a credential-shaped model ID before normalization", () => {
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig";
  const backup = encodeAgentBackup(
    zipSync({
      "HERMES.md": strToU8("Read this."),
      "config.yaml": strToU8(`model: { provider: anthropic, default: 'anthropic:${token}' }`),
    }),
  );
  expect(JSON.parse(backup).model).toBe("unavailable");
  expect(backup).not.toContain(token);
  expect(backup).not.toContain(token.replaceAll(".", "-"));
});

it("omits a model ID that becomes credential-shaped after normalization", () => {
  const candidate = "SK-FIXTURENOTACREDENTIAL123";
  const backup = encodeAgentBackup(
    zipSync({
      "HERMES.md": strToU8("Read this."),
      "config.yaml": strToU8(`model: { provider: deepseek, default: '${candidate}' }`),
    }),
  );
  expect(JSON.parse(backup).model).toBe("unavailable");
  expect(backup).not.toContain(candidate);
  expect(backup).not.toContain(candidate.toLowerCase());
});

it("accepts a declared workspace containing only an attributable model preference", () => {
  const model = { provider: "openai", modelId: "gpt-4.1" };
  const files = {
    "backup/manifest.json": JSON.stringify({
      schemaVersion: 1,
      archiveRoot: "backup",
      paths: { stateDir: "/state", workspaceDirs: ["/state/workspace"] },
      assets: [{ kind: "state", archivePath: "state" }],
    }),
    "backup/state/openclaw.json": JSON.stringify({
      agents: { entries: { main: { workspace: "/state/workspace", model: "openai/gpt-4.1" } } },
    }),
    "backup/state/workspace/notes.txt": "Unsupported file.",
    "backup/state/skills/reports/SKILL.md": "Managed Skill outside the selected workspace.",
  };
  const backup = encodeAgentBackup(tar(files));
  expect(JSON.parse(backup)).toMatchObject({ files: [], model });
  expect(JSON.parse(agentBackupPreview(backup, false, [], [], true).source)).toMatchObject({
    files: [],
    model,
  });
  expect(backup).not.toContain("Managed Skill");
  expect(() => encodeAgentBackup(tar({ ...files, "backup/state/openclaw.json": "{}" }))).toThrow(
    "The backup could not be read.",
  );
  expect(() =>
    encodeAgentBackup(tar({ ...files, "backup/state/agents/main/agent/models.json": "{}" })),
  ).toThrow("The backup could not be read.");
});

it("reports an unavailable declared active configuration without using the home fallback", () => {
  const root = "backup";
  const value = encodeAgentBackup(
    tar({
      [`${root}/manifest.json`]: JSON.stringify({
        schemaVersion: 1,
        archiveRoot: root,
        paths: {
          stateDir: "/state",
          configPath: "/external/openclaw.json",
          workspaceDirs: ["/state/workspace"],
        },
        assets: [
          { kind: "state", archivePath: "state" },
          {
            kind: "config",
            archivePath: "external/openclaw.json",
            sourcePath: "/external/openclaw.json",
          },
        ],
      }),
      [`${root}/external/openclaw.json`]: "x".repeat(400_001),
      [`${root}/state/openclaw.json`]: JSON.stringify({
        agents: { defaults: { model: "openai/gpt-4.1" } },
      }),
      [`${root}/state/workspace/SOUL.md`]: "Review the source.",
    }),
  );
  expect(JSON.parse(value)).toMatchObject({ model: "unavailable", files: [{ path: "SOUL.md" }] });
  expect(value).not.toContain("gpt-4.1");
});

it.each([
  "model: { provider: openrouter, default: anthropic/claude-opus-4.6 }\nproviders: { openrouter: { base_url: 'https://openrouter.ai/api/v1' } }",
  "model: { provider: openrouter, default: anthropic/claude-opus-4.6, base_url: 'https://openrouter.ai/other' }",
  "model: { provider: openrouter, default: anthropic/claude-opus-4.6, base_url: 'https://openrouter.ai/api/v1?token=fixture' }",
  "model: { provider: anthropic, default: claude-opus-4.6, base_url: 'https://openrouter.ai/api/v1' }",
  "provider: openai\nmodel: { provider: '   ', default: gpt-4.1 }",
  "provider: openai\nmodel: { provider: 123, default: gpt-4.1 }",
  "model: { provider: 123, default: { provider: openai, model: gpt-4.1 } }",
  "model: { provider: openai, default: '   ', model: gpt-4.1 }",
  "model: { provider: openai, default: 123, model: gpt-4.1 }",
  "model: { provider: openai, default: { model: 123, default: gpt-4.1 } }",
  "model: { default: { provider: openai, model: gpt-4.1, api_base: 'https://example.test' } }",
  "model: { default: { provider: openai, model: gpt-4.1 } }\nproviders: { openai: { api: 'https://example.test' } }",
  "model: { provider: openai, default: gpt-4.1, base_url: 'https://example.test/v1' }",
  "model: { provider: openai, default: gpt-4.1 }\nproviders: { openai: { base_url: 'https://example.test' } }",
  "model: { provider: openai, default: gpt-4.1 }\nproviders: { openai: { api: 'https://example.test' } }",
  "model: { provider: openai, default: gpt-4.1 }\napi_base: 'https://example.test'",
  "model: { provider: openai, default: gpt-4.1 }\nmodel_aliases: { gpt-4.1: { model: other } }",
  "model: { provider: openai, default: 'https://example.test/unknown' }",
  "model: { provider: openai, provider: anthropic, default: gpt-4.1 }",
  "model: &cycle { provider: openai, default: gpt-4.1, child: *cycle }",
])(
  "reports nonportable or malformed Hermes config without transmitting it (%s)",
  async (config) => {
    const backup = await encodeAgentBackupFolder(
      [
        folderEntry("profile/HERMES.md", "Review sources."),
        folderEntry("profile/config.yaml", config),
      ],
      () => true,
    );
    expect(JSON.parse(backup).model).toBe("unavailable");
    expect(backup).not.toContain("example.test");
  },
);

it("reads Hermes notes and routines and keeps customized Skills even when names are listed", async () => {
  const customized = folderEntry(
    "agent/skills/report/SKILL.md",
    "---\nname: report\ndescription: Review a report.\n---\nUser-edited checklist.\n",
  );
  const renamed = folderEntry(
    "agent/skills/renamed/SKILL.md",
    "---\nname: earlier\ndescription: Review a report.\n---\nRenamed local Skill.\n",
  );
  const manifest = folderEntry(
    "agent/skills/.bundled_manifest",
    "report:fixture-origin\r\nearlier\r\n",
  );
  const jobs = folderEntry(
    "agent/cron/jobs.json",
    JSON.stringify({
      jobs: [
        {
          name: "Daily report",
          prompt: "Review rows.",
          schedule: { kind: "cron", expr: "0 9 * * *" },
          timezone: "UTC",
          deliver: "local",
        },
      ],
    }),
  );
  const files = [
    folderEntry("agent/.hermes.md", "Review sources."),
    folderEntry("agent/memories/MEMORY.md", "Private note"),
    folderEntry("agent/skills/custom/SKILL.md", "custom Skill"),
    manifest,
    customized,
    renamed,
    jobs,
  ];
  const result = await encodeAgentBackupFolder(files, () => true);
  expect(JSON.parse(result)).toMatchObject({
    source: "hermes",
    files: [
      { path: ".hermes.md", content: "Review sources." },
      { path: "memories/MEMORY.md", content: "Private note" },
      { path: "skills/custom/SKILL.md", content: "custom Skill" },
      { path: "skills/renamed/SKILL.md", content: expect.stringContaining("Renamed local Skill.") },
      {
        path: "skills/report/SKILL.md",
        content: expect.stringContaining("User-edited checklist."),
      },
      { path: "cron/routine-1.json", content: expect.stringContaining("Review rows.") },
    ],
  });
  expect(agentBackupFileGroups(result)?.skills).toEqual([
    "skills/renamed/SKILL.md",
    "skills/report/SKILL.md",
  ]);
  expect(manifest.read).not.toHaveBeenCalled();
  expect(jobs.read).toHaveBeenCalledOnce();
  expect(customized.read).toHaveBeenCalledOnce();
  expect(renamed.read).toHaveBeenCalledOnce();
});

it("preserves a boundary-sized folder when optional model metadata does not fit", async () => {
  const soul = folderEntry("profile/HERMES.md", "Review sources.");
  const escapedNotes = Array.from({ length: 6 }, (_, index) =>
    folderEntry(`profile/skills/review-${index}/SKILL.md`, "\u0001".repeat(100_000)),
  );
  const remainder = folderEntry("profile/skills/remainder/SKILL.md");
  const bytes = (value: string) => new TextEncoder().encode(value).length;
  const empty = await encodeAgentBackupFolder([soul, ...escapedNotes, remainder], () => true);
  const missing = BOT_PACKAGE_MAX_BYTES - bytes(empty);
  const end = folderEntry(
    remainder.path,
    "\u0001".repeat(Math.floor(missing / 6)) + "x".repeat(missing % 6),
  );
  const config = folderEntry(
    "profile/config.yaml",
    "model: { provider: openai-api, default: gpt-4.1 }",
  );
  const backup = await encodeAgentBackupFolder([soul, ...escapedNotes, end, config], () => true);
  expect(bytes(backup)).toBe(BOT_PACKAGE_MAX_BYTES);
  expect(JSON.parse(backup)).not.toHaveProperty("model");
});

it("offers Hermes content even if the optional routine store exceeds the read limit", async () => {
  const soul = folderEntry(".hermes/SOUL.md", "Review the source.");
  const jobs = folderEntry(".hermes/cron/jobs.json", "", 400_001);
  expect(JSON.parse(await encodeAgentBackupFolder([soul, jobs], () => true))).toMatchObject({
    source: "hermes",
    files: [{ path: "SOUL.md", content: "Review the source." }],
    routineOmissions: [{ path: "cron/jobs.json", reason: "routineSchedule" }],
  });
  expect(jobs.read).not.toHaveBeenCalled();
});

it("preserves Hermes text when the optional jobs file becomes unreadable", async () => {
  const soul = folderEntry(".hermes/SOUL.md", "Review the source.");
  const jobs = folderEntry(".hermes/cron/jobs.json", "{}");
  jobs.read.mockRejectedValueOnce(new DOMException("File missing", "NotFoundError"));
  expect(JSON.parse(await encodeAgentBackupFolder([soul, jobs], () => true))).toMatchObject({
    files: [{ path: "SOUL.md", content: "Review the source." }],
    routineOmissions: [{ path: "cron/jobs.json", reason: "routineSchedule" }],
  });
  let current = true;
  jobs.read.mockImplementationOnce(async () => {
    current = false;
    return strToU8("{}");
  });
  await expect(encodeAgentBackupFolder([soul, jobs], () => current)).rejects.toMatchObject({
    reason: "unreadable",
  });
});

it("does not offer Skills linking to files absent from the picker inventory", async () => {
  const skill = (name: string, body: string) =>
    folderEntry(
      `agent/skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: Review the source.\n---\n${body}\n`,
    );
  const folder = await encodeAgentBackupFolder(
    [
      folderEntry("agent/SOUL.md", "Review rows."),
      skill("local-autolink", "Read <file:///example/helper.txt>."),
      skill("local-file", "Read [the helper](helper.txt)."),
      skill("local-reference", "Read [the helper][ref].\n\n[ref]: <folder/file name.md>"),
      skill(
        "local-first",
        "> [ref]: helper.txt\n\n[ref]: https://example.test\n\nRead [the helper][ref].",
      ),
      skill("external", "Read [the docs](https://example.test) and [the heading](#summary)."),
      skill("unused", "Review rows.\n\n[unused]: helper.txt"),
    ],
    () => true,
  );
  expect(agentBackupFileGroups(folder)).toMatchObject({
    skills: ["skills/external/SKILL.md", "skills/unused/SKILL.md"],
    unavailable: [
      { path: "skills/local-autolink/SKILL.md", reason: "missingSkillFiles" },
      { path: "skills/local-file/SKILL.md", reason: "missingSkillFiles" },
      { path: "skills/local-first/SKILL.md", reason: "missingSkillFiles" },
      { path: "skills/local-reference/SKILL.md", reason: "missingSkillFiles" },
    ],
  });
  const archiveSkill = skill("local-file", "Read [the helper](helper.txt).");
  const archive = zipSync({
    "IDENTITY.md": strToU8("- Name: Review"),
    "skills/local-file/SKILL.md": await archiveSkill.read(),
  });
  expect(agentBackupFileGroups(encodeAgentBackup(archive))?.skills).toEqual([
    "skills/local-file/SKILL.md",
  ]);
});

it.each([
  ["other/AGENTS.md", "mixed roots"],
  ["agent/../AGENTS.md", "parent segments"],
  ["agent/SOUL.md", "duplicate entries"],
  ["agent/soul.md", "case collisions"],
  ["agent/dir\\AGENTS.md", "nonportable separators"],
])("rejects %s before reading either file (%s)", async (path) => {
  const first = folderEntry("agent/SOUL.md", "Review rows.");
  const second = folderEntry(path);
  await expect(encodeAgentBackupFolder([first, second], () => true)).rejects.toMatchObject({
    reason: "unreadable",
  });
  expect(first.read).not.toHaveBeenCalled();
  expect(second.read).not.toHaveBeenCalled();
});

it.each([["agent/AGENTS.md"], ["SOUL.md"]])(
  "requires a relative path and an identifiable agent folder for %s",
  async (path) => {
    const file = folderEntry(path);
    await expect(encodeAgentBackupFolder([file], () => true)).rejects.toMatchObject({
      reason: "unreadable",
    });
    expect(file.read).not.toHaveBeenCalled();
  },
);

it("rejects ambiguous workspaces before opening files", async () => {
  const first = folderEntry("agent/workspace-a/SOUL.md");
  const second = folderEntry("agent/workspace-b/SOUL.md");
  await expect(encodeAgentBackupFolder([first, second], () => true)).rejects.toMatchObject({
    reason: "unreadable",
  });
  expect(first.read).not.toHaveBeenCalled();
  expect(second.read).not.toHaveBeenCalled();
});

it("does not mistake generic workspace or memories folders for an agent", async () => {
  const instructions = folderEntry("project/AGENTS.md", "Project instructions.");
  for (const path of ["workspace/README.md", "memories/README.md", "config.yaml"]) {
    const unrelated = folderEntry(`project/${path}`);
    await expect(
      encodeAgentBackupFolder([instructions, unrelated], () => true),
    ).rejects.toMatchObject({ reason: "unreadable" });
    expect(unrelated.read).not.toHaveBeenCalled();
  }
  expect(instructions.read).not.toHaveBeenCalled();
});

it("does not switch from a workspace to home instructions or a different workspace", async () => {
  const home = folderEntry(".openclaw/SOUL.md", "Home instructions.");
  const unrelated = folderEntry(".openclaw/workspace/README\u2028notes.md");
  const otherWorkspace = folderEntry(".openclaw/workspace-else/SOUL.md", "Other agent.");
  await expect(encodeAgentBackupFolder([home, unrelated], () => true)).rejects.toMatchObject({
    reason: "unreadable",
  });
  await expect(
    encodeAgentBackupFolder([home, unrelated, otherWorkspace], () => true),
  ).rejects.toMatchObject({ reason: "unreadable" });
  for (const entry of [home, unrelated, otherWorkspace]) expect(entry.read).not.toHaveBeenCalled();
});

it("checks inventory, selected file count and byte budgets before reading", async () => {
  const soul = folderEntry("agent/SOUL.md", "Review rows.");
  const rows = (count: number, directory: string, size = 0) =>
    Array.from({ length: count }, (_, index) =>
      folderEntry(`agent/${directory}/${index}.md`, "", size),
    );
  const rejected = [
    rows(2_000, "notes"),
    rows(500, "memory"),
    rows(11, "memory", 400_000),
    rows(1, "memory", 400_001),
  ];
  for (const files of rejected) {
    await expect(encodeAgentBackupFolder([soul, ...files], () => true)).rejects.toMatchObject({
      reason: "too_large",
    });
    for (const file of files) expect(file.read).not.toHaveBeenCalled();
  }
  expect(soul.read).not.toHaveBeenCalled();
});

it("bounds decoded and serialized text and rejects changed or invalid bytes", async () => {
  const soul = folderEntry("agent/SOUL.md", "x".repeat(100_000));
  await expect(encodeAgentBackupFolder([soul], () => true)).resolves.toContain("agent-backup/v1");
  const cases = [
    { files: [folderEntry("agent/SOUL.md", "x".repeat(100_001))], reason: "too_large" },
    { files: [folderEntry("agent/SOUL.md", "Changed", 1)], reason: "unreadable" },
    { files: [folderEntry("agent/SOUL.md", Uint8Array.of(0xff))] },
    {
      files: [
        soul,
        ...Array.from({ length: 8 }, (_, index) =>
          folderEntry(`agent/memory/${index}.md`, "\t".repeat(100_000)),
        ),
        ...Array.from({ length: 7 }, (_, index) =>
          folderEntry(`agent/memory/escape-${index}.md`, "\u0001".repeat(100_000)),
        ),
      ],
      reason: "too_large",
    },
  ];
  for (const { files, reason } of cases) {
    const result = expect(encodeAgentBackupFolder(files, () => true));
    if (reason) await result.rejects.toMatchObject({ reason });
    else await result.rejects.toThrow();
  }
});

it("stops reading as soon as the editor's scope expires", async () => {
  const soul = folderEntry("agent/SOUL.md", "Review rows.");
  const memory = folderEntry("agent/memory/one.md", "Fixture note");
  let current = true;
  soul.read.mockImplementationOnce(async () => {
    current = false;
    return strToU8("Review rows.");
  });
  await expect(encodeAgentBackupFolder([soul, memory], () => current)).rejects.toMatchObject({
    reason: "unreadable",
  });
  expect(soul.read).toHaveBeenCalledOnce();
  expect(memory.read).not.toHaveBeenCalled();
});

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

it("recognizes wrapped backup JSON and lists missing Skill dependencies separately", () => {
  const raw = JSON.stringify(
    {
      source: "openclaw",
      format: "agent-backup/v1",
      files: [
        { path: "SOUL.md", content: "Review the report." },
        {
          path: "skills/review/SKILL.md",
          content:
            "---\nname: review\ndescription: A report review.\n---\nRead references/guide.md.",
        },
      ],
    },
    null,
    2,
  );
  expect(agentBackupFileGroups(`\n\x60\x60\x60json\n${raw}\n\x60\x60\x60\n`)).toEqual({
    instructions: ["SOUL.md"],
    skills: [],
    memory: [],
    routines: [],
    unavailable: [{ path: "skills/review/SKILL.md", reason: "missingSkillFiles" }],
  });
});

it("projects and selects only jobs bound to the selected OpenClaw workspace", () => {
  const definition = {
    agentId: "research",
    name: "Review reports",
    enabled: true,
    schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Asia/Taipei" },
    payload: { kind: "agentTurn", message: "Review today's reports." },
    delivery: { mode: "none" },
    sessionTarget: "isolated",
    wakeMode: "now",
    state: { privateHistory: "Do not send the job's state." },
  };
  const files = {
    "backup/manifest.json": JSON.stringify({
      schemaVersion: 1,
      archiveRoot: "backup",
      paths: {
        stateDir: "/state",
        configPath: "/state/openclaw.json",
        workspaceDirs: ["/state/workspace-research"],
      },
      assets: [{ kind: "state", archivePath: "state" }],
    }),
    "backup/state/workspace-research/SOUL.md": "Review the reports.",
    "backup/state/openclaw.json": JSON.stringify({
      agents: {
        defaults: { model: "anthropic/claude-sonnet-4-6" },
        list: [
          {
            id: " research ",
            workspace: "/state/workspace-research",
            model: { primary: "openai/gpt-4.1" },
          },
          { id: "other", workspace: "/state/other", model: "xai/grok-4" },
        ],
      },
      unrelated: "Private configuration fixture.",
    }),
    "backup/state/cron/jobs.json": JSON.stringify({
      jobs: [
        definition,
        {
          ...definition,
          agentId: "main",
          payload: { ...definition.payload, message: "Other agent text." },
        },
        { ...definition, agentId: undefined },
        { ...definition, payload: { ...definition.payload, toolsAllow: [] } },
        { ...definition, schedule: { kind: "every", everyMs: 60_000 } },
        { ...definition, payload: { ...definition.payload, message: "Use @Weekly review." } },
        { ...definition, payload: { ...definition.payload, message: "Use skill: Review" } },
        { ...definition, schedule: { ...definition.schedule, expr: "0 * * * *" } },
        { ...definition, schedule: { ...definition.schedule, expr: "0 * * * *", staggerMs: 0 } },
        { ...definition, delivery: undefined },
        { ...definition, sessionTarget: undefined },
        {
          ...definition,
          schedule: { ...definition.schedule, expr: "30 2 * * *", tz: "Europe/Oslo" },
        },
      ],
    }),
  };
  const source = encodeAgentBackup(tar(files));
  expect(JSON.parse(source).model).toEqual({ provider: "openai", modelId: "gpt-4.1" });
  const overridden = encodeAgentBackup(
    tar({
      ...files,
      "backup/state/agents/research/agent/models.json":
        '{"providers":{"openai":{"baseUrl":"https://example.test"}}}',
    }),
  );
  expect(JSON.parse(overridden).model).toBe("unavailable");
  expect(overridden).not.toContain("example.test");
  expect(source).not.toContain("claude-sonnet");
  expect(source).not.toContain("grok-4");
  expect(source).not.toContain("Other agent text.");
  expect(source).not.toContain("privateHistory");
  expect(source).not.toContain("Private configuration fixture.");
  const groups = agentBackupFileGroups(source);
  expect(groups?.routines).toMatchObject([
    { path: "cron/routine-1.json", name: "Review reports" },
    { path: "cron/routine-9.json", name: "Review reports" },
  ]);
  expect(groups?.unavailable).toEqual(
    expect.arrayContaining([
      { path: "cron/routine-10.json", reason: "routineSchedule" },
      { path: "cron/routine-11.json", reason: "routineSchedule" },
      { path: "cron/routine-12.json", reason: "routineSchedule" },
      { path: "cron/routine-3.json", reason: "routineOwner" },
      { path: "cron/routine-4.json", reason: "routineSchedule" },
      { path: "cron/routine-5.json", reason: "routineSchedule" },
      { path: "cron/routine-6.json", reason: "routineSchedule" },
      { path: "cron/routine-7.json", reason: "routineSchedule" },
      { path: "cron/routine-8.json", reason: "routineSchedule" },
    ]),
  );
  const sent = agentBackupPreview(source, false, ["cron/routine-1.json"]);
  expect(sent.source).not.toContain("Review today's reports.");
  expect(sent.backupOmissions).toEqual(expect.arrayContaining(groups!.unavailable));
  const chosen = agentBackupPreview(source, false, [], ["cron/routine-1.json"]);
  expect(chosen.source).not.toContain("cron/routine-1.json");
  expect(chosen.backupRoutines).toEqual([
    {
      path: "cron/routine-1.json",
      routine: {
        name: "Review reports",
        prompt: "Review today's reports.",
        crons: ["0 9 * * 1-5"],
        timezone: "Asia/Taipei",
      },
    },
  ]);
});

it("does not infer a schedule owner from an unrelated workspace's name", () => {
  const files = {
    "backup/manifest.json": JSON.stringify({
      schemaVersion: 1,
      archiveRoot: "backup",
      paths: {
        stateDir: "/state",
        configPath: "/linked/openclaw.json",
        configSourcePath: "/configuration/openclaw.json",
        workspaceDirs: ["/external/workspace-main"],
      },
      assets: [
        { kind: "state", archivePath: "state" },
        { kind: "workspace", archivePath: "external", sourcePath: "/external/workspace-main" },
        {
          kind: "config",
          archivePath: "config/openclaw.json",
          sourcePath: "/configuration/openclaw.json",
        },
      ],
    }),
    "backup/external/SOUL.md": "Review the reports.",
    "backup/config/openclaw.json":
      "{ agents: { entries: { research: { workspace: '/external/workspace-main' } } } }",
    "backup/state/cron/jobs.json": JSON.stringify({
      jobs: [
        {
          agentId: "main",
          name: "Wrong owner",
          schedule: { kind: "cron", expr: "30 9 * * *", tz: "UTC" },
          payload: { kind: "agentTurn", message: "Other agent text." },
          sessionTarget: "isolated",
          delivery: { mode: "none" },
        },
        {
          agentId: "research",
          name: "Correct owner",
          schedule: { kind: "cron", expr: "30 9 * * *", tz: "UTC" },
          payload: { kind: "agentTurn", message: "Review the reports." },
          sessionTarget: "isolated",
          delivery: { mode: "none" },
        },
      ],
    }),
  };
  const source = encodeAgentBackup(tar(files));
  expect(source).not.toContain("Other agent text.");
  expect(agentBackupFileGroups(source)?.routines).toMatchObject([
    { path: "cron/routine-2.json", name: "Correct owner" },
  ]);

  const customConfig = encodeAgentBackup(
    tar({
      "backup/manifest.json": files["backup/manifest.json"].replaceAll(
        "openclaw.json",
        "custom.json",
      ),
      "backup/config/custom.json": files["backup/config/openclaw.json"],
      "backup/external/SOUL.md": files["backup/external/SOUL.md"],
      "backup/state/cron/jobs.json": files["backup/state/cron/jobs.json"],
    }),
  );
  expect(agentBackupFileGroups(customConfig)).toMatchObject({
    instructions: ["SOUL.md"],
    routines: [],
    unavailable: [{ path: "cron/jobs.json", reason: "routineOwner" }],
  });

  const unresolvedOwner = encodeAgentBackup(
    tar({
      ...files,
      "backup/config/openclaw.json":
        "{ agents: { entries: { main: {}, research: { workspace: '/external/workspace-main' } } } }",
    }),
  );
  expect(agentBackupFileGroups(unresolvedOwner)).toMatchObject({
    instructions: ["SOUL.md"],
    routines: [],
    unavailable: [{ path: "cron/jobs.json", reason: "routineOwner" }],
  });

  const sharedWorkspace = encodeAgentBackup(
    tar({
      ...files,
      "backup/config/openclaw.json":
        "{ agents: { entries: { main: { workspace: '/external//workspace-main ' }, research: { workspace: '/external/workspace-main' } } } }",
    }),
  );
  expect(agentBackupFileGroups(sharedWorkspace)).toMatchObject({
    instructions: ["SOUL.md"],
    routines: [],
    unavailable: [{ path: "cron/jobs.json", reason: "routineOwner" }],
  });

  const externalInclude = encodeAgentBackup(
    tar({
      ...files,
      "backup/manifest.json": files["backup/manifest.json"].replace(
        "/configuration/openclaw.json",
        "/state/openclaw.json",
      ),
      "backup/state/openclaw.json": '{ $include: "/configuration/openclaw.json" }',
    }),
  );
  expect(agentBackupFileGroups(externalInclude)).toMatchObject({
    instructions: ["SOUL.md"],
    routines: [],
    unavailable: [{ path: "cron/jobs.json", reason: "routineOwner" }],
  });
});

it("opens a declared workspace with only a portable routine", () => {
  const files = {
    "backup/manifest.json": JSON.stringify({
      schemaVersion: 1,
      archiveRoot: "backup",
      paths: {
        stateDir: "/state",
        configPath: "/state/openclaw.json",
        workspaceDirs: ["/state/workspace"],
      },
      assets: [{ kind: "state", archivePath: "state" }],
    }),
    "backup/state/openclaw.json": JSON.stringify({
      agents: { entries: { main: { workspace: "/state/workspace" } } },
    }),
    "backup/state/workspace/notes.txt": "Unsupported workspace note.",
    "backup/state/SOUL.md": "Text outside the chosen workspace.",
    "backup/state/cron/jobs.json": JSON.stringify({
      jobs: [
        {
          agentId: "main",
          name: "Review reports",
          schedule: { kind: "cron", expr: "30 9 * * *", tz: "UTC" },
          payload: { kind: "agentTurn", message: "Review the reports." },
          sessionTarget: "isolated",
          delivery: { mode: "none" },
        },
      ],
    }),
  };
  const source = encodeAgentBackup(tar(files));
  expect(source).not.toContain("Text outside the chosen workspace.");
  expect(source).not.toContain("Unsupported workspace note.");
  expect(agentBackupFileGroups(source)).toMatchObject({
    instructions: [],
    routines: [{ path: "cron/routine-1.json", name: "Review reports" }],
  });
  const preview = agentBackupPreview(source, false, [], ["cron/routine-1.json"]);
  expect(JSON.parse(preview.source).files).toEqual([]);
  expect(preview.backupRoutines).toHaveLength(1);

  const database = "backup/state/state/openclaw.sqlite";
  const databaseContents = "Private state database fixture.";
  const managedSkill = "backup/state/skills/reports/SKILL.md";
  const managedSkillContents =
    "---\nname: reports\ndescription: Review reports.\n---\nSummarize the supplied report.";
  const stateDatabaseBackup = encodeAgentBackup(
    tar({ ...files, [database]: databaseContents, [managedSkill]: managedSkillContents }),
  );
  expect(stateDatabaseBackup).not.toContain(databaseContents);
  expect(stateDatabaseBackup).not.toContain("Review the reports.");
  const databaseGroups = agentBackupFileGroups(stateDatabaseBackup)!;
  expect(databaseGroups).toMatchObject({
    instructions: [],
    skills: [],
    routines: [],
    unavailable: [{ path: "state/openclaw.sqlite", reason: "routineSchedule" }],
  });
  expect(
    agentBackupSelectableGroups(databaseGroups, false, new Set(), new Set()).hasSelection,
  ).toBe(false);
  const mixedDatabaseBackup = encodeAgentBackup(
    tar({
      ...files,
      [database]: databaseContents,
      "backup/state/workspace/SOUL.md": "Workspace instructions.",
    }),
  );
  const mixedPreview = agentBackupPreview(mixedDatabaseBackup, false);
  expect(mixedPreview.backupOmissions).toEqual(databaseGroups.unavailable);
  expect(mixedPreview.backupRoutines).toBeUndefined();
  expect(mixedPreview.source).not.toContain(databaseContents);

  const withManagedSkill = encodeAgentBackup(
    tar({ ...files, [managedSkill]: managedSkillContents }),
  );
  expect(agentBackupFileGroups(withManagedSkill)).toMatchObject({
    instructions: [],
    skills: ["skills/reports/SKILL.md"],
    routines: [{ path: "cron/routine-1.json", name: "Review reports" }],
  });
  for (const config of [
    { agents: { defaults: { workspace: "/state/workspace" }, entries: { main: {} } } },
    { agents: { defaults: { workspace: "/state/workspace" } } },
  ]) {
    const inherited = encodeAgentBackup(
      tar({ ...files, "backup/state/openclaw.json": JSON.stringify(config) }),
    );
    expect(agentBackupFileGroups(inherited)?.routines).toMatchObject([
      { path: "cron/routine-1.json", name: "Review reports" },
    ]);
  }
  for (const config of [
    {},
    { agents: { defaults: { workspace: "/state/workspace" }, entries: { main: null } } },
    { agents: { defaults: { workspace: "/state/workspace" }, ownership: "explicit" } },
  ]) {
    expect(() =>
      encodeAgentBackup(tar({ ...files, "backup/state/openclaw.json": JSON.stringify(config) })),
    ).toThrow("could not be read");
  }
});

it("keeps supported text usable if the optional job store cannot be read", () => {
  const source = encodeAgentBackup(
    zipSync({
      "HERMES.md": strToU8("Review assistant."),
      "cron/jobs.json": new Uint8Array([255]),
    }),
  );
  expect(agentBackupFileGroups(source)).toMatchObject({
    instructions: ["HERMES.md"],
    routines: [],
    unavailable: [{ path: "cron/jobs.json", reason: "routineSchedule" }],
  });
});

it("projects a Hermes cron with a source timezone and omits finite or restricted jobs", () => {
  const job = {
    name: "Daily review",
    prompt: "Review the supplied notes.",
    schedule: { kind: "cron", expr: "0 9 * * *", display: "Every day at 9" },
    timezone: "Asia/Taipei",
    repeat: { times: null, completed: 1 },
    enabled_toolsets: null,
    deliver: "local",
  };
  const source = encodeAgentBackup(
    zipSync({
      "HERMES.md": strToU8("Review assistant."),
      "cron/jobs.json": strToU8(
        JSON.stringify({
          jobs: [
            job,
            { ...job, enabled_toolsets: [] },
            { ...job, repeat: { times: 3 } },
            { ...job, timezone: undefined },
            { ...job, script: "test-script" },
          ],
        }),
      ),
    }),
  );
  expect(agentBackupFileGroups(source)?.routines).toMatchObject([
    { path: "cron/routine-1.json", name: "Daily review" },
  ]);
  expect(agentBackupFileGroups(source)?.unavailable).toHaveLength(4);
});

it("distinguishes backup routines with the same name and schedule", () => {
  const routine = {
    name: "Review",
    prompt: "Review the notes.",
    crons: ["0 9 * * *"],
    timezone: "UTC",
  };
  const source = JSON.stringify({
    format: "agent-backup/v1",
    source: "hermes",
    files: [
      { path: "cron/routine-1.json", content: JSON.stringify(routine) },
      {
        path: "cron/routine-2.json",
        content: JSON.stringify({
          ...routine,
          prompt: "Review the reports.",
          crons: ["0  9 * * *"],
        }),
      },
    ],
  });
  const files = agentBackupFileGroups(source)!;
  const selected = new Set(["cron/routine-2.json"]);
  const { groups } = agentBackupSelectableGroups(files, false, new Set(), selected);
  expect(groups[0]?.items).toMatchObject([
    { label: "Review · 0 9 * * * · UTC · #1", selected: false },
    { label: "Review · 0 9 * * * · UTC · #2", selected: true },
  ]);
  expect(agentBackupPreview(source, false, [], [...selected]).backupRoutines).toEqual([
    {
      path: "cron/routine-2.json",
      routine: { ...routine, prompt: "Review the reports.", crons: ["0  9 * * *"] },
    },
  ]);
});

it("counts every valid locally omitted note without applying the saved-memory limit", () => {
  const files = Array.from({ length: 101 }, (_, index) => ({
    path: `memory/note-${index}.md`,
    content: "Local note.",
  }));
  const source = JSON.stringify({ format: "agent-backup/v1", source: "openclaw", files });
  expect(JSON.parse(agentBackupPreview(source, false).source)).toMatchObject({
    files: [],
    excludedMemoryCount: 101,
  });
});

it("sends only the validated backup when pasted text wraps its JSON", () => {
  const files = [{ path: "SOUL.md", content: "Selected instruction." }];
  const json = JSON.stringify({ format: "agent-backup/v1", source: "openclaw", files });
  const source = `Local prose.\n\x60\x60\x60json\n${json}\n\x60\x60\x60`;
  expect(agentBackupPreview(source, true).source).not.toContain("Local prose.");
  expect(JSON.parse(agentBackupPreview(source, true).source)).toMatchObject({ files });
});

it("preserves bounded legacy omission names and leaves the backup JSON compatible", () => {
  const files = [{ path: "HERMES.md", content: "Selected instruction." }];
  const missing = Array.from({ length: 500 }, (_, index) => `skills/missing-${index}/SKILL.md`);
  const source = JSON.stringify({
    format: "agent-backup/v1",
    source: "hermes",
    files: [...files, { path: "memories/MEMORY.md", content: "§\n§\n" }],
    incompleteSkills: missing,
  });
  const preview = agentBackupPreview(source, true);
  expect(JSON.parse(preview.source)).toEqual({
    format: "agent-backup/v1",
    source: "hermes",
    files,
    excludedMemoryCount: 0,
    incompleteSkills: missing,
  });
  expect(preview.backupOmissions).toHaveLength(500);
  expect(preview.backupOmissions?.every(({ reason }) => reason === "missingSkillFiles")).toBe(true);
});

it("keeps unavailable file bodies and runtime text out of the preview request", () => {
  const path = `memory/${"m".repeat(200)}.md`;
  const raw = JSON.stringify({
    source: "openclaw",
    format: "agent-backup/v1",
    files: [
      { path: "SOUL.md", content: "Review the report." },
      { path, content: "Private unselectable note." },
      { path: "TOOLS.md", content: "Local runtime details." },
      { path: "skills/invalid/SKILL.md", content: "Invalid skill body." },
      {
        path: "skills/review/SKILL.md",
        content: "---\nname: review\ndescription: A report review.\n---\nRead references/guide.md.",
      },
    ],
  }).replace("agent-backup/v1", "agent-backup\\/v1");
  expect(agentBackupFileGroups(raw)).toMatchObject({ memory: [], skills: [] });
  const preview = agentBackupPreview(raw, true);
  expect(JSON.parse(preview.source)).toEqual({
    format: "agent-backup/v1",
    source: "openclaw",
    excludedMemoryCount: 0,
    incompleteSkills: ["skills/review/SKILL.md"],
    files: [
      { path: "SOUL.md", content: "Review the report." },
      { path: "TOOLS.md", content: "" },
    ],
  });
  expect(preview.backupOmissions).toEqual([
    { path, reason: "memoryLimit" },
    { path: "skills/invalid/SKILL.md", reason: "invalidSkill" },
    { path: "skills/review/SKILL.md", reason: "missingSkillFiles" },
  ]);
});

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
    "skills/.bundled_manifest": strToU8("review:fixture-origin"),
    "memories/MEMORY.md": strToU8("One\n§\nTwo\n"),
    "sessions/history.md": strToU8("fixture history"),
    "skills/review/SKILL.md": strToU8("\uFEFFOriginal text\r\n"),
  });
  expect(JSON.parse(readBotImportBytes(backup))).toMatchObject({
    source: "hermes",
    files: [
      { path: "memories/MEMORY.md", content: "One\n§\nTwo\n" },
      { path: "skills/review/SKILL.md", content: "\uFEFFOriginal text\r\n" },
    ],
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
    { ".openclaw/workspace/SOUL.md": "One", ".openclaw/workspace-other/SOUL.md": "Two" },
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

it("uses the one declared internal workspace before an old default directory", () => {
  const backup = tar({
    "backup/manifest.json": JSON.stringify({
      schemaVersion: 1,
      archiveRoot: "backup",
      paths: { workspaceDirs: ["/state/custom-main"] },
      assets: [{ kind: "state", archivePath: "state", sourcePath: "/state" }],
    }),
    "backup/state/workspace/SOUL.md": "Stale instructions",
    "backup/state/custom-main/SOUL.md": "Current instructions",
  });
  expect(JSON.parse(encodeAgentBackup(backup)).files).toEqual([
    { path: "SOUL.md", content: "Current instructions" },
  ]);
});

it("rejects a declared workspace without supported text even when other content exists", () => {
  const backup = tar({
    "backup/manifest.json": JSON.stringify({
      schemaVersion: 1,
      archiveRoot: "backup",
      paths: { workspaceDirs: ["/state/custom-main"] },
      assets: [{ kind: "state", archivePath: "state", sourcePath: "/state" }],
    }),
    "backup/state/workspace-old/SOUL.md": "Stale instructions",
    "backup/state/custom-main/backup.zip": "Skipped nested archive",
    "backup/state/skills/review/SKILL.md": "Home Skill",
  });
  expect(() => encodeAgentBackup(backup)).toThrow("could not be read");
});

it.each(["tar", "zip"])("uses the declared external workspace in %s archives", (format) => {
  const files = {
    "backup/manifest.json": JSON.stringify({
      schemaVersion: 1,
      archiveRoot: "backup",
      paths: { workspaceDirs: ["/current"] },
      assets: [
        { kind: "state", archivePath: "state", sourcePath: "/state" },
        { kind: "workspace", archivePath: "external", sourcePath: "/current" },
      ],
    }),
    "backup/state/openclaw.json": "{}",
    "backup/state/workspace-other/SOUL.md": "Old instructions",
    "backup/external/SOUL.md": "Current instructions",
  };
  const backup =
    format === "tar"
      ? tar(files)
      : zipSync(
          Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])),
        );
  expect(JSON.parse(encodeAgentBackup(backup)).files).toEqual([
    { path: "SOUL.md", content: "Current instructions" },
  ]);
});

it.each(["missing", "mismatched", "runtime-only"])(
  "refuses %s declared external workspace",
  (variant) => {
    const backup = tar({
      "backup/manifest.json": JSON.stringify({
        schemaVersion: 1,
        archiveRoot: "backup",
        paths: { workspaceDirs: ["/current"] },
        assets: [
          { kind: "state", archivePath: "state", sourcePath: "/state" },
          ...(variant === "missing"
            ? []
            : [
                {
                  kind: "workspace",
                  archivePath: "external",
                  sourcePath: variant === "mismatched" ? "/old" : "/current",
                },
              ]),
        ],
      }),
      "backup/state/workspace-old/SOUL.md": "Old instructions",
      "backup/state/skills/review/SKILL.md": "Home Skill",
      ...(variant === "mismatched"
        ? { "backup/external/SOUL.md": "Wrong instructions" }
        : { "backup/external/TOOLS.md": "Runtime-only instructions" }),
    });
    expect(() => encodeAgentBackup(backup)).toThrow("could not be read");
  },
);

it.each([
  { archiveRoot: "backup", assets: null },
  { archiveRoot: "backup", assets: [null] },
  { paths: { workspaceDirs: ["/declared"] } },
])("does not infer a stale ZIP workspace for malformed layout %j", (manifest) => {
  const backup = zipSync({
    "backup/manifest.json": strToU8(JSON.stringify({ schemaVersion: 1, ...manifest })),
    "backup/openclaw.json": strToU8("{}"),
    "backup/workspace-old/SOUL.md": strToU8("Old instructions"),
  });
  expect(() => encodeAgentBackup(backup)).toThrow("could not be read");
});

it.each(["\n", "\r\n"])("renames quoted and multiline Skills with valid YAML (%j)", (newline) => {
  const name = 'Reader\'s "quoted" \\notes-2';
  const description = "description: 'Keep #tags and \"quotes\".'";
  for (const original of [
    "name: Reader",
    `name: |2-${newline}  First${newline}${newline}  Second`,
    `name: >2-${newline}  First${newline}${newline}  Second`,
  ]) {
    const source = ["---", original, description, "---", "Body", ""].join(newline);
    const renamed = renameBackupSkill(source, name);
    expect(parseSkillMd(renamed)).toMatchObject({ name, description: 'Keep #tags and "quotes".' });
    expect(parseYaml(renamed.split("---")[1]!)).toMatchObject({ name });
    expect(renamed.endsWith([description, "---", "Body", ""].join(newline))).toBe(true);
  }
});
