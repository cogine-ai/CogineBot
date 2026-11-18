import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";
import { build, Platform } from "electron-builder";
import type { ViteDevServer } from "vite";
import { createServer } from "vite";
import { developmentBuildConfiguration } from "../src/development-build.js";

// Native OS associations belong only to this disposable Linux CI session.
test.skip(
  process.platform !== "linux" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    !process.env.COGINEBOT_PROTOCOL_TEST_ROOT,
  "Requires the isolated Linux CI desktop session",
);
test.describe.configure({ mode: "serial", timeout: 120_000 });

const exec = promisify(execFile);
const desktop = path.resolve(import.meta.dirname, "..");
const screenshotRoot = path.join(desktop, "e2e/screenshots");
const title = "CogineBot Console fixture";
const apps = new Set<ElectronApplication>();
const dispatches: ReturnType<typeof spawn>[] = [];
let root: string;
let env: Record<string, string>;
let vite: ViteDevServer;
let origin: string;
let devExecutable: string;
let productionExecutable: string;
let developmentProfile: string;
let mounted = 0;
let documentRequests = 0;
let failureMode: "ready" | "failed" | "hold" = "ready";
let releaseFailedProbe: (() => void) | undefined;

async function nativeWindows() {
  const { stdout } = await exec("wmctrl", ["-lp"]);
  return stdout
    .split("\n")
    .map((line) => /^(\S+)\s+\S+\s+(\d+)\s+\S+\s+(.*)$/.exec(line))
    .filter((match) => match?.[3] === title)
    .map((match) => ({ id: match![1]!, pid: Number(match![2]) }));
}

function dispatch(url: string) {
  const child = spawn("xdg-open", [url], { env, stdio: ["ignore", "pipe", "pipe"] });
  dispatches.push(child);
  let error = "";
  child.on("error", (value) => {
    error += value.message;
  });
  child.stderr?.on("data", (chunk) => {
    error = (error + chunk).slice(-16_384);
  });
  child.stdout?.resume();
  return async () => {
    await expect
      .poll(() => ({ code: child.exitCode, error: child.exitCode === 0 ? "" : error }))
      .toEqual({ code: 0, error: "" });
  };
}

async function launch(executablePath: string) {
  const app = await electron.launch({
    executablePath,
    env,
    args: ["--no-sandbox"],
  });
  apps.add(app);
  return app;
}

