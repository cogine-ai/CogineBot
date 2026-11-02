// @vitest-environment jsdom

import { initialDeploymentTransferState } from "@rakazo/core";
import { beforeEach, expect, it, vi } from "vitest";
import { snapshot, sourceIdentity, targetScope } from "./deployment-transfer.test-helpers.js";
import {
  createWebDeploymentTransfer,
  rememberTransferAddress,
  sourceTransferPageUrl,
} from "./deployment-transfer-client";

const transport = vi.hoisted(() => ({ session: 1, selection: 1, start: vi.fn(), status: vi.fn() }));
vi.mock("./rpc", () => ({
  currentRpcSessionGeneration: () => transport.session,
  currentSpaceSelectionGeneration: () => transport.selection,
  createSpaceRpc: () => ({ transfer: { start: transport.start, status: transport.status } }),
}));
vi.mock("./client-id", () => ({ newClientId: () => "request-one" }));
beforeEach(() => {
  vi.clearAllMocks();
  transport.session = 1;
  transport.selection = 1;
  window.history.replaceState({}, "", "/app");
});
it("writes its pending recovery URL before the first invitation request", async () => {
  transport.start.mockImplementation(async () => {
    expect(window.location.pathname).toBe("/transfers/receive/request/request-one");
    throw new Error("lost reply");
  });
  const changed = vi.fn(rememberTransferAddress);
  const client = createWebDeploymentTransfer({
    spaceId: "selected",
    isCurrent: () => true,
    changed,
  });
  await client.manager.startReceive(targetScope.botId, sourceIdentity.origin);
  expect(changed.mock.lastCall?.[0].request).toBe("unknown");
  expect(transport.start).toHaveBeenCalledTimes(1);
  expect(window.location.search).toBe("");
});
it("does not publish an old response after a session or selection ABA", async () => {
  const changed = vi.fn();
  transport.status.mockImplementation(async () => {
    transport.session += 2;
    transport.selection += 2;
    return snapshot();
  });
  const client = createWebDeploymentTransfer({ spaceId: null, isCurrent: () => true, changed });
  await client.manager.restore({ transferId: "a".repeat(43) });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0]![0].snapshot).toBeNull();
});
it("allows only a matching protected source invitation, never a token or redirect", () => {
  const id = "a".repeat(43);
  const valid = `https://source.example.test/transfers/source?targetOrigin=https%3A%2F%2Ftarget.example.test&locator=${id}`;
  expect(sourceTransferPageUrl(snapshot({ side: "target", sourcePageUrl: valid }))).toBe(valid);
  for (const url of [
    `${valid}&token=not-navigation`,
    valid.replace(id, "b".repeat(43)),
    valid.replace("target.example.test", "other.example.test"),
    valid.replace("https://source", "http://source"),
    valid.replace("source.example.test", "user@source.example.test"),
    `${valid}#fragment`,
  ])
    expect(sourceTransferPageUrl(snapshot({ side: "target", sourcePageUrl: url }))).toBeNull();
  expect(rememberTransferAddress(initialDeploymentTransferState)).toBeNull();
});
