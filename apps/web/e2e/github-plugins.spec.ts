import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { PluginInstallReceipt, PluginPreview } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openIntegrations, signup } from "./helpers";

// Synthetic RPC responses isolate cross-surface review; API transactions are tested separately.
const preview: PluginPreview = {
  source: `https://github.com/example/research-plugin/tree/${"a".repeat(40)}`,
  sourceSha: "a".repeat(40),
  digest: `sha256:${"b".repeat(64)}`,
  format: "agent-plugins",
  name: "Research plugin",
  description: "Summarize research with explicit source links.",
  version: "1.0.0",
  skills: [
    {
      name: "research",
      description: "Research a topic",
      content:
        "---\nname: research\ndescription: Research a topic\n---\nRead the sources. Keep direct quotes separate from your conclusions.",
    },
  ],
  mcpServers: [
    {
      name: "Research service",
      transport: "streamable_http",
      endpoint: "https://research.example.test/mcp",
      headerKeys: ["Authorization"],
    },
  ],
  skipped: [{ kind: "mcp_stdio", name: "Local helper", reason: "Local commands are not imported" }],
};
function receipt(nonce: string): PluginInstallReceipt {
  return {
    id: "synthetic-plugin-install",
    clientNonce: nonce,
    source: preview.source,
    sourceSha: preview.sourceSha,
    digest: preview.digest,
    name: preview.name,
    status: "installed",
    revision: 1,
    installedAt: "2026-11-01T00:00:00.000Z",
    skills: [{ id: "synthetic-skill", name: "research" }],
    mcpServers: [
      {
        id: "synthetic-mcp",
        name: "Research service",
        endpoint: preview.mcpServers[0]!.endpoint,
        transport: "streamable_http",
      },
    ],
  };
}
async function openPlugins(page: Page) {
  await signup(page, `github-plugins-${Date.now()}@coginebot.test`, "password12", "Plugin review");
  await completeOnboarding(page);
  const chatUrl = page.url();
  const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
  await composer.fill("Keep this draft. 保留草稿。");
  await openIntegrations(page);
  const advanced = page.getByTestId("integrations-advanced");
  await advanced.locator("summary").first().click();
  await advanced.getByRole("button", { name: "GitHub plugins", exact: true }).click();
  const panel = page.getByTestId("github-plugin-installs");
  await panel
    .getByRole("textbox", { name: "Plugin GitHub URL", exact: true })
    .fill("https://github.com/example/research-plugin");
  await panel.getByRole("button", { name: "Preview", exact: true }).click();
  return { panel, chatUrl, composer };
}

