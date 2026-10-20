import type { Page, Request } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { CHAT_DIAGRAM_MAX_TEXT_SIZE, chatMermaidConfig } from "@rakazo/chat-ui/mermaid";
import { lightTokens } from "@rakazo/ui-tokens";
import {
  diagramBootScript,
  diagramDocument,
  diagramScriptUrl,
  MAX_DIAGRAM_HEIGHT,
  parseDiagramMessage,
} from "../../mobile/lib/mermaid-webview";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/markdown-diagram.html";
const source = [
  "flowchart LR",
  "  accTitle: Purchase flow",
  "  A[Choose item] --> B{In stock?}",
  "  B -->|Yes| C[Place order]",
  "  B -->|No| D[Notify me]",
].join("\n");
const fence = (body: string) => `\`\`\`mermaid\n${body}\n\`\`\``;
const diagram = (page: Page) => page.getByTestId("chat-diagram");
const output = (page: Page) => page.getByTestId("diagram-fixture");
const libraryRequest = (request: Request) =>
  request.resourceType() === "fetch" && request.url().includes("mermaid.min");

async function update(page: Page, markdown: string, streaming = false) {
  await page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent("diagram-update", { detail })),
    { markdown, streaming },
  );
}

async function svg(page: Page) {
  return diagram(page)
    .getByRole("img")
    .evaluate((image) => decodeURIComponent((image as HTMLImageElement).src.split(",")[1] ?? ""));
}

