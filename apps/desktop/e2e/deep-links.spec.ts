import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";
import { build, Platform } from "electron-builder";
import type { ViteDevServer } from "vite";
import { createServer } from "vite";
import { developmentBuildConfiguration } from "../src/development-build.js";

// Native OS associations belong only to this disposable Linux CI session.
test.skip(process.platform !== "linux" || !process.env.CI, "Requires the Linux CI virtual display");
test.describe.configure({ mode: "serial", timeout: 120_000 });

const exec = promisify(execFile);
const desktop = path.resolve(import.meta.dirname, "..");
const screenshotRoot = path.join(desktop, "e2e/screenshots");
const title = "CogineBot Console fixture";
const apps = new Set<ElectronApplication>();
let root: string;
let env: NodeJS.ProcessEnv;
let vite: ViteDevServer;
let origin: string;
let devExecutable: string;
let productionExecutable: string;
let mounted = 0;

async function nativeWindows() {
  const { stdout } = await exec("wmctrl", ["-lp"]);
  return stdout
    .split("\n")
    .map((line) => /^(\S+)\s+\S+\s+(\d+)\s+\S+\s+(.*)$/.exec(line))
    .filter((match) => match?.[3] === title)
    .map((match) => ({ id: match![1]!, pid: Number(match![2]) }));
}

function dispatch(url: string) {
  const child = spawn("xdg-open", [url], { env, stdio: "ignore" });
  // Keep errors observable; successful dispatch is established by the native window.
  let error: Error | undefined;
  child.once("error", (value) => {
    error = value;
  });
  return () => {
    if (error) throw error;
  };
}

async function launch(executablePath: string) {
  const app = await electron.launch({
    executablePath,
    env: { ...env, RAKAZO_WEB_URL: origin },
    args: ["--no-sandbox"],
  });
  apps.add(app);
  return app;
}

async function consoleWindow(app: ElectronApplication): Promise<Page> {
  const window = await app.firstWindow();
  await expect(window.getByRole("heading", { name: "Console fixture" })).toBeVisible();
  return window;
}

async function close(app: ElectronApplication) {
  await app.close();
  apps.delete(app);
}

async function closeNativeWindow() {
  for (const window of await nativeWindows()) await exec("wmctrl", ["-ic", window.id]);
  await expect.poll(async () => (await nativeWindows()).length).toBe(0);
}

async function nativeDialog(title: string) {
  let id = "";
  await expect
    .poll(async () => {
      const { stdout } = await exec("wmctrl", ["-l"]);
      id =
        stdout
          .split("\n")
          .find((line) => line.endsWith(` ${title}`))
          ?.split(/\s+/)[0] ?? "";
      return id;
    })
    .not.toBe("");
  return id;
}

async function dismissDialog(title: string, screenshot: string) {
  const id = await nativeDialog(title);
  await exec("scrot", [path.join(screenshotRoot, screenshot)]);
  await exec("xdotool", ["windowactivate", "--sync", id]);
  await exec("xdotool", ["key", "--clearmodifiers", "Return"]);
}

test.beforeAll(async () => {
  test.setTimeout(600_000);
  root = await mkdtemp(path.join(tmpdir(), "coginebot-protocol-ci-"));
  env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CURRENT_DESKTOP: "openbox",
    RAKAZO_PERFORMANCE_USER_DATA: path.join(root, "profiles"),
    RAKAZO_DISABLE_AUTO_UPDATE: "1",
    APPIMAGE_EXTRACT_AND_RUN: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  await mkdir(screenshotRoot, { recursive: true });
  const fixture = path.join(root, "vite");
  await mkdir(fixture);
  await writeFile(
    path.join(fixture, "index.html"),
    `<!doctype html><html lang="en"><head><title>${title}</title></head><body>
    <main><h1>Console fixture</h1><label>Draft <textarea aria-label="Draft"></textarea></label>
    <p data-testid="run">Synthetic Run is active</p><p id="version"></p></main>
    <script type="module">
    import { text } from './message.js';
    document.querySelector('#version').textContent = text;
    fetch('/mounted', { method: 'POST' });
    if (import.meta.hot) import.meta.hot.accept('./message.js', module => {
      document.querySelector('#version').textContent = module.text;
    });
    </script></body></html>`,
  );
  await writeFile(path.join(fixture, "message.js"), 'export const text = "Initial module";');
  vite = await createServer({
    configFile: false,
    root: fixture,
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "native-mount-receipt",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/mounted") return next();
            mounted += 1;
            response.end("ok");
          });
        },
      },
    ],
  });
  await vite.listen();
  origin = vite.resolvedUrls!.local[0]!.replace(/\/$/, "");
  env.RAKAZO_WEB_URL = origin;

  // This invokes the actual registration command, packaged development helper and xdg-mime.
  await exec(process.execPath, ["scripts/development.mjs", "register", "--vite-url", origin], {
    cwd: desktop,
    env,
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const launcher = JSON.parse(await readFile(path.join(desktop, "out-dev/launch.json"), "utf8"));
  devExecutable = launcher.executable;
  const artifacts = await build({
    projectDir: desktop,
    targets: Platform.LINUX.createTarget(["AppImage"]),
    publish: "never",
    config: { directories: { output: path.join(desktop, "out/protocol-ci") } },
  });
  productionExecutable = artifacts.find((file) => file.endsWith(".AppImage"))!;
  expect(productionExecutable).toBeTruthy();
});

