import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UpdateRevocationClient } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { manifest, signed, TEST_PUBLIC_KEY } from "../test-fixtures/update-revocations.js";
import type { ElectronAutoUpdater } from "./auto-update.js";
import { DesktopUpdateController, REVOCATION_RECHECK_INTERVAL_MS } from "./auto-update.js";
import { DownloadedUpdateRevocationGate } from "./update-revocation-gate.js";
import { createUpdateRevocationPoc } from "./update-revocations.js";

const NOW = Date.parse("2026-11-01T10:00:00.000Z");
const directories: string[] = [];
const controllers: DesktopUpdateController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(client: UpdateRevocationClient, now = () => NOW) {
  const directory = await mkdtemp(path.join(tmpdir(), "update-controller-test-"));
  directories.push(directory);
  const downloadedFile = path.join(directory, "synthetic.zip");
  await writeFile(downloadedFile, "synthetic downloaded ZIP");
  const digest = createHash("sha512").update("synthetic downloaded ZIP").digest("base64");
  const listeners = new Map<string, (payload: unknown) => void>();
  const updater: ElectronAutoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    allowPrerelease: true,
    disableWebInstaller: false,
    on(event, listener) {
      listeners.set(event, listener);
    },
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
  };
  const gate = new DownloadedUpdateRevocationGate({
    client,
    platform: "darwin",
    arch: "arm64",
    channel: "stable",
    now,
  });
  const controller = new DesktopUpdateController(
    { packaged: true, version: "0.2.1" },
    async () => updater,
    { now, iso: () => new Date(now()).toISOString() },
    undefined,
    gate,
  );
  controllers.push(controller);
  await controller.check(false);
  const downloaded = () =>
    listeners.get("update-downloaded")?.({
      version: "0.3.0",
      downloadedFile,
      files: [{ sha512: digest }],
    });
  return {
    controller,
    gate,
    updater,
    downloaded,
    directory,
    downloadedFile,
    digest,
    emit: (event: string, payload?: unknown) => listeners.get(event)?.(payload),
  };
}

async function protocol(readFeed: () => Promise<ReturnType<typeof signed>>, now = () => NOW) {
  const directory = await mkdtemp(path.join(tmpdir(), "update-controller-serial-test-"));
  directories.push(directory);
  return createUpdateRevocationPoc({
    feedOrigin: "https://updates.example.test",
    publicKeyPem: TEST_PUBLIC_KEY,
    serialFile: path.join(directory, "serial.json"),
    readFeed,
    now,
  });
}