test("completed diagrams render accessibly and preserve their source", async ({
  page,
}, testInfo) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(fixture);
  const image = diagram(page).getByRole("img", { name: "Purchase flow", exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  expect(
    await image.evaluate((element) => (element as HTMLImageElement).naturalHeight),
  ).toBeGreaterThan(0);
  await expect(diagram(page).locator("svg")).toHaveCount(0);

  await output(page).getByRole("button", { name: "Copy diagram source" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${source}\n`);
  await output(page).getByRole("button", { name: "Show source" }).click();
  await expect(output(page).locator("pre code")).toHaveText(`${source}\n`);
  await output(page).getByRole("button", { name: "Show diagram" }).click();
  await expect(image).toBeVisible();
  await captureScreenshot(page, testInfo, "markdown-diagram-flow-light");
});

test("sequence diagrams retain Chinese labels and react to theme changes", async ({
  page,
}, testInfo) => {
  await page.goto(fixture);
  await update(
    page,
    fence(
      "sequenceDiagram\n  accTitle: 订单时序\n  用户->>商店: 提交订单\n  商店-->>用户: 确认收货",
    ),
  );
  await expect(diagram(page).getByRole("img", { name: "订单时序", exact: true })).toBeVisible();
  const light = await svg(page);
  expect(light).toContain("提交订单");
  expect(light).toContain("确认收货");
  await page.getByRole("checkbox", { name: "Dark theme" }).check();
  await expect.poll(() => svg(page)).not.toBe(light);
  const dark = await svg(page);
  expect(dark).toContain("提交订单");
  await captureScreenshot(page, testInfo, "markdown-diagram-sequence-dark");
  await page.getByRole("checkbox", { name: "Dark theme" }).uncheck();
  await expect.poll(() => svg(page)).toBe(light);
});

test("ordinary code and unclosed streaming fences do not load the diagram engine", async ({
  page,
}) => {
  const loads: string[] = [];
  page.on("request", (request) => {
    if (libraryRequest(request)) loads.push(request.url());
  });
  await page.goto(
    `${fixture}?${new URLSearchParams({ markdown: "```ts\nconst answer = 42;\n```" })}`,
  );
  await expect(output(page).locator("pre code")).toHaveText("const answer = 42;\n");
  await expect(diagram(page)).toHaveCount(0);
  await update(page, `\`\`\`mermaid\n${source}`, true);
  await expect(output(page).locator("pre code")).toHaveText(`${source}\n`);
  await expect(diagram(page).getByRole("img")).toHaveCount(0);
  expect(loads).toEqual([]);

  await update(page, `${fence(source)}\n\nThe reply is still streaming.`, true);
  await expect(
    diagram(page).getByRole("img", { name: "Purchase flow", exact: true }),
  ).toBeVisible();
  await expect(output(page)).toContainText("The reply is still streaming.");
  expect(loads.length).toBeGreaterThan(0);
  await update(page, `${fence(source)}\n\nThe reply is complete.`);
  await expect(
    diagram(page).getByRole("img", { name: "Purchase flow", exact: true }),
  ).toBeVisible();
  await expect(output(page)).toContainText("The reply is complete.");
});

test("oversized diagrams preserve exact source without loading the engine", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const loads: string[] = [];
  page.on("request", (request) => {
    if (libraryRequest(request)) loads.push(request.url());
  });
  await page.goto(`${fixture}?${new URLSearchParams({ markdown: "```text\nReady\n```" })}`);
  await expect(output(page).locator("pre code")).toHaveText("Ready\n");
  const oversized = `flowchart LR\n  A["${"x".repeat(CHAT_DIAGRAM_MAX_TEXT_SIZE + 1)}"]`;
  const expected = `${oversized}\n`;
  await update(page, fence(oversized));
  await expect
    .poll(() =>
      output(page)
        .locator("pre code")
        .evaluate((element, text) => element.textContent === text, expected),
    )
    .toBe(true);
  await expect(diagram(page)).toHaveCount(0);
  await output(page).getByRole("button", { name: "Copy diagram source", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        (text) => navigator.clipboard.readText().then((copied) => copied === text),
        expected,
      ),
    )
    .toBe(true);
  expect(loads).toEqual([]);
  await update(page, fence(source));
  await expect(
    diagram(page).getByRole("img", { name: "Purchase flow", exact: true }),
  ).toBeVisible();
  expect(loads.length).toBeGreaterThan(0);
});

test("invalid diagrams fall back to copyable code and the next diagram still renders", async ({
  page,
}, testInfo) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const invalid = "flowchart LR\n  A -->[unfinished";
  const drawingFinished = page.waitForEvent("framedetached", {
    predicate: (frame) => frame.url() === "about:srcdoc",
  });
  await page.goto(`${fixture}?${new URLSearchParams({ markdown: fence(invalid) })}`);
  await drawingFinished;
  await expect(output(page).locator("pre code")).toHaveText(`${invalid}\n`);
  await expect(diagram(page).getByRole("img")).toHaveCount(0);
  await output(page).getByRole("button", { name: "Copy diagram source" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${invalid}\n`);
  await captureScreenshot(page, testInfo, "markdown-diagram-invalid-source");
  await update(page, fence(source));
  await expect(
    diagram(page).getByRole("img", { name: "Purchase flow", exact: true }),
  ).toBeVisible();
});

for (const failure of ["network failure", "HTML asset response"] as const) {
  test(`${failure} preserves source and retries the next diagram without reloading`, async ({
    page,
  }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const loads: string[] = [];
    page.on("request", (request) => {
      if (libraryRequest(request)) loads.push(request.url());
    });
    let blocked = 0;
    await page.route(/mermaid\.min/, (route) => {
      if (!libraryRequest(route.request())) return route.continue();
      blocked += 1;
      return failure === "network failure"
        ? route.abort("failed")
        : route.fulfill({
            status: 200,
            contentType: "text/html",
            body: "<!doctype html><html><body>Missing asset</body></html>",
          });
    });
    const drawingFinished =
      failure === "HTML asset response"
        ? page.waitForEvent("framedetached", {
            predicate: (frame) => frame.url() === "about:srcdoc",
          })
        : undefined;
    await page.goto(fixture);
    await expect.poll(() => blocked).toBeGreaterThan(0);
    if (drawingFinished) await drawingFinished;
    await expect(output(page).getByRole("button", { name: "Copy diagram source" })).toBeVisible();
    expect(await output(page).locator("pre code").textContent()).toBe(`${source}\n`);
    await expect(diagram(page).getByRole("img")).toHaveCount(0);
    await output(page).getByRole("button", { name: "Copy diagram source", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${source}\n`);
    await page.unroute(/mermaid\.min/);
    const requestsBeforeRetry = loads.length;
    const retrySource = "flowchart LR\n  accTitle: Recovered flow\n  A[New diagram] --> B[Ready]";
    await update(page, fence(retrySource));
    await expect(
      diagram(page).getByRole("img", { name: "Recovered flow", exact: true }),
    ).toBeVisible();
    expect(loads.length).toBeGreaterThan(requestsBeforeRetry);
  });
}