test("GitHub plugin review pins the version, renders raw instructions and preserves cleanup receipts", async ({
  page,
}, testInfo) => {
  let installed: PluginInstallReceipt | null = null;
  let writes = 0;
  const removals: number[] = [];
  await page.route("**/rpc/plugins/list", (route) =>
    route.fulfill({ json: { json: installed ? [installed] : [] } }),
  );
  await page.route("**/rpc/plugins/preview", (route) => route.fulfill({ json: { json: preview } }));
  await page.route("**/rpc/plugins/install", (route) => {
    const input = route.request().postDataJSON().json;
    expect(input).toMatchObject({
      source: preview.source,
      sourceSha: preview.sourceSha,
      digest: preview.digest,
    });
    expect(typeof input.clientNonce).toBe("string");
    writes += 1;
    installed = receipt(input.clientNonce);
    return route.fulfill({ json: { json: installed } });
  });
  await page.route("**/rpc/plugins/uninstall", (route) => {
    const input = route.request().postDataJSON().json;
    expect(input.installId).toBe(installed!.id);
    expect(input.expectedRevision).toBe(installed!.revision);
    removals.push(input.expectedRevision);
    installed = {
      ...installed!,
      status: removals.length === 1 ? "cleanup_failed" : "removed",
      revision: installed!.revision + 2,
    };
    return route.fulfill({ json: { json: installed } });
  });
  const { panel, chatUrl, composer } = await openPlugins(page);
  const review = panel.getByTestId("plugin-preview");
  await expect(review.getByRole("heading", { name: preview.name, exact: true })).toBeVisible();
  await review.getByText("View instructions", { exact: true }).click();
  await expect(review.locator("pre")).toHaveText(preview.skills[0]!.content);
  await expect(review.getByText(preview.mcpServers[0]!.endpoint, { exact: true })).toBeVisible();
  await review.getByText(/Skipped components/).click();
  await expect(review.getByText("Local commands are not imported", { exact: false })).toBeVisible();
  expect(writes).toBe(0);
  await review.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "d011-plugin-preview");
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(panel.getByRole("button", { name: "Install plugin", exact: true })).toBeVisible();
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await panel.getByRole("button", { name: "Install plugin", exact: true }).scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "d011-plugin-preview-320");
  await page.setViewportSize({ width: 1280, height: 900 });
  await panel.getByRole("button", { name: "Install plugin", exact: true }).click();
  const row = panel.getByRole("article", { name: preview.name, exact: true });
  await expect(row.getByText("Installed", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  await row.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "d011-plugin-installed");
  await row.getByRole("button", { name: "Remove plugin", exact: true }).click();
  expect(removals).toEqual([]);
  await row.getByRole("button", { name: "Confirm removal", exact: true }).click();
  await expect(row.getByText("Cleanup incomplete", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "d011-plugin-cleanup-failed");
  await row.getByRole("button", { name: "Retry cleanup", exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(removals).toEqual([1, 3]);
  await page.getByRole("button", { name: "Close integrations", exact: true }).click();
  expect(page.url()).toBe(chatUrl);
  await expect(composer).toHaveText("Keep this draft. 保留草稿。");
});

test("a lost plugin installation reply requires a read-only status check before retrying its nonce", async ({
  page,
}, testInfo) => {
  let installed: PluginInstallReceipt | null = null;
  const nonces: string[] = [];
  await page.route("**/rpc/plugins/list", (route) =>
    route.fulfill({ json: { json: installed ? [installed] : [] } }),
  );
  await page.route("**/rpc/plugins/preview", (route) => route.fulfill({ json: { json: preview } }));
  await page.route("**/rpc/plugins/install", (route) => {
    const input = route.request().postDataJSON().json;
    nonces.push(input.clientNonce);
    if (nonces.length === 1) return route.abort("failed");
    installed = receipt(input.clientNonce);
    return route.fulfill({ json: { json: installed } });
  });
  const { panel } = await openPlugins(page);
  await panel.getByRole("button", { name: "Install plugin", exact: true }).click();
  await expect(panel.getByText("Could not confirm installation.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Check status", exact: true }).scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "d011-plugin-unknown");
  await panel.getByRole("button", { name: "Check status", exact: true }).click();
  await panel.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(panel.getByRole("article", { name: preview.name, exact: true })).toBeVisible();
  expect(nonces).toHaveLength(2);
  expect(nonces[0]).toBe(nonces[1]);
});

test("a reopened pending installation can be explicitly cleaned up without replaying its install", async ({
  page,
}) => {
  let pending: PluginInstallReceipt | null = null;
  let installs = 0;
  const removals: number[] = [];
  await page.route("**/rpc/plugins/list", (route) =>
    route.fulfill({ json: { json: pending ? [pending] : [] } }),
  );
  await page.route("**/rpc/plugins/preview", (route) => route.fulfill({ json: { json: preview } }));
  await page.route("**/rpc/plugins/install", (route) => {
    installs += 1;
    const input = route.request().postDataJSON().json;
    pending = { ...receipt(input.clientNonce), status: "installing", installedAt: null };
    return route.fulfill({ json: { json: pending } });
  });
  await page.route("**/rpc/plugins/uninstall", (route) => {
    const input = route.request().postDataJSON().json;
    expect(input.installId).toBe(pending!.id);
    expect(input.expectedRevision).toBe(pending!.revision);
    removals.push(input.expectedRevision);
    pending = { ...pending!, status: "removed", revision: 3 };
    return route.fulfill({ json: { json: pending } });
  });
  const { panel } = await openPlugins(page);
  await panel.getByRole("button", { name: "Install plugin", exact: true }).click();
  await expect(panel.getByRole("article", { name: preview.name, exact: true })).toContainText(
    "Installation pending.",
  );
  await expect(panel.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page
    .getByTestId("integrations-advanced")
    .getByRole("button", { name: "GitHub plugins", exact: true })
    .click();
  const reopened = page.getByTestId("github-plugin-installs");
  const row = reopened.getByRole("article", { name: preview.name, exact: true });
  await expect(row).toContainText("Installation pending.");
  await row.getByRole("button", { name: "Remove plugin", exact: true }).click();
  expect(removals).toEqual([]);
  await row.getByRole("button", { name: "Confirm removal", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(reopened.getByText("No plugins installed", { exact: true })).toBeVisible();
  expect(removals).toEqual([1]);
  expect(installs).toBe(1);
});