test.afterAll(async () => {
  for (const app of apps) await app.close().catch(() => undefined);
  if (root) {
    await closeNativeWindow();
    await exec(process.execPath, ["scripts/development.mjs", "unregister"], {
      cwd: desktop,
      env,
      timeout: 30_000,
    });
    await vite?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("installed AppImage and development launcher coexist and OS links restore without reloading", async () => {
  const production = await launch(productionExecutable);
  const productionWindow = await consoleWindow(production);
  const development = await launch(devExecutable);
  const window = await consoleWindow(development);
  await productionWindow.getByLabel("Draft").fill("Installed draft");
  await window.getByLabel("Draft").fill("Development draft");
  const identity = (app: ElectronApplication) =>
    app.evaluate(({ app, BrowserWindow }) => ({
      packaged: app.isPackaged,
      name: app.getName(),
      profile: app.getPath("userData"),
      session: app.getPath("sessionData"),
      window: BrowserWindow.getAllWindows()[0]!.id,
    }));
  const installedIdentity = await identity(production);
  const developmentIdentity = await identity(development);
  expect(installedIdentity.packaged && developmentIdentity.packaged).toBe(true);
  expect(developmentIdentity.name).toBe("CogineBot Dev");
  expect(developmentIdentity.profile).not.toBe(installedIdentity.profile);
  expect(developmentIdentity.session).not.toBe(installedIdentity.session);
  await productionWindow.evaluate(() => localStorage.setItem("isolation", "installed"));
  expect(await window.evaluate(() => localStorage.getItem("isolation"))).toBeNull();
  const setCookie = (app: ElectronApplication, value: string) =>
    app.evaluate(async ({ BrowserWindow }, value) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      await contents.session.cookies.set({
        url: contents.getURL(),
        name: "session-fixture",
        value,
      });
    }, value);
  await setCookie(production, "installed");
  expect(
    await development.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.session.cookies.get({
        name: "session-fixture",
      }),
    ),
  ).toEqual([]);
  const before = mounted;
  for (const action of ["minimize", "hide"] as const) {
    await development.evaluate(({ BrowserWindow }, action) => {
      BrowserWindow.getAllWindows()[0]![action]();
    }, action);
    const delivered = dispatch("coginebot-dev://bot/");
    await expect
      .poll(() =>
        development.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]!;
          return win.isVisible() && !win.isMinimized();
        }),
      )
      .toBe(true);
    delivered();
    await expect(window.getByLabel("Draft")).toHaveValue("Development draft");
    await expect(window.getByTestId("run")).toHaveText("Synthetic Run is active");
  }
  for (let index = 0; index < 4; index += 1) dispatch("coginebot://bot/");
  await expect(productionWindow.getByLabel("Draft")).toHaveValue("Installed draft");
  expect(await identity(production)).toEqual(installedIdentity);
  expect(await identity(development)).toEqual(developmentIdentity);
  expect(mounted).toBe(before);

  await writeFile(path.join(root, "vite/message.js"), 'export const text = "Updated by Vite HMR";');
  await expect(window.locator("#version")).toHaveText("Updated by Vite HMR");
  await expect(window.getByLabel("Draft")).toHaveValue("Development draft");
  await window.screenshot({
    path: path.join(screenshotRoot, "deep-links-development-restored.png"),
  });
  const delivered = dispatch("coginebot-dev://bot/?target=https://example.test");
  await dismissDialog("Invalid CogineBot link", "deep-links-invalid-entry.png");
  delivered();
  await expect(window.getByLabel("Draft")).toHaveValue("Development draft");
  expect(window.url()).toBe(`${origin}/`);
  await productionWindow.screenshot({
    path: path.join(screenshotRoot, "deep-links-installed-restored.png"),
  });
  const handler = await exec("xdg-mime", ["query", "default", "x-scheme-handler/coginebot"], {
    env,
  });
  expect(handler.stdout.trim()).toBe("coginebot.desktop");
  const entry = await readFile(
    path.join(env.XDG_DATA_HOME!, "applications/coginebot.desktop"),
    "utf8",
  );
  expect(entry).toContain(productionExecutable);
  await close(development);
  await close(production);
});

