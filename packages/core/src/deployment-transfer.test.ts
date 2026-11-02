import type { DeploymentTransferStatus } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "./bot-package.test-helpers.js";
import {
  createDeploymentTransfer,
  initialDeploymentTransferState,
  parseDeploymentTransferPage,
} from "./deployment-transfer.js";
import {
  candidate,
  copied,
  plan,
  snapshot,
  sourceIdentity,
  sourceScope,
  targetIdentity,
  targetScope,
} from "./deployment-transfer.test-helpers.js";

const locator = "a".repeat(43);
const sourcePath = `/transfers/source?targetOrigin=https%3A%2F%2Ftarget.example.test&locator=${locator}`;

describe("protected transfer navigation", () => {
  it("keeps only the exact origin and public locator through source sign-in", () => {
    expect(parseDeploymentTransferPage(sourcePath)).toEqual({
      side: "source",
      targetOrigin: "https://target.example.test",
      locator,
    });
    expect(parseDeploymentTransferPage(`/transfers/receive/${locator}`)).toEqual({
      side: "target",
      transferId: locator,
    });
    expect(parseDeploymentTransferPage(`/transfers/source/${locator}`)).toEqual({
      side: "source",
      transferId: locator,
    });
    expect(parseDeploymentTransferPage("/transfers/source/request/request-one")).toEqual({
      side: "source",
      clientNonce: "request-one",
    });
    expect(parseDeploymentTransferPage("/transfers/receive/request/request-one")).toEqual({
      side: "target",
      clientNonce: "request-one",
    });
  });
  it.each([
    "https://target.example.test/transfers/source",
    "//target.example.test/transfers/source",
    `/transfers/source/../receive/${locator}`,
    `/transfers/source/%2e%2e/receive/${locator}`,
    `/transfers/receive/${locator}?next=/app`,
    "/transfers/source/request/..%2fapp",
    "/transfers/source/request/request-one?token=untrusted",
    "/transfers/receive/request/request-one#",
    `${sourcePath}#`,
    `${sourcePath}#fragment`,
    `${sourcePath}&locator=${locator}`,
    `${sourcePath}&next=https://untrusted.example.test`,
    `${sourcePath}&token=not-a-navigation-field`,
    sourcePath.replace(locator, "short"),
    sourcePath.replace(locator, `${locator}%0a`),
    sourcePath.replace("https%3A%2F%2Ftarget.example.test", "http%3A%2F%2Ftarget.example.test"),
    sourcePath.replace("target.example.test", "user%40target.example.test"),
    sourcePath.replace("target.example.test", "target.example.test%2F"),
    sourcePath.replace("target.example.test", "target.example.test%3Fredirect%3Delsewhere"),
    sourcePath.replace("target.example.test", "target.example.test%23fragment"),
    sourcePath.replace("target.example.test", "target.example.test%3A443"),
    `/transfers/receive/${locator}\\elsewhere`,
  ])("rejects unsupported navigation without resolving or fetching %s", (path) => {
    expect(parseDeploymentTransferPage(path)).toBeNull();
  });
});

function fixture(side?: "source" | "target") {
  type Deps = Parameters<typeof createDeploymentTransfer>[0];
  let state = initialDeploymentTransferState;
  let generation = 1;
  let nonce = 0;
  const changes: (typeof state)[] = [];
  const deps = {
    side,
    start: vi.fn<Deps["start"]>(async () =>
      snapshot({ side: "target", phase: "created", localScope: targetScope }),
    ),
    preview: vi.fn<Deps["preview"]>(async () => snapshot()),
    propose: vi.fn<Deps["propose"]>(async () => snapshot({ phase: "proposed", revision: 2 })),
    approve: vi.fn<Deps["approve"]>(async () =>
      snapshot({ side: "target", phase: "approved", revision: 5, localScope: targetScope }),
    ),
    commit: vi.fn<Deps["commit"]>(async () =>
      snapshot({ phase: "completed", revision: 5, items: [copied] }),
    ),
    status: vi.fn<Deps["status"]>(async () => snapshot()),
    cancel: vi.fn<Deps["cancel"]>(async () => snapshot({ phase: "cancelled", revision: 6 })),
    recent: vi.fn<Deps["recent"]>(async () => []),
    newNonce: vi.fn(() => `intent-${++nonce}`),
    isCurrent: () => generation === 1,
    changed(value: typeof state) {
      state = value;
      changes.push(value);
    },
  };
  return {
    manager: createDeploymentTransfer(deps),
    deps,
    changes,
    get state() {
      return state;
    },
    leaveAndReturnToSameScope() {
      generation += 2;
    },
  };
}
async function readySource(f: ReturnType<typeof fixture>) {
  f.deps.status.mockResolvedValue(
    snapshot({
      phase: "ready",
      revision: 3,
      plan,
      planDigest: "d".repeat(64),
      canCommit: true,
      grantDelivery: "acknowledged",
    }),
  );
  await f.manager.restore({ transferId: locator });
}

