import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type {
  Bot,
  BotPackageDocument,
  BotPackageReceipt,
  MemoryDocument,
  Routine,
  RunsListOutput,
  ThreadSnapshot,
} from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openNewBot,
  rpc,
  signup,
} from "./helpers";

const skillName = "package-review-recipe";
const source = JSON.stringify({
  format: "openmaus.grok/1",
  name: "Package reviewer",
  title: "Review sources",
  description: "Synthetic portable assistant",
  instructions: "First instruction line\n<img src=x onerror=alert(1)>\nLast instruction line\n",
  skills: [
    {
      name: skillName,
      description: "Review source material",
      body: "Keep the original evidence.\nNever send a message automatically.\n",
    },
  ],
  routines: [
    {
      name: "Morning review",
      cron: "0 9 * * 1-5",
      timeZone: "UTC",
      prompt: "Review the supplied material.",
    },
    { name: "On new email", schedule: "When a new email arrives", prompt: "Review the email." },
  ],
  plugins: ["GitHub"],
  memories: ["Synthetic note selected separately"],
});

test("package review preserves text, keeps execution off, and explicitly enables or exports shared skills", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await signup(page, `package-review-${Date.now()}@example.test`, "password12", "Package reviewer");
  await completeOnboarding(page);
  await rpc(page, "agentSkills/create", {
    name: skillName,
    description: "Existing shared recipe",
    body: "Keep this original shared recipe.",
  });
  const before = await rpc<Bot[]>(page, "bots/list", {});
  let imports = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/botPackages/import")) imports++;
  });
  await openNewBot(page);
  await page
    .getByTestId("create-bot-form")
    .getByRole("button", { name: "Import bot", exact: true })
    .click();
  const panel = page.getByTestId("bot-package-import");
  await panel.getByLabel("Choose package file", { exact: true }).setInputFiles({
    name: "review.json",
    mimeType: "application/json",
    buffer: Buffer.from(source),
  });
  await expect(panel.getByLabel("Bot package or Grok JSON", { exact: true })).toHaveValue(source);
  await expect(
    panel.getByRole("switch", { name: "Include memory", exact: true }),
  ).not.toBeChecked();
  await panel.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = panel.getByTestId("bot-package-document");
  await expect(preview.getByText("Package reviewer", { exact: true })).toBeVisible();
  await expect(preview.locator("pre").first()).toHaveText(JSON.parse(source).instructions);
  await expect(preview.locator("img")).toHaveCount(0);
  await expect(panel.getByTestId("bot-package-left-out")).toContainText("routines[1]");
  await expect(panel.getByTestId("bot-package-left-out")).toContainText(
    "Event or unrecognized schedules need manual setup.",
  );
  expect(imports).toBe(0);
  expect(await rpc<Bot[]>(page, "bots/list", {})).toHaveLength(before.length);
  await captureScreenshot(page, testInfo, "d021-package-review");
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(panel.getByRole("button", { name: "Import as new bot", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await captureScreenshot(page, testInfo, "d021-package-review-320");
  await page.setViewportSize({ width: 1280, height: 1100 });
  await panel.getByRole("button", { name: "Import as new bot", exact: true }).click();
  await expect(panel.getByText("Bot imported", { exact: true })).toBeVisible();
  const after = await rpc<Bot[]>(page, "bots/list", {});
  expect(after).toHaveLength(before.length + 1);
  const imported = after.find((bot) => !before.some((existing) => existing.id === bot.id))!;
  expect(imported.instructions).toBe(JSON.parse(source).instructions);
  expect(imported.modelProvider).toBeNull();
  expect(imported.modelCredentialId).toBeNull();
  expect(imported.parentBotId).toBeNull();
  expect(imported.teamChatAmbientEnabled).toBe(false);
  const routines = await rpc<Routine[]>(page, "routines/list", { botId: imported.id });
  expect(routines).toHaveLength(1);
  expect(routines[0]).toMatchObject({
    active: false,
    webhookEnabled: false,
    githubEnabled: false,
    modelCredentialId: null,
  });
  const memory = await rpc<MemoryDocument[]>(page, "memory/list", {
    botId: imported.id,
    scope: "bot",
  });
  expect(
    memory.every((entry) => !entry.content.includes("Synthetic note selected separately")),
  ).toBe(true);
  const skills = panel.getByTestId("bot-package-skills");
  await skills.locator("summary").click();
  await expect(
    skills.getByText("Enabling a skill shares it with your bots in this space.", { exact: true }),
  ).toBeVisible();
  await skills.getByRole("button", { name: "Enable shared skill", exact: true }).click();
  await expect(skills.getByRole("alert")).toBeVisible();
  await expect(
    skills.getByRole("button", { name: "Enable shared skill", exact: true }),
  ).toBeDisabled();
  await captureScreenshot(page, testInfo, "d021-package-skill-conflict");
  await skills.getByRole("button", { name: "Check status", exact: true }).click();
  await skills.getByLabel("Skill name", { exact: true }).fill("package-reviewed-copy");
  await skills.getByRole("button", { name: "Enable shared skill", exact: true }).click();
  await expect(skills.locator("summary")).toContainText("Enabled");
  const original = await rpc<{ content: string }>(page, "agentSkills/get", { name: skillName });
  expect(original.content).toContain("Keep this original shared recipe.");
  await captureScreenshot(page, testInfo, "d021-package-imported");
  await panel.getByRole("button", { name: "Open bot", exact: true }).click();
  await page.waitForURL(`**/app/${imported.id}`);
  await page.locator("main").getByRole("button", { name: imported.name, exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await settings.getByRole("button", { name: "Export package", exact: true }).click();
  const exporting = settings.getByTestId("bot-package-export");
  await expect(
    exporting.getByRole("switch", { name: "Include memory", exact: true }),
  ).not.toBeChecked();
  await expect(
    exporting.getByRole("switch", { name: "package-reviewed-copy", exact: true }),
  ).not.toBeChecked();
  await exporting.getByRole("switch", { name: "package-reviewed-copy", exact: true }).click();
  let downloads = 0;
  page.on("download", () => downloads++);
  await expect(
    exporting.getByRole("button", { name: "Download package", exact: true }),
  ).toHaveCount(0);
  await exporting.getByRole("button", { name: "Preview package", exact: true }).click();
  await expect(exporting.getByTestId("bot-package-document")).toBeVisible();
  expect(downloads).toBe(0);
  await exporting
    .getByRole("button", { name: "Download package", exact: true })
    .scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "d021-package-export");
  const downloadEvent = page.waitForEvent("download");
  await exporting.getByRole("button", { name: "Download package", exact: true }).click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BotPackageDocument;
  expect(exported.format).toBe("coginebot.package/v1");
  expect(exported.profile.instructions).toBe(imported.instructions);
  expect(exported.memory).toEqual([]);
  expect(exported.skills.map((skill) => skill.name)).toEqual(["package-reviewed-copy"]);
  expect(exported).not.toHaveProperty("history");
  expect(exported).not.toHaveProperty("files");
  expect(imports).toBe(1);
  expect(downloads).toBe(1);
});

test("agent backup import previews supported text and saves only the selected content", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await signup(page, `agent-backup-${Date.now()}@example.test`, "password12", "Backup reviewer");
  await completeOnboarding(page);
  await openNewBot(page);
  await page
    .getByTestId("create-bot-form")
    .getByRole("button", { name: "Import bot", exact: true })
    .click();
  const panel = page.getByTestId("bot-package-import");
  const instructions = "Summarize the supplied material.";
  const note = "Keep selected notes in this Bot only.";
  const otherInstructions = "Instructions left on the device.";
  const otherNote = "Private preferences left on the device.";
  const backupRoot = "backup/state";
  const files = {
    "backup/manifest.json": JSON.stringify({
      schemaVersion: 1,
      archiveRoot: "backup",
      assets: [{ kind: "state", archivePath: "state" }],
      paths: {
        stateDir: "/example-state",
        configPath: "/example-state/openclaw.json",
        workspaceDirs: ["/example-state/workspace"],
      },
    }),
    [`${backupRoot}/openclaw.json`]: JSON.stringify({
      agents: { list: [{ id: "main", workspace: "/example-state/workspace" }] },
      unrelated: "Private config fixture.",
    }),
    [`${backupRoot}/workspace/SOUL.md`]: instructions,
    [`${backupRoot}/workspace/AGENTS.md`]: otherInstructions,
    [`${backupRoot}/workspace/MEMORY.md`]: note,
    [`${backupRoot}/workspace/USER.md`]: otherNote,
    [`${backupRoot}/workspace/skills/check/SKILL.md`]:
      "---\nname: check\ndescription: Check a report.\n---\nInspect each row.\n",
    [`${backupRoot}/workspace/skills/missing/SKILL.md`]:
      "---\nname: missing\ndescription: Needs a reference.\n---\nRead references/guide.md.\n",
    [`${backupRoot}/workspace/skills/invalid/SKILL.md`]: "Private text without metadata.",
    [`${backupRoot}/workspace/TOOLS.md`]: "Private runtime fixture.",
    [`${backupRoot}/cron/jobs.json`]: JSON.stringify({
      jobs: [
        {
          agentId: "main",
          name: "Morning review",
          schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Asia/Taipei" },
          payload: { kind: "agentTurn", message: "Review the morning reports." },
          delivery: { mode: "none" },
          sessionTarget: "isolated",
        },
        {
          agentId: "main",
          name: "Morning review",
          schedule: { kind: "cron", expr: "0 18 * * 1-5", tz: "Asia/Taipei" },
          payload: { kind: "agentTurn", message: "Review the evening reports." },
          delivery: { mode: "none" },
          sessionTarget: "isolated",
        },
      ],
    }),
    [`${backupRoot}/.env`]: "IGNORE_THIS_FIXTURE_VALUE",
  };
  const blocks = Object.entries(files).flatMap(([name, text]) => {
    const data = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write(data.length.toString(8).padStart(11, "0"), 124, 11);
    header.fill(32, 148, 156);
    header.write("0", 156, 1);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    return [header, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
  });
  const archive = {
    name: "assistant.tar.gz",
    mimeType: "application/gzip",
    buffer: gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])),
  };
  const picker = panel.getByLabel("Choose package file", { exact: true });
  const memory = panel.getByRole("switch", { name: "Include memory", exact: true });
  await picker.setInputFiles(archive);
  await expect(panel.getByRole("status")).toHaveText("Agent backup selected");
  await memory.click();
  await expect(memory).toBeChecked();
  await panel.getByRole("button", { name: "Use JSON instead", exact: true }).click();
  await expect(panel.getByLabel("Bot package or Grok JSON", { exact: true })).toBeEmpty();
  await expect(memory).not.toBeChecked();
  await picker.setInputFiles(archive);
  await expect(panel.getByRole("status")).toHaveText("Agent backup selected");
  await expect(memory).not.toBeChecked();
  const importedName = "Imported report assistant";
  await panel.getByLabel("Imported bot name").fill(importedName);
  await panel.getByText("Choose backup content", { exact: true }).click();
  await panel.getByRole("checkbox", { name: "AGENTS.md", exact: true }).click();
  await panel.getByRole("checkbox", { name: "skills/check/SKILL.md", exact: true }).click();
  await expect(panel.getByText("Unavailable backup files", { exact: true })).toBeVisible();
  await expect(panel.getByText("skills/missing/SKILL.md", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("This Skill is missing valid metadata.", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("This Skill needs additional files.", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("This runtime file is not used.", { exact: true })).toBeVisible();
  const persona = panel.getByRole("checkbox", { name: "SOUL.md", exact: true });
  await persona.click();
  await expect(panel.getByRole("button", { name: "Preview", exact: true })).toBeDisabled();
  await persona.click();
  await expect(panel.getByRole("checkbox", { name: "USER.md", exact: true })).toHaveCount(0);
  let uploaded = "";
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/botPackages/preview")) uploaded = request.postData() ?? "";
  });
  const previewButton = panel.getByRole("button", { name: "Preview", exact: true });
  const document = panel.getByTestId("bot-package-document");
  await previewButton.click();
  await expect(document.getByText(instructions, { exact: true })).toBeVisible();
  expect(uploaded).not.toContain("Review the morning reports.");
  await expect(document.getByText(note, { exact: true })).toHaveCount(0);
  expect(uploaded).not.toContain("IGNORE_THIS_FIXTURE_VALUE");
  expect(uploaded).not.toContain("Private config fixture.");
  expect(uploaded).not.toContain(otherInstructions);
  expect(uploaded).not.toContain("Inspect each row.");
  expect(uploaded).not.toContain("Read references/guide.md.");
  expect(uploaded).not.toContain("Private text without metadata.");
  expect(uploaded).not.toContain("Private runtime fixture.");
  expect(uploaded).not.toContain(note);
  await memory.click();
  await panel.getByRole("checkbox", { name: "USER.md", exact: true }).click();
  const morning = panel.getByRole("checkbox", {
    name: "Morning review · 0 9 * * 1-5 · Asia/Taipei",
    exact: true,
  });
  const evening = panel.getByRole("checkbox", {
    name: "Morning review · 0 18 * * 1-5 · Asia/Taipei",
    exact: true,
  });
  await expect(morning).not.toBeChecked();
  await expect(evening).not.toBeChecked();
  await morning.click();
  await expect(evening).not.toBeChecked();
  await expect(panel.getByRole("button", { name: "Import as new bot", exact: true })).toHaveCount(
    0,
  );
  await previewButton.click();
  await document.getByText("Memory · 1", { exact: true }).click();
  await document.getByText("MEMORY.md", { exact: true }).click();
  await expect(document.getByText(note, { exact: true })).toBeVisible();
  expect(uploaded).toContain(note);
  expect(uploaded).toContain("Review the morning reports.");
  expect(uploaded).not.toContain("Review the evening reports.");
  await expect(panel.getByText("Imported routines start paused.", { exact: true })).toBeVisible();
  expect(uploaded).not.toContain(otherNote);
  expect(uploaded).not.toContain("Read references/guide.md.");
  await expect(document.getByText("Skills · 0", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "agent-backup-import");
  await panel.getByText("Choose backup content", { exact: true }).click();
  await document.getByText("Memory · 1", { exact: true }).click();
  await document.getByText("Routines · 1", { exact: true }).click();
  await document.getByText("Morning review", { exact: true }).click();
  await expect(document.getByText("0 9 * * 1-5 · Asia/Taipei", { exact: true })).toBeVisible();
  await panel
    .getByText("Imported routines start paused.", { exact: true })
    .scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "d021-package-paused-routine");
  await panel.getByRole("button", { name: "Import as new bot", exact: true }).click();
  await expect(panel.getByText("Bot imported", { exact: true })).toBeVisible();
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  const bot = bots.find((candidate) => candidate.instructions === instructions);
  expect(bot?.id).toBeTruthy();
  expect(
    await rpc<MemoryDocument[]>(page, "memory/list", { botId: bot!.id, scope: "bot" }),
  ).toEqual([expect.objectContaining({ path: "MEMORY.md", content: note })]);
  const receipt = await rpc<BotPackageReceipt>(page, "botPackages/forBot", { botId: bot!.id });
  expect(receipt).toMatchObject({ status: "completed", botId: bot!.id, botName: importedName });
  expect(receipt.leftOut.length).toBeGreaterThan(0);
  const paused = await rpc<Routine[]>(page, "routines/list", { botId: bot!.id });
  expect(paused).toMatchObject([{ name: "Morning review", active: false, nextRunAt: null }]);
  await panel.getByRole("button", { name: "Open bot", exact: true }).click();
  await expect.poll(() => activeBotId(page)).toBe(bot!.id);
  const prompt = "Summarize these synthetic notes: three invoices arrived, all paid.";
  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeEnabled();
  await composer.fill(prompt);
  const sent = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/rpc/threads/send",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const response = await sent;
  expect(response.ok()).toBe(true);
  const { json: started } = (await response.json()) as { json: { runId: string } };
  expect(started.runId).toBeTruthy();
  await expect(transcript.getByTestId("message-bot-bubble").last()).toContainText(prompt, {
    timeout: 30_000,
  });
  await expect
    .poll(
      async () => {
        const recent = await rpc<RunsListOutput>(page, "runs/list", { filter: "recent" });
        return recent.runs.find(({ runId }) => runId === started.runId);
      },
      { timeout: 15_000 },
    )
    .toMatchObject({ status: "completed", botId: bot!.id });
  const snapshot = await rpc<ThreadSnapshot>(page, "threads/get", { botId: bot!.id });
  expect(snapshot.messages).toContainEqual(
    expect.objectContaining({
      role: "bot",
      runId: started.runId,
      blocks: expect.arrayContaining([
        expect.objectContaining({ kind: "text", text: expect.stringContaining(prompt) }),
      ]),
    }),
  );
  expect(await rpc<Routine[]>(page, "routines/list", { botId: bot!.id })).toMatchObject([
    { id: paused[0]!.id, active: false, lastRunAt: null, nextRunAt: null },
  ]);
  await captureScreenshot(page, testInfo, "agent-backup-first-completed-run");
});

