import type {
  PluginInstallInput,
  PluginInstallReceipt,
  PluginPreview,
  PluginUninstallInput,
} from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createPluginInstallReview } from "./plugin-install-review.js";

function listing(
  owned: PluginInstallReceipt[] = [],
  managed: { receipt: PluginInstallReceipt; ownerName: string | null }[] = [],
) {
  return { owned, managed };
}

const preview: PluginPreview = {
  source: `https://github.com/example/plugin/tree/${"a".repeat(40)}`,
  sourceSha: "a".repeat(40),
  digest: `sha256:${"b".repeat(64)}`,
  format: "agent-plugins",
  name: "Research",
  description: "Synthetic plugin",
  version: null,
  skills: [{ name: "research", description: "Research a topic", content: "Complete instructions" }],
  mcpServers: [],
  skipped: [],
};
const receipt: PluginInstallReceipt = {
  id: "install-one",
  clientNonce: "nonce-one",
  source: preview.source,
  sourceSha: preview.sourceSha,
  digest: preview.digest,
  name: preview.name,
  status: "installed",
  revision: 1,
  installedAt: "2026-11-01T00:00:00.000Z",
  skills: [{ id: "skill-one", name: "research" }],
  mcpServers: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(makeNonce = () => "nonce-one") {
  const transport = {
    preview: vi.fn(async (_input: { source: string }, _signal: AbortSignal) => preview),
    install: vi.fn(
      async (input: PluginInstallInput, _signal: AbortSignal): Promise<PluginInstallReceipt> => ({
        ...receipt,
        clientNonce: input.clientNonce,
      }),
    ),
    list: vi.fn(async (_signal: AbortSignal) => listing()),
    uninstall: vi.fn(
      async (
        _input: PluginUninstallInput,
        _signal: AbortSignal,
      ): Promise<PluginInstallReceipt> => ({
        ...receipt,
        status: "removed",
        revision: 3,
      }),
    ),
  };
  const manager = createPluginInstallReview({
    ...transport,
    makeNonce,
    isCurrent: () => true,
    changed: vi.fn(),
  });
  return { ...transport, manager };
}

describe("plugin installation review", () => {
  it("installs only the immutable reviewed source and keeps the returned receipt", async () => {
    const f = fixture();
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    expect(f.install).toHaveBeenCalledWith(
      {
        source: preview.source,
        sourceSha: preview.sourceSha,
        digest: preview.digest,
        clientNonce: "nonce-one",
      },
      expect.any(AbortSignal),
    );
    expect(f.manager.state()).toMatchObject({ phase: "installed", receipt });
  });

  it("requires a receipt check before retrying an uncertain install and reuses its nonce", async () => {
    const f = fixture();
    f.install.mockRejectedValueOnce(new Error("reply lost"));
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    expect(f.manager.state().phase).toBe("unknown");
    await f.manager.install();
    expect(f.install).toHaveBeenCalledTimes(1);
    await f.manager.check();
    expect(f.manager.state().retryChecked).toBe(true);
    await f.manager.install();
    expect(f.install).toHaveBeenCalledTimes(2);
    expect(f.install.mock.calls[0]?.[0]).toEqual(f.install.mock.calls[1]?.[0]);
  });

  it("does not mistake another nonce's removed installation for the current request", async () => {
    const f = fixture();
    f.install.mockRejectedValueOnce(new Error("reply lost"));
    f.list.mockResolvedValue(
      listing([{ ...receipt, clientNonce: "old-nonce", status: "removed" }]),
    );
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    await f.manager.check();
    expect(f.manager.state()).toMatchObject({
      phase: "unknown",
      retryChecked: true,
      receipt: null,
    });
    f.list.mockResolvedValue(listing([{ ...receipt, status: "removed", revision: 3 }]));
    await f.manager.check();
    expect(f.manager.state()).toMatchObject({ phase: "terminal", receipt: { status: "removed" } });
    await f.manager.install();
    expect(f.install).toHaveBeenCalledTimes(1);
  });

  it("rejects a nonce receipt bound to different reviewed bytes", async () => {
    const f = fixture();
    f.install.mockResolvedValue({ ...receipt, digest: `sha256:${"f".repeat(64)}` });
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    expect(f.manager.state()).toMatchObject({ phase: "unknown", receipt: null });
    f.list.mockResolvedValue(listing([{ ...receipt, sourceSha: "c".repeat(40) }]));
    await f.manager.check();
    expect(f.manager.state()).toMatchObject({ phase: "unknown", retryChecked: false });
  });

  it("joins same-tick user intent to one install request", async () => {
    const f = fixture();
    let resolve!: (value: PluginInstallReceipt) => void;
    f.install.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await f.manager.preview("https://github.com/example/plugin");
    const first = f.manager.install();
    const second = f.manager.install();
    expect(f.install).toHaveBeenCalledTimes(1);
    expect(f.manager.changeSource("https://github.com/example/other")).toBe(false);
    resolve(receipt);
    await Promise.all([first, second]);
  });

  it("cancels a preview when the URL changes and ignores its late response", async () => {
    const f = fixture();
    let resolve!: (value: PluginPreview) => void;
    f.preview.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const old = f.manager.preview("https://github.com/example/plugin");
    const signal = f.preview.mock.calls[0]?.[1];
    f.manager.changeSource("https://github.com/example/other");
    expect(signal?.aborted).toBe(true);
    resolve(preview);
    await old;
    expect(f.manager.state()).toMatchObject({
      phase: "idle",
      source: "https://github.com/example/other",
      preview: null,
    });
    await f.manager.install();
    expect(f.install).not.toHaveBeenCalled();
  });

  it("does not let a stale installed-list response erase a committed receipt", async () => {
    const f = fixture();
    let resolve!: (value: ReturnType<typeof listing>) => void;
    f.list.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const old = f.manager.refresh();
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    resolve(listing());
    await old;
    expect(f.manager.state()).toMatchObject({ loading: false, installations: [receipt] });
  });

  it("uses frozen reviewed fields even when the displayed preview object is mutated", async () => {
    const f = fixture();
    f.preview.mockResolvedValue(structuredClone(preview));
    await f.manager.preview("https://github.com/example/plugin");
    const state = f.manager.state();
    if (!state.preview) throw new Error("Expected a preview");
    state.preview.sourceSha = "f".repeat(40);
    await f.manager.install();
    expect(f.install.mock.calls[0]?.[0].sourceSha).toBe(preview.sourceSha);
  });

  it("discards late writes after disposal and never dispatches a new request", async () => {
    const f = fixture();
    let resolve!: (value: PluginInstallReceipt) => void;
    f.install.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await f.manager.preview("https://github.com/example/plugin");
    const write = f.manager.install();
    const signal = f.install.mock.calls[0]?.[1];
    f.manager.dispose();
    expect(signal?.aborted).toBe(true);
    resolve(receipt);
    await write;
    await f.manager.refresh();
    await f.manager.install();
    expect(f.install).toHaveBeenCalledTimes(1);
    expect(f.list).not.toHaveBeenCalled();
    expect(f.manager.state().receipt).toBeNull();
  });

  it("refreshes an uncertain removal before retrying with the latest revision", async () => {
    const f = fixture();
    f.list.mockResolvedValue(listing([receipt]));
    await f.manager.refresh();
    f.uninstall.mockRejectedValueOnce(new Error("reply lost"));
    await f.manager.uninstall(receipt);
    expect(f.manager.state().removalUnknownId).toBe(receipt.id);
    await f.manager.uninstall(receipt);
    expect(f.uninstall).toHaveBeenCalledTimes(1);
    const latest = { ...receipt, status: "cleanup_failed" as const, revision: 4 };
    f.list.mockResolvedValue(listing([latest]));
    await f.manager.refresh();
    expect(f.manager.state()).toMatchObject({ removalUnknownId: null, error: null });
    await f.manager.uninstall(latest);
    expect(f.uninstall.mock.calls[1]?.[0]).toEqual({ installId: receipt.id, expectedRevision: 4 });
  });

  it("keeps a durable installing outcome check-only and requires new preview intent after failure", async () => {
    let nonce = 0;
    const f = fixture(() => `nonce-${++nonce}`);
    const pending = {
      ...receipt,
      clientNonce: "nonce-1",
      status: "installing" as const,
      installedAt: null,
    };
    f.install.mockResolvedValueOnce(pending);
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    expect(f.manager.state()).toMatchObject({
      phase: "unknown",
      receipt: pending,
      retryChecked: false,
    });
    f.list.mockResolvedValue(listing([pending]));
    await f.manager.check();
    await f.manager.install();
    expect(f.install).toHaveBeenCalledTimes(1);
    f.list.mockResolvedValue(listing([{ ...pending, status: "failed", revision: 2 }]));
    await f.manager.check();
    expect(f.manager.state()).toMatchObject({
      phase: "terminal",
      receipt: { status: "failed", installedAt: null },
    });
    await f.manager.install();
    expect(f.install).toHaveBeenCalledTimes(1);
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    expect(f.install.mock.calls[1]?.[0].clientNonce).toBe("nonce-2");
  });

  it("refreshes the known outcome when the same installation changes elsewhere", async () => {
    const f = fixture();
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    f.list.mockResolvedValue(listing([{ ...receipt, status: "removed", revision: 3 }]));
    await f.manager.refresh();
    expect(f.manager.state()).toMatchObject({
      phase: "terminal",
      receipt: { status: "removed", revision: 3 },
    });
  });

  it("moves the current installed receipt to a terminal phase after explicit removal", async () => {
    const f = fixture();
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    await f.manager.uninstall(receipt);
    expect(f.manager.state()).toMatchObject({
      phase: "terminal",
      receipt: { id: receipt.id, status: "removed", revision: 3 },
    });
  });

  it("does not change the active review when a different persisted installation is removed", async () => {
    const f = fixture();
    const other = { ...receipt, id: "other-install", clientNonce: "other-nonce" };
    f.list.mockResolvedValue(listing([receipt, other]));
    f.uninstall.mockResolvedValue({ ...other, status: "removed", revision: 3 });
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    await f.manager.refresh();
    await f.manager.uninstall(other);
    expect(f.manager.state()).toMatchObject({ phase: "installed", receipt });
    expect(f.manager.state().installations).toContainEqual({
      ...other,
      status: "removed",
      revision: 3,
    });
  });

  it("allows explicit cleanup of a durable pending receipt after reopening the list", async () => {
    const f = fixture();
    const pending = { ...receipt, status: "installing" as const, installedAt: null };
    f.list.mockResolvedValue(listing([pending]));
    f.uninstall.mockResolvedValue({ ...pending, status: "removed", revision: 3 });
    await f.manager.refresh();
    expect(f.manager.canUninstall(pending)).toBe(true);
    await f.manager.uninstall(pending);
    expect(f.uninstall).toHaveBeenCalledWith(
      { installId: pending.id, expectedRevision: pending.revision },
      expect.any(AbortSignal),
    );
    expect(f.manager.state()).toMatchObject({ phase: "idle", receipt: null });
    expect(f.manager.state().installations[0]?.status).toBe("removed");
    expect(f.install).not.toHaveBeenCalled();
  });

  it("allows cleanup of the exact current pending outcome without replaying its install", async () => {
    const f = fixture();
    const pending = { ...receipt, status: "installing" as const, installedAt: null };
    f.install.mockResolvedValue(pending);
    f.uninstall.mockResolvedValue({ ...pending, status: "removed", revision: 3 });
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    expect(f.manager.canUninstall(pending)).toBe(true);
    await f.manager.uninstall(pending);
    expect(f.manager.state()).toMatchObject({
      phase: "terminal",
      receipt: { status: "removed", revision: 3 },
    });
    await f.manager.install();
    expect(f.install).toHaveBeenCalledTimes(1);
  });

  it("never removes another list row while the active write has no exact receipt", async () => {
    const f = fixture();
    const pending = {
      ...receipt,
      clientNonce: "another-nonce",
      status: "installing" as const,
      installedAt: null,
    };
    f.install.mockRejectedValueOnce(new Error("reply lost"));
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    f.list.mockResolvedValue(listing([pending]));
    await f.manager.refresh();
    expect(f.manager.state()).toMatchObject({ phase: "unknown", receipt: null });
    expect(f.manager.canUninstall(pending)).toBe(false);
    await f.manager.uninstall(pending);
    expect(f.uninstall).not.toHaveBeenCalled();
  });

  it("requires the exact persisted identity, binding, revision and status for cleanup", async () => {
    const f = fixture();
    f.list.mockResolvedValue(listing([receipt]));
    await f.manager.refresh();
    expect(f.manager.canUninstall(receipt)).toBe(true);
    const stale = [
      { ...receipt, id: "other-id" },
      { ...receipt, clientNonce: "other-nonce" },
      { ...receipt, source: "https://github.com/example/other" },
      { ...receipt, sourceSha: "c".repeat(40) },
      { ...receipt, digest: `sha256:${"d".repeat(64)}` },
      { ...receipt, revision: 2 },
      { ...receipt, status: "installing" as const },
    ];
    for (const value of stale) {
      expect(f.manager.canUninstall(value)).toBe(false);
      await f.manager.uninstall(value);
    }
    expect(f.uninstall).not.toHaveBeenCalled();
    f.list.mockResolvedValue(listing([{ ...receipt, status: "removed", revision: 3 }]));
    await f.manager.refresh();
    expect(f.manager.canUninstall({ ...receipt, status: "removed", revision: 3 })).toBe(false);
  });

  it("does not dispatch cleanup while a write is busy or duplicate its own cleanup", async () => {
    const f = fixture();
    f.list.mockResolvedValue(listing([receipt]));
    await f.manager.refresh();
    let installed!: (value: PluginInstallReceipt) => void;
    f.install.mockImplementationOnce(
      () =>
        new Promise((done) => {
          installed = done;
        }),
    );
    await f.manager.preview("https://github.com/example/plugin");
    const install = f.manager.install();
    expect(f.manager.canUninstall(receipt)).toBe(false);
    await f.manager.uninstall(receipt);
    expect(f.uninstall).not.toHaveBeenCalled();
    installed(receipt);
    await install;
    let removed!: (value: PluginInstallReceipt) => void;
    f.uninstall.mockImplementationOnce(
      () =>
        new Promise((done) => {
          removed = done;
        }),
    );
    const first = f.manager.uninstall(receipt);
    expect(f.manager.canUninstall(receipt)).toBe(false);
    const second = f.manager.uninstall(receipt);
    expect(f.uninstall).toHaveBeenCalledTimes(1);
    removed({ ...receipt, status: "removed", revision: 3 });
    await Promise.all([first, second]);
  });

  it("keeps a new preview intact when another persisted row is removed", async () => {
    const f = fixture();
    const other = { ...receipt, id: "other-install", clientNonce: "other-nonce" };
    f.list.mockResolvedValue(listing([other]));
    f.uninstall.mockResolvedValue({ ...other, status: "removed", revision: 3 });
    await f.manager.refresh();
    await f.manager.preview("https://github.com/example/new-draft");
    await f.manager.uninstall(other);
    expect(f.manager.state()).toMatchObject({
      phase: "review",
      source: "https://github.com/example/new-draft",
      preview,
      receipt: null,
    });
  });

  it("recovers only its own receipt when another member uses the same nonce and reviewed bytes", async () => {
    const f = fixture();
    const own = { ...receipt, status: "installing" as const, installedAt: null };
    const managed = { ...receipt, id: "member-install", status: "removed" as const, revision: 3 };
    f.install.mockRejectedValueOnce(new Error("reply lost"));
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    f.list.mockResolvedValue(listing([own], [{ receipt: managed, ownerName: "Alex" }]));
    await f.manager.check();
    expect(f.manager.state()).toMatchObject({
      phase: "unknown",
      receipt: own,
      retryChecked: false,
      installationOwners: { "member-install": "Alex" },
    });
    expect(f.manager.canUninstall(own)).toBe(true);
    expect(f.manager.canUninstall(managed)).toBe(false);
    expect(f.install).toHaveBeenCalledTimes(1);
  });

  it("cannot resolve an own unknown write from a managed-only matching nonce", async () => {
    const f = fixture();
    const managed = { ...receipt, id: "member-install" };
    f.install.mockRejectedValueOnce(new Error("reply lost"));
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    f.list.mockResolvedValue(listing([], [{ receipt: managed, ownerName: null }]));
    await f.manager.check();
    expect(f.manager.state()).toMatchObject({
      phase: "unknown",
      receipt: null,
      retryChecked: true,
    });
    expect(f.manager.canUninstall(managed)).toBe(false);
    await f.manager.uninstall(managed);
    expect(f.uninstall).not.toHaveBeenCalled();
  });

  it("preserves a managed receipt's provenance through a lost removal response and tombstone refresh", async () => {
    const f = fixture();
    const managed = { ...receipt, id: "member-install" };
    const removed = { ...managed, status: "removed" as const, revision: 3 };
    f.list.mockResolvedValue(listing([], [{ receipt: managed, ownerName: "Alex" }]));
    await f.manager.refresh();
    expect(f.manager.canUninstall(managed)).toBe(true);
    f.uninstall.mockRejectedValueOnce(new Error("reply lost"));
    await f.manager.uninstall(managed);
    expect(f.manager.state().removalUnknownId).toBe(managed.id);
    f.list.mockResolvedValue(listing([], [{ receipt: removed, ownerName: "Alex" }]));
    await f.manager.refresh();
    expect(f.manager.state()).toMatchObject({
      phase: "idle",
      receipt: null,
      removalUnknownId: null,
      installationOwners: { "member-install": "Alex" },
    });
    f.install.mockRejectedValueOnce(new Error("own reply lost"));
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    await f.manager.check();
    expect(f.manager.state()).toMatchObject({
      phase: "unknown",
      receipt: null,
      retryChecked: true,
    });
    expect(f.manager.canUninstall(removed)).toBe(false);
  });

  it("does not promote a managed removal outcome or replace the owner's current preview", async () => {
    const f = fixture();
    const managed = { ...receipt, id: "member-install" };
    f.list.mockResolvedValue(listing([], [{ receipt: managed, ownerName: "Alex" }]));
    await f.manager.refresh();
    await f.manager.preview("https://github.com/example/draft");
    f.uninstall.mockResolvedValue({ ...managed, status: "cleanup_failed", revision: 3 });
    await f.manager.uninstall(managed);
    expect(f.manager.state()).toMatchObject({
      phase: "review",
      source: "https://github.com/example/draft",
      receipt: null,
      installationOwners: { "member-install": "Alex" },
    });
    f.uninstall.mockResolvedValue({ ...managed, status: "removed", revision: 5 });
    await f.manager.uninstall({ ...managed, status: "cleanup_failed", revision: 3 });
    f.install.mockRejectedValueOnce(new Error("own reply lost"));
    await f.manager.install();
    f.list.mockResolvedValue(
      listing([], [{ receipt: { ...managed, status: "removed", revision: 5 }, ownerName: "Alex" }]),
    );
    await f.manager.check();
    expect(f.manager.state()).toMatchObject({ phase: "unknown", receipt: null });
  });

  it("invalidates an old managed confirmation when a fresh listing loses management rights", async () => {
    const f = fixture();
    const managed = { ...receipt, id: "member-install" };
    f.list.mockResolvedValue(listing([], [{ receipt: managed, ownerName: "Alex" }]));
    await f.manager.refresh();
    expect(f.manager.canUninstall(managed)).toBe(true);
    f.list.mockResolvedValue(listing());
    await f.manager.refresh();
    expect(f.manager.state()).toMatchObject({ installations: [], installationOwners: {} });
    expect(f.manager.canUninstall(managed)).toBe(false);
    await f.manager.uninstall(managed);
    expect(f.uninstall).not.toHaveBeenCalled();
  });

  it("never refreshes the selected own outcome from a managed receipt", async () => {
    const f = fixture();
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    f.list.mockResolvedValue(
      listing([], [{ receipt: { ...receipt, status: "removed", revision: 3 }, ownerName: "Alex" }]),
    );
    await f.manager.refresh();
    expect(f.manager.state()).toMatchObject({ phase: "installed", receipt });
    expect(f.manager.canUninstall(receipt)).toBe(false);
  });

  it("does not resurrect managed authority when a refresh withdraws it before a late cleanup reply", async () => {
    const f = fixture();
    const managed = { ...receipt, id: "member-install" };
    f.list.mockResolvedValue(listing([], [{ receipt: managed, ownerName: "Alex" }]));
    await f.manager.refresh();
    const read = deferred<ReturnType<typeof listing>>();
    const write = deferred<PluginInstallReceipt>();
    f.list.mockReturnValueOnce(read.promise);
    f.uninstall.mockReturnValueOnce(write.promise);
    const refresh = f.manager.refresh();
    const removal = f.manager.uninstall(managed);
    read.resolve(listing());
    await refresh;
    const result = { ...managed, status: "cleanup_failed" as const, revision: 3 };
    write.resolve(result);
    await removal;
    expect(f.manager.state()).toMatchObject({
      installations: [],
      installationOwners: {},
      removalUnknownId: null,
    });
    expect(f.manager.canUninstall(result)).toBe(false);
    await f.manager.uninstall(result);
    expect(f.uninstall).toHaveBeenCalledTimes(1);
  });

  it("lets an in-flight authoritative listing withdraw managed access after a cleanup reply arrives first", async () => {
    const f = fixture();
    const managed = { ...receipt, id: "member-install" };
    f.list.mockResolvedValue(listing([], [{ receipt: managed, ownerName: "Alex" }]));
    await f.manager.refresh();
    const read = deferred<ReturnType<typeof listing>>();
    f.list.mockReturnValueOnce(read.promise);
    const refresh = f.manager.refresh();
    const signal = f.list.mock.calls.at(-1)![0];
    f.uninstall.mockResolvedValueOnce({ ...managed, status: "cleanup_failed", revision: 3 });
    await f.manager.uninstall(managed);
    expect(signal.aborted).toBe(false);
    expect(f.manager.state()).toMatchObject({
      installationOwners: { "member-install": "Alex" },
      loading: true,
    });
    read.resolve(listing());
    await refresh;
    expect(f.manager.state()).toMatchObject({
      installations: [],
      installationOwners: {},
      loading: false,
    });
  });

  it("keeps fresh managed attribution and the newest revision across racing cleanup and listing", async () => {
    const f = fixture();
    const managed = { ...receipt, id: "member-install" };
    f.list.mockResolvedValue(listing([], [{ receipt: managed, ownerName: "Alex" }]));
    await f.manager.refresh();
    const read = deferred<ReturnType<typeof listing>>();
    const write = deferred<PluginInstallReceipt>();
    f.list.mockReturnValueOnce(read.promise);
    f.uninstall.mockReturnValueOnce(write.promise);
    const refresh = f.manager.refresh();
    const removal = f.manager.uninstall(managed);
    const latest = { ...managed, status: "removed" as const, revision: 5 };
    read.resolve(listing([], [{ receipt: latest, ownerName: "New name" }]));
    await refresh;
    write.resolve({ ...managed, status: "cleanup_failed", revision: 3 });
    await removal;
    expect(f.manager.state()).toMatchObject({
      installations: [latest],
      installationOwners: { "member-install": "New name" },
    });
    expect(f.manager.canUninstall(latest)).toBe(false);
  });

  it("keeps an owned cleanup outcome when an earlier overlapping listing omits it", async () => {
    const f = fixture();
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    const read = deferred<ReturnType<typeof listing>>();
    const write = deferred<PluginInstallReceipt>();
    f.list.mockReturnValueOnce(read.promise);
    f.uninstall.mockReturnValueOnce(write.promise);
    const refresh = f.manager.refresh();
    const removal = f.manager.uninstall(receipt);
    read.resolve(listing());
    await refresh;
    const result = { ...receipt, status: "cleanup_failed" as const, revision: 3 };
    write.resolve(result);
    await removal;
    expect(f.manager.state()).toMatchObject({
      phase: "terminal",
      receipt: result,
      installations: [result],
      installationOwners: {},
    });
    expect(f.manager.canUninstall(result)).toBe(true);
  });

  it("requires an exact managed readback after a lost removal reply even if a fresh list withdrew access", async () => {
    const f = fixture();
    const managed = { ...receipt, id: "member-install" };
    f.list.mockResolvedValue(listing([], [{ receipt: managed, ownerName: "Alex" }]));
    await f.manager.refresh();
    const read = deferred<ReturnType<typeof listing>>();
    const write = deferred<PluginInstallReceipt>();
    f.list.mockReturnValueOnce(read.promise);
    f.uninstall.mockReturnValueOnce(write.promise);
    const refresh = f.manager.refresh();
    const removal = f.manager.uninstall(managed);
    read.resolve(listing());
    await refresh;
    write.reject(new Error("reply lost"));
    await removal;
    expect(f.manager.state()).toMatchObject({ installations: [], removalUnknownId: managed.id });
    const tombstone = { ...managed, status: "removed" as const, revision: 3 };
    f.list.mockResolvedValue(listing([tombstone]));
    await f.manager.refresh();
    expect(f.manager.state().removalUnknownId).toBe(managed.id);
    f.list.mockResolvedValue(
      listing(
        [],
        [{ receipt: { ...tombstone, clientNonce: "different-nonce" }, ownerName: "Alex" }],
      ),
    );
    await f.manager.refresh();
    expect(f.manager.state().removalUnknownId).toBe(managed.id);
    f.list.mockResolvedValue(listing([], [{ receipt: tombstone, ownerName: "Alex" }]));
    await f.manager.refresh();
    expect(f.manager.state()).toMatchObject({
      removalUnknownId: null,
      installationOwners: { "member-install": "Alex" },
      receipt: null,
    });
  });

  it("retains an acknowledged managed revision while an overlapping listing still grants access", async () => {
    const f = fixture();
    const managed = { ...receipt, id: "member-install" };
    f.list.mockResolvedValue(listing([], [{ receipt: managed, ownerName: "Alex" }]));
    await f.manager.refresh();
    const read = deferred<ReturnType<typeof listing>>();
    f.list.mockReturnValueOnce(read.promise);
    const refresh = f.manager.refresh();
    const acknowledged = { ...managed, status: "cleanup_failed" as const, revision: 3 };
    f.uninstall.mockResolvedValueOnce(acknowledged);
    await f.manager.uninstall(managed);
    read.resolve(listing([], [{ receipt: managed, ownerName: "New name" }]));
    await refresh;
    expect(f.manager.state()).toMatchObject({
      installations: [acknowledged],
      installationOwners: { "member-install": "New name" },
    });
    expect(f.manager.canUninstall(acknowledged)).toBe(true);
  });
});
