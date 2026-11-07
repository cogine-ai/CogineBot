import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";

function dashboard(churn: string) {
  return `const data = { signups: [42, 51, 47, 63, 58, 71, 66], labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] };
function Dashboard() {
  const [period, setPeriod] = useState("7d");
  const [targets, setTargets] = useState(false);
  const points = useMemo(() => data.signups.map((value, i) => ({ label: data.labels[i], value })), []);
  return (
    <Page width="wide" title="Test dashboard" summary="A sample dashboard with made-up example data, to show what a Page looks like and how its controls work.">
      <Section heading="Headline figures">
        <Segmented options={[{ value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }]} value={period} onChange={setPeriod} />
        <Text>All numbers here are example data, not real metrics. Method: https://example.com/metrics</Text>
        <ReplyButton label="Ask about churn" reply="Why did churn change this week?" />
        <CopyButton label="Copy MRR" text="MRR $12,400" />
        <Toggle label={targets ? "Targets shown" : "Show targets"} value={targets} onChange={setTargets} />
        <Metrics metrics={[{ value: "$12,400", label: "MRR" }, { value: "398", label: "New users" }, { value: "${churn}", label: "Churn", tone: "warning" }, { value: "4.8%", label: "Trial to paid" }]} />
      </Section>
      <Grid columns={2}>
        <Section heading="Signups over time"><LineChart points={points} ceiling={86} floor={0} labels={["Signups"]} /></Section>
        <Section heading="Signups by source"><Bars bars={[{ label: "Organic search", value: 46, display: "46%" }, { label: "Direct", value: 24, display: "24%" }]} emphasis={0} /></Section>
      </Grid>
    </Page>
  );
}
export default Dashboard;`;
}

/** The page document, two sandboxed frames down. */
function pageFrame(page: Page, title: string) {
  return page
    .locator(`iframe[title="${title}"]`)
    .last()
    .contentFrame()
    .locator("iframe#preview")
    .contentFrame();
}

async function send(page: Page, text: string) {
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill(text);
  await composer.press("Enter");
}

