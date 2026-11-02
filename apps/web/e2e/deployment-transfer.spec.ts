import { expect, test } from "@playwright/test";
import type { Bot, DeploymentTransferStatus, Me } from "@rakazo/contracts";
import {
  candidate,
  copied,
  plan,
  snapshot,
  sourceIdentity,
  targetIdentity,
} from "../src/lib/deployment-transfer.test-helpers";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

// Synthetic transfer RPCs exercise the protected UI; transactional peer transfer is covered separately.
test("protected transfer review binds both approvals and restores uncertain receipts without copying again", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await signup(
    page,
    `transfer-review-${Date.now()}@example.test`,
    "password12",
    "Transfer reviewer",
  );
  await completeOnboarding(page);
  const me = await rpc<Me>(page, "me", {});
  const bot = (await rpc<Bot[]>(page, "bots/list", {}))[0]!;
  const localScope = { userId: me.userId!, spaceId: me.spaceId!, botId: bot.id };
  const shared = {
    ...candidate,
    itemKey: "shared-api",
    name: "shared-api",
    kind: "api_key" as const,
    auth: { type: "bearer" as const },
  };
  const next = {
    ...candidate,
    itemKey: "new-api",
    name: "new-api",
    kind: "api_key" as const,
    auth: { type: "header" as const, name: "X-API-Key" },
  };
  const planned = [
    plan.items[0]!,
    {
      source: shared,
      action: "keep" as const,
      targetRevision: candidate.revision,
      canOverwrite: false,
      reason: "resource_unknown" as const,
    },
    { source: next, action: "create" as const, targetRevision: null, canOverwrite: false },
  ];
  let targetState = snapshot({ side: "target", phase: "proposed", revision: 2, localScope });
  let sourceState = snapshot({
    side: "source",
    phase: "ready",
    revision: 6,
    localScope,
    plan: {
      ...plan,
      sourceScope: localScope,
      sourceOwnerName: "Transfer reviewer",
      items: planned.map((item, i) => (i === 0 ? { ...item, action: "overwrite" } : item)),
    },
    planDigest: "f".repeat(64),
    canCommit: true,
    grantDelivery: "acknowledged",
  });
  let commits = 0;
  const sent: { procedure: string; input: Record<string, unknown> }[] = [];
  await page.route("**/rpc/transfer/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const input = (route.request().postDataJSON() as { json: Record<string, unknown> }).json;
    sent.push({ procedure, input });
    let value: DeploymentTransferStatus | null;
    if (procedure === "status")
      value = page.url().includes("/transfers/source/") ? sourceState : targetState;
    else if (procedure === "preview") {
      const decisions = input.decisions as { itemKey: string; action: string }[];
      const overwrite = decisions.some(
        (item) => item.itemKey === candidate.itemKey && item.action === "overwrite",
      );
      targetState = snapshot({
        side: "target",
        phase: "previewed",
        revision: targetState.revision + 1,
        localScope,
        plan: {
          ...plan,
          targetScope: localScope,
          targetOwnerName: "Transfer reviewer",
          items: planned.map((item, i) =>
            i === 0 && overwrite ? { ...item, action: "overwrite" } : item,
          ),
        },
        planDigest: (overwrite ? "f" : "d").repeat(64),
        canApprove: true,
      });
      value = targetState;
    } else if (procedure === "approve") {
      expect(input.planDigest).toBe("f".repeat(64));
      expect(input.expectedSourceFingerprint).toBe(sourceIdentity.fingerprint);
      targetState = {
        ...targetState,
        phase: "approved",
        revision: targetState.revision + 1,
        canApprove: false,
        grantDelivery: "acknowledged",
      };
      value = targetState;
    } else if (procedure === "commit") {
      commits++;
      expect(input.planDigest).toBe("f".repeat(64));
      expect(input.expectedTargetFingerprint).toBe(targetIdentity.fingerprint);
      sourceState = {
        ...sourceState,
        phase: "partial",
        revision: 8,
        canCommit: false,
        commitNonce: input.clientNonce as string,
        items: [
          copied,
          {
            ...copied,
            itemKey: shared.itemKey,
            name: shared.name,
            kind: "api_key",
            status: "kept",
          },
          {
            ...copied,
            itemKey: next.itemKey,
            name: next.name,
            kind: "api_key",
            status: "unknown",
            reason: "write_unknown",
          },
        ],
      };
      await route.abort("failed");
      return;
    } else throw new Error(`Unexpected transfer UI request: ${procedure}`);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: value }) });
  });
  await page.goto(`/transfers/receive/${targetState.transferId}`);
  const panel = page.getByTestId("deployment-transfer-page");
  await panel.getByRole("button", { name: "Review selection", exact: true }).click();
  const replace = panel.getByRole("switch", { name: `Replace ${candidate.name}`, exact: true });
  await expect(replace).not.toBeChecked();
  await replace.click();
  await expect(
    panel.getByRole("button", { name: "Approve this transfer", exact: true }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "Update review", exact: true }).click();
  await expect(replace).toBeChecked();
  await expect(panel.getByTestId("transfer-plan")).toContainText(
    "Target retained to protect the source.",
  );
  await captureScreenshot(page, testInfo, "d022-transfer-target-plan");
  await panel.getByRole("button", { name: "Approve this transfer", exact: true }).click();
  expect(commits).toBe(0);
  await page.goto(`/transfers/source/${sourceState.transferId}`);
  await expect(
    panel.getByRole("button", { name: "Copy approved credentials", exact: true }),
  ).toBeVisible();
  await expect(panel.getByTestId("transfer-identities")).toContainText(targetIdentity.fingerprint);
  await captureScreenshot(page, testInfo, "d022-transfer-source-confirm");
  await panel.getByRole("button", { name: "Copy approved credentials", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Check status");
  await panel.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(panel.getByTestId("transfer-receipts")).toContainText(
    "new-api · Status not confirmed",
  );
  expect(commits).toBe(1);
  await page.reload();
  await expect(panel.getByTestId("transfer-receipts")).toContainText("research-login · Copied");
  expect(commits).toBe(1);
  await expect(
    panel.getByRole("button", { name: "Copy approved credentials", exact: true }),
  ).toHaveCount(0);
  await captureScreenshot(page, testInfo, "d022-transfer-partial-unknown");
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await captureScreenshot(page, testInfo, "d022-transfer-status-320");
  const forbidden = new Set([
    "value",
    "password",
    "username",
    "token",
    "tokenHash",
    "signature",
    "grant",
    "ciphertext",
    "providerRef",
    "secretId",
    "protectedSourceResources",
  ]);
  function metadataOnly(value: unknown) {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      expect(forbidden.has(key), `unexpected protected field ${key}`).toBe(false);
      metadataOnly(item);
    }
  }
  for (const request of sent) metadataOnly(request.input);
  expect(sent.filter((request) => request.procedure === "commit")).toHaveLength(1);
});