test("registered OS dispatch cold-starts each distribution once, including repeated requests", async () => {
  for (const scheme of ["coginebot", "coginebot-dev"]) {
    const before = mounted;
    const delivered = dispatch(`${scheme}://bot/`);
    for (let index = 0; index < 3; index += 1) dispatch(`${scheme}://bot/`);
    await expect.poll(async () => (await nativeWindows()).length).toBe(1);
    await expect.poll(() => mounted).toBe(before + 1);
    delivered();
    await exec("scrot", [path.join(screenshotRoot, `deep-links-${scheme}-cold.png`)]);
    await closeNativeWindow();
  }
});

test("a rebound workspace owns only its development association", async () => {
  test.setTimeout(300_000);
  const workspace = path.join(root, "second-workspace");
  await mkdir(workspace);
  const output = path.join(desktop, "out-dev/rebound");
  let executable = "";
  await build({
    projectDir: desktop,
    targets: Platform.LINUX.createTarget(["dir"]),
    publish: "never",
    config: {
      ...developmentBuildConfiguration({ workspaceRoot: workspace, viteUrl: origin }, output),
      afterPack: async ({ appOutDir }) => {
        executable = path.join(appOutDir, "coginebot-dev");
      },
    },
  });
  await exec(executable, ["--no-sandbox", "--coginebot-register-protocol"], { env });
  const entry = path.join(env.XDG_DATA_HOME!, "applications/coginebot-dev.desktop");
  const rebound = await readFile(entry, "utf8");
  expect(rebound).toContain(executable);
  await exec(process.execPath, ["scripts/development.mjs", "unregister"], { cwd: desktop, env });
  expect(await readFile(entry, "utf8")).toBe(rebound);
  const delivered = dispatch("coginebot-dev://bot/");
  await expect.poll(async () => (await nativeWindows()).length).toBe(1);
  delivered();
  await closeNativeWindow();
  await exec(executable, ["--no-sandbox", "--coginebot-unregister-protocol"], { env });
  await expect(readFile(entry)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    (
      await exec("xdg-mime", ["query", "default", "x-scheme-handler/coginebot"], { env })
    ).stdout.trim(),
  ).toBe("coginebot.desktop");
  await exec(devExecutable, ["--no-sandbox", "--coginebot-register-protocol"], { env });
});

test("an unavailable Vite server offers native Retry and recovers without production setup", async () => {
  await vite.close();
  const development = await launch(devExecutable);
  await nativeDialog("CogineBot Dev");
  // Restore the same address before accepting the native dialog's Retry button.
  vite = await createServer({
    configFile: false,
    root: path.join(root, "vite"),
    server: { host: "127.0.0.1", port: Number(new URL(origin).port), strictPort: true },
  });
  await vite.listen();
  await dismissDialog("CogineBot Dev", "deep-links-development-unavailable.png");
  const window = await consoleWindow(development);
  await expect(window.getByRole("heading", { name: "Welcome to CogineBot" })).toHaveCount(0);
  await expect(window.locator("#version")).toHaveText("Updated by Vite HMR");
  await window.screenshot({
    path: path.join(screenshotRoot, "deep-links-development-retried.png"),
  });
  await close(development);
});