test("the Pages button reflects the library's open state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signup(page, `pages-toggle-${Date.now()}@rakazo.test`, "password12", "Page Owner");
  await completeOnboarding(page);

  const toggle = page.getByRole("button", { name: "Pages", exact: true });
  const panel = page.getByTestId("side-panel");
  const library = panel.getByText(/Pages this bot builds for you appear here/);

  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(library).toBeHidden();
  const closedBackground = await toggle.evaluate(
    (button) => getComputedStyle(button).backgroundColor,
  );
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(library).toBeVisible();
  await expect(toggle).not.toHaveCSS("background-color", closedBackground);

  await toggle.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(library).toBeHidden();
  await expect(toggle).toHaveCSS("background-color", closedBackground);

  await toggle.click();
  await panel.getByRole("button", { name: "Show settings", exact: true }).click();
  await expect(panel).toHaveAttribute("data-panel", "settings");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(library).toBeHidden();
  await panel.getByRole("button", { name: "Close panel", exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(library).toBeVisible();
  await panel.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(library).toBeHidden();
});

test("a private page opens from its card, replies in chat and updates", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
  await page
    .context()
    .route("https://example.com/metrics", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<p>Example metrics</p>" }),
    );
  await page.setViewportSize({ width: 1280, height: 860 });
  await signup(page, `pages-${Date.now()}@rakazo.test`, "password12", "Page Owner");
  await completeOnboarding(page);

  const title = "Test dashboard (example data)";
  await send(
    page,
    `call save_page with ${JSON.stringify({ title, source: dashboard("2.1%") })}\nthen say I made a ${title} with made-up example data.`,
  );
  const card = page.getByTestId("page-card");
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await expect(card).toContainText(title);
  await expect(card).toContainText("Page");
  // The card sits under the reply that introduces it.
  await expect(page.getByTestId("message-bot-bubble").last()).toContainText(`I made a ${title}`);
  await expect(pageFrame(page, title).getByText("$12,400")).toBeVisible();
  await captureScreenshot(page, testInfo, "page-chat-card");

  await card.getByRole("button", { name: `Open ${title}` }).click();
  const view = page.getByTestId("page-view");
  await expect(view).toBeVisible();
  await expect(page).toHaveURL(/[?&]page=/);
  const pageId = new URL(page.url()).searchParams.get("page")!;
  await expect(
    pageFrame(page, title).getByRole("heading", { name: "Test dashboard", level: 1 }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "page-full-screen");
  // Opening lands on Close; title and Download PDF precede the page's own controls.
  await expect(view.getByRole("button", { name: "Close page" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(view.getByRole("button", { name: title })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(view.getByRole("button", { name: "Download PDF" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(view.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
  // Download PDF opens the print dialog, and on paper only the page shows: no controls, no
  // composer, no chat behind it, and the page at its full height drawn light on a dark app.
  await page.evaluate(() => {
    const counted = window as Window & { printed?: number };
    counted.printed = 0;
    window.print = () => {
      counted.printed = (counted.printed ?? 0) + 1;
    };
  });
  await view.getByRole("button", { name: "Download PDF" }).click();
  expect(await page.evaluate(() => (window as Window & { printed?: number }).printed)).toBe(1);
  await page.emulateMedia({ media: "print" });
  for (const name of ["Close page", title, "Download PDF"]) {
    await expect(view.getByRole("button", { name })).toBeHidden();
  }
  await expect(page.getByRole("combobox", { name: /^Message/ })).toBeHidden();
  await expect(card).toBeHidden();
  const printedHeading = pageFrame(page, title).getByRole("heading", {
    name: "Test dashboard",
    level: 1,
  });
  await expect(printedHeading).toBeVisible();
  await expect
    .poll(() => printedHeading.evaluate((heading) => getComputedStyle(heading).color))
    .toMatch(/^rgb\((\d|[1-9]\d), (\d|[1-9]\d), (\d|[1-9]\d)\)$/);
  const pageHeight = await pageFrame(page, title)
    .locator("body")
    .evaluate((body) => body.scrollHeight);
  await expect
    .poll(async () => (await page.locator(`iframe[title="${title}"]`).last().boundingBox())?.height)
    .toBeGreaterThanOrEqual(pageHeight);
  await captureScreenshot(page, testInfo, "page-print");
  await page.emulateMedia({ media: null });

  // A reply button on the page fills the chat's composer; the user still sends it.
  const userBubbles = page.getByTestId("message-user-bubble");
  const sentBefore = await userBubbles.count();
  await pageFrame(page, title).getByRole("button", { name: "Ask about churn" }).click();
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toHaveValue("Why did churn change this week?");
  await expect(userBubbles).toHaveCount(sentBefore);
  await composer.fill("");

  // Copying works where the page's own frame has no clipboard (Safari, phone WebViews): the
  // app copies for it and the button says so.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await pageFrame(page, title)
    .locator("body")
    .evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { value: undefined });
    });
  await pageFrame(page, title).getByRole("button", { name: "Copy MRR" }).click();
  await expect(pageFrame(page, title).getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("MRR $12,400");
  // The switch itself takes the click, not only its label.
  await pageFrame(page, title).getByRole("switch").click();
  await expect(pageFrame(page, title).getByRole("switch", { name: "Targets shown" })).toBeChecked();

  // Links in the page ask first, as links in chat do, then open in a new tab through the app.
  await pageFrame(page, title).getByRole("link", { name: "https://example.com/metrics" }).click();
  const leave = page.getByRole("alertdialog", { name: "Open external link?" });
  await expect(leave).toContainText("example.com/metrics");
  const [popup] = await Promise.all([
    page.context().waitForEvent("page"),
    leave.getByRole("button", { name: "Open", exact: true }).click(),
  ]);
  expect(popup.url()).toBe("https://example.com/metrics");
  await popup.close();

  await view.getByRole("button", { name: title }).click();
  await view.getByRole("textbox", { name: "Page title" }).fill("Signups dashboard");
  await view.getByRole("textbox", { name: "Page title" }).press("Enter");
  await expect(view.getByRole("button", { name: "Signups dashboard" })).toBeVisible();
  // A lost receipt keeps the Page-derived payload even if the reader closes before retry.
  const pageSends: Record<string, unknown>[] = [];
  const pageReceipts: unknown[] = [];
  await page.route("**/rpc/threads/send", async (route) => {
    pageSends.push(route.request().postDataJSON().json);
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    pageReceipts.push((await response.json()).json);
    if (pageSends.length === 1) await route.abort("internetdisconnected");
    else await route.fulfill({ response });
  });
  await composer.fill("make the churn tile red");
  await composer.press("Enter");
  await expect(page.getByTestId("composer-error")).toBeVisible();
  await view.getByRole("button", { name: "Close page" }).click();
  await expect(view).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]page=/);
  const retryResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/send") && response.ok(),
  );
  await send(page, "make the churn tile red");
  await retryResponse;
  await expect(page.getByTestId("composer-error")).toBeHidden();
  expect(pageSends).toHaveLength(2);
  expect(pageSends[1]).toEqual(pageSends[0]);
  expect(pageReceipts[1]).toEqual(pageReceipts[0]);
  await page.unroute("**/rpc/threads/send");

  await expect(
    page.getByTestId("message-user-bubble").filter({ hasText: "make the churn tile red" }),
  ).toBeVisible();
  // It replies to the page's card, so the bot reads which page it is about by id.
  const history = await rpc<{
    messages: Array<{ id: string; replyToMessageId?: string; blocks: Array<{ kind: string }> }>;
  }>(page, "threads/messages", { botId: activeBotId(page) });
  const askedMessages = history.messages.filter((message) =>
    message.blocks.some(
      (block) =>
        block.kind === "text" && "text" in block && block.text === "make the churn tile red",
    ),
  );
  expect(askedMessages).toHaveLength(1);
  const asked = askedMessages[0];
  const target = history.messages.find((message) => message.id === asked?.replyToMessageId);
  expect(target?.blocks).toContainEqual({ kind: "page", pageId, version: 1, title });

  await send(
    page,
    `call save_page with ${JSON.stringify({ pageId, title: "Signups dashboard", source: dashboard("1.9%") })}\nthen say Updated [Signups dashboard](page:${pageId}) with the new churn figure.`,
  );
  await expect(card).toHaveCount(2, { timeout: 30_000 });
  await expect(card.first()).toContainText("Updated below");
  await expect(card.last()).not.toContainText("Updated below");
  // Previews draw once their card scrolls near view.
  await card.last().scrollIntoViewIfNeeded();
  await expect(pageFrame(page, "Signups dashboard").getByText("1.9%")).toBeVisible();
  await captureScreenshot(page, testInfo, "page-updated-below");

  // The reply names the page as a chip that opens it.
  const chip = page.getByTestId("message-bot-bubble").last().getByRole("button", {
    name: "Signups dashboard",
  });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(view).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]page=${pageId}`));
  await page.keyboard.press("Escape");
  await expect(view).toBeHidden();

  // The older card opens the latest version.
  await card.first().getByRole("button", { name: "Open Signups dashboard" }).click();
  await expect(view).toBeVisible();
  await expect(pageFrame(page, "Signups dashboard").getByText("1.9%")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await page
    .getByTestId("bot-pages")
    .getByRole("button", { name: /^Signups dashboard/ })
    .click();
  await expect(view).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(view).toBeHidden();
  // The Library pins a page into its own group and deletes it after naming it.
  const library = page.getByTestId("bot-pages");
  const more = library.getByRole("button", { name: "Actions for Signups dashboard" });
  await more.click();
  await expect(page.getByRole("menuitem", { name: "Pin", exact: true })).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCSS("opacity", "1");
  await captureScreenshot(page, testInfo, "page-library-menu");
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await expect(library.getByRole("heading", { name: "Pinned" })).toBeVisible();
  await captureScreenshot(page, testInfo, "page-library-pinned");
  await more.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete Signups dashboard?" });
  await captureScreenshot(page, testInfo, "page-delete-confirm");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(/Pages this bot builds for you appear here/)).toBeVisible();
  await captureScreenshot(page, testInfo, "page-library-empty");
});

const ROGUE = `Object.defineProperty(KeyboardEvent.prototype, "repeat", { get: () => false });
function Rogue() {
  const [sent, setSent] = useState(0);
  useEffect(() => {
    let keys = 0;
    const onKey = () => {
      keys += 1;
      parent.postMessage({ type: "rakazo-page:copy", id: "key" + keys, text: "key " + keys }, "*");
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const ask = () => {
      parent.postMessage({ type: "rakazo-page:copy", id: "load", text: "copied on load" }, "*");
      parent.postMessage({ type: "rakazo-page:open-link", url: "https://example.com/on-load" }, "*");
      parent.postMessage({ type: "rakazo-page:reply", text: "replied on load" }, "*");
      setSent((count) => count + 1);
    };
    ask();
    const timer = setInterval(ask, 300);
    setTimeout(() => clearInterval(timer), 1500);
    return () => clearInterval(timer);
  }, []);
  return (
    <Page title="Rogue">
      <Text>{sent >= 5 ? "Sent on load" : "Sending"}</Text>
      <CopyButton label="Copy now" text="copied after a click" />
      <button
        onClick={() => {
          parent.postMessage({ type: "rakazo-page:copy", id: "one", text: "first copy" }, "*");
          parent.postMessage({ type: "rakazo-page:copy", id: "two", text: "second copy" }, "*");
          parent.postMessage({ type: "rakazo-page:reply", text: "replied too" }, "*");
        }}
      >
        Ask three times
      </button>
      <Text>Read more: https://example.com/after-click</Text>
    </Page>
  );
}
export default Rogue;`;

test("a page acts for its reader only after a click in it, never on load or from a card", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signup(page, `pages-rogue-${Date.now()}@rakazo.test`, "password12", "Rogue Reader");
  await completeOnboarding(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("untouched"));
  const opened: string[] = [];
  page.context().on("page", (tab) => opened.push(tab.url()));
  const composer = page.getByRole("combobox", { name: /^Message/ });
  const untouched = async () => {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("untouched");
    expect(opened).toEqual([]);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(composer).toHaveValue("");
  };

  await send(
    page,
    `call save_page with ${JSON.stringify({ title: "Rogue", source: ROGUE })}\nthen say Done.`,
  );
  const card = page.getByTestId("page-card");
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  // The card's live preview runs the page, which asks five times on load.
  await expect(pageFrame(page, "Rogue").getByText("Sent on load")).toBeVisible();
  await untouched();

  // Opening it full screen is a click in the app, not in the page.
  await card.getByRole("button", { name: "Open Rogue" }).click();
  await expect(page.getByTestId("page-view")).toBeVisible();
  await expect(pageFrame(page, "Rogue").getByText("Sent on load")).toBeVisible();
  await untouched();

  // A click inside the page lets the app copy for it, and its link still asks before leaving.
  await pageFrame(page, "Rogue").getByRole("button", { name: "Copy now" }).click();
  await expect(pageFrame(page, "Rogue").getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("copied after a click");
  await pageFrame(page, "Rogue")
    .getByRole("link", { name: "https://example.com/after-click" })
    .click();
  const leave = page.getByRole("alertdialog", { name: "Open external link?" });
  await expect(leave).toContainText("example.com/after-click");
  await captureScreenshot(page, testInfo, "page-link-confirm");
  await leave.getByRole("button", { name: "Cancel" }).click();
  await expect(leave).toBeHidden();
  expect(opened).toEqual([]);

  // One click is one action: what else the page asks for with that click is dropped.
  await pageFrame(page, "Rogue").getByRole("button", { name: "Ask three times" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("first copy");
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("first copy");
  await expect(composer).toHaveValue("");

  // A held key is one gesture, even when the page hides that its keydowns repeat.
  await page.waitForTimeout(1100);
  await page.keyboard.down("a");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("key 1");
  await page.keyboard.down("a");
  await page.keyboard.down("a");
  await page.keyboard.up("a");
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("key 1");
});

test("a deep-linked page replies in its originating bot or group, leaving the other chat unchanged", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signup(page, `pages-origin-${Date.now()}@rakazo.test`, "password12", "Page Reader");
  await completeOnboarding(page);
  const originBotId = activeBotId(page);
  const save = async (title: string, reply: string) => {
    const source = `export default function Plan() { return <Page title="Origin plan"><ReplyButton label="Ask origin" reply=${JSON.stringify(reply)} /></Page>; }`;
    await send(page, `call save_page with ${JSON.stringify({ title, source })}\nthen say Done.`);
    await expect(page.getByTestId("page-card").filter({ hasText: title }).first()).toBeVisible({
      timeout: 30_000,
    });
  };
  const history = (target: { botId: string } | { groupId: string }) =>
    rpc<{ messages: Array<{ blocks: Array<{ kind: string; text?: string }> }> }>(
      page,
      "threads/messages",
      target,
    );
  const includes = async (target: { botId: string } | { groupId: string }, text: string) =>
    (await history(target)).messages.some((message) =>
      message.blocks.some((block) => block.kind === "text" && block.text === text),
    );

  await save("Bot origin plan", "Clarify the bot page.");
  const botPages = await rpc<{ items: Array<{ id: string }> }>(page, "pages/list", {
    botId: originBotId,
  });
  expect(botPages.items).toHaveLength(1);
  const botPageId = botPages.items[0]!.id;
  const otherBotId = await createNamedBot(page, "Other Page Bot");
  await page.goto(`/app/${otherBotId}?page=${botPageId}`);
  await expect(page).toHaveURL(new RegExp(`/app/${originBotId}\\?page=${botPageId}$`));
  await expect(page.getByTestId("page-view")).toBeVisible();
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await pageFrame(page, "Bot origin plan").getByRole("button", { name: "Ask origin" }).click();
  await expect(composer).toHaveValue("Clarify the bot page.");
  expect(await includes({ botId: originBotId }, "Clarify the bot page.")).toBe(false);
  await composer.press("Enter");
  await expect.poll(() => includes({ botId: originBotId }, "Clarify the bot page.")).toBe(true);
  expect(await includes({ botId: otherBotId }, "Clarify the bot page.")).toBe(false);
  await page.keyboard.press("Escape");

  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Page Planning Team",
    botIds: [originBotId, otherBotId],
  });
  await page.goto(`/app/g/${group.id}`);
  await expect(composer).toBeVisible();
  await save("Group origin plan", "Clarify the group page.");
  const groupPages = await rpc<{ items: Array<{ id: string }> }>(page, "pages/list", {
    groupId: group.id,
  });
  expect(groupPages.items.length).toBeGreaterThan(0);
  const groupPageId = groupPages.items[0]!.id;
  await page.goto(`/app/${otherBotId}?page=${groupPageId}`);
  await expect(page).toHaveURL(new RegExp(`/app/g/${group.id}\\?page=${groupPageId}$`));
  await expect(
    pageFrame(page, "Group origin plan").getByRole("heading", { name: "Origin plan" }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "page-origin-group");
  await pageFrame(page, "Group origin plan").getByRole("button", { name: "Ask origin" }).click();
  await expect(composer).toHaveValue("Clarify the group page.");
  expect(await includes({ groupId: group.id }, "Clarify the group page.")).toBe(false);
  await composer.press("Enter");
  await expect.poll(() => includes({ groupId: group.id }, "Clarify the group page.")).toBe(true);
  expect(await includes({ botId: otherBotId }, "Clarify the group page.")).toBe(false);
});

test("the network viewer shell loads an embedded font and blocks remote font requests", async ({
  page,
}) => {
  const font = readFileSync(
    new URL(
      "../node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
      import.meta.url,
    ),
  );
  expect(font.subarray(0, 4).toString()).toBe("wOF2");
  const remoteFontUrl = "https://page-font.invalid/probe.woff2";
  const remoteRequests: string[] = [];
  await page.route(remoteFontUrl, async (route) => {
    remoteRequests.push(route.request().url());
    await route.abort();
  });
  const document = `<!doctype html>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'">
    <style>
      @font-face {
        font-family: "EmbeddedPageFontProbe";
        font-weight: 100 900;
        src: url("data:font/woff2;base64,${font.toString("base64")}") format("woff2");
      }
      @font-face {
        font-family: "RemotePageFontProbe";
        src: url("${remoteFontUrl}") format("woff2");
      }
    </style>
    <p>Embedded Page font probe</p>`;
  // A real application document embeds the network shell, which owns the opaque nested frame.
  await page.goto("/sign-in");
  await page.evaluate((html) => {
    const shell = window.document.createElement("iframe");
    shell.title = "Page font shell";
    shell.setAttribute("sandbox", "allow-scripts");
    shell.addEventListener("load", () => shell.contentWindow!.postMessage(html, "*"));
    shell.src = "/html-viewer.html";
    window.document.body.replaceChildren(shell);
  }, document);
  const preview = page
    .frameLocator('iframe[title="Page font shell"]')
    .frameLocator("iframe#preview");
  await expect(preview.getByText("Embedded Page font probe", { exact: true })).toBeVisible();
  const result = await preview.locator("body").evaluate(async () => {
    const load = async (family: string) => {
      try {
        const faces = await window.document.fonts.load(`400 16px "${family}"`, "Hello Pages");
        return {
          faces: faces.map((face) => ({ family: face.family, status: face.status })),
          error: null,
        };
      } catch (error) {
        return { faces: [], error: error instanceof Error ? error.name : String(error) };
      }
    };
    return {
      embedded: await load("EmbeddedPageFontProbe"),
      remote: await load("RemotePageFontProbe"),
    };
  });
  expect(result.embedded.error).toBeNull();
  expect(result.embedded.faces).toHaveLength(1);
  expect(result.embedded.faces[0]!.family.replaceAll('"', "")).toBe("EmbeddedPageFontProbe");
  expect(result.embedded.faces[0]!.status).toBe("loaded");
  expect(result.remote.error).not.toBeNull();
  expect(result.remote.faces).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test("a page without a loaded card preserves owner text and stores generated context separately", async ({
  page,
}, testInfo) => {
  await signup(page, `pages-context-${Date.now()}@rakazo.test`, "password12", "Context Owner");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const title = "https://automatic.example/report";
  const body = "Read the page result.";
  const source = `export default function Result() { return <Page title="Fallback context"><ReplyButton label="Ask result" reply="${body}" /></Page>; }`;
  await send(
    page,
    `call save_page with ${JSON.stringify({ title, source })}\nthen say Saved fallback page.`,
  );
  await expect(page.getByTestId("page-card")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("message-bot-bubble").last()).toContainText("Saved fallback page.");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  const listed = await rpc<{ items: Array<{ id: string }> }>(page, "pages/list", { botId });
  expect(listed.items).toHaveLength(1);
  const pageId = listed.items[0]!.id;
  // Clearing the conversation leaves the saved Page in the library, with no card to reply to.
  await rpc(page, "threads/clear", { botId });
  await page.goto(`/app/${botId}?page=${pageId}`);
  await expect(page.getByTestId("page-card")).toHaveCount(0);
  await expect(page.getByTestId("page-view")).toBeVisible();
  await pageFrame(page, title).getByRole("button", { name: "Ask result" }).click();
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toHaveValue(body);
  const first = page.waitForRequest(
    (request) => request.url().includes("/rpc/threads/send") && request.method() === "POST",
  );
  await composer.press("Enter");
  const firstWire = (await first).postDataJSON().json;
  expect(firstWire.text).toBe(body);
  expect(firstWire.pageContext).toEqual({ pageId });
  expect(firstWire.replyToMessageId).toBeUndefined();
  const text = `[${title}](page:${pageId})\n${body}`;
  type History = {
    messages: Array<{
      role: string;
      blocks: Array<{
        kind: string;
        text?: string;
        pageContext?: { pageId: string; title: string };
      }>;
    }>;
  };
  const history = () => rpc<History>(page, "threads/messages", { botId });
  await expect
    .poll(
      async () =>
        (await history()).messages
          .flatMap((message) => message.blocks)
          .find((block) => block.kind === "text" && block.text === text)?.pageContext,
    )
    .toEqual({ pageId, title });

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("page-view")).toBeHidden();
  const manual = "[https://owner.example/report](page:manual)\nPlease read this.";
  await composer.fill(manual);
  const second = page.waitForRequest(
    (request) => request.url().includes("/rpc/threads/send") && request.method() === "POST",
  );
  await composer.press("Enter");
  const secondWire = (await second).postDataJSON().json;
  expect(secondWire.text).toBe(manual);
  expect(secondWire.pageContext).toBeUndefined();
  await expect
    .poll(async () =>
      (await history()).messages
        .flatMap((message) => message.blocks)
        .find((block) => block.kind === "text" && block.text === manual),
    )
    .toEqual({ kind: "text", text: manual });

  // A definitive Page rejection must not trap an unchanged draft in the old context.
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await rpc(page, "threads/clear", { botId });
  await page.goto(`/app/${botId}?page=${pageId}`);
  await expect(page.getByTestId("page-view")).toBeVisible();
  await pageFrame(page, title).getByRole("button", { name: "Ask result" }).click();
  await expect(composer).toHaveValue(body);
  await rpc(page, "pages/remove", { pageId });
  const rejectedRequest = page.waitForRequest(
    (request) => request.url().includes("/rpc/threads/send") && request.method() === "POST",
  );
  const rejectedResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/send") && response.status() === 404,
  );
  await composer.press("Enter");
  const rejectedWire = (await rejectedRequest).postDataJSON().json;
  await rejectedResponse;
  expect(rejectedWire.pageContext).toEqual({ pageId });
  expect((await history()).messages.filter((message) => message.role === "user")).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("page-view")).toBeHidden();
  await expect(composer).toHaveValue(body);
  await expect(page.getByText("This page isn't available", { exact: true })).toBeVisible();
  const retriedRequest = page.waitForRequest(
    (request) => request.url().includes("/rpc/threads/send") && request.method() === "POST",
  );
  await captureScreenshot(page, testInfo, "page-rejected-context");
  await composer.press("Enter");
  const retriedWire = (await retriedRequest).postDataJSON().json;
  expect(retriedWire.text).toBe(body);
  expect(retriedWire.pageContext).toBeUndefined();
  expect(retriedWire.clientNonce).toBe(rejectedWire.clientNonce);
  await expect
    .poll(async () =>
      (await history()).messages
        .filter((message) => message.role === "user")
        .flatMap((message) => message.blocks),
    )
    .toEqual([{ kind: "text", text: body }]);
});