test("agent backup folder previews only selected content and preserves the draft after a bad pick", async ({
  page,
}, testInfo) => {
  const fixture = await mkdtemp(join(tmpdir(), "bot-package-folder-"));
  try {
    const root = join(fixture, "review-agent");
    const unrelated = join(fixture, "ordinary-project");
    const otherBackup = join(fixture, "other-review-agent");
    await mkdir(join(root, "memories"), { recursive: true });
    await mkdir(join(unrelated, "workspace"), { recursive: true });
    await mkdir(join(otherBackup, "memories"), { recursive: true });
    const instructions = "Summarize the folder's research notes.";
    const note = "Keep this note private unless selected.";
    const secret = "Local fixture credential value.";
    await Promise.all([
      writeFile(join(root, "HERMES.md"), instructions),
      writeFile(join(root, "memories", "MEMORY.md"), note),
      writeFile(join(root, "auth.json"), JSON.stringify({ gateway_token: secret })),
      writeFile(
        join(root, "config.yaml"),
        "model: { provider: anthropic, default: claude-sonnet-4-6, api_key: local-config-fixture }\n",
      ),
      writeFile(join(unrelated, "AGENTS.md"), "Ordinary project instructions."),
      writeFile(join(unrelated, "workspace", "README.md"), "Ordinary project workspace."),
      writeFile(join(otherBackup, "HERMES.md"), instructions),
      writeFile(join(otherBackup, "memories", "MEMORY.md"), note),
      writeFile(join(otherBackup, "auth.json"), JSON.stringify({ gateway_token: secret })),
      writeFile(
        join(otherBackup, "config.yaml"),
        "model: { provider: anthropic, default: claude-sonnet-4-6, api_key: another-config-fixture }\n",
      ),
    ]);

    await page.setViewportSize({ width: 1280, height: 1100 });
    await signup(page, `backup-folder-${Date.now()}@example.test`, "password12", "Folder reviewer");
    await completeOnboarding(page);
    await openNewBot(page);
    await page
      .getByTestId("create-bot-form")
      .getByRole("button", { name: "Import bot", exact: true })
      .click();
    const panel = page.getByTestId("bot-package-import");
    const picker = panel.getByRole("button", { name: "Choose backup folder", exact: true });
    const name = panel.getByLabel("Imported bot name");
    const memory = panel.getByRole("switch", { name: "Include memory", exact: true });
    async function choose(directory: string) {
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), picker.click()]);
      await chooser.setFiles(directory);
    }
    const previews: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/rpc/botPackages/preview"))
        previews.push(request.postData() ?? "");
    });
    await choose(root);
    await expect(panel.getByRole("status")).toHaveText("Agent backup selected");
    await name.fill("Research folder Bot");
    await memory.click();
    await panel.getByText("Choose backup content", { exact: true }).click();
    await expect(panel.getByRole("checkbox", { name: "MEMORY.md", exact: false })).toBeChecked();
    await choose(unrelated);
    await expect(
      panel.getByText("Could not read this backup folder.", { exact: false }),
    ).toBeVisible();
    await expect(panel.getByRole("status")).toHaveText("Agent backup selected");
    await expect(name).toHaveValue("Research folder Bot");
    await expect(memory).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: "HERMES.md", exact: true })).toBeChecked();
    await choose(root);
    await expect(
      panel.getByText("Could not read this backup folder.", { exact: false }),
    ).toHaveCount(0);
    await expect(memory).not.toBeChecked();
    await panel.getByText("Choose backup content", { exact: true }).click();
    expect(previews).toHaveLength(0);

    await panel.getByRole("button", { name: "Preview", exact: true }).click();
    const document = panel.getByTestId("bot-package-document");
    await expect(document.getByText(instructions, { exact: true })).toBeVisible();
    expect(previews).toHaveLength(1);
    expect(previews[0]).not.toContain(note);
    expect(previews[0]).not.toContain(secret);
    expect(previews[0]).not.toContain("Ordinary project instructions.");
    expect(previews[0]).not.toContain("claude-sonnet-4-6");
    await captureScreenshot(page, testInfo, "d021-package-folder");
    await panel.getByText("Choose backup content", { exact: true }).click();
    const model = panel.getByRole("checkbox", {
      name: "Model · anthropic/claude-sonnet-4-6",
      exact: true,
    });
    await expect(model).not.toBeChecked();
    await model.click();
    const instructionsChoice = panel.getByRole("checkbox", { name: "HERMES.md", exact: true });
    await instructionsChoice.click();
    await panel.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(
      panel.getByTestId("bot-package-left-out").getByText("anthropic/claude-sonnet-4-6"),
    ).toBeVisible();
    await expect(panel.getByRole("button", { name: "Import as new bot", exact: true })).toHaveCount(
      0,
    );
    await expect(panel.getByText("This import includes supported text only.")).toHaveCount(0);
    expect(previews).toHaveLength(2);
    expect(previews[1]).toContain("claude-sonnet-4-6");
    expect(previews[1]).not.toContain("local-config-fixture");
    await captureScreenshot(page, testInfo, "d021-package-backup-model");
    const key = panel.getByRole("checkbox", { name: "Also import this model’s API key" });
    await expect(key).not.toBeChecked();
    await key.click();
    await panel.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(
      panel.getByText("Import API key · anthropic/claude-sonnet-4-6", { exact: true }),
    ).toBeVisible();
    expect(previews).toHaveLength(3);
    expect(previews[2]).not.toContain("local-config-fixture");
    expect(JSON.parse(previews[2]!).json.importModelKey).toBe(true);
    await captureScreenshot(page, testInfo, "d021-package-backup-model-key");
    const writes: string[] = [];
    let pendingNonce = "";
    const capture = async (route: Route) => {
      const body = route.request().postData() ?? "";
      writes.push(body);
      const { clientNonce } = JSON.parse(body).json;
      pendingNonce = clientNonce;
      // The offline provider emulator rejects this key after the import marker is accepted.
      const response = await route.fetch({ maxRetries: 0 });
      expect(response.status()).toBe(400);
      await route.abort("failed");
    };
    await page.route("**/rpc/botPackages/import", capture);
    await panel.getByRole("button", { name: "Import as new bot", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Check status", exact: true })).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!).json.apiKey).toBe("local-config-fixture");
    expect(
      await rpc<BotPackageReceipt>(page, "botPackages/status", { clientNonce: pendingNonce }),
    ).toMatchObject({
      status: "failed",
      modelKey: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
    });
    await page.unroute("**/rpc/botPackages/import", capture);
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByTestId("create-bot-form")
      .getByRole("button", { name: "Import bot", exact: true })
      .click();
    await panel.getByRole("button", { name: "Recent imports", exact: true }).click();
    await panel
      .getByTestId("bot-package-recent")
      .getByRole("button", { name: "Review import", exact: true })
      .first()
      .click();
    const resume = panel.getByRole("button", { name: "Resume import", exact: true });
    await expect(resume).toBeDisabled();
    await expect(
      panel.getByText("Choose the backup again to resume importing the API key."),
    ).toBeVisible();
    const resumes: string[] = [];
    await page.route("**/rpc/botPackages/resume", async (route) => {
      const body = route.request().postData() ?? "";
      if (JSON.parse(body).json.apiKey === "another-config-fixture") {
        const response = await route.fetch({ maxRetries: 0 });
        expect(response.status()).toBe(400);
        const error = (await response.json()) as { json?: { message?: string } };
        expect(error.json?.message).toBe(
          "Select the original backup to resume this model connection.",
        );
        await route.fulfill({ response });
        return;
      }
      resumes.push(body);
      await route.abort("failed");
    });
    await choose(otherBackup);
    await resume.click();
    await expect(
      panel.getByText("Select the original backup to resume this model connection."),
    ).toBeVisible();
    expect(resumes).toHaveLength(0);
    await choose(root);
    await resume.click();
    await expect.poll(() => resumes.length).toBe(1);
    expect(JSON.parse(resumes[0]!).json).toEqual({
      clientNonce: JSON.parse(writes[0]!).json.clientNonce,
      apiKey: "local-config-fixture",
    });
    await panel.getByRole("button", { name: "Cancel import", exact: true }).click();
    await expect(panel.getByText("Import cancelled.", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Import another bot", exact: true }).click();
    await choose(root);
    await expect(panel.getByRole("status")).toHaveText("Agent backup selected");
    await name.fill("Research folder Bot");
    await panel.getByRole("button", { name: "Preview", exact: true }).click();
    await panel.getByRole("button", { name: "Import as new bot", exact: true }).click();
    await expect(panel.getByText("Bot imported", { exact: true })).toBeVisible();
    expect(
      (await rpc<Bot[]>(page, "bots/list", {})).some(({ name }) => name === "Research folder Bot"),
    ).toBe(true);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("package import survives a committed reply loss and can be recovered explicitly from recent receipts", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await signup(
    page,
    `package-recovery-${Date.now()}@example.test`,
    "password12",
    "Package recovery",
  );
  await completeOnboarding(page);
  const before = await rpc<Bot[]>(page, "bots/list", {});
  let importCalls = 0;
  let accepted: BotPackageReceipt | null = null;
  let failRefresh = false;
  let refreshFailed = false;
  await page.route("**/rpc/spaces/list", async (route) => {
    if (!failRefresh) return route.fallback();
    failRefresh = false;
    refreshFailed = true;
    await route.abort("failed");
  });
  await page.route("**/rpc/botPackages/import", async (route) => {
    importCalls++;
    const response = await route.fetch({ maxRetries: 0 });
    expect(response.ok()).toBe(true);
    accepted = (await response.json()).json as BotPackageReceipt;
    await route.abort("failed");
  });
  await openNewBot(page);
  await page
    .getByTestId("create-bot-form")
    .getByRole("button", { name: "Import bot", exact: true })
    .click();
  const panel = page.getByTestId("bot-package-import");
  await panel.getByLabel("Bot package or Grok JSON", { exact: true }).fill(source);
  await panel.getByRole("button", { name: "Preview", exact: true }).click();
  await panel.getByRole("button", { name: "Import as new bot", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Check status", exact: true })).toBeVisible();
  await expect(panel.getByLabel("Bot package or Grok JSON", { exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Resume import", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "d021-package-unknown");
  failRefresh = true;
  await panel.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(panel.getByText("Bot imported", { exact: true })).toBeVisible();
  await expect.poll(() => refreshFailed).toBe(true);
  await expect(panel.getByText("Bot imported", { exact: true })).toBeVisible();
  expect(importCalls).toBe(1);
  expect(await rpc<Bot[]>(page, "bots/list", {})).toHaveLength(before.length + 1);
  expect(accepted).not.toBeNull();
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByTestId("create-bot-form")
    .getByRole("button", { name: "Import bot", exact: true })
    .click();
  await panel.getByRole("button", { name: "Recent imports", exact: true }).click();
  await panel
    .getByTestId("bot-package-recent")
    .getByRole("button", { name: "Review import", exact: true })
    .first()
    .click();
  await expect(panel.getByText("Bot imported", { exact: true })).toBeVisible();
  expect(importCalls).toBe(1);
  await captureScreenshot(page, testInfo, "d021-package-recovered");
});

test("reviews an imported remote connection before sharing any tools", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1180 });
  await signup(page, `package-mcp-${Date.now()}@example.test`, "password12", "Connection reviewer");
  await completeOnboarding(page);
  await openNewBot(page);
  await page
    .getByTestId("create-bot-form")
    .getByRole("button", { name: "Import bot", exact: true })
    .click();
  const panel = page.getByTestId("bot-package-import");
  const root = await mkdtemp(join(tmpdir(), "backup-connection-browser-"));
  try {
    await mkdir(join(root, ".hermes"));
    const endpoint = "https://docs.example.test/mcp";
    await writeFile(
      join(root, ".hermes", "config.yaml"),
      [
        "mcp_servers:",
        "  Docs:",
        `    url: ${endpoint}`,
        "  Restricted:",
        "    url: https://restricted.example.test/mcp",
        "    tools: { exclude: [fixture_tool] }",
        "  Manual:",
        "    url: https://manual.example.test/mcp",
        "    headers: { Authorization: fixture-credential }",
      ].join("\n"),
    );
    const previews: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/rpc/botPackages/preview"))
        previews.push(request.postData() ?? "");
    });
    await panel.locator("input[webkitdirectory]").setInputFiles(join(root, ".hermes"));
    await expect(panel.getByRole("status")).toHaveText("Agent backup selected");
    await panel.getByLabel("Imported bot name").fill("Connection review bot");
    await panel.getByText("Choose backup content", { exact: true }).click();
    const choice = panel.getByRole("checkbox", { name: `Docs · ${endpoint}`, exact: true });
    await expect(choice).not.toBeChecked();
    await expect(panel.getByRole("button", { name: "Preview", exact: true })).toBeDisabled();
    await expect(
      panel.getByText("Restricted · This connection's tool restrictions cannot be carried over."),
    ).toBeVisible();
    await choice.click();
    await panel.getByRole("button", { name: "Preview", exact: true }).click();
    const reviewed = panel.getByTestId("bot-package-document");
    await reviewed.getByText("Connections · 1", { exact: true }).click();
    await expect(reviewed.getByText(endpoint, { exact: true })).toBeVisible();
    await expect(
      panel.getByText("Review tool access in the imported bot before using these connections."),
    ).toBeVisible();
    expect(previews).toHaveLength(1);
    expect(previews[0]).not.toMatch(
      /fixture-credential|fixture_tool|restricted\.example|manual\.example/,
    );
    await captureScreenshot(page, testInfo, "d021-package-backup-mcp-review");
    await panel.getByRole("button", { name: "Import as new bot", exact: true }).click();
    await expect(panel.getByText("Bot imported", { exact: true })).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Set up connections", exact: true }),
    ).toHaveCount(0);
    await panel.getByRole("button", { name: "Open bot", exact: true }).click();
    const card = page.getByTestId("mcp-approval-card");
    await expect(card).toContainText(endpoint);
    await expect(card.getByRole("button", { name: "Review tool access" })).toBeVisible();
    const dismiss = card.getByRole("button", { name: "Not now" });
    await expect(dismiss).toBeVisible();
    const bounds = await card.boundingBox();
    const dismissBounds = await dismiss.boundingBox();
    expect(bounds).not.toBeNull();
    expect(dismissBounds).not.toBeNull();
    expect(dismissBounds!.x + dismissBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    await captureScreenshot(page, testInfo, "d021-package-backup-mcp-pending");
    await card.getByRole("button", { name: "Review tool access" }).click();
    const settings = page.getByRole("dialog", { name: "MCP servers" });
    await expect(settings.getByText(endpoint, { exact: true })).toBeVisible();
    await expect(settings.getByText("No tools shared in this space")).toBeVisible();
    await settings.getByRole("button", { name: "Tool access", exact: true }).click();
    await expect(
      settings.getByRole("switch", { name: "Share all tools with this space" }),
    ).not.toBeChecked();
    await expect(settings.getByRole("textbox", { name: "Tool names, one per line" })).toHaveValue(
      "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
