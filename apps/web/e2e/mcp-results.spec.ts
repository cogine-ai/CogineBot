import { expect, test } from "@playwright/test";
import type { McpServer } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openIntegrations, signup } from "./helpers";

for (const width of [1280, 390]) {
  test(`saves whole MCP results only after reviewing the existing server at ${width}px`, async ({
    page,
  }, testInfo) => {
    await signup(
      page,
      `mcp-results-${width}-${Date.now()}@rakazo.test`,
      "password12",
      "MCP results",
    );
    await completeOnboarding(page);
    await page.setViewportSize({ width, height: 900 });

    let server: McpServer = {
      id: "mcp-results-server",
      spaceId: "mcp-results-space",
      slug: "research",
      name: "Research MCP",
      description: "",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/mcp",
      command: null,
      args: [],
      envKeys: [],
      headerKeys: [],
      hasSecret: false,
      oauthStatus: "none",
      enabled: true,
      allowAllTools: false,
      allowedTools: ["lookup"],
      verbatimResults: true,
      revision: 7,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    let saves = 0;
    let credentialWrites = 0;
    await page.route("**/rpc/mcp/servers/list", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ json: [server] }),
      });
    });
    await page.route("**/rpc/mcp/servers/setTools", async (route) => {
      const { json: input } = route.request().postDataJSON();
      expect(input).toEqual({
        id: server.id,
        revision: 7,
        allowAllTools: false,
        allowedTools: ["lookup"],
        verbatimResults: false,
      });
      saves += 1;
      server = { ...server, verbatimResults: false, revision: 8 };
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ json: server }),
      });
    });
    for (const operation of ["create", "update"]) {
      await page.route(`**/rpc/mcp/servers/${operation}`, async (route) => {
        credentialWrites += 1;
        await route.abort();
      });
    }

    if (width === 390)
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await openIntegrations(page);
    await page.getByTestId("integrations-advanced").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    await page.getByRole("button", { name: "Manage MCP servers", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "MCP servers" });
    await expect(dialog.getByText("Research MCP", { exact: true })).toBeVisible();
    await dialog.getByText("Advanced", { exact: true }).click();
    const wholeResultSwitches = dialog.getByRole("switch", {
      name: "Keep tool results whole",
      exact: true,
    });
    const createPreference = wholeResultSwitches.first();
    await expect(createPreference).not.toBeChecked();
    await createPreference.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, `mcp-results-default-${width}`);

    await dialog.getByRole("button", { name: "Tool access", exact: true }).click();
    await expect(wholeResultSwitches).toHaveCount(2);
    const preference = wholeResultSwitches.nth(1);
    await expect(preference).toBeChecked();
    await preference.click();
    await expect(preference).not.toBeChecked();
    expect(saves).toBe(0);
    await dialog.getByRole("button", { name: "Tool access", exact: true }).click();
    await expect(preference).toHaveCount(0);
    expect(saves).toBe(0);
    await dialog.getByRole("button", { name: "Tool access", exact: true }).click();
    await expect(preference).toBeChecked();
    await preference.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, `mcp-results-existing-${width}`);

    await preference.click();
    await dialog.getByRole("button", { name: "Save tool access", exact: true }).click();
    await expect(preference).toHaveCount(0);
    expect(saves).toBe(1);
    await dialog.getByRole("button", { name: "Tool access", exact: true }).click();
    await expect(preference).not.toBeChecked();
    await expect(
      dialog.getByRole("switch", { name: "Share all tools with this space", exact: true }),
    ).not.toBeChecked();
    await expect(dialog.getByLabel("Tool names, one per line")).toHaveValue("lookup");
    expect(credentialWrites).toBe(0);
    expect(server.revision).toBe(8);
  });
}
