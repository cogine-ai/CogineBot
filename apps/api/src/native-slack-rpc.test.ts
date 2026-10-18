import { createRouterClient } from "@orpc/server";
import { NativeActionError } from "@rakazo/adapters";
import type { Actor, NativeSlackHook } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const hook: NativeSlackHook = {
  id: "fixture-hook",
  configId: "fixture-config",
  configRevision: 1,
  revision: 1,
  appId: "AFIXTURE",
  teamId: "TFIXTURE",
  botEvents: ["app_mention"],
  enabled: true,
  configured: true,
  verified: false,
  phase: "waiting_for_verification",
  webhookUrl: "https://instance.example.test/api/connectors/events/slack/fixture-hook",
  lastVerifiedAt: null,
};
const save = {
  configId: "fixture-config",
  appId: "AFIXTURE",
  signingSecret: "fixture-signing-secret",
  botEvents: ["app_mention"] as const,
  botSubscriptionsConfirmed: true as const,
};
function setup(owner = true, configured = true) {
  const store = {
    status: vi
      .fn()
      .mockResolvedValue({ configId: "fixture-config", publicHttpsAvailable: true, hooks: [hook] }),
    save: vi.fn().mockResolvedValue(hook),
    disable: vi.fn().mockResolvedValue({ ...hook, enabled: false, phase: "disabled", revision: 2 }),
  };
  const actor: Actor = {
    userId: "fixture-owner",
    spaceId: "fixture-space",
    email: "fixture@example.test",
    isDeploymentOwner: owner,
  };
  const deps = {
    prisma: {},
    env: {},
    dataDir: "/tmp/native-slack-rpc-fixture",
    ...(configured ? { nativeConnectors: { slackEventHooks: store } } : {}),
  } as unknown as RouterDeps;
  return { store, client: createRouterClient(createRouter(deps), { context: { actor } }) };
}
it("Slack hooks are owner-scoped through the three existing native connector routes", async () => {
  const { store, client } = setup();
  expect(
    await client.nativeConnectors.slackWebhookStatus({ configId: "fixture-config" }),
  ).toMatchObject({ hooks: [{ appId: "AFIXTURE" }] });
  await client.nativeConnectors.saveSlackWebhook({ ...save, botEvents: [...save.botEvents] });
  await client.nativeConnectors.disableSlackWebhook({
    configId: "fixture-config",
    id: "fixture-hook",
    expectedRevision: 1,
  });
  for (const method of [store.status, store.save, store.disable]) {
    expect(method).toHaveBeenCalledTimes(1);
    expect(method.mock.calls[0]![1]).toMatchObject({
      userId: "fixture-owner",
      spaceId: "fixture-space",
    });
    expect(method.mock.calls[0]![2]).toBe(true);
  }
  const status = await client.nativeConnectors.slackWebhookStatus({ configId: "fixture-config" });
  expect(JSON.stringify(status)).not.toContain(save.signingSecret);
});
it("ordinary members cannot read or mutate application signing configuration", async () => {
  const { store, client } = setup(false);
  await expect(
    client.nativeConnectors.slackWebhookStatus({ configId: "fixture-config" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    client.nativeConnectors.saveSlackWebhook({ ...save, botEvents: [...save.botEvents] }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    client.nativeConnectors.disableSlackWebhook({
      configId: "fixture-config",
      id: "fixture-hook",
      expectedRevision: 1,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(store.status).not.toHaveBeenCalled();
  expect(store.save).not.toHaveBeenCalled();
  expect(store.disable).not.toHaveBeenCalled();
});
it("disabled native provider returns unavailable without creating app resources", async () => {
  const { client } = setup(true, false);
  await expect(
    client.nativeConnectors.slackWebhookStatus({ configId: "fixture-config" }),
  ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
});
it("hook conflicts preserve safe error semantics without echoing signing material", async () => {
  const { store, client } = setup();
  store.save.mockRejectedValue(
    new NativeActionError("version_conflict", "fixture-signing-secret", {
      recovery: { private: "fixture-signing-secret" },
    }),
  );
  await expect(
    client.nativeConnectors.saveSlackWebhook({ ...save, botEvents: [...save.botEvents] }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  try {
    await client.nativeConnectors.saveSlackWebhook({ ...save, botEvents: [...save.botEvents] });
  } catch (error) {
    expect(String(error)).not.toContain(save.signingSecret);
  }
});
