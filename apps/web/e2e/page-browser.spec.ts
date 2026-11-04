import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, expect, test } from "@playwright/test";

const execute = promisify(execFile);
const helper = path.resolve(
  import.meta.dirname,
  "../../../infra/sandboxes/computer/rakazo-page-browser",
);

test("live page helper preserves identity, masks passwords, and reports partial actions", async () => {
  test.setTimeout(180_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "page-browser-test-"));
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Fixture</title><p>Readable article content</p>
      <label>Name <input id="name"></label><input aria-label="Password" type="password" value="fake-test-password">
      <button id="save" onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">Save</button>
      <button onmousedown="alert('Synthetic dialog')">Dialog action</button>
      <label><input type="checkbox">Agree</label><button disabled>Disabled</button>
      <script>window.__rakazoPageBrowser={snapshot:()=>({title:'spoofed'})};
        window.mouseEvents=[];
        for (const type of ['pointerdown','mousedown','pointerup','mouseup','click'])
          document.getElementById('save').addEventListener(type,event=>window.mouseEvents.push([type,event.isTrusted]));
      </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture server");
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      args: ["--remote-debugging-port=0"],
    });
    let port = "";
    await expect(async () => {
      port =
        (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0] ?? "";
      expect(port).toMatch(/^\d+$/);
    }).toPass({ timeout: 5_000 });
    async function command(name: string, args: Record<string, unknown> = {}) {
      const { stdout } = await execute("python3", [helper, name, JSON.stringify(args)], {
        env: { ...process.env, RAKAZO_CDP_PORT: port },
        timeout: 30_000,
      });
      return JSON.parse(stdout);
    }
    const page = context.pages()[0]!;
    await page.goto(`http://127.0.0.1:${address.port}`);
    const snapshot = await command("snapshot");
    expect(snapshot.ok).toBe(true);
    expect(snapshot.title).toBe("Fixture");
    expect(snapshot.tree).toContain("Readable article content");
    expect(JSON.stringify(snapshot)).not.toContain("fake-test-password");
    const ref = (snapshot: { elements: { name: string; ref: string }[] }, name: string) =>
      snapshot.elements.find((element) => element.name === name)!.ref;
    const result = await command("act", {
      actions: [
        { kind: "fill", ref: ref(snapshot, "Name"), text: "Example" },
        { kind: "click", ref: ref(snapshot, "Save") },
        {
          kind: "click",
          ref: `r2.${Buffer.from(JSON.stringify(["missing-tab", "missing-frame", "missing-loader", "0".repeat(32)])).toString("base64url")}`,
        },
      ],
    });
    expect(result).toMatchObject({ ok: false, completed: 2, uncertain: false });
    await expect(page.locator("#name")).toHaveValue("Example");
    await expect(page.locator("#save")).toHaveAttribute("data-clicks", "1");
    expect(
      await page.evaluate(() => (window as unknown as { mouseEvents: unknown[] }).mouseEvents),
    ).toEqual([
      ["pointerdown", true],
      ["mousedown", true],
      ["pointerup", true],
      ["mouseup", true],
      ["click", true],
    ]);

    const beforeSameNameReplacement = await command("snapshot");
    const replacedRef = ref(beforeSameNameReplacement, "Save");
    await page.locator("#save").evaluate((el) => {
      el.outerHTML =
        '<button id="save" data-clicks="0" onclick="this.dataset.clicks=Number(this.dataset.clicks)+1">Save</button>';
    });
    expect(await command("act", { actions: [{ kind: "click", ref: replacedRef }] })).toMatchObject({
      ok: false,
      completed: 0,
    });
    await expect(page.locator("#save")).toHaveAttribute("data-clicks", "0");
    const sameNameReplacement = await command("snapshot");
    const replacementRef = ref(sameNameReplacement, "Save");
    expect(replacementRef).not.toBe(replacedRef);
    expect(
      await command("act", { actions: [{ kind: "click", ref: replacementRef }] }),
    ).toMatchObject({ ok: true, completed: 1 });
    await expect(page.locator("#save")).toHaveAttribute("data-clicks", "1");

    // A page that replaces a pressed control must not receive a guessed cleanup click.
    await page.evaluate(() => {
      (window as unknown as { released: number }).released = 0;
      addEventListener("mouseup", () => {
        (window as unknown as { released: number }).released++;
      });
      document.getElementById("save")!.addEventListener(
        "mousedown",
        (event) => {
          (event.currentTarget as HTMLElement).outerHTML =
            '<button id="save" data-clicks="0" onclick="this.dataset.clicks=Number(this.dataset.clicks)+1">Save</button>';
        },
        { once: true },
      );
    });
    const pressed = await command("snapshot");
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(pressed, "Save") }] }),
    ).toMatchObject({ ok: false, completed: 0, uncertain: true });
    expect(await page.evaluate(() => (window as unknown as { released: number }).released)).toBe(0);
    const pending = await command("snapshot");
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(pending, "Save") }] }),
    ).toMatchObject({ ok: false, completed: 0 });
    await expect(page.locator("#save")).toHaveAttribute("data-clicks", "0");
    await page.evaluate(() =>
      dispatchEvent(new MouseEvent("mouseup", { bubbles: true, buttons: 0 })),
    );
    const afterSyntheticRelease = await command("snapshot");
    expect(
      await command("act", {
        actions: [{ kind: "click", ref: ref(afterSyntheticRelease, "Save") }],
      }),
    ).toMatchObject({ ok: false, completed: 0 });
    await page.mouse.up();
    const released = await command("snapshot");
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(released, "Save") }] }),
    ).toMatchObject({ ok: true, completed: 1 });
    await expect(page.locator("#save")).toHaveAttribute("data-clicks", "1");

    const beforeDialog = await command("snapshot");
    // Keeping a listener installed prevents Playwright's default dialog dismissal.
    const [dialog, interruptedDialog] = await Promise.all([
      page.waitForEvent("dialog"),
      command("act", { actions: [{ kind: "click", ref: ref(beforeDialog, "Dialog action") }] }),
    ]);
    expect(interruptedDialog).toMatchObject({ ok: false, completed: 0, uncertain: true });
    expect(dialog.message()).toBe("Synthetic dialog");
    await dialog.dismiss();
    await page.mouse.up();
    const afterDialog = await command("snapshot");
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(afterDialog, "Save") }] }),
    ).toMatchObject({ ok: true, completed: 1 });

    const stale = await command("snapshot");
    await page.locator("#save").evaluate((el) => {
      el.outerHTML = '<button id="save">Replacement</button>';
    });
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(stale, "Save") }] }),
    ).toMatchObject({ ok: false, completed: 0 });
    const refreshed = await command("snapshot");
    expect(ref(refreshed, "Replacement")).not.toBe(ref(stale, "Save"));
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(refreshed, "Agree") }] }),
    ).toMatchObject({ ok: true, completed: 1 });
    await expect(page.getByRole("checkbox")).toBeChecked();
    expect(
      await command("navigate", { url: `http://127.0.0.1:${address.port}/next` }),
    ).toMatchObject({ ok: true, title: "Fixture" });
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(refreshed, "Replacement") }] }),
    ).toMatchObject({ ok: false, completed: 0 });
    expect(await command("navigate", { url: "file:///tmp/fixture" })).toMatchObject({ ok: false });
    await page.route("http://insecure.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>Insecure fixture</title><button>HTTP action</button>",
      }),
    );
    await page.goto("http://insecure.test/");
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    expect(await command("snapshot")).toMatchObject({ ok: true, title: "Insecure fixture" });
    // Saved passwords go only into password fields. A site can still reveal them normally.
    await page.route("https://login.example.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<title>Sign in</title><input aria-label="Email">
          <input id="password" aria-label="Password" type="password">
          <button onclick="const field = document.getElementById('password'); field.type = 'text';
            requestAnimationFrame(() => { window.drawn = field.value; })">Show</button>`,
      }),
    );
    await page.goto("https://login.example.test/");
    const login = {
      text: "fake-test-password",
      origin: "https://login.example.test",
      field: "password",
    };
    const signIn = await command("snapshot");
    const refused = await command("act", {
      actions: [{ kind: "fill", ref: ref(signIn, "Email"), ...login }],
    });
    expect(refused).toMatchObject({
      ok: false,
      completed: 0,
      uncertain: false,
      error: expect.stringMatching(/field type/),
    });
    await expect(page.getByLabel("Email")).toHaveValue("");
    const filled = await command("act", {
      actions: [
        {
          kind: "fill",
          ref: ref(await command("snapshot"), "Password"),
          ...login,
        },
      ],
    });
    expect(filled).toMatchObject({ ok: true, completed: 1 });
    await expect(page.locator("#password")).toHaveValue(login.text);
    const shown = await command("act", {
      actions: [{ kind: "click", ref: ref(filled, "Show") }],
    });
    expect(shown).toMatchObject({ ok: true, completed: 1 });
    await expect
      .poll(() => page.evaluate(() => (window as { drawn?: string }).drawn))
      .toBe(login.text);
    await expect(page.locator("#password")).toHaveAttribute("type", "text");
    await expect(page.locator("#password")).toHaveValue(login.text);
    expect(JSON.stringify([refused, filled, shown])).not.toContain(login.text);
    await page.goto(`http://127.0.0.1:${address.port}`);
    const elsewhere = await command("act", {
      actions: [{ kind: "fill", ref: ref(await command("snapshot"), "Name"), ...login }],
    });
    expect(elsewhere).toMatchObject({ ok: false, completed: 0, uncertain: false });
    expect(elsewhere.error).toMatch(/secure/);
    expect(elsewhere).not.toHaveProperty("fallback");
    await page.goto(`http://127.0.0.1:${address.port}`);
    const other = await context.newPage();
    await other.setContent("<title>Other tab</title><button>Other action</button>");
    await page.bringToFront();
    // Read the browser tab most recently brought to the front.
    expect(await command("snapshot")).toMatchObject({ ok: true, title: "Fixture" });
    await expect(page).toHaveTitle("Fixture");
    await expect(other).toHaveTitle("Other tab");
    // Reading an existing page neither creates nor switches tabs.
    expect(context.pages()).toHaveLength(2);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("live page helper selects enabled options, edits rich text, and uploads confined files", async () => {
  test.setTimeout(180_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "page-browser-controls-"));
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    await writeFile(path.join(profile, "note.txt"), "Synthetic upload fixture\n");
    await writeFile(path.join(profile, "second.txt"), "Second synthetic fixture\n");
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      args: ["--remote-debugging-port=0"],
    });
    let port = "";
    await expect(async () => {
      port =
        (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0] ?? "";
      expect(port).toMatch(/^\d+$/);
    }).toPass({ timeout: 5_000 });
    const command = async (name: string, args: Record<string, unknown> = {}) => {
      const { stdout } = await execute("python3", [helper, name, JSON.stringify(args)], {
        env: { ...process.env, HOME: profile, RAKAZO_CDP_PORT: port },
        timeout: 30_000,
      });
      return JSON.parse(stdout);
    };
    const page = context.pages()[0]!;
    await page.route("https://controls.example.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>Controls</title>
        <label>Destination <select id="destination"><option value="old">Old</option>
          <option value="new">New destination</option><optgroup disabled label="Unavailable">
          <option value="blocked">Blocked destination</option></optgroup></select></label>
        <div id="message" role="textbox" aria-label="Rich message" contenteditable="true">Old text</div>
        <label>Documents <input id="files" type="file" multiple></label>
        <label>Aria-hidden document <input id="aria-file" type="file" aria-hidden="true"></label>
        <label style="display:none">Invisible document <input id="invisible-file" type="file"></label>
        <label>Single document <input id="single" type="file"></label>`,
      }),
    );
    await page.goto("https://controls.example.test/");
    const act = async (name: string, action: Record<string, unknown>) => {
      const snapshot = await command("snapshot");
      expect(snapshot.ok).toBe(true);
      const ref = snapshot.elements.find((element: { name: string }) => element.name === name)?.ref;
      expect(ref, name).toBeTruthy();
      return command("act", { actions: [{ ref, ...action }] });
    };
    expect(await act("Destination", { kind: "fill", text: "New destination" })).toMatchObject({
      ok: true,
      completed: 1,
    });
    await expect(page.locator("#destination")).toHaveValue("new");
    expect(await act("Destination", { kind: "fill", text: "blocked" })).toMatchObject({
      ok: false,
      completed: 0,
    });
    await expect(page.locator("#destination")).toHaveValue("new");
    expect(await act("Rich message", { kind: "type", text: "你好，世界 🌍" })).toMatchObject({
      ok: true,
      completed: 1,
    });
    await expect(page.locator("#message")).toHaveText("你好，世界 🌍");
    expect(
      await act("Documents", { kind: "upload", paths: ["note.txt", "second.txt"], roots: ["."] }),
    ).toMatchObject({ ok: true, completed: 1 });
    expect(
      await page
        .locator("#files")
        .evaluate((el) => Array.from((el as HTMLInputElement).files ?? [], (file) => file.name)),
    ).toEqual(["note.txt", "second.txt"]);
    expect(
      await act("Single document", {
        kind: "upload",
        paths: ["note.txt", "second.txt"],
        roots: ["."],
      }),
    ).toMatchObject({ ok: false, completed: 0, uncertain: false });
    expect(
      await page.locator("#single").evaluate((el) => (el as HTMLInputElement).files?.length),
    ).toBe(0);
    expect(
      await act("Documents", { kind: "upload", paths: ["../outside.txt"], roots: ["."] }),
    ).toMatchObject({ ok: false, completed: 0 });
    expect(
      await page
        .locator("#files")
        .evaluate((el) => Array.from((el as HTMLInputElement).files ?? [], (file) => file.name)),
    ).toEqual(["note.txt", "second.txt"]);
    expect(
      await act("Aria-hidden document", { kind: "upload", paths: ["note.txt"], roots: ["."] }),
    ).toMatchObject({ ok: true, completed: 1 });
    expect(
      await page.locator("#aria-file").evaluate((el) => (el as HTMLInputElement).files?.[0]?.name),
    ).toBe("note.txt");
    expect(
      (await command("snapshot")).elements.some(
        (element: { name: string }) => element.name === "Invisible document",
      ),
    ).toBe(false);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("live page helper waits for a site's sign-in check, or says the page is still loading", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "page-browser-settle-"));
  // Like many web apps, the page draws a signed-out shell and asks its server who is signed in.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.test");
    if (url.pathname === "/api/me") {
      setTimeout(
        () => {
          res.setHeader("content-type", "application/json");
          res.end('{"name":"test-user"}');
        },
        Number(url.searchParams.get("delay")),
      );
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Example</title><header><a href="/login">Sign in</a></header>
      <main id="m">Loading</main>
      <script>fetch('/api/me?delay=${Number(url.searchParams.get("check"))}').then((r) => r.json())
        .then((u) => { document.querySelector('header').textContent = 'Signed in as ' + u.name;
          document.getElementById('m').textContent = 'Your account'; });</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture server");
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      args: ["--remote-debugging-port=0"],
    });
    let port = "";
    await expect(async () => {
      port =
        (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0] ?? "";
      expect(port).toMatch(/^\d+$/);
    }).toPass({ timeout: 5_000 });
    const snapshot = async () => {
      const { stdout } = await execute("python3", [helper, "snapshot", "{}"], {
        env: { ...process.env, RAKAZO_CDP_PORT: port },
        timeout: 30_000,
      });
      return JSON.parse(stdout);
    };
    const page = context.pages()[0]!;

    // The check answers within the wait: the snapshot shows the signed-in page.
    await page.goto(`http://127.0.0.1:${address.port}/?check=500`);
    const settled = await snapshot();
    expect(settled).toMatchObject({ ok: true, title: "Example" });
    expect(settled.tree).toContain("Signed in as test-user");
    expect(settled.tree).not.toContain('link "Sign in"');
    expect(settled).not.toHaveProperty("loading");

    // The check outlasts the wait: the snapshot still shows the shell, and says it is loading.
    await page.goto(`http://127.0.0.1:${address.port}/?check=20000`);
    const loading = await snapshot();
    expect(loading).toMatchObject({ ok: true, title: "Example", loading: true });
    expect(loading.tree).toContain('link "Sign in"');
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Common code widgets. Each expects real key presses, and most move focus between their boxes.
// The page logs untrusted key events, which real typing never produces, and when keys arrive.
// Ordinary fields come first, so they stay inside the snapshot's control limit.
const CODE_FIELDS = `<!doctype html><title>Code</title>
  <form id="plain" onsubmit="event.preventDefault(); window.submits = (window.submits || 0) + 1">
    <label>Name <input value="Ada"></label><label>Email <input type="email" value="ada@example.test"></label>
    <textarea aria-label="Notes">Old</textarea><label>Pin <input type="number"></label></form>
  <textarea aria-label="Message"
    onkeydown="if (event.key === 'Enter' && !event.shiftKey) window.sent = (window.sent || 0) + 1"></textarea>
  <section id="last">Last <div class="boxes" data-kind="last"></div></section>
  <section id="keys">Keys <div class="boxes" data-kind="keydown"></div></section>
  <section id="state">State <div class="boxes" data-kind="state"></div></section>
  <section id="single">Single <label style="position:relative;display:inline-block;width:240px;height:40px">
    <span id="single-boxes"></span><input aria-label="Code" autocomplete="one-time-code" maxlength="6"
      style="position:absolute;inset:0;opacity:0"></label></section>
  <section id="paste">Paste <div class="boxes" data-kind="paste"></div></section>
  <section id="overtype">Overtype <div class="boxes" data-kind="overtype"></div></section>
  <section id="split">Split <div class="boxes" data-kind="split" data-letters></div></section>
  <section id="submit">Submit <div class="boxes" data-kind="submit"></div></section>
  <section id="leave">Leave <div class="boxes" data-kind="leave"></div></section>
  <section id="eager">Eager <div class="boxes" data-kind="eager"></div></section>
  <section id="still">Still <div class="boxes" data-kind="still"></div></section>
  <section id="initial">Initial <div class="boxes" data-kind="last">
    <input aria-label="Middle initial" maxlength="1" value="Q"></div></section>
  <section id="rebuild">Rebuild <div></div></section>
  <section id="jump">Jump <div class="boxes" data-kind="jump"></div></section>
  <script>
    window.untrusted = 0;
    window.keyTimes = [];
    addEventListener("keydown", (event) => {
      if (!event.isTrusted) window.untrusted++;
      window.keyTimes.push(performance.now());
    }, true);
    for (const group of document.querySelectorAll(".boxes")) {
      const kind = group.dataset.kind;
      const id = group.closest("section").id;
      const accepts = (key) => (group.hasAttribute("data-letters") ? /^[0-9A-Z]$/i : /^[0-9]$/).test(key);
      const boxes = Array.from({ length: 6 }, (_, i) => {
        const box = document.createElement("input");
        box.maxLength = 1;
        box.setAttribute("aria-label", id + " " + (i + 1));
        (kind === "split" && i >= 3 ? group.lastElementChild : group).append(box);
        if (kind === "split" && i === 2) group.append("-", document.createElement("span"));
        return box;
      });
      const state = boxes.map(() => "");
      const spread = (from, chars) => {
        for (let j = 0; j < chars.length && from + j < 6; j++) boxes[from + j].value = chars[j];
        boxes[Math.min(from + chars.length, 5)].focus();
      };
      boxes.forEach((box, i) => {
        box.addEventListener("focus", () => box.select());
        // Plain boxes that never move focus themselves.
        if (kind === "still") return;
        if (kind === "keydown") {
          box.addEventListener("beforeinput", (event) => event.preventDefault());
          box.addEventListener("keydown", (event) => {
            if (!event.isTrusted || !accepts(event.key)) return;
            event.preventDefault();
            box.value = event.key;
            boxes[Math.min(i + 1, 5)].focus();
          });
          return;
        }
        box.addEventListener("input", (event) => {
          if (kind === "state") {
            // A controlled widget renders from its own state, which only real input events change.
            state[i] = accepts(event.data || "") ? event.data : "";
            boxes.forEach((b, j) => (b.value = state[j]));
            if (state[i] && i < 5) boxes[i + 1].focus();
            return;
          }
          const chars = box.value.split("").filter(accepts).join("");
          if (kind === "overtype" && chars.length > 1) {
            box.value = "";
            spread(i, chars.slice(1));
          } else {
            box.value = chars.slice(-1);
            if (box.value && i < 5) boxes[i + 1].focus();
          }
          if (kind === "submit" && boxes.every((b) => b.value)) location.href = "/done";
          // Pages that move on, or move focus to another field, before the code is complete.
          if (kind === "leave" && i === 2 && box.value) location.href = "/next";
          if (kind === "eager" && i === 2) location.href = "/next";
          if (kind === "jump" && i === 1) document.querySelector("#plain input").focus();
        });
        if (kind === "paste") {
          box.addEventListener("paste", (event) => {
            event.preventDefault();
            spread(i, event.clipboardData.getData("text").split("").filter(accepts));
          });
        }
      });
    }
    // A widget that draws all its boxes again, as new elements, on every input.
    const rebuild = document.querySelector("#rebuild div");
    const draw = (values, focus) => {
      rebuild.replaceChildren(...values.map((value, i) => {
        const box = document.createElement("input");
        box.maxLength = 1;
        box.value = value;
        box.setAttribute("aria-label", "rebuild " + (i + 1));
        box.addEventListener("input", () => {
          const next = Array.from(rebuild.children, (b) => b.value.replace(/[^0-9]/g, "").slice(-1));
          draw(next, next[i] ? Math.min(i + 1, 5) : i);
        });
        return box;
      }));
      if (focus !== undefined) rebuild.children[focus].focus();
    };
    draw(["", "", "", "", "", ""]);
    const single = document.querySelector("#single input");
    single.addEventListener("input", () => {
      single.value = single.value.replace(/[^0-9]/g, "");
      document.getElementById("single-boxes").textContent = single.value.split("").join(" ");
    });
  </script>`;

// An email code and a text-message code side by side in one element, both built from the same
// "Digit 1" to "Digit 6" boxes that move on by themselves.
const TWO_CODES = `<!doctype html><title>Two codes</title><style>input { width: 2em }</style>
  <div id="codes"></div>
  <script>
    const boxes = [];
    for (const label of ["Email", "Text message"]) {
      document.getElementById("codes").append(label + " ");
      for (let i = 0; i < 6; i++) {
        const box = document.createElement("input");
        box.maxLength = 1;
        box.setAttribute("aria-label", "Digit " + (i + 1));
        boxes.push(box);
        box.addEventListener("input", () => {
          if (box.value && i < 5) boxes[boxes.indexOf(box) + 1].focus();
        });
        document.getElementById("codes").append(box);
      }
    }
    for (const box of boxes.slice(0, 6)) box.value = "1";
  </script>`;

test("live page helper types codes as real key presses into one-box-per-digit fields", async () => {
  test.setTimeout(240_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "page-browser-test-"));
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      args: ["--remote-debugging-port=0"],
    });
    let port = "";
    await expect(async () => {
      port =
        (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0] ?? "";
      expect(port).toMatch(/^\d+$/);
    }).toPass({ timeout: 5_000 });
    async function command(name: string, args: Record<string, unknown> = {}) {
      const { stdout } = await execute("python3", [helper, name, JSON.stringify(args)], {
        env: { ...process.env, RAKAZO_CDP_PORT: port },
        timeout: 30_000,
      });
      return JSON.parse(stdout);
    }
    // Each result carries a fresh snapshot, whose refs replace the previous ones.
    let elements: Array<{ name: string; ref: string; value?: string }> = [];
    const refresh = async () => {
      elements = (await command("snapshot")).elements;
    };
    async function type(name: string, text: string) {
      const ref = elements.find((element) => element.name === name)?.ref;
      expect(ref, name).toBeTruthy();
      const result = await command("act", { actions: [{ kind: "type", ref, text }] });
      elements = result.elements ?? [];
      return result;
    }
    const page = context.pages()[0]!;
    await page.route("https://code.example.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: route.request().url().endsWith("/done")
          ? "<title>Signed in</title>"
          : route.request().url().endsWith("/two")
            ? TWO_CODES
            : route.request().url().endsWith("/next")
              ? '<title>Next</title><input aria-label="Next" autofocus>'
              : CODE_FIELDS,
      }),
    );
    const open = async () => {
      await page.goto("https://code.example.test/");
      await refresh();
    };
    const code = (section: string) =>
      page
        .locator(`#${section} input`)
        .evaluateAll((boxes) => boxes.map((box) => (box as HTMLInputElement).value).join(""));
    // From the first key press to the last, as the page saw them.
    const typingMs = () =>
      page.evaluate(() => {
        const times = (window as unknown as { keyTimes: number[] }).keyTimes.splice(0);
        return times.length ? times[times.length - 1]! - times[0]! : 0;
      });

    for (const section of ["last", "keys", "state", "paste", "overtype", "split"]) {
      await open();
      // One action enters the whole code; the result shows what landed in each box.
      expect(await type(`${section} 1`, "482913"), section).toMatchObject({
        ok: true,
        completed: 1,
      });
      expect(await typingMs(), section).toBeLessThan(2_000);
      expect(await code(section), section).toBe("482913");
      expect(elements.find((element) => element.name === `${section} 6`)?.value).toBe("3");
      // A partial code, then the full one typed from another box, replaces it.
      await type(`${section} 1`, "48");
      expect(await type(`${section} 4`, "482913")).toMatchObject({ ok: true });
      expect(await code(section), section).toBe("482913");
    }
    // Typing again replaces: twice in a row, and a wrong code then the right one.
    expect(await type("last 1", "482913")).toMatchObject({ ok: true });
    expect(await code("last")).toBe("482913");
    await type("last 1", "482931");
    await type("last 1", "482913");
    expect(await code("last")).toBe("482913");
    expect(await type("split 1", "A7K29Q")).toMatchObject({ ok: true });
    expect(await code("split")).toBe("A7K29Q");
    // Boxes the page filled itself are emptied first.
    await page.locator("#last input").evaluateAll((boxes) => {
      for (const box of boxes) (box as HTMLInputElement).value = "9";
    });
    await refresh();
    await type("last 1", "482913");
    expect(await code("last")).toBe("482913");
    // A key the widget refuses is reported, not claimed as done, and the error repeats no text.
    const refused = await type("last 1", "48291A");
    expect(refused).toMatchObject({ ok: false, completed: 1 });
    expect(refused.error).toContain("did not keep every character");
    expect(refused.error).not.toContain("48291A");

    // The real input of a drawn code field is transparent, and it is still listed and typed into.
    await page.locator("#single input").fill("123456");
    await refresh();
    expect(await type("Code", "482913")).toMatchObject({ ok: true });
    await expect(page.locator("#single input")).toHaveValue("482913");
    await expect(page.locator("#single-boxes")).toHaveText("4 8 2 9 1 3");

    // Ordinary fields: type replaces the text, and Enter goes only where a line break belongs.
    await type("Name", "Grace\n");
    await expect(page.getByLabel("Name")).toHaveValue("Grace");
    expect(await page.evaluate(() => (window as { submits?: number }).submits ?? 0)).toBe(0);
    await type("Email", "grace@example.test");
    await expect(page.getByLabel("Email")).toHaveValue("grace@example.test");
    await type("Notes", "é ß 中文 🙂\nline two");
    await expect(page.getByLabel("Notes")).toHaveValue("é ß 中文 🙂\nline two");
    // A chat box that sends on Enter gets line breaks, never a send.
    expect(await type("Message", "Hi\nsee you")).toMatchObject({ ok: true });
    await expect(page.getByLabel("Message")).toHaveValue("Hi\nsee you");
    expect(await page.evaluate(() => (window as { sent?: number }).sent ?? 0)).toBe(0);
    const long = "x".repeat(1_000);
    const started = Date.now();
    expect(await type("Notes", long)).toMatchObject({ ok: true });
    expect(Date.now() - started).toBeLessThan(20_000);
    await expect(page.getByLabel("Notes")).toHaveValue(long);
    expect(await type("Pin", "12a")).toMatchObject({ ok: false });
    expect(await page.evaluate(() => (window as { untrusted?: number }).untrusted)).toBe(0);

    // Typing into one code leaves another code on the page as it was.
    await open();
    await page.locator("#keys input").evaluateAll((boxes) => {
      for (const box of boxes) (box as HTMLInputElement).value = "7";
    });
    await type("last 1", "482913");
    expect(await code("keys")).toBe("777777");
    // Focus moved to another field mid-code: typing stops there and that field keeps its text.
    const jumped = await type("jump 1", "482913");
    expect(jumped).toMatchObject({ ok: false, completed: 0 });
    expect(jumped.error).toMatch(/Focus left|Typing stopped/);
    expect(jumped.error).not.toContain("482913");
    await expect(page.getByLabel("Name")).toHaveValue("Ada");
    // The page moved on mid-code: no key reaches the next page, even its focused field.
    const left = await type("leave 1", "482913");
    expect(left).toMatchObject({ ok: false, completed: 0, title: "Next" });
    expect(left.error).toMatch(
      /(?:page changed while typing, after|Typing stopped after) 3 of 6 characters/,
    );
    await expect(page.getByLabel("Next")).toHaveValue("");
    // The page moves on as soon as its filled boxes are emptied: not one key is typed.
    await open();
    await page.locator("#eager input").evaluateAll((boxes) => {
      for (const box of boxes) (box as HTMLInputElement).value = "7";
    });
    await refresh();
    const eager = await type("eager 1", "482913");
    expect(eager).toMatchObject({ ok: false, completed: 0, title: "Next" });
    expect(eager.error).toMatch(
      /(?:page changed while typing, after|Typing stopped after) 0 of 6 characters/,
    );
    await expect(page.getByLabel("Next")).toHaveValue("");

    // A code typed one character per box, into boxes that move on by themselves and boxes that don't.
    await open();
    for (const section of ["last", "still"]) {
      for (const [i, digit] of Array.from("482913").entries()) {
        expect(await type(`${section} ${i + 1}`, digit), section).toMatchObject({ ok: true });
      }
      expect(await code(section), section).toBe("482913");
    }
    // A one-letter field just before the boxes is not part of the code.
    await open();
    expect(await type("initial 1", "482913")).toMatchObject({ ok: true });
    expect(await code("initial")).toBe("Q482913");
    // Boxes drawn again as new elements on every input get the code, the first time and again.
    expect(await type("rebuild 1", "482913")).toMatchObject({ ok: true, completed: 1 });
    expect(await code("rebuild")).toBe("482913");
    expect(await type("rebuild 4", "482931")).toMatchObject({ ok: true });
    expect(await code("rebuild")).toBe("482931");

    // Adjacent codes can share their names, size, row and form without sharing their values.
    await page.evaluate(() => {
      document.body.innerHTML =
        '<form style="display:flex"><div id="left"></div><div id="right"></div></form>';
      for (const id of ["left", "right"]) {
        const group = document.getElementById(id)!;
        for (let i = 0; i < 6; i++) {
          const box = document.createElement("input");
          box.maxLength = 1;
          box.style.width = "20px";
          box.setAttribute("aria-label", `Digit ${i + 1}`);
          box.value = "7";
          box.addEventListener("input", () => {
            if (box.value) (box.nextElementSibling as HTMLInputElement | null)?.focus();
          });
          group.append(box);
        }
      }
    });
    await refresh();
    const right = elements.filter((element) => element.name === "Digit 1")[1]!.ref;
    expect(
      await command("act", { actions: [{ kind: "type", ref: right, text: "482913" }] }),
    ).toMatchObject({ ok: true });
    expect(await code("left")).toBe("777777");
    expect(await code("right")).toBe("482913");

    // Removing a widget and focusing a same-named replacement must stop the remaining keys.
    await page.evaluate(() => {
      document.getElementById("left")!.remove();
      const group = document.getElementById("right")!;
      group.querySelectorAll("input").forEach((box) => {
        box.value = "";
      });
      group.addEventListener(
        "input",
        () => {
          const replacement = group.cloneNode(true) as HTMLElement;
          replacement.querySelectorAll("input").forEach((box) => {
            box.value = "7";
          });
          group.replaceWith(replacement);
          replacement.querySelector("input")!.focus();
        },
        { once: true },
      );
    });
    await refresh();
    expect(await type("Digit 1", "482913")).toMatchObject({ ok: false, completed: 0 });
    expect(await code("right")).toBe("777777");

    // Typing into the second of two codes in one element leaves the first one as it was.
    await page.goto("https://code.example.test/two");
    await refresh();
    const second = elements.filter((element) => element.name === "Digit 1")[1]?.ref;
    expect(second).toBeTruthy();
    const typed = await command("act", {
      actions: [{ kind: "type", ref: second, text: "482913" }],
    });
    expect(typed).toMatchObject({ ok: true, completed: 1 });
    const digits = await page
      .locator("#codes input")
      .evaluateAll((boxes) => boxes.map((box) => (box as HTMLInputElement).value).join(""));
    expect(digits).toBe("111111482913");

    // A widget that submits on its last digit: the step is done and the result is the next page.
    await open();
    expect(await type("submit 1", "482913")).toMatchObject({
      ok: true,
      completed: 1,
      title: "Signed in",
    });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("live exact refs stay with their document, tab, shadow node, and frame", async () => {
  test.setTimeout(180_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "page-browser-frames-"));
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      args: ["--remote-debugging-port=0", "--site-per-process"],
    });
    let port = "";
    await expect(async () => {
      port =
        (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0] ?? "";
      expect(port).toMatch(/^\d+$/);
    }).toPass({ timeout: 5_000 });
    const command = async (name: string, args: Record<string, unknown> = {}) => {
      const { stdout } = await execute("python3", [helper, name, JSON.stringify(args)], {
        env: { ...process.env, RAKAZO_CDP_PORT: port },
        timeout: 30_000,
      });
      return JSON.parse(stdout);
    };
    expect(await command("capabilities")).toMatchObject({
      ok: true,
      capabilities: {
        protocol: 2,
        engine: "agent-browser",
        engineVersion: "0.41.0",
        refIdentity: "exact-node-v1",
        loginFields: ["username", "password"],
      },
    });
    await context.route("https://frame.example.test/**", (route) => {
      const leaf = new URL(route.request().url()).pathname;
      return route.fulfill({
        contentType: "text/html",
        body:
          leaf === "/"
            ? `<!doctype html><title>Frames</title>
        <input aria-label="Top user"><button id="save" onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">Top save</button>
        <div id="shadow"></div>
        <iframe title="Same frame" src="/child"></iframe>
        <iframe title="Other frame" src="https://other.example.test/child"></iframe>
        <iframe title="Opaque frame" sandbox="allow-scripts" src="/opaque"></iframe>
        <script>const root=document.getElementById('shadow').attachShadow({mode:'open'});
          root.innerHTML='<button id="shadow-save" onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">Shadow action</button>';</script>`
            : `<!doctype html><title>Child</title><input aria-label="${leaf === "/opaque" ? "Opaque" : "Same"} user">`,
      });
    });
    await context.route("https://other.example.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><title>Other child</title><input aria-label="Other user"><button id="other-save" onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">Other action</button>',
      }),
    );
    const page = context.pages()[0]!;
    await page.goto("https://frame.example.test/");
    await expect(page.frames()).toHaveLength(4);
    const ref = (snapshot: { elements: Array<{ name: string; ref: string }> }, name: string) => {
      const value = snapshot.elements.find((element) => element.name === name)?.ref;
      expect(value, name).toMatch(/^r2\./);
      return value!;
    };
    let snapshot = await command("snapshot");

    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(snapshot, "Other action") }] }),
    ).toMatchObject({ ok: true, completed: 1 });
    await expect(
      page.frameLocator('iframe[title="Other frame"]').locator("#other-save"),
    ).toHaveAttribute("data-clicks", "1");
    snapshot = await command("snapshot");
    const refusedCrossOrigin = await command("act", {
      actions: [
        {
          kind: "fill",
          ref: ref(snapshot, "Other user"),
          text: "private-cross-value",
          field: "username",
          origin: "https://frame.example.test",
        },
      ],
    });
    expect(refusedCrossOrigin).toMatchObject({ ok: false, completed: 0, uncertain: false });
    expect(refusedCrossOrigin).not.toHaveProperty("fallback");
    await expect(
      page.frameLocator('iframe[title="Other frame"]').getByLabel("Other user"),
    ).toHaveValue("");
    snapshot = await command("snapshot");
    const refusedOpaque = await command("act", {
      actions: [
        {
          kind: "fill",
          ref: ref(snapshot, "Opaque user"),
          text: "private-opaque-value",
          field: "username",
          origin: "https://frame.example.test",
        },
      ],
    });
    expect(refusedOpaque).toMatchObject({ ok: false, completed: 0, uncertain: false });
    await expect(
      page.frameLocator('iframe[title="Opaque frame"]').getByLabel("Opaque user"),
    ).toHaveValue("");
    snapshot = await command("snapshot");
    const filled = await command("act", {
      actions: [
        {
          kind: "fill",
          ref: ref(snapshot, "Same user"),
          text: "ada",
          field: "username",
          origin: "https://frame.example.test",
        },
      ],
    });
    expect(filled).toMatchObject({ ok: true, completed: 1 });
    await expect(
      page.frameLocator('iframe[title="Same frame"]').getByLabel("Same user"),
    ).toHaveValue("ada");
    expect(
      filled.elements.find((element: { name: string }) => element.name === "Same user"),
    ).not.toHaveProperty("value");
    snapshot = await command("snapshot");
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(snapshot, "Shadow action") }] }),
    ).toMatchObject({ ok: true, completed: 1 });
    await expect(page.locator("#shadow-save")).toHaveAttribute("data-clicks", "1");

    // A same-URL reload changes the document even if its labels are identical.
    const originalDocumentRef = ref(await command("snapshot"), "Top save");
    await page.reload();
    expect(
      await command("act", { actions: [{ kind: "click", ref: originalDocumentRef }] }),
    ).toMatchObject({ ok: false, completed: 0, uncertain: false });
    await expect(page.locator("#save")).not.toHaveAttribute("data-clicks", "1");
    snapshot = await command("snapshot");
    const firstTabRef = ref(snapshot, "Top save");
    const other = await context.newPage();
    await other.goto("https://frame.example.test/");
    await other.bringToFront();
    expect(await command("act", { actions: [{ kind: "click", ref: firstTabRef }] })).toMatchObject({
      ok: false,
      completed: 0,
      uncertain: false,
    });
    await expect(other.locator("#save")).not.toHaveAttribute("data-clicks", "1");
    const current = await command("snapshot");
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(current, "Top save") }] }),
    ).toMatchObject({ ok: true, completed: 1 });
    await expect(other.locator("#save")).toHaveAttribute("data-clicks", "1");
    expect(context.pages()).toHaveLength(2);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
