import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

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

test("a private page opens from its card, replies in chat and updates", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
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
  // The docked composer talks to the same chat, naming the page.
  await send(page, "make the churn tile red");
  await page.keyboard.press("Escape");
  await expect(view).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]page=/);

  await expect(
    page.getByTestId("message-user-bubble").filter({ hasText: "make the churn tile red" }),
  ).toBeVisible();
  // It replies to the page's card, so the bot reads which page it is about by id.
  const history = await rpc<{
    messages: Array<{ id: string; replyToMessageId?: string; blocks: Array<{ kind: string }> }>;
  }>(page, "threads/messages", { botId: activeBotId(page) });
  const asked = history.messages.find((message) =>
    message.blocks.some(
      (block) =>
        block.kind === "text" && "text" in block && block.text === "make the churn tile red",
    ),
  );
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
