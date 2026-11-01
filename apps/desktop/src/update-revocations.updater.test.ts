import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import type { AppAdapter } from "electron-updater/out/AppAdapter.js";
import type { DownloadExecutorTask } from "electron-updater/out/AppUpdater.js";
import type { BaseUpdater as BaseUpdaterType } from "electron-updater/out/BaseUpdater.js";
import type { MacUpdater as MacUpdaterType } from "electron-updater/out/MacUpdater.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const desktopRequire = createRequire(import.meta.url);
const packagePath = desktopRequire.resolve("electron-updater/package.json");
const libraryRequire = createRequire(packagePath);
const roots: string[] = [];
const cleanup: (() => void)[] = [];

/** Load the complete installed module; only the native Electron effect is replaced. */
async function loadUpdater(name: string, nativeUpdater: EventEmitter) {
  const file = path.join(path.dirname(packagePath), "out", `${name}.js`);
  const module = { exports: {} as Record<string, unknown> };
  const requireFromFile = createRequire(file);
  const evaluate = runInNewContext(
    `(function (exports, require, module, __filename, __dirname) {\n${await readFile(file, "utf8")}\n})`,
    { Buffer, URL, process, setImmediate, console },
    { filename: file },
  );
  evaluate(
    module.exports,
    (id: string) => (id === "electron" ? { autoUpdater: nativeUpdater } : requireFromFile(id)),
    module,
    file,
    path.dirname(file),
  );
  return module.exports;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "update-native-boundary-"));
  roots.push(root);
  const sequence: string[] = [];
  const quitHandlers: ((exitCode: number) => void)[] = [];
  const app: AppAdapter = {
    version: "0.1.0",
    name: "Fixture",
    isPackaged: true,
    appUpdateConfigPath: path.join(root, "app-update.yml"),
    userDataPath: root,
    baseCachePath: root,
    whenReady: async () => undefined,
    relaunch() {},
    quit() {
      sequence.push("quit");
      for (const handler of quitHandlers) handler(0);
    },
    onQuit(handler) {
      quitHandlers.push(handler);
    },
  };
  await writeFile(app.appUpdateConfigPath, "updaterCacheDirName: fixture-cache\n");
  const bytes = Buffer.from("synthetic update bytes; never an executable");
  const file = path.join(root, "fixture.zip");
  await writeFile(file, bytes);
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  return { root, sequence, quitHandlers, app, bytes, file, sha512 };
}

async function baseFixture() {
  const f = await fixture();
  const nativeUpdater = new EventEmitter();
  const BaseUpdater = (await loadUpdater("BaseUpdater", nativeUpdater))
    .BaseUpdater as typeof BaseUpdaterType;
  class FixtureUpdater extends BaseUpdater {
    constructor() {
      super(undefined, f.app);
      this.logger = null;
    }
    protected doInstall() {
      f.sequence.push("install");
      return true;
    }
    downloadFixture() {
      const { CancellationToken } = libraryRequire("builder-util-runtime");
      const fileInfo = {
        url: new URL("https://updates.invalid/fixture.exe"),
        info: { url: "fixture.exe", sha512: f.sha512 },
      };
      return this.executeDownload({
        fileExtension: "exe",
        fileInfo,
        downloadUpdateOptions: {
          cancellationToken: new CancellationToken(),
          updateInfoAndProvider: {
            info: { version: "0.2.0", files: [fileInfo.info], releaseDate: "2026-11-01" },
            provider: {},
          },
        } as DownloadExecutorTask["downloadUpdateOptions"],
        task: async (destination) => writeFile(destination, f.bytes),
        done: async () => undefined,
      });
    }
  }
  return { ...f, updater: new FixtureUpdater() };
}

function readUrl(url: string, headers?: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

async function macFixture() {
  const f = await fixture();
  const native = new EventEmitter() as EventEmitter & {
    setFeedURL: ReturnType<typeof vi.fn>;
    checkForUpdates: ReturnType<typeof vi.fn>;
    quitAndInstall: ReturnType<typeof vi.fn>;
  };
  let feed: { url: string; headers: Record<string, string> };
  let transfer: Promise<void> | null = null;
  native.setFeedURL = vi.fn((value) => {
    feed = value;
  });
  native.checkForUpdates = vi.fn(() => {
    transfer = (async () => {
      const manifest = JSON.parse((await readUrl(feed.url, feed.headers)).toString());
      expect(await readUrl(manifest.url)).toEqual(f.bytes);
      native.emit("update-downloaded");
    })();
  });
  native.quitAndInstall = vi.fn(() => f.sequence.push("native-install"));
  const MacUpdater = (await loadUpdater("MacUpdater", native)).MacUpdater as typeof MacUpdaterType;
  const updater = new MacUpdater(undefined, f.app);
  updater.logger = null;
  const effect = updater as unknown as {
    updateDownloaded: (
      info: { url: URL; info: { size: number } },
      event: { version: string; downloadedFile: string },
    ) => Promise<unknown>;
    closeServerIfExists: () => void;
  };
  cleanup.push(() => effect.closeServerIfExists());
  return {
    ...f,
    updater,
    native,
    downloaded: () =>
      effect.updateDownloaded(
        { url: new URL("https://updates.invalid/fixture.zip"), info: { size: f.bytes.length } },
        { version: "0.2.0", downloadedFile: f.file },
      ),
    transferred: async () => {
      expect(transfer).not.toBeNull();
      await transfer;
    },
  };
}

afterEach(async () => {
  for (const close of cleanup.splice(0)) close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("downloaded update native installation boundaries", () => {
  it("blocks quit-handler registration in the synchronous downloaded callback", async () => {
    const f = await baseFixture();
    f.updater.on("update-downloaded", () => {
      f.updater.autoInstallOnAppQuit = false;
    });
    await f.updater.downloadFixture();
    expect(f.quitHandlers).toHaveLength(0);
    f.app.quit();
    expect(f.sequence).toEqual(["quit"]);
  });

  it("rechecks a previously registered quit handler instead of retaining its old permission", async () => {
    const f = await baseFixture();
    await f.updater.downloadFixture();
    expect(f.quitHandlers).toHaveLength(1);
    f.updater.autoInstallOnAppQuit = false;
    f.app.quit();
    expect(f.sequence).toEqual(["quit"]);
  });

  it("dispatches explicit installation before app quit, so a quit-time check is too late", async () => {
    const f = await baseFixture();
    await f.updater.downloadFixture();
    f.updater.quitAndInstall();
    expect(f.sequence).toEqual(["install"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.sequence).toEqual(["install", "quit"]);
  });

  it("prevents initial native staging and starts it only after an explicit installation", async () => {
    const f = await macFixture();
    f.updater.on("update-downloaded", () => {
      f.updater.autoInstallOnAppQuit = false;
    });
    await f.downloaded();
    expect(f.native.checkForUpdates).not.toHaveBeenCalled();
    f.app.quit();
    expect(f.sequence).toEqual(["quit"]);
    f.updater.quitAndInstall();
    await f.transferred();
    expect(f.native.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(f.sequence).toEqual(["quit", "native-install"]);
  });

  it("does not treat a flag changed after native staging as withdrawal of the staged package", async () => {
    const f = await macFixture();
    await f.downloaded();
    await f.transferred();
    expect(f.native.checkForUpdates).toHaveBeenCalledTimes(1);
    f.updater.autoInstallOnAppQuit = false;
    f.updater.quitAndInstall();
    expect(f.native.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(f.sequence).toEqual(["native-install"]);
  });
});
