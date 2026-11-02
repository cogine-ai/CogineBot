import { beforeEach, expect, it, vi } from "vitest";
import { snapshot } from "./deployment-transfer.test-helpers.js";
import { mobileDeploymentTransferClient } from "./deployment-transfer-client";
import type { MobileScope } from "./mobile-scope";

const state = vi.hoisted(() => ({ current: true, ready: 1, capture: vi.fn(), rpc: vi.fn() }));
vi.mock("./api", () => ({ captureApiRequestContext: state.capture, rpc: state.rpc }));
vi.mock("./mobile-scope", () => ({ isMobileScopeCurrent: () => state.current }));
vi.mock("./session", () => ({ currentReadySessionGeneration: () => state.ready }));
const scope: MobileScope = {
  apiBase: "https://target.example.test",
  apiGeneration: 1,
  sessionGeneration: 1,
  spaceId: "currently-selected-space",
  spaceGeneration: 1,
  selectionSeq: 1,
};
beforeEach(() => {
  vi.clearAllMocks();
  state.current = true;
  state.ready = 1;
  state.capture.mockResolvedValue({
    apiBase: scope.apiBase,
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": scope.spaceId },
  });
  state.rpc.mockResolvedValue(snapshot());
});
it("restores the exact existing receipt without me, Space recovery or an API-base change", async () => {
  const client = await mobileDeploymentTransferClient(scope, () => true);
  const signal = new AbortController().signal;
  await client.request("transfer/status", { transferId: "a".repeat(43) }, signal);
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith(
    "transfer/status",
    { transferId: "a".repeat(43) },
    {
      requestContext: {
        apiBase: scope.apiBase,
        sessionGeneration: 1,
        headers: { "x-rakazo-space-id": scope.spaceId },
        isCurrent: client.isCurrent,
      },
      skipSpaceAuthRecovery: true,
      signal,
    },
  );
});
it("uses only the local protected page and an owner-authenticated navigation handle", async () => {
  const client = await mobileDeploymentTransferClient(scope, () => true);
  expect(client.pageUrl(snapshot({ side: "target" }), null)).toBe(
    `https://target.example.test/transfers/receive/${"a".repeat(43)}`,
  );
  expect(client.pageUrl(snapshot({ side: "source" }), null)).toBe(
    `https://source.example.test/transfers/source/${"a".repeat(43)}`,
  );
  expect(client.pageUrl(null, { clientNonce: "request-one", side: "target" })).toBe(
    "https://target.example.test/transfers/receive/request/request-one",
  );
  expect(client.pageUrl(snapshot({ transferId: "../../elsewhere" }), null)).toBeNull();
});
it("rejects a request context resolved after an origin or session transition", async () => {
  state.capture.mockImplementationOnce(async () => {
    state.current = false;
    return { apiBase: scope.apiBase, sessionGeneration: 1 };
  });
  await expect(mobileDeploymentTransferClient(scope, () => true)).rejects.toThrow(
    "no longer current",
  );
  expect(state.rpc).not.toHaveBeenCalled();
});
it("does not send a request from a session that is not ready", async () => {
  state.ready = 2;
  await expect(mobileDeploymentTransferClient(scope, () => true)).rejects.toThrow(
    "no longer current",
  );
  expect(state.capture).not.toHaveBeenCalled();
});
it("discards responses and browser actions after the owning scope leaves", async () => {
  const client = await mobileDeploymentTransferClient(scope, () => true);
  state.rpc.mockImplementationOnce(async () => {
    state.current = false;
    return snapshot();
  });
  await expect(client.request("transfer/status", { transferId: "a".repeat(43) })).rejects.toThrow(
    "no longer current",
  );
  expect(() => client.pageUrl(snapshot(), null)).toThrow("no longer current");
});
it("checks cancellation before contacting the server", async () => {
  const client = await mobileDeploymentTransferClient(scope, () => true);
  const controller = new AbortController();
  controller.abort();
  await expect(
    client.request("transfer/status", { transferId: "a".repeat(43) }, controller.signal),
  ).rejects.toThrow();
  expect(state.rpc).not.toHaveBeenCalled();
});