test("the loaded diagram engine can draw a new diagram while offline", async ({
  page,
  context,
}) => {
  await page.goto(fixture);
  await expect(
    diagram(page).getByRole("img", { name: "Purchase flow", exact: true }),
  ).toBeVisible();
  await context.setOffline(true);
  try {
    await update(
      page,
      fence("flowchart TD\n  accTitle: Offline flow\n  A[Draft] --> B[Saved locally]"),
    );
    await expect(
      diagram(page).getByRole("img", { name: "Offline flow", exact: true }),
    ).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test("the public renderer runs the native document and message contract in a browser", async ({
  page,
}) => {
  // The official harness provides the API. This exercises the WebView document
  // and injected boot script in Chromium; it does not claim native OS coverage.
  const endpoint = diagramScriptUrl(process.env.API_URL ?? "http://127.0.0.1:3110");
  const response = await page.request.get(endpoint, { headers: { origin: "null" } });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("text/javascript; charset=utf-8");
  expect(response.headers()["access-control-allow-origin"]).toBe("*");
  expect(response.headers()["cross-origin-resource-policy"]).toBe("cross-origin");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["set-cookie"]).toBeUndefined();
  const bundle = await response.text();
  expect(bundle).toContain("Permission is hereby granted, free of charge");
  expect(bundle).toContain('globalThis["mermaid"]');
  const etag = response.headers().etag;
  expect(etag).toMatch(/^"mermaid-[0-9a-f]{64}"$/);
  const unchanged = await page.request.get(endpoint, {
    headers: { origin: "null", "if-none-match": `W/${etag}` },
  });
  expect(unchanged.status()).toBe(304);
  expect(await unchanged.text()).toBe("");
  expect(unchanged.headers()["access-control-allow-origin"]).toBe("*");

  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${fixture}?${new URLSearchParams({ markdown: "Native document preview" })}`);
  const scriptRequest = page.waitForRequest(endpoint);
  await page.evaluate((html) => {
    const frame = document.createElement("iframe");
    frame.title = "Diagram document";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.width = "390px";
    frame.style.height = "400px";
    frame.srcdoc = html;
    document.querySelector("main")!.appendChild(frame);
  }, diagramDocument(endpoint));
  const request = await scriptRequest;
  const headers = await request.allHeaders();
  expect(headers.origin).toBe("null");
  expect(headers.cookie).toBeUndefined();
  expect(headers.authorization).toBeUndefined();
  expect(headers.referer).toBeUndefined();
  expect((await request.response())?.status()).toBe(200);
  const frame = await page
    .getByTitle("Diagram document")
    .elementHandle()
    .then((handle) => handle!.contentFrame());
  expect(frame).not.toBeNull();
  await frame!.waitForFunction(() =>
    Boolean((window as typeof window & { mermaid?: unknown }).mermaid),
  );
  expect(await frame!.evaluate(() => location.origin)).toBe("null");
  await frame!.evaluate(() => {
    const bridge = window as typeof window & {
      diagramMessages: string[];
      ReactNativeWebView: { postMessage: (message: string) => void };
    };
    bridge.diagramMessages = [];
    bridge.ReactNativeWebView = {
      postMessage: (message) => bridge.diagramMessages.push(message),
    };
  });
  const requestId = "diagram-browser-contract";
  await frame!.evaluate(
    diagramBootScript(source, chatMermaidConfig(lightTokens, "light"), requestId),
  );
  await expect
    .poll(async () =>
      frame!.evaluate(
        () => (window as typeof window & { diagramMessages: string[] }).diagramMessages.length,
      ),
    )
    .toBeGreaterThan(0);
  const messages = await frame!.evaluate(
    () => (window as typeof window & { diagramMessages: string[] }).diagramMessages,
  );
  const drawn = messages
    .map((message) => parseDiagramMessage(message, requestId))
    .find((message) => message?.type === "drawn");
  expect(drawn?.type).toBe("drawn");
  if (drawn?.type !== "drawn")
    throw new Error("The native document did not report a drawn diagram");
  expect(drawn.alt).toBe("Purchase flow");
  expect(Number.isFinite(drawn.width)).toBe(true);
  expect(Number.isFinite(drawn.height)).toBe(true);
  expect(drawn.width).toBeGreaterThan(0);
  expect(drawn.height).toBeGreaterThan(0);
  expect(drawn.height).toBeLessThanOrEqual(MAX_DIAGRAM_HEIGHT);
  await expect(frame!.locator("#diagram svg")).toBeVisible();
  await expect(frame!.locator("#diagram title")).toHaveText("Purchase flow");
  expect(errors).toEqual([]);
});

for (const remote of [false, true]) {
  test(`diagram rendering blocks external image requests with remote images ${remote ? "enabled" : "disabled"}`, async ({
    page,
  }) => {
    const attempted: string[] = [];
    const blocked: string[] = [];
    const refused: string[] = [];
    let networkRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).hostname === "diagram-assets.example.test")
        attempted.push(request.url());
    });
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).hostname === "diagram-assets.example.test") {
        blocked.push(request.failure()?.errorText ?? "");
      }
    });
    page.on("console", (message) => {
      if (message.text().includes("diagram-assets.example.test")) refused.push(message.text());
    });
    await page.route("https://diagram-assets.example.test/**", (route) => {
      networkRequests += 1;
      return route.abort();
    });
    const imageSource =
      'flowchart LR\n  A@{ img: "https://diagram-assets.example.test/tracker.png", label: "External image" }';
    await page.goto(
      `${fixture}?${new URLSearchParams({ markdown: fence(imageSource), ...(remote ? { remote: "1" } : {}) })}`,
    );
    // This input reaches Mermaid's image loader. CSP must prevent the request
    // while it is drawing, before the final SVG becomes an inert image.
    await expect.poll(() => refused.join("\n")).toMatch(/Content Security Policy|img-src/i);
    await expect.poll(() => blocked.length).toBe(attempted.length);
    expect(attempted.length).toBeGreaterThan(0);
    expect(blocked.every((failure) => /csp/i.test(failure))).toBe(true);
    expect(networkRequests).toBe(0);
    await update(page, fence(source));
    await expect(
      diagram(page).getByRole("img", { name: "Purchase flow", exact: true }),
    ).toBeVisible();
    expect(networkRequests).toBe(0);
  });
}

test("diagram directives and HTML cannot add active links or execute content", async ({ page }) => {
  const external: string[] = [];
  const popups: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "diagram-assets.example.test")
      external.push(request.url());
  });
  page.on("popup", (popup) => popups.push(popup.url()));
  await page.route("https://diagram-assets.example.test/**", (route) => route.abort());
  const hostile = [
    '%%{init: {"securityLevel":"loose","flowchart":{"htmlLabels":true}}}%%',
    "flowchart LR",
    "  accTitle: Safe diagram",
    "  A[\"<img src='https://diagram-assets.example.test/label.png' onerror='parent.document.body.dataset.diagramExecuted=1'>\"] --> B[Done]",
    '  click B "https://diagram-assets.example.test/navigate" "Open" _blank',
  ].join("\n");
  await page.goto(`${fixture}?${new URLSearchParams({ markdown: fence(hostile) })}`);
  await expect(diagram(page).getByRole("img", { name: "Safe diagram", exact: true })).toBeVisible();
  await diagram(page).getByRole("img").click();
  await expect(diagram(page).locator("a, svg, iframe")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute("data-diagram-executed");
  expect(external).toEqual([]);
  expect(popups).toEqual([]);
  await expect(page).toHaveURL(/\/e2e\/fixtures\/markdown-diagram\.html/);
});

test.describe("narrow diagram layout", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("wide diagrams scroll locally without widening the page", async ({ page }, testInfo) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const wide = [
      "flowchart LR",
      "  accTitle: Wide workflow",
      "  A[Collect customer requirements] --> B[Prepare detailed specification] --> C[Review implementation] --> D[Run acceptance tests] --> E[Deliver completed work]",
    ].join("\n");
    await page.goto(`${fixture}?${new URLSearchParams({ markdown: fence(wide) })}`);
    await expect(
      diagram(page).getByRole("img", { name: "Wide workflow", exact: true }),
    ).toBeVisible();
    for (const name of ["Show source", "Copy diagram source"]) {
      const button = output(page).getByRole("button", { name, exact: true });
      await expect(button).toHaveCSS("opacity", "1");
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await output(page).getByRole("button", { name: "Show source", exact: true }).click();
    await expect(output(page).locator("pre code")).toHaveText(`${wide}\n`);
    await output(page).getByRole("button", { name: "Show diagram", exact: true }).click();
    const scroll = diagram(page).locator(".rk-chat-markdown-diagram-scroll");
    const scrollBox = await scroll.boundingBox();
    const sourceButtonBox = await output(page)
      .getByRole("button", { name: "Show source", exact: true })
      .boundingBox();
    expect(scrollBox).not.toBeNull();
    expect(sourceButtonBox).not.toBeNull();
    expect(scrollBox!.y).toBeGreaterThanOrEqual(sourceButtonBox!.y + sourceButtonBox!.height);
    const metrics = await scroll.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await scroll.evaluate((element) => {
      element.scrollLeft = 100;
    });
    await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await scroll.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await captureScreenshot(page, testInfo, "markdown-diagram-wide-mobile");

    const invalid = "flowchart LR\n  A -->[unfinished";
    const drawingFinished = page.waitForEvent("framedetached", {
      predicate: (frame) => frame.url() === "about:srcdoc",
    });
    await update(page, fence(invalid));
    await drawingFinished;
    await expect(diagram(page)).toHaveCount(0);
    await expect(output(page).locator("pre code")).toHaveText(`${invalid}\n`);
    const copy = output(page).getByRole("button", { name: "Copy diagram source", exact: true });
    await expect(copy).toBeVisible();
    await expect(copy).toHaveCSS("opacity", "1");
    const copyBox = await copy.boundingBox();
    expect(copyBox).not.toBeNull();
    expect(copyBox!.width).toBeGreaterThanOrEqual(44);
    expect(copyBox!.height).toBeGreaterThanOrEqual(44);
    await copy.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${invalid}\n`);
    await captureScreenshot(page, testInfo, "markdown-diagram-fallback-mobile");
  });
});