async function consoleWindow(app: ElectronApplication): Promise<Page> {
  let window: Page | undefined;
  await expect
    .poll(async () => {
      for (const page of app.windows()) {
        if (page.isClosed() || !page.url().startsWith(`${origin}/`)) continue;
        const native = await app.browserWindow(page);
        if (
          (await native.evaluate((win) => win.isVisible())) &&
          (await page.getByRole("heading", { name: "Console fixture" }).isVisible())
        ) {
          window = page;
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  await expect(window!.getByRole("heading", { name: "Console fixture" })).toBeVisible();
  return window!;
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

async function startFixtureServer(port = 0) {
  const server = await createServer({
    configFile: false,
    root: path.join(root, "vite"),
    server: { host: "127.0.0.1", port, strictPort: true },
    plugins: [
      {
        name: "native-fixture-receipts",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url === "/") {
              documentRequests += 1;
              if (failureMode !== "ready") {
                const fail = () => {
                  response.setHeader("content-type", "text/html");
                  response.end(
                    '<!doctype html><html><head><title>Development fixture unavailable</title></head><body><main data-rakazo-app-state="failed">Development fixture unavailable</main></body></html>',
                  );
                };
                if (failureMode === "hold" && request.headers["sec-fetch-dest"] !== "document")
                  releaseFailedProbe = fail;
                else fail();
                return;
              }
            }
            if (request.url === "/rpc/health" && request.method === "POST") {
              response.setHeader("content-type", "application/json");
              response.end(JSON.stringify({ json: { ok: true, version: "0.2.2" } }));
              return;
            }
            if (request.url !== "/mounted") return next();
            mounted += 1;
            response.end("ok");
          });
        },
      },
    ],
  });
  await server.listen();
  return server;
}

test.beforeAll(async () => {
  test.setTimeout(600_000);
  root = process.env.COGINEBOT_PROTOCOL_TEST_ROOT!;
  // Set before dbus-run-session/Openbox, so OS-launched processes use the same
  // profile and associations as direct Playwright launches.
  expect(process.env.XDG_CONFIG_HOME).toBe(path.join(root, "config"));
  expect(process.env.XDG_DATA_HOME).toBe(path.join(root, "data"));
  expect(process.env.RAKAZO_PERFORMANCE_USER_DATA).toBe(path.join(root, "profiles"));
  await mkdir(root, { recursive: true });
  env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    RAKAZO_DISABLE_AUTO_UPDATE: "1",
    APPIMAGE_EXTRACT_AND_RUN: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.RAKAZO_WEB_URL;
  delete env.RAKAZO_FORCE_SETUP;
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
    // Session-migration probes have no desktop preload and are not Console mounts.
    if (window.rakazoDesktop) fetch('/mounted', { method: 'POST' });
    if (import.meta.hot) import.meta.hot.accept('./message.js', module => {
      document.querySelector('#version').textContent = module.text;
    });
    </script></body></html>`,
  );
  await writeFile(path.join(fixture, "message.js"), 'export const text = "Initial module";');
  vite = await startFixtureServer();
  origin = vite.resolvedUrls!.local[0]!.replace(/\/$/, "");

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
    for (const child of dispatches) if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test.afterEach(async () => {
  const info = test.info();
  if (info.status === info.expectedStatus) return;
  const { stdout: windows } = await exec("wmctrl", ["-lp"]);
  const { stdout: processes } = await exec("ps", ["-eo", "pid,ppid,args"]);
  await info.attach("native-dispatch-state", {
    body: JSON.stringify(
      {
        windows,
        processes: processes.split("\n").filter((line) => /coginebot|AppImage|xdg-open/.test(line)),
        children: dispatches.map((child) => ({
          pid: child.pid,
          exit: child.exitCode,
          signal: child.signalCode,
        })),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

test("a system link restores first-run setup without bypassing it", async () => {
  const production = await electron.launch({
    executablePath: productionExecutable,
    env: { ...env, RAKAZO_WEB_URL: "", RAKAZO_FORCE_SETUP: "1" },
    args: ["--no-sandbox"],
  });
  apps.add(production);
  const setup = await production.firstWindow();
  await expect(setup.getByRole("heading", { name: "Welcome to CogineBot" })).toBeVisible();
  await production.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
  const delivered = dispatch("coginebot://bot/");
  await expect
    .poll(() =>
      production.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
    )
    .toBe(true);
  await delivered();
  await expect(setup.getByRole("heading", { name: "Welcome to CogineBot" })).toBeVisible();
  expect(mounted).toBe(0);
  await setup.screenshot({ path: path.join(screenshotRoot, "deep-links-setup-restored.png") });
  await setup.getByRole("radio", { name: /Existing instance/ }).check();
  await setup.locator("#server-url").fill(origin);
  await setup.getByRole("button", { name: "Continue" }).click();
  const connected = await consoleWindow(production);
  await expect(connected.getByRole("heading", { name: "Console fixture" })).toBeVisible();
  await expect
    .poll(async () =>
      JSON.parse(
        await readFile(path.join(env.RAKAZO_PERFORMANCE_USER_DATA!, "setup.json"), "utf8"),
      ),
    )
    .toMatchObject({ mode: "existing", serverUrl: origin });
  await close(production);
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
  developmentProfile = developmentIdentity.profile;
  await writeFile(path.join(developmentProfile, "preserved-data.txt"), "Keep development data");
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
    await expect
      .poll(() =>
        development.evaluate(({ BrowserWindow }, action) => {
          const win = BrowserWindow.getAllWindows()[0]!;
          return action === "minimize" ? win.isMinimized() : !win.isVisible();
        }, action),
      )
      .toBe(true);
    const delivered = dispatch("coginebot-dev://bot/");
    await expect
      .poll(() =>
        development.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]!;
          return win.isVisible() && !win.isMinimized();
        }),
      )
      .toBe(true);
    await delivered();
    await expect(window.getByLabel("Draft")).toHaveValue("Development draft");
    await expect(window.getByTestId("run")).toHaveText("Synthetic Run is active");
  }
  const repeats = Array.from({ length: 4 }, () => dispatch("coginebot://bot/"));
  await Promise.all(repeats.map((complete) => complete()));
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
  await delivered();
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
    const requestsBefore = documentRequests;
    const delivered = dispatch(`${scheme}://bot/`);
    // The first document probe establishes that the cold process owns its lock.
    await expect.poll(() => documentRequests).toBeGreaterThan(requestsBefore);
    const repeats = Array.from({ length: 3 }, () => dispatch(`${scheme}://bot/`));
    await Promise.all(repeats.map((complete) => complete()));
    await expect.poll(async () => (await nativeWindows()).length).toBe(1);
    await expect.poll(() => mounted).toBe(before + 1);
    await exec("scrot", [path.join(screenshotRoot, `deep-links-${scheme}-cold.png`)]);
    await closeNativeWindow();
    await delivered();
  }
});

