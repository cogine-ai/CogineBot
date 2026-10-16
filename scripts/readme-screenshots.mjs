/**
 * Capture the current, complete web app with synthetic data for the README.
 * Run after `pnpm install --frozen-lockfile --ignore-scripts` and
 * `pnpm --filter @rakazo/web exec playwright install chromium`:
 *   node scripts/readme-screenshots.mjs
 * No API, database, model, account, or running deployment is used. Every API
 * request is intercepted; unexpected requests fail the capture. The computer
 * screen is a synthetic document, not evidence of a live sandbox session.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "apps/web/package.json"));
const { chromium, expect } = require("@playwright/test");
const output = path.join(root, "docs/images");
const now = "2026-10-16T10:00:00.000Z";
const time = (minute) => `2026-10-16T09:${String(minute).padStart(2, "0")}:00.000Z`;
const spaceId = "readme-space";
const userId = "readme-user";
const bot = (id, name, color, preview, pinned = false) => ({
  id,
  spaceId,
  name,
  color,
  preview,
  pinned,
  title: "",
  description: "",
  instructions: "",
  notifyOnFinish: true,
  sectionId: null,
  archivedAt: null,
  unread: false,
  attentionMessageId: null,
  parentBotId: null,
  memoryScope: null,
  threadId: `thread-${id}`,
  status: "idle",
  runErrorId: null,
  computerMode: "team",
  updatedAt: time(50),
  createdAt: time(0),
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  disabledBuiltinTools: [],
  webhookConfigured: false,
  spawnKey: null,
});
const bots = [
  bot(
    "readme-chief",
    "Chief",
    "#F5A15D::shape_0",
    "One clear next step. Then we can take it from there.",
    true,
  ),
  bot(
    "readme-scout",
    "Scout",
    "#62A8EC::shape_3",
    "I've added the source notes to our shared brief.",
    true,
  ),
  bot("readme-quill", "Quill", "#A78BE4::shape_6", "The shorter introduction is ready for a look."),
  bot("readme-sage", "Sage", "#56C4B7::shape_8", "Let's compare the options before we decide."),
  bot("readme-spark", "Spark", "#E88EB1::shape_10", "A small idea for the next iteration."),
];
bots[2].unread = true;
const members = bots
  .slice(0, 3)
  .map(({ id, name, color, status }) => ({ botId: id, name, color, status }));
const group = {
  id: "readme-group",
  spaceId,
  name: "Studio",
  pinned: false,
  sectionId: null,
  archivedAt: null,
  members,
  threadId: "thread-readme-group",
  preview: "Quill: I'll keep the brief focused and easy to read.",
  unread: true,
  attentionMessageId: null,
  updatedAt: time(48),
  createdAt: time(0),
};
const spaces = [
  {
    id: spaceId,
    name: "My space",
    isDefault: true,
    hasContent: true,
    canRename: true,
    canDelete: false,
    bots,
    groups: [group],
    externalConversations: [],
    botSections: [],
  },
];
const me = {
  ticketBoardEnabled: false,
  userId,
  email: "demo@example.test",
  name: "Alex",
  spaceId,
  isDeploymentOwner: true,
  needsModel: false,
  defaultProvider: null,
  defaultModel: null,
  hostCredentialProvider: null,
  hostCredentialSource: null,
  computerHost: "docker",
  canChooseHostComputer: true,
  sandboxProvider: "docker",
  avatarStyle: "organic",
  billingEnabled: false,
};
const text = (text) => ({ kind: "text", text });
const message = (id, role, blocks, minute, botId, threadId = "thread-readme-chief") => ({
  id,
  threadId,
  role,
  blocks: typeof blocks === "string" ? [text(blocks)] : blocks,
  seq: minute,
  createdAt: time(minute),
  ...(botId ? { botId } : {}),
});
const conversation = [
  message(
    "chat-1",
    "user",
    "Let's pick up the studio idea. I'd like a small first version we can actually use.",
    31,
  ),
  message(
    "chat-2",
    "bot",
    "Let's keep it simple: one shared brief, a short list of decisions, and a clear next step. I'll help keep the pieces together.",
    32,
    bots[0].id,
  ),
  message(
    "chat-3",
    "user",
    "Good. Ask Scout to gather the notes, and keep the writing conversational.",
    34,
  ),
  message(
    "chat-sent",
    "bot",
    [
      {
        kind: "bot_message_sent",
        toBotId: bots[1].id,
        toBotName: "Scout",
        text: "Please gather the source notes for our studio brief.",
        intent: "request",
      },
    ],
    35,
    bots[0].id,
  ),
  message(
    "chat-received",
    "system",
    [
      {
        kind: "bot_message_received",
        fromBotId: bots[1].id,
        fromBotName: "Scout",
        text: "The source notes are ready. I separated what we know from what still needs a decision.",
        intent: "result",
      },
    ],
    39,
  ),
  message(
    "chat-4",
    "bot",
    "Scout's notes are in. We have enough to start with a focused brief:\n\n- **Purpose:** make the next decision easier.\n- **First version:** a short outline, with sources alongside it.\n- **Next step:** choose the one question we want to answer first.",
    40,
    bots[0].id,
  ),
  message(
    "chat-5",
    "user",
    "That feels right. Let's start with the question, and leave the rest for later.",
    43,
  ),
  message("chat-6", "bot", "One clear next step. Then we can take it from there.", 44, bots[0].id),
];
const brief =
  "# Studio brief\n\nA small first version, with space to keep thinking together.\n\n## What we are making\n\nA shared place to turn scattered notes into one clear next step. Keep the language direct and the decisions easy to find.\n\n## First version\n\n- A short introduction that explains the purpose.\n- Source notes alongside the claims they support.\n- Open questions kept separate from decisions.\n\n## Decisions\n\n| Question | Direction |\n| --- | --- |\n| How much should we start with? | One useful page |\n| How should it read? | Like a conversation |\n| What comes next? | Choose one question to explore |\n\n## Next step\n\nRead this together, leave comments, and choose the next small step.\n";
const groupMessages = [
  message(
    "group-1",
    "user",
    "@Scout @Quill Let's turn the studio notes into a brief. Keep it useful, and leave room for questions.",
    35,
    undefined,
    group.threadId,
  ),
  message(
    "group-2",
    "bot",
    "I'll gather the evidence and keep the open questions visible. We can separate what we know from what we're still exploring.",
    36,
    bots[1].id,
    group.threadId,
  ),
  message(
    "group-3",
    "bot",
    "And I'll shape it into a short introduction. A clear purpose, three useful points, and a next step should be enough.",
    37,
    bots[2].id,
    group.threadId,
  ),
  message(
    "group-4",
    "user",
    "Exactly. It should feel like a conversation we can return to, rather than a finished presentation.",
    40,
    undefined,
    group.threadId,
  ),
  message(
    "group-5",
    "bot",
    "Then let's keep one shared thread. Scout brings the notes, Quill works on the wording, and I'll keep track of our decisions.",
    41,
    bots[0].id,
    group.threadId,
  ),
  message(
    "group-6",
    "bot",
    "I've added the source notes to our shared brief. The two open questions are clearly marked.",
    45,
    bots[1].id,
    group.threadId,
  ),
  message(
    "group-7",
    "bot",
    [
      text("I'll keep the brief focused and easy to read."),
      {
        kind: "file",
        artifactId: "readme-brief",
        mimeType: "text/markdown",
        name: "Studio brief.md",
        size: Buffer.byteLength(brief),
      },
    ],
    48,
    bots[2].id,
    group.threadId,
  ),
];
const contents = {
  "readme-brief": brief,
  "readme-notes":
    "# Source notes\n\n## Observations\n\n- Keep each claim close to its source.\n- Make open questions easy to find.\n- Prefer a useful first version over a long document.\n\nAll content in this workspace is synthetic demo data.\n",
  "readme-decisions":
    "date,decision,owner\n2026-10-16,Start with one useful page,Chief\n2026-10-16,Keep sources alongside the brief,Scout\n2026-10-16,Use conversational language,Quill\n",
  "readme-outline":
    "# Working outline\n\n1. Why this matters\n2. What we know\n3. What we should try next\n",
};
const artifacts = [
  [
    "readme-brief",
    "Studio brief.md",
    "text/markdown",
    bots[2].id,
    48,
    "A small first version, ready to discuss.",
  ],
  [
    "readme-notes",
    "Source notes.md",
    "text/markdown",
    bots[1].id,
    45,
    "Evidence and open questions in one place.",
  ],
  [
    "readme-decisions",
    "Decisions.csv",
    "text/csv",
    bots[0].id,
    41,
    "A short record of the choices so far.",
  ],
  [
    "readme-outline",
    "Working outline.md",
    "text/markdown",
    bots[2].id,
    37,
    "An early outline for the studio brief.",
  ],
].map(([id, name, mimeType, botId, minute, description]) => ({
  id,
  name,
  mimeType,
  botId,
  description,
  groupId: group.id,
  runId: null,
  size: Buffer.byteLength(contents[id]),
  version: 1,
  createdAt: time(minute),
  versionCount: 1,
}));
let controlled = false;
const computer = () => ({
  botId: bots[0].id,
  mode: "team",
  kind: "docker",
  state: "running",
  controlHolder: controlled ? "user" : "bot",
  controlBotId: controlled ? bots[0].id : null,
  takeoverRequested: false,
  screenAvailable: true,
  screenWidth: 1280,
  screenHeight: 800,
  homeRevision: null,
  busyBotName: null,
  canUpdate: false,
  terminalAvailable: true,
});
function snapshot(target = {}) {
  const grouped = target.groupId === group.id;
  const botId = target.botId ?? bots[0].id;
  return {
    threadId: grouped ? group.threadId : `thread-${botId}`,
    cursor: 50,
    messages: grouped ? groupMessages : conversation,
    olderCursor: null,
    run: null,
    activeRuns: [],
    attentionMessageId: null,
    answerableApprovalMessageIds: [],
    ...(grouped
      ? { groupId: group.id, groupName: group.name, members }
      : { botId, computer: computer() }),
  };
}

const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const base = `http://127.0.0.1:${port}`;
const viteCli = path.join(path.dirname(require.resolve("vite/package.json")), "bin/vite.js");
const vite = spawn(process.execPath, [viteCli, "--host", "127.0.0.1", "--strictPort"], {
  cwd: path.join(root, "apps/web"),
  env: { ...process.env, WEB_PORT: String(port), BROWSER: "none" },
  stdio: ["ignore", "pipe", "pipe"],
});
const viteClosed = new Promise((resolve) => vite.once("close", resolve));
let viteStartError;
vite.on("error", (error) => {
  viteStartError = error;
});
let serverLog = "";
vite.stdout.on("data", (data) => {
  serverLog += data;
});
vite.stderr.on("data", (data) => {
  serverLog += data;
});
let browser;
const unexpected = new Set();
const errors = new Set();
const calls = [];
const json = (route, value) =>
  route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
try {
  for (let attempt = 0; ; attempt++) {
    if (viteStartError) throw viteStartError;
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      /* Wait for our own Vite process. */
    }
    if (attempt === 119 || vite.exitCode !== null)
      throw new Error(`Web server did not start.\n${serverLog}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await mkdir(output, { recursive: true });
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  await context.addInitScript(
    ({ userId, spaceId }) => {
      localStorage.setItem("rakazo.uiLocale", "en");
      localStorage.setItem("rakazo.uiAppearance", "light");
      localStorage.setItem("rakazo:space-id", spaceId);
      localStorage.setItem("rakazo:artifacts-view-mode", "list");
      localStorage.removeItem(`rakazo:bots-sidebar-collapsed:${userId}`);
    },
    { userId, spaceId },
  );
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) {
      unexpected.add(`External request: ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (url.pathname === "/api/auth/get-session")
      return json(route, {
        session: {
          id: "readme-session",
          token: "synthetic-not-a-secret",
          userId,
          expiresAt: "2030-01-01T00:00:00.000Z",
          createdAt: time(0),
          updatedAt: time(0),
          ipAddress: "",
          userAgent: "",
        },
        user: {
          id: userId,
          name: "Alex",
          email: me.email,
          emailVerified: true,
          image: null,
          createdAt: time(0),
          updatedAt: time(0),
        },
      });
    if (url.pathname === "/api/auth/capabilities")
      return json(route, {
        sso: null,
        passwordAuth: true,
        passwordReset: false,
        resetUrl: null,
        billing: false,
      });
    if (url.pathname === "/readme-demo-screen")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Studio notes — synthetic example</title><style>body{margin:0;background:#f4f5f7;color:#202b35;font:16px/1.7 system-ui}main{margin:48px auto;max-width:1080px;background:white;padding:40px 48px;min-height:580px;border:1px solid #e2e5e8}small{color:#67717a}h1{font-size:36px;letter-spacing:-1px}p{max-width:660px}hr{border:0;border-top:1px solid #e2e5e8;margin:28px 0}</style><main><small>STUDIO / WORKING NOTES · SYNTHETIC EXAMPLE</small><h1>A useful first version.</h1><p>One shared brief. Sources close to the claims. Open questions that are easy to return to.</p><hr><h2>Keep the next step clear</h2><p>Start with one useful page, then read it together. Leave room for comments and the next conversation.</p><ul><li>Purpose and context</li><li>Evidence and source notes</li><li>Decisions and open questions</li></ul></main></html>`,
      });
    if (url.pathname.startsWith("/rpc/")) {
      const procedure = url.pathname.slice(5);
      const input = request.postDataJSON()?.json ?? {};
      calls.push(procedure);
      let result;
      switch (procedure) {
        case "bootstrap":
          result = {
            me,
            bots,
            groups: [group],
            botSections: [],
            archivedBots: [],
            archivedGroups: [],
            thread: snapshot(input),
            routines: [],
            spaces,
          };
          break;
        case "me":
          result = me;
          break;
        case "spaces/list":
          result = { current: { ...spaces[0] }, spaces };
          break;
        case "bots/list":
          result = bots;
          break;
        case "groups/list":
          result = [group];
          break;
        case "bots/listArchived":
        case "groups/listArchived":
        case "agentSkills/list":
        case "routines/list":
        case "skills/list":
        case "connections/list":
        case "connections/catalog":
        case "computer/updates":
          result = [];
          break;
        case "memory/providerConfig":
          result = null;
          break;
        case "messaging/status":
          result = { enabled: false, providers: [], linkedIdentities: [] };
          break;
        case "voice/status":
          result = {
            configured: false,
            ready: false,
            transcribe: false,
            provider: null,
            voiceId: "",
          };
          break;
        case "usage/summary":
          result = { inputTokens: 0, outputTokens: 0, runs: 0 };
          break;
        case "threads/get":
          result = snapshot(input);
          break;
        case "threads/head":
          result = { threadId: snapshot(input).threadId, cursor: 50 };
          break;
        case "threads/subscribe":
          return route.fulfill({
            contentType: "text/event-stream",
            body: ": synthetic snapshot; no live events\n\n",
          });
        case "threads/markRead":
        case "threads/markUnread":
        case "computer/heartbeat":
          result = { ok: true };
          break;
        case "computer/status":
        case "computer/boot":
          result = computer();
          break;
        case "computer/screenUrl":
          result = { url: `${base}/readme-demo-screen` };
          break;
        case "computer/takeover":
          controlled = true;
          result = { leaseId: "readme-lease", expiresAt: "2026-10-16T10:30:00.000Z" };
          break;
        case "computer/release":
          controlled = false;
          result = { ok: true };
          break;
        case "computer/files":
          result = artifacts.map((entry) => ({ path: entry.name, kind: "file", size: entry.size }));
          break;
        case "computer/commands":
          result = [
            {
              executionId: "readme-command",
              kind: "shell",
              command: "ls -1",
              cwd: "/home/oai/share",
              status: "done",
              exitCode: 0,
              output: artifacts.map((entry) => entry.name).join("\n"),
              createdAt: time(49),
            },
          ];
          break;
        case "artifacts/listSpace":
          result = { items: artifacts, nextCursor: null };
          break;
        case "artifacts/listVersions": {
          const artifact = artifacts.find((entry) => entry.id === input.familyId);
          assert(artifact);
          result = [artifact];
          break;
        }
        case "artifacts/getById": {
          const artifact = artifacts.find((entry) => entry.id === input.artifactId);
          assert(artifact);
          result = {
            ...artifact,
            contentBase64: Buffer.from(contents[artifact.id]).toString("base64"),
          };
          break;
        }
        default:
          unexpected.add(`RPC: ${procedure}`);
          return route.fulfill({ status: 500, body: "Unexpected synthetic screenshot request" });
      }
      return json(route, { json: result });
    }
    if (url.pathname.startsWith("/api/")) {
      unexpected.add(`API: ${url.pathname}`);
      return route.fulfill({ status: 500, body: "Unexpected synthetic screenshot request" });
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.add(error.message));
  page.on("console", (event) => {
    if (event.type() === "error") errors.add(event.text());
  });
  await page.clock.setFixedTime(new Date(now));
  async function capture(name) {
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await page.mouse.move(1430, 950);
    await page.screenshot({ path: path.join(output, name), animations: "disabled", caret: "hide" });
    console.log(`Captured ${name}`);
  }
  await page.goto(`${base}/app/${bots[0].id}`);
  await expect(page.getByTestId("bots-sidebar")).toBeVisible();
  await expect(
    page.getByText("One clear next step. Then we can take it from there.", { exact: true }).last(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Message from Scout", exact: true })).toBeVisible();
  await capture("conversation.png");
  await page.getByTestId("minimize-bots-sidebar").click();
  await expect(page.getByTestId("bots-sidebar")).toHaveAttribute("data-collapsed", "true");
  await capture("conversation-compact.png");
  await page.getByTestId("restore-bots-sidebar").click();

  await page.goto(`${base}/app/g/${group.id}`);
  const composer = page.getByRole("combobox", { name: "Message Studio", exact: true });
  await expect(
    page
      .getByTestId("transcript")
      .getByText("I'll keep the brief focused and easy to read.", { exact: true }),
  ).toBeVisible();
  await composer.fill("@Scout");
  await page.getByRole("option", { name: "@Scout", exact: true }).click();
  await composer.fill("@Quill");
  await page.getByRole("option", { name: "@Quill", exact: true }).click();
  await composer.fill("Let's review the open questions together.");
  await expect(page.getByTestId("mention-chip")).toHaveCount(2);
  await capture("group-chat.png");

  await page.goto(`${base}/app/artifacts/readme-brief`);
  await expect(page.getByRole("heading", { name: "Studio brief", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await capture("files.png");

  await page.goto(`${base}/app/${bots[0].id}`);
  await page.getByTitle("Agent computer", { exact: true }).click();
  await page.getByTestId("computer-preview-open").click();
  const chrome = page.getByTestId("computer-chrome");
  await expect(chrome.getByText("Watching", { exact: true })).toBeVisible();
  assert.equal(calls.filter((procedure) => procedure === "computer/takeover").length, 0);
  await chrome.getByRole("button", { name: "Take control", exact: true }).click();
  await expect(chrome.getByText("You have control", { exact: true })).toBeVisible();
  await chrome.getByRole("button", { name: "I’m done", exact: true }).click();
  await expect(chrome.getByText("Watching", { exact: true })).toBeVisible();
  assert.equal(calls.filter((procedure) => procedure === "computer/takeover").length, 1);
  assert.equal(calls.filter((procedure) => procedure === "computer/release").length, 1);
  await page
    .getByTestId("computer-viewport")
    .getByRole("button", { name: "Files", exact: true })
    .click();
  await expect(
    page.getByTestId("computer-files").getByText("Studio brief.md", { exact: true }),
  ).toBeVisible();
  await capture("computer.png");
  assert.deepEqual(
    [...unexpected],
    [],
    "Unexpected requests must be explicitly represented by synthetic fixtures",
  );
  assert.deepEqual(
    [...errors],
    [],
    "The rendered app must have no browser runtime or console errors",
  );
  console.log(
    "Verified full app rendering, multi-Bot mentions, file preview, watch → take control → done → watch; all API data synthetic.",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    vite.kill("SIGTERM");
    const forceStop = setTimeout(() => vite.kill("SIGKILL"), 5_000);
    forceStop.unref();
    try {
      await viteClosed;
    } finally {
      clearTimeout(forceStop);
    }
  }
}
