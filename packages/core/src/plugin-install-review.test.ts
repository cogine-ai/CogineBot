import type {
  PluginInstallInput,
  PluginInstallReceipt,
  PluginPreview,
  PluginUninstallInput,
} from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createPluginInstallReview } from "./plugin-install-review.js";

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

function fixture(makeNonce = () => "nonce-one") {
  const transport = {
    preview: vi.fn(async (_input: { source: string }, _signal: AbortSignal) => preview),
    install: vi.fn(
      async (input: PluginInstallInput, _signal: AbortSignal): Promise<PluginInstallReceipt> => ({
        ...receipt,
        clientNonce: input.clientNonce,
      }),
    ),
    list: vi.fn(async (_signal: AbortSignal) => [] as PluginInstallReceipt[]),
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
    f.list.mockResolvedValue([{ ...receipt, clientNonce: "old-nonce", status: "removed" }]);
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    await f.manager.check();
    expect(f.manager.state()).toMatchObject({
      phase: "unknown",
      retryChecked: true,
      receipt: null,
    });
    f.list.mockResolvedValue([{ ...receipt, status: "removed", revision: 3 }]);
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
    f.list.mockResolvedValue([{ ...receipt, sourceSha: "c".repeat(40) }]);
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
    let resolve!: (value: PluginInstallReceipt[]) => void;
    f.list.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const old = f.manager.refresh();
    await f.manager.preview("https://github.com/example/plugin");
    await f.manager.install();
    resolve([]);
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
    f.list.mockResolvedValue([receipt]);
    await f.manager.refresh();
    f.uninstall.mockRejectedValueOnce(new Error("reply lost"));
    await f.manager.uninstall(receipt);
    expect(f.manager.state().removalUnknownId).toBe(receipt.id);
    await f.manager.uninstall(receipt);
    expect(f.uninstall).toHaveBeenCalledTimes(1);
    const latest = { ...receipt, status: "cleanup_failed" as const, revision: 4 };
    f.list.mockResolvedValue([latest]);
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
    f.list.mockResolvedValue([pending]);
    await f.manager.check();
    await f.manager.install();
    expect(f.install).toHaveBeenCalledTimes(1);
    f.list.mockResolvedValue([{ ...pending, status: "failed", revision: 2 }]);
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
    f.list.mockResolvedValue([{ ...receipt, status: "removed", revision: 3 }]);
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
    f.list.mockResolvedValue([receipt, other]);
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
    f.list.mockResolvedValue([pending]);
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
    f.list.mockResolvedValue([pending]);
    await f.manager.refresh();
    expect(f.manager.state()).toMatchObject({ phase: "unknown", receipt: null });
    expect(f.manager.canUninstall(pending)).toBe(false);
    await f.manager.uninstall(pending);
    expect(f.uninstall).not.toHaveBeenCalled();
  });

  it("requires the exact persisted identity, binding, revision and status for cleanup", async () => {
    const f = fixture();
    f.list.mockResolvedValue([receipt]);
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
    f.list.mockResolvedValue([{ ...receipt, status: "removed", revision: 3 }]);
    await f.manager.refresh();
    expect(f.manager.canUninstall({ ...receipt, status: "removed", revision: 3 })).toBe(false);
  });

  it("does not dispatch cleanup while a write is busy or duplicate its own cleanup", async () => {
    const f = fixture();
    f.list.mockResolvedValue([receipt]);
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
    f.list.mockResolvedValue([other]);
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
});