describe("desktop update withdrawal prototype", () => {
  it("disables the unguarded native quit path synchronously before verification", async () => {
    const client: UpdateRevocationClient = { check: vi.fn(() => new Promise(() => undefined)) };
    const f = await fixture(client);
    f.downloaded();
    expect(f.updater.autoInstallOnAppQuit).toBe(false);
    expect(f.controller.state()).toMatchObject({ phase: "ready", revocation: null });
    expect(await f.controller.installOnQuit()).toMatchObject({ phase: "ready" });
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("rechecks a ready download, blocks withdrawal, then installs a newer signed restoration once", async () => {
    let feed = signed(manifest());
    const f = await fixture(await protocol(async () => feed));
    f.downloaded();
    await f.gate.refresh();
    expect(f.controller.state().revocation?.status).toBe("clear");
    feed = signed(
      manifest({
        serial: 2,
        revoked: [
          {
            version: "0.3.0",
            platform: "darwin",
            arch: "arm64",
            sha512: f.digest,
            reason: "Synthetic withdrawal",
          },
        ],
      }),
    );
    await f.controller.check(true);
    expect(f.controller.state()).toMatchObject({
      phase: "ready",
      revocation: { status: "revoked" },
    });
    expect(f.controller.state().message).toContain("Synthetic withdrawal");
    await f.controller.install();
    await f.controller.installOnQuit();
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(await readFile(f.downloadedFile, "utf8")).toBe("synthetic downloaded ZIP");
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);

    feed = signed(manifest({ serial: 3 }));
    await Promise.all([f.controller.install(), f.controller.install()]);
    expect(f.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(f.updater.autoInstallOnAppQuit).toBe(false);
  });

  it("uses fresh cached evidence for the guarded quit simulation without a network request", async () => {
    let reads = 0;
    const f = await fixture(
      await protocol(async () => {
        reads += 1;
        return signed(manifest());
      }),
    );
    f.downloaded();
    await f.gate.refresh();
    const beforeQuit = reads;
    await f.controller.installOnQuit();
    expect(reads).toBe(beforeQuit);
    expect(f.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(f.updater.autoInstallOnAppQuit).toBe(false);
  });

  it("checks on foreground and hourly without requesting another normal update offer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let reads = 0;
    const f = await fixture(
      await protocol(
        async () => {
          reads += 1;
          return signed(manifest());
        },
        () => Date.now(),
      ),
      () => Date.now(),
    );
    f.downloaded();
    await f.gate.refresh();
    expect(reads).toBe(1);
    await f.controller.foreground();
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(REVOCATION_RECHECK_INTERVAL_MS);
    await f.gate.refresh();
    expect(reads).toBe(3);
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    f.controller.dispose();
    await vi.advanceTimersByTimeAsync(REVOCATION_RECHECK_INTERVAL_MS);
    f.downloaded();
    await f.controller.foreground();
    expect(reads).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an offline download and refuses installation after a previously clear check", async () => {
    let online = true;
    const f = await fixture(
      await protocol(async () => {
        if (!online) throw new Error("offline");
        return signed(manifest());
      }),
    );
    f.downloaded();
    await f.gate.refresh();
    online = false;
    await f.controller.install();
    expect(f.controller.state().revocation?.status).toBe("unknown");
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(await readFile(f.downloadedFile, "utf8")).toBe("synthetic downloaded ZIP");
  });

  it("allows a manual replacement check after confirmed withdrawal without discarding a ready package on an empty feed", async () => {
    const client: UpdateRevocationClient = {
      check: async (identity) => ({
        status: "revoked",
        artifact: identity,
        checkedAt: NOW,
        expiresAt: NOW + 60_000,
        reason: "Synthetic withdrawal",
      }),
    };
    const f = await fixture(client);
    f.downloaded();
    await f.gate.refresh();
    vi.mocked(f.updater.checkForUpdates).mockImplementation(async () => {
      f.emit("update-not-available");
    });
    await f.controller.check(true);
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(f.controller.state()).toMatchObject({
      phase: "ready",
      revocation: { status: "revoked" },
    });
    vi.mocked(f.updater.checkForUpdates).mockImplementation(async () => {
      f.emit("update-available", { version: "0.4.0" });
    });
    await f.controller.check(true);
    await f.controller.download();
    expect(f.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(f.controller.state()).toMatchObject({ phase: "downloading", availableVersion: "0.4.0" });
    expect(await readFile(f.downloadedFile, "utf8")).toBe("synthetic downloaded ZIP");
  });

  it("does not retain manual replacement intent after a clear check completes", async () => {
    let status: "clear" | "revoked" = "clear";
    const f = await fixture({
      check: async (identity) => ({
        status,
        artifact: identity,
        checkedAt: NOW,
        expiresAt: NOW + 60_000,
        reason: null,
      }),
    });
    f.downloaded();
    await f.gate.refresh();
    await f.controller.check(true);
    status = "revoked";
    await f.controller.check(false);
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a check after disposal while the updater was loading", async () => {
    const f = await fixture({
      check: async () => {
        throw new Error("unused");
      },
    });
    vi.mocked(f.updater.checkForUpdates).mockClear();
    let release!: (value: ElectronAutoUpdater) => void;
    const loading = new Promise<ElectronAutoUpdater>((resolve) => {
      release = resolve;
    });
    const controller = new DesktopUpdateController(
      { packaged: true, version: "0.2.1" },
      () => loading,
    );
    controllers.push(controller);
    const check = controller.check(false);
    controller.dispose();
    release(f.updater);
    await check;
    expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it.each(["download", "install"])(
    "does not dispatch %s after disposal during an updater await",
    async (operation) => {
      const f = await fixture({
        check: async () => {
          throw new Error("unused");
        },
      });
      // Use the normal construction too: dispose is a lifecycle boundary with or without the PoC.
      const controller = new DesktopUpdateController(
        { packaged: true, version: "0.2.1" },
        async () => f.updater,
      );
      controllers.push(controller);
      await controller.check(false);
      let pending: Promise<unknown>;
      if (operation === "download") {
        f.emit("update-available", { version: "0.3.0" });
        pending = controller.download();
      } else {
        f.emit("update-downloaded", { version: "0.3.0" });
        pending = controller.install();
      }
      controller.dispose();
      await pending;
      expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
      expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    },
  );
});