describe("one-time transfer review controller", () => {
  it("requires source selection, target approval and an explicit final source confirmation", async () => {
    const f = fixture();
    await f.manager.previewSource(targetIdentity.origin, locator, sourceScope.botId);
    await f.manager.propose();
    expect(f.deps.propose).not.toHaveBeenCalled();
    f.manager.select(candidate.itemKey, true);
    await f.manager.propose();
    expect(f.deps.propose).toHaveBeenCalledWith(
      {
        transferId: locator,
        expectedRevision: 1,
        selected: [{ itemKey: candidate.itemKey, revision: candidate.revision }],
      },
      expect.any(AbortSignal),
    );
    expect(f.deps.commit).not.toHaveBeenCalled();
    f.deps.status.mockResolvedValue(
      snapshot({
        phase: "ready",
        revision: 3,
        plan,
        planDigest: "d".repeat(64),
        canCommit: true,
        grantDelivery: "acknowledged",
      }),
    );
    await f.manager.checkStatus();
    expect(f.deps.commit).not.toHaveBeenCalled();
    await f.manager.confirmCopy();
    expect(f.deps.commit).toHaveBeenCalledExactlyOnceWith(
      {
        transferId: locator,
        expectedRevision: 3,
        planDigest: "d".repeat(64),
        expectedTargetFingerprint: targetIdentity.fingerprint,
        clientNonce: "intent-2",
      },
      expect.any(AbortSignal),
    );
    expect(f.state.snapshot?.items).toEqual([copied]);
  });
  it("keeps target conflicts by default and requires another exact preview after choosing overwrite", async () => {
    const f = fixture();
    f.deps.status.mockResolvedValue(
      snapshot({ side: "target", phase: "proposed", revision: 2, localScope: targetScope }),
    );
    f.deps.preview.mockResolvedValue(
      snapshot({
        side: "target",
        phase: "previewed",
        revision: 3,
        localScope: targetScope,
        plan,
        planDigest: "d".repeat(64),
        canApprove: true,
      }),
    );
    await f.manager.restore({ transferId: locator });
    await f.manager.previewTarget();
    expect(f.deps.preview).toHaveBeenCalledWith(
      { mode: "target", transferId: locator, expectedRevision: 2, decisions: [] },
      expect.any(AbortSignal),
    );
    f.manager.decide(candidate.itemKey, "overwrite");
    await f.manager.approve();
    expect(f.deps.approve).not.toHaveBeenCalled();
    f.deps.preview.mockResolvedValue(
      snapshot({
        side: "target",
        phase: "previewed",
        revision: 4,
        localScope: targetScope,
        plan: { ...plan, items: [{ ...plan.items[0]!, action: "overwrite" }] },
        planDigest: "e".repeat(64),
        canApprove: true,
      }),
    );
    await f.manager.previewTarget();
    expect(f.deps.preview).toHaveBeenLastCalledWith(
      {
        mode: "target",
        transferId: locator,
        expectedRevision: 3,
        decisions: [{ itemKey: candidate.itemKey, action: "overwrite" }],
      },
      expect.any(AbortSignal),
    );
    await f.manager.approve();
    expect(f.deps.approve).toHaveBeenCalledExactlyOnceWith(
      {
        transferId: locator,
        expectedRevision: 4,
        planDigest: "e".repeat(64),
        expectedSourceFingerprint: sourceIdentity.fingerprint,
      },
      expect.any(AbortSignal),
    );
    expect(f.deps.commit).not.toHaveBeenCalled();
  });
  it("holds a lost initial receipt under the same nonce and only queries it", async () => {
    const f = fixture();
    f.deps.start.mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_ERROR"));
    await f.manager.startReceive(targetScope.botId, sourceIdentity.origin);
    expect(f.state.request).toBe("unknown");
    expect(f.state.recovery).toEqual({ clientNonce: "intent-1", side: "target" });
    expect(JSON.stringify(f.state)).not.toContain("SYNTHETIC_PRIVATE_ERROR");
    await f.manager.startReceive(targetScope.botId, sourceIdentity.origin);
    expect(f.deps.start).toHaveBeenCalledTimes(1);
    f.deps.status.mockResolvedValue(
      snapshot({ side: "target", localScope: targetScope, phase: "created" }),
    );
    await f.manager.checkStatus();
    expect(f.deps.status).toHaveBeenCalledWith(
      { clientNonce: "intent-1", side: "target" },
      expect.any(AbortSignal),
    );
    expect(f.deps.start).toHaveBeenCalledTimes(1);
  });
  it("does not retry an unknown commit until status and keeps the original plan nonce", async () => {
    const f = fixture();
    await readySource(f);
    f.deps.commit.mockRejectedValueOnce(new Error("reply lost"));
    await f.manager.confirmCopy();
    await f.manager.confirmCopy();
    expect(f.deps.commit).toHaveBeenCalledTimes(1);
    await f.manager.checkStatus();
    expect(f.deps.commit).toHaveBeenCalledTimes(1);
    await f.manager.confirmCopy();
    expect(f.deps.commit.mock.calls.map(([input]) => input.clientNonce)).toEqual([
      "intent-1",
      "intent-1",
    ]);
  });
  it("recovers a retained receipt after expiry without enabling another copy", async () => {
    const f = fixture();
    f.deps.status.mockResolvedValue(
      snapshot({
        phase: "expired",
        revision: 4,
        items: [copied],
        canCommit: false,
        canRecover: false,
      }),
    );
    await f.manager.restore({ transferId: locator });
    await f.manager.confirmCopy();
    await f.manager.checkStatus();
    expect(f.deps.commit).not.toHaveBeenCalled();
    expect(f.state.snapshot?.items).toEqual([copied]);
    expect(f.deps.status).toHaveBeenCalledTimes(2);
  });
  it("cancels the server intent and ignores a late commit while retaining accepted items", async () => {
    const f = fixture();
    await readySource(f);
    const reply = deferred<DeploymentTransferStatus>();
    f.deps.commit.mockReturnValue(reply.promise);
    const writing = f.manager.confirmCopy();
    const signal = f.deps.commit.mock.calls[0]![1];
    f.deps.cancel.mockResolvedValue(snapshot({ phase: "cancelled", revision: 6, items: [copied] }));
    await f.manager.cancel();
    expect(signal.aborted).toBe(true);
    reply.resolve(snapshot({ phase: "completed", revision: 5, items: [copied] }));
    await writing;
    expect(f.state.snapshot?.phase).toBe("cancelled");
    expect(f.state.snapshot?.items).toEqual([copied]);
  });
  it("rejects late callbacks across a scope ABA and after disposal", async () => {
    const f = fixture();
    const reply = deferred<DeploymentTransferStatus>();
    f.deps.preview.mockReturnValue(reply.promise);
    const reading = f.manager.previewSource(targetIdentity.origin, locator, sourceScope.botId);
    f.leaveAndReturnToSameScope();
    f.manager.dispose();
    const count = f.changes.length;
    reply.resolve(snapshot());
    await reading;
    expect(f.changes).toHaveLength(count);
    expect(f.deps.preview.mock.calls[0]![1].aborted).toBe(true);
  });
  it("never downgrades an accepted item or replaces a newer receipt with an older one", async () => {
    const f = fixture();
    f.deps.status.mockResolvedValue(snapshot({ phase: "completed", revision: 5, items: [copied] }));
    await f.manager.restore({ transferId: locator });
    f.deps.status.mockResolvedValue(snapshot({ phase: "ready", revision: 4, items: [] }));
    await f.manager.checkStatus();
    expect(f.state.snapshot?.revision).toBe(5);
    expect(f.state.request).toBe("idle");
    f.deps.status.mockResolvedValue(snapshot({ phase: "cancelled", revision: 6, items: [] }));
    await f.manager.checkStatus();
    expect(f.state.snapshot?.items).toEqual([copied]);
    expect(f.state.request).toBe("unknown");
  });
  it("rejects an unbounded or secret-bearing response before publishing it", async () => {
    const f = fixture();
    f.deps.status.mockResolvedValue({
      ...snapshot(),
      token: "SYNTHETIC_PRIVATE_VALUE",
    } as DeploymentTransferStatus);
    await f.manager.restore({ transferId: locator });
    expect(f.state.snapshot).toBeNull();
    expect(JSON.stringify(f.state)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    expect(f.state.request).toBe("unknown");
  });
  it("does not turn a protected resource conflict into an overwrite decision", async () => {
    const f = fixture();
    f.deps.status.mockResolvedValue(
      snapshot({
        side: "target",
        phase: "previewed",
        localScope: targetScope,
        plan: {
          ...plan,
          items: [{ ...plan.items[0]!, canOverwrite: false, reason: "source_resource_shared" }],
        },
      }),
    );
    await f.manager.restore({ transferId: locator });
    f.manager.decide(candidate.itemKey, "overwrite");
    expect(f.state.dirty).toBe(false);
    expect(f.state.decisions[candidate.itemKey]).toBe("keep");
  });
  it("blocks malformed origins before creating an invitation", async () => {
    const f = fixture();
    await f.manager.startReceive(targetScope.botId, "http://target.example.test");
    expect(f.deps.start).not.toHaveBeenCalled();
    expect(f.state.error).toBe("invalid_origin");
  });
});

it("keeps an absent pending receipt unknown because an initial create may still arrive", async () => {
  const f = fixture();
  f.deps.status.mockResolvedValue(null);
  await f.manager.restore({ clientNonce: "original-request", side: "target" });
  await f.manager.startReceive(targetScope.botId, sourceIdentity.origin);
  expect(f.state.request).toBe("unknown");
  expect(f.state.recovery).toEqual({ clientNonce: "original-request", side: "target" });
  expect(f.deps.start).not.toHaveBeenCalled();
  expect(f.deps.newNonce).not.toHaveBeenCalled();
});
it("restores the server's accepted batch nonce before an explicit recovery confirmation", async () => {
  const f = fixture();
  f.deps.status.mockResolvedValue(
    snapshot({
      phase: "partial",
      revision: 4,
      plan,
      planDigest: "d".repeat(64),
      commitNonce: "durable-batch",
      canRecover: true,
    }),
  );
  await f.manager.restore({ transferId: locator });
  expect(f.deps.commit).not.toHaveBeenCalled();
  await f.manager.confirmCopy();
  expect(f.deps.commit.mock.calls[0]![0].clientNonce).toBe("durable-batch");
  expect(f.deps.newNonce).not.toHaveBeenCalled();
});

it("lets an explicit second cancellation reconcile unknown cleanup without restarting copy", async () => {
  const f = fixture();
  await readySource(f);
  const unknown = { ...copied, itemKey: "uncertain", status: "unknown" as const };
  f.deps.cancel
    .mockResolvedValueOnce(snapshot({ phase: "cancelled", revision: 6, items: [copied, unknown] }))
    .mockResolvedValueOnce(
      snapshot({
        phase: "cancelled",
        revision: 7,
        items: [copied, { ...unknown, status: "cancelled" }],
      }),
    );
  await f.manager.cancel();
  await f.manager.cancel();
  expect(f.deps.cancel.mock.calls.map(([input]) => input.expectedRevision)).toEqual([3, 6]);
  expect(f.state.snapshot?.items[0]?.status).toBe("copied");
  expect(f.deps.commit).not.toHaveBeenCalled();
  await f.manager.cancel();
  expect(f.deps.cancel).toHaveBeenCalledTimes(2);
});
it("does not discard accepted facts when restoring the same receipt", async () => {
  const f = fixture();
  f.deps.status
    .mockResolvedValueOnce(snapshot({ phase: "completed", revision: 5, items: [copied] }))
    .mockResolvedValueOnce(snapshot({ phase: "cancelled", revision: 6, items: [] }));
  await f.manager.restore({ transferId: locator });
  await f.manager.restore({ transferId: locator });
  expect(f.state.snapshot?.items).toEqual([copied]);
  expect(f.state.request).toBe("unknown");
});
it("rejects a receipt from the other protected page role", async () => {
  const f = fixture("target");
  await f.manager.restore({ transferId: locator });
  expect(f.state.snapshot).toBeNull();
  expect(f.state.request).toBe("unknown");
});

it("accepts current restore revocation below a previously observed revision without rewriting history", async () => {
  const f = fixture();
  f.deps.status
    .mockResolvedValueOnce(
      snapshot({
        phase: "ready",
        revision: 12,
        plan,
        planDigest: "d".repeat(64),
        commitNonce: "accepted-batch",
        canCommit: true,
        items: [{ ...copied, targetState: "unchanged" }],
      }),
    )
    .mockResolvedValueOnce(
      snapshot({ phase: "expired", revision: 3, writeRevokedReason: "restore", items: [] }),
    );
  await f.manager.restore({ transferId: locator });
  await f.manager.checkStatus();
  expect(f.state.snapshot?.revision).toBe(3);
  expect(f.state.snapshot?.phase).toBe("expired");
  expect(f.state.snapshot?.canCommit).toBe(false);
  expect(f.state.snapshot?.canRecover).toBe(false);
  expect(f.state.snapshot?.items[0]?.status).toBe("copied");
  expect(f.state.snapshot?.items[0]?.targetState).toBeUndefined();
  await f.manager.confirmCopy();
  await f.manager.cancel();
  expect(f.deps.commit).not.toHaveBeenCalled();
  expect(f.deps.cancel).not.toHaveBeenCalled();
});
it("keeps restore revocation sticky and uses only freshly observed target state", async () => {
  const f = fixture();
  f.deps.status
    .mockResolvedValueOnce(
      snapshot({
        phase: "completed",
        revision: 12,
        items: [{ ...copied, targetState: "unchanged" }],
      }),
    )
    .mockResolvedValueOnce(
      snapshot({
        phase: "expired",
        revision: 3,
        writeRevokedReason: "restore",
        items: [{ ...copied, targetState: "modified" }],
      }),
    )
    .mockResolvedValueOnce(
      snapshot({
        phase: "ready",
        revision: 13,
        plan,
        planDigest: "d".repeat(64),
        canCommit: true,
        items: [{ ...copied, targetState: "unchanged" }],
      }),
    );
  await f.manager.restore({ transferId: locator });
  await f.manager.checkStatus();
  expect(f.state.snapshot?.items[0]?.targetState).toBe("modified");
  await f.manager.checkStatus();
  expect(f.state.snapshot?.phase).toBe("expired");
  expect(f.state.snapshot?.canCommit).toBe(false);
  expect(f.state.snapshot?.items[0]?.targetState).toBe("modified");
});

it("updates current target observations without downgrading the historical copy", async () => {
  const f = fixture();
  f.deps.status
    .mockResolvedValueOnce(
      snapshot({
        phase: "completed",
        revision: 12,
        items: [{ ...copied, targetState: "unchanged" }],
      }),
    )
    .mockResolvedValueOnce(
      snapshot({
        phase: "completed",
        revision: 13,
        items: [{ ...copied, targetState: "modified" }],
      }),
    )
    .mockResolvedValueOnce(
      snapshot({
        phase: "completed",
        revision: 14,
        items: [{ ...copied, targetState: "removed" }],
      }),
    )
    .mockResolvedValueOnce(snapshot({ phase: "completed", revision: 14, items: [copied] }));
  await f.manager.restore({ transferId: locator });
  await f.manager.checkStatus();
  expect(f.state.snapshot?.items[0]?.status).toBe("copied");
  expect(f.state.snapshot?.items[0]?.targetState).toBe("modified");
  await f.manager.checkStatus();
  expect(f.state.snapshot?.items[0]?.targetState).toBe("removed");
  await f.manager.checkStatus();
  expect(f.state.snapshot?.items[0]?.status).toBe("copied");
  expect(f.state.snapshot?.items[0]?.targetState).toBeUndefined();
  expect(f.deps.commit).not.toHaveBeenCalled();
});

it("permits explicit cleanup after TTL expiry only while an unknown item remains", async () => {
  const f = fixture();
  const unknown = { ...copied, itemKey: "pending-cleanup", status: "unknown" as const };
  f.deps.status.mockResolvedValue(
    snapshot({ phase: "expired", revision: 8, items: [copied, unknown] }),
  );
  f.deps.cancel.mockResolvedValue(
    snapshot({
      phase: "cancelled",
      revision: 9,
      items: [copied, { ...unknown, status: "cancelled" }],
    }),
  );
  await f.manager.restore({ transferId: locator });
  await f.manager.confirmCopy();
  expect(f.deps.commit).not.toHaveBeenCalled();
  await f.manager.cancel();
  expect(f.deps.cancel).toHaveBeenCalledExactlyOnceWith(
    { transferId: locator, expectedRevision: 8 },
    expect.any(AbortSignal),
  );
  expect(f.state.snapshot?.items[0]?.status).toBe("copied");
  await f.manager.cancel();
  expect(f.deps.cancel).toHaveBeenCalledTimes(1);
});
it.each([undefined, "restore"] as const)(
  "keeps settled expired or restore-revoked receipts read-only (%s)",
  async (writeRevokedReason) => {
    const f = fixture();
    f.deps.status.mockResolvedValue(
      snapshot({
        phase: "expired",
        writeRevokedReason,
        items: writeRevokedReason ? [{ ...copied, status: "unknown" }] : [copied],
      }),
    );
    await f.manager.restore({ transferId: locator });
    await f.manager.cancel();
    await f.manager.confirmCopy();
    expect(f.deps.cancel).not.toHaveBeenCalled();
    expect(f.deps.commit).not.toHaveBeenCalled();
  },
);