test("a rebound workspace owns only its development association", async () => {
  test.setTimeout(300_000);
  const workspace = path.join(root, "second-workspace");
  await mkdir(workspace);
  const original = await launch(devExecutable);
  const originalWindow = await consoleWindow(original);
  await originalWindow.getByLabel("Draft").fill("Keep the first workspace draft");
  let reboundRequests = 0;
  const reboundVite = await createServer({
    configFile: false,
    root: path.join(root, "vite"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "rebound-workspace-receipt",
        configureServer(server) {
          server.middlewares.use((request, _response, next) => {
            if (request.url === "/") reboundRequests += 1;
            next();
          });
        },
      },
    ],
  });
  await reboundVite.listen();
  const reboundOrigin = reboundVite.resolvedUrls!.local[0]!.replace(/\/$/, "");
  const output = path.join(desktop, "out-dev/rebound");
  await mkdir(output, { recursive: true });
  const configFile = path.join(output, "build-config.json");
  const { build: base } = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"));
  await writeFile(
    configFile,
    JSON.stringify({
      ...developmentBuildConfiguration(
        { workspaceRoot: workspace, viteUrl: reboundOrigin },
        output,
        base,
      ),
      afterPack: path.join(desktop, "scripts/development-after-pack.mjs"),
    }),
  );
  await build({
    projectDir: desktop,
    targets: Platform.LINUX.createTarget(["dir"]),
    publish: "never",
    config: configFile,
  });
  const { executable } = JSON.parse(
    await readFile(path.join(output, "build-receipt.json"), "utf8"),
  );
  await exec(executable, ["--no-sandbox", "--coginebot-register-protocol"], { env });
  const entry = path.join(env.XDG_DATA_HOME!, "applications/coginebot-dev.desktop");
  const rebound = await readFile(entry, "utf8");
  expect(rebound).toContain(executable);
  const delivered = dispatch("coginebot-dev://bot/");
  await expect.poll(async () => (await nativeWindows()).length).toBe(2);
  await expect.poll(() => reboundRequests).toBeGreaterThan(0);
  await expect(originalWindow.getByLabel("Draft")).toHaveValue("Keep the first workspace draft");
  expect(originalWindow.url()).toBe(`${origin}/`);
  expect(await readFile(entry, "utf8")).toBe(rebound);
  await close(original);
  await exec(process.execPath, ["scripts/development.mjs", "unregister"], { cwd: desktop, env });
  expect(await readFile(entry, "utf8")).toBe(rebound);
  await expect.poll(async () => (await nativeWindows()).length).toBe(1);
  await closeNativeWindow();
  await delivered();
  await exec(executable, ["--no-sandbox", "--coginebot-unregister-protocol"], { env });
  await reboundVite.close();
  await expect(readFile(entry)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(developmentProfile, "preserved-data.txt"), "utf8")).toBe(
    "Keep development data",
  );
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
  vite = await startFixtureServer(Number(new URL(origin).port));
  await dismissDialog("CogineBot Dev", "deep-links-development-unavailable.png");
  const window = await consoleWindow(development);
  await expect(window.getByRole("heading", { name: "Welcome to CogineBot" })).toHaveCount(0);
  await expect(window.locator("#version")).toHaveText("Updated by Vite HMR");
  await window.screenshot({
    path: path.join(screenshotRoot, "deep-links-development-retried.png"),
  });
  await close(development);
});

test("closing the old failed window during Retry keeps recovery alive", async () => {
  failureMode = "failed";
  const development = await launch(devExecutable);
  await nativeDialog("CogineBot Dev");
  const previous = await development.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((win) => win.getBounds().width > 1)!.id,
  );
  failureMode = "hold";
  await dismissDialog("CogineBot Dev", "deep-links-development-first-failure.png");
  await expect.poll(() => releaseFailedProbe !== undefined).toBe(true);
  await development.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.close(),
    previous,
  );
  releaseFailedProbe!();
  await nativeDialog("CogineBot Dev");
  expect(
    await development.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((win) => win.getBounds().width > 1).length,
    ),
  ).toBe(1);
  failureMode = "ready";
  await dismissDialog("CogineBot Dev", "deep-links-development-retry-after-close.png");
  await consoleWindow(development);
  await close(development);
});
