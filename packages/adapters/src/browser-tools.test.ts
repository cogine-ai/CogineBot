import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  browserActFromTool,
  browserNavigateFromTool,
  browserResultForModel,
  browserSnapshotFromTool,
  parseBrowserActions,
  redactBrowserResult,
} from "./browser-tools.js";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { filterPageBrowserTools, PAGE_BROWSER_TOOL_NAMES } from "./executor.js";
import { FakeBrowserProvider } from "./fake-browser.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const computer: ComputerRef = {
  id: "c1",
  botId: "b1",
  kind: "fake",
  providerRef: "c1",
};

describe("browser tools", () => {
  it("reports timed-out partial navigation without replaying or exposing saved values", async () => {
    const secret = "synthetic-password-for-navigation";
    const liveDriver = vi.fn(async () => ({
      ok: false,
      completed: 1,
      uncertain: false,
      timedOut: true,
      url: "https://example.test/current",
      title: "Current page",
      tree: `- textbox value=${secret}`,
      elements: [{ ref: "new", role: "textbox", name: "Name", value: secret }],
      error: "Navigation wait timed out",
    }));
    const result = await browserActFromTool(
      new ComputerBrowserProvider({ liveDriver }),
      { ...computer, kind: "docker" },
      context,
      {
        actions: [
          { kind: "click", ref: "old" },
          { kind: "click", ref: "also-old" },
        ],
      },
      { redactions: () => [secret] },
    );
    expect(result).toMatchObject({
      ok: false,
      completed: 1,
      uncertain: false,
      timedOut: true,
      url: "https://example.test/current",
      title: "Current page",
      elements: [{ ref: "new", role: "textbox", name: "Name" }],
    });
    expect(result).not.toHaveProperty("fallback");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(liveDriver).toHaveBeenCalledTimes(1);
  });

  it("parses click/fill/type actions and rejects bad batches", () => {
    expect(
      parseBrowserActions([
        { kind: "fill", ref: "e1", text: "hi" },
        { kind: "click", ref: "e2" },
      ]),
    ).toEqual([
      { kind: "fill", ref: "e1", text: "hi" },
      { kind: "click", ref: "e2" },
    ]);
    expect(() => parseBrowserActions([])).toThrow(/at least one/i);
    expect(() => parseBrowserActions([{ kind: "click" }])).toThrow(/ref/i);
    expect(() => parseBrowserActions([{ kind: "fill", ref: "e1" }])).toThrow(/text/i);
  });

  it("rejects URL credentials before invoking the browser", async () => {
    const browser = new FakeBrowserProvider();
    browser.navigateError = new Error("must not invoke browser");
    for (const scheme of ["http", "https"]) {
      expect(
        await browserNavigateFromTool(browser, computer, context, {
          url: `${scheme}://example:fake-password@example.test`,
        }),
      ).toMatchObject({ error: expect.stringContaining("credentials") });
    }
  });

  it("navigates, snapshots, and acts through the tool helpers", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/x": {
          title: "Demo",
          html: `<!doctype html><html><head><title>Demo</title></head><body>
            <input aria-label="Name" />
            <button>Save</button>
          </body></html>`,
        },
      },
    });
    const navigated = await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test/x",
    });
    expect(navigated).toMatchObject({ title: "Demo" });
    expect("fallback" in navigated && navigated.fallback).toBeFalsy();

    const snap = await browserSnapshotFromTool(browser, computer, context, {});
    expect(snap).toMatchObject({ title: "Demo" });
    expect(String((snap as { tree?: string }).tree)).toMatch(/\[e\d+\]/);

    const nameRef = (snap as { elements: Array<{ ref: string; name: string }> }).elements.find(
      (el) => el.name.includes("Name"),
    )!.ref;
    const acted = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "fill", ref: nameRef, text: "Ada" }],
    });
    expect(acted).toMatchObject({ ok: true, completed: 1 });
  });

  it("parses fill_secret without a value and rejects unknown fields", () => {
    expect(
      parseBrowserActions([
        { kind: "fill_secret", ref: "e1", secret: "site_login", field: "password" },
      ]),
    ).toEqual([{ kind: "fill_secret", ref: "e1", secret: "site_login", field: "password" }]);
    expect(() =>
      parseBrowserActions([{ kind: "fill_secret", ref: "e1", secret: "site_login", field: "pin" }]),
    ).toThrow(/username or password/);
    expect(() =>
      parseBrowserActions([{ kind: "fill_secret", ref: "e1", field: "password" }]),
    ).toThrow(/secret/);
  });

  describe("saved login fills", () => {
    const loginPage = (url: string) =>
      new FakeBrowserProvider({
        pages: {
          [url]: {
            title: "Sign in",
            html: `<!doctype html><html><head><title>Sign in</title></head><body>
              <input aria-label="Email" />
              <input aria-label="Password" type="password" />
            </body></html>`,
          },
        },
      });
    async function refs(browser: FakeBrowserProvider, url: string) {
      await browserNavigateFromTool(browser, computer, context, { url });
      const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const ref = (name: string) => snap.elements.find((el) => el.name.includes(name))!.ref;
      return { email: ref("Email"), password: ref("Password") };
    }
    const values = { username: "fake-user@example.test", password: "fake-password-1" };
    const resolveSecretFill = async (step: { field: "username" | "password" }) => ({
      text: values[step.field],
      origin: "https://login.example.test",
    });

    it.each(["missing", "false"])(
      "does not resolve a secret when capability proof is %s",
      async (mode) => {
        const browser = loginPage("https://login.example.test/signin");
        const resolve = vi.fn(resolveSecretFill);
        const act = vi.spyOn(browser, "act");
        if (mode === "missing")
          Object.defineProperty(browser, "supportsPageActions", { value: undefined });
        else vi.spyOn(browser, "supportsPageActions").mockResolvedValue(false);
        const result = await browserActFromTool(
          browser,
          computer,
          context,
          {
            actions: [
              {
                kind: "fill_secret",
                ref: "old-image-ref",
                secret: "site_login",
                field: "password",
              },
            ],
          },
          { resolveSecretFill: resolve },
        );
        expect(result).toMatchObject({ ok: false, completed: 0, uncertain: false });
        expect(resolve).not.toHaveBeenCalled();
        expect(act).not.toHaveBeenCalled();
      },
    );

    it.each(["type", "upload"])(
      "refuses %s on an old helper before resolving inputs or dispatching the batch",
      async (kind) => {
        const browser = loginPage("https://login.example.test/signin");
        vi.spyOn(browser, "supportsPageActions").mockResolvedValue(false);
        const act = vi.spyOn(browser, "act");
        const resolvePath = vi.fn((path: string) => path);
        const result = await browserActFromTool(
          browser,
          computer,
          context,
          {
            actions: [
              { kind: "click", ref: "before" },
              kind === "type"
                ? { kind: "type", ref: "field", text: "not-dispatched" }
                : { kind: "upload", ref: "field", paths: ["shared/report.txt"] },
            ],
          },
          { resolveUploadPath: resolvePath, uploadRoots: ["shared"] },
        );
        expect(result).toMatchObject({ ok: false, completed: 0, uncertain: false });
        expect(resolvePath).not.toHaveBeenCalled();
        expect(act).not.toHaveBeenCalled();
      },
    );

    it("does not resolve a secret after cancellation during the capability probe", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const abort = new AbortController();
      const resolve = vi.fn(resolveSecretFill);
      const act = vi.spyOn(browser, "act");
      vi.spyOn(browser, "supportsPageActions").mockImplementation(async () => {
        abort.abort(new Error("cancelled-by-user"));
        return true;
      });
      await expect(
        browserActFromTool(
          browser,
          computer,
          { ...context, signal: abort.signal },
          {
            actions: [{ kind: "fill_secret", ref: "ref", secret: "site_login", field: "password" }],
          },
          { resolveSecretFill: resolve },
        ),
      ).rejects.toThrow("cancelled-by-user");
      expect(resolve).not.toHaveBeenCalled();
      expect(act).not.toHaveBeenCalled();
    });

    it.each(["deadline", "stop"])(
      "settles a pending saved-login resolver on %s without dispatching a late value",
      async (reason) => {
        const browser = loginPage("https://login.example.test/signin");
        const deadline = new AbortController();
        const stop = new AbortController();
        const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
        let resolvePending!: (value: { text: string; origin: string }) => void;
        const pending = new Promise<{ text: string; origin: string }>((resolve) => {
          resolvePending = resolve;
        });
        const resolve = vi.fn(() => pending);
        const act = vi.spyOn(browser, "act").mockResolvedValue({
          ok: true,
          completed: 1,
          url: "https://example.test",
          title: "Page",
        });
        const task = browserActFromTool(
          browser,
          computer,
          { ...context, signal: stop.signal },
          {
            actions: [{ kind: "fill_secret", ref: "ref", secret: "site_login", field: "password" }],
          },
          { resolveSecretFill: resolve },
        );
        const outcome = task.then(
          (value) => ({ kind: "resolved" as const, value }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        try {
          await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
          const error = new DOMException(
            reason,
            reason === "deadline" ? "TimeoutError" : "AbortError",
          );
          (reason === "deadline" ? deadline : stop).abort(error);
          const result = await Promise.race([
            outcome,
            new Promise<{ kind: "pending" }>((resolve) =>
              setTimeout(() => resolve({ kind: "pending" }), 30),
            ),
          ]);
          expect(result.kind).not.toBe("pending");
          if (reason === "deadline") {
            expect(result).toMatchObject({
              kind: "resolved",
              value: { ok: false, completed: 0, uncertain: false, timedOut: true },
            });
          } else {
            expect(result).toMatchObject({ kind: "rejected", error });
          }
          expect(timer).toHaveBeenCalledOnce();
          expect(timer).toHaveBeenCalledWith(22_000);
          expect(act).not.toHaveBeenCalled();
          resolvePending({ text: "late-private-value", origin: "https://login.example.test" });
          await Promise.resolve();
          await Promise.resolve();
          expect(act).not.toHaveBeenCalled();
        } finally {
          resolvePending({ text: "late-private-value", origin: "https://login.example.test" });
          await outcome;
          timer.mockRestore();
        }
      },
    );

    it("types saved values on the saved origin and redacts them from the result", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email, password } = await refs(browser, "https://login.example.test/signin");
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        {
          actions: [
            { kind: "fill_secret", ref: email, secret: "site_login", field: "username" },
            { kind: "fill_secret", ref: password, secret: "site_login", field: "password" },
          ],
        },
        { resolveSecretFill, redactions: () => [values.username, values.password] },
      );
      expect(acted).toMatchObject({ ok: true, completed: 2 });
      expect(JSON.stringify(acted)).not.toContain(values.username);
      expect(JSON.stringify(acted)).not.toContain(values.password);
    });

    it("never reports a login-filled field's value, even when too short to redact", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email } = await refs(browser, "https://login.example.test/signin");
      const shortName = async () => ({ text: "ada", origin: "https://login.example.test" });
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        { resolveSecretFill: shortName },
      );
      expect(acted).toMatchObject({ ok: true });
      expect(JSON.stringify(acted)).not.toContain("ada");
      const snap = await browserSnapshotFromTool(browser, computer, context, {});
      expect(JSON.stringify(snap)).not.toContain("ada");
    });

    it("replaces a saved username on ordinary typing without exposing the earlier secret", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email } = await refs(browser, "https://login.example.test/signin");
      // Each result carries a fresh snapshot, whose refs replace the previous ones.
      const emailRef = (result: unknown) =>
        (result as { elements: Array<{ ref: string; name: string }> }).elements.find((el) =>
          el.name.includes("Email"),
        )!.ref;
      const filled = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        { resolveSecretFill: async () => ({ text: "ada", origin: "https://login.example.test" }) },
      );
      const typed = await browserActFromTool(browser, computer, context, {
        actions: [{ kind: "type", ref: emailRef(filled), text: "!" }],
      });
      expect(typed).toMatchObject({ ok: true });
      expect(JSON.stringify(typed)).not.toContain("ada");
      const replaced = await browserActFromTool(browser, computer, context, {
        actions: [{ kind: "fill", ref: emailRef(typed), text: "visible-now" }],
      });
      expect(JSON.stringify(replaced)).toContain("visible-now");
    });

    it("refuses to type a saved login into editable page content", async () => {
      const browser = new FakeBrowserProvider({
        pages: {
          "https://login.example.test/notes": {
            title: "Notes",
            html: `<!doctype html><html><head><title>Notes</title></head><body>
              <div contenteditable="true" aria-label="Notes"></div>
            </body></html>`,
          },
        },
      });
      await browserNavigateFromTool(browser, computer, context, {
        url: "https://login.example.test/notes",
      });
      const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const notes = snap.elements.find((el) => el.name.includes("Notes"))!.ref;
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: notes, secret: "site_login", field: "username" }] },
        { resolveSecretFill },
      );
      expect(acted).toMatchObject({ ok: false, completed: 0 });
      expect(JSON.stringify(acted)).toMatch(/text, email, or telephone/g);
    });

    it("refuses to type a saved login into a textarea or a non-login input type", async () => {
      const browser = new FakeBrowserProvider({
        pages: {
          "https://login.example.test/signin": {
            title: "Sign in",
            html: `<!doctype html><html><head><title>Sign in</title></head><body>
              <textarea aria-label="Username"></textarea>
              <input aria-label="Query" type="search" />
              <input aria-label="Website" type="url" />
              <input aria-label="Pin" type="number" />
              <input aria-label="Phone" type="tel" />
            </body></html>`,
          },
        },
      });
      await browserNavigateFromTool(browser, computer, context, {
        url: "https://login.example.test/signin",
      });
      const ref = async (name: string) => {
        const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
          elements: Array<{ ref: string; name: string }>;
        };
        return snap.elements.find((el) => el.name.includes(name))!.ref;
      };
      for (const name of ["Username", "Query", "Website", "Pin"]) {
        const acted = await browserActFromTool(
          browser,
          computer,
          context,
          {
            actions: [
              {
                kind: "fill_secret",
                ref: await ref(name),
                secret: "site_login",
                field: "username",
              },
            ],
          },
          { resolveSecretFill },
        );
        expect(acted, name).toMatchObject({ ok: false, completed: 0 });
        expect(JSON.stringify(acted), name).toMatch(/text, email, or telephone/g);
      }
      const phone = await browserActFromTool(
        browser,
        computer,
        context,
        {
          actions: [
            {
              kind: "fill_secret",
              ref: await ref("Phone"),
              secret: "site_login",
              field: "username",
            },
          ],
        },
        { resolveSecretFill },
      );
      expect(phone).toMatchObject({ ok: true, completed: 1 });
    });

    it("refuses to type a saved login on a private-LAN HTTP origin", async () => {
      const origin = "http://192.168.2.10:8080";
      const browser = new FakeBrowserProvider({
        pages: {
          [`${origin}/signin`]: {
            title: "Sign in",
            html: `<!doctype html><html><head><title>Sign in</title></head><body>
              <input aria-label="Email" />
            </body></html>`,
          },
        },
      });
      await browserNavigateFromTool(browser, computer, context, { url: `${origin}/signin` });
      const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const email = snap.elements.find((el) => el.name.includes("Email"))!.ref;
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        { resolveSecretFill: async () => ({ text: values.username, origin }) },
      );
      expect(acted).toMatchObject({ ok: false, completed: 0 });
      expect(JSON.stringify(acted)).toMatch(/HTTPS/);
      expect(JSON.stringify(acted)).not.toContain(values.username);
    });

    it("refuses to type a saved login on another origin", async () => {
      const browser = loginPage("https://phish.example.test/signin");
      const { email } = await refs(browser, "https://phish.example.test/signin");
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        { resolveSecretFill },
      );
      expect(acted).toMatchObject({ ok: false, completed: 0 });
      expect(JSON.stringify(acted)).toMatch(/not on the site/);
    });

    it("acts on nothing when a saved login cannot be resolved", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email, password } = await refs(browser, "https://login.example.test/signin");
      const acted = await browserActFromTool(browser, computer, context, {
        actions: [
          { kind: "fill", ref: email, text: "typed-before" },
          { kind: "fill_secret", ref: password, secret: "site_login", field: "password" },
        ],
      });
      expect(acted).toEqual({
        ok: false,
        completed: 0,
        uncertain: false,
        error: "Saved logins are unavailable here.",
      });
      const snap = await browserSnapshotFromTool(browser, computer, context, {});
      expect(JSON.stringify(snap)).not.toContain("typed-before");
    });
  });

  it("maps uploads through trusted workspace paths before dispatching", async () => {
    const browser = new FakeBrowserProvider();
    const act = vi
      .spyOn(browser, "act")
      .mockResolvedValue({ ok: true, completed: 1, url: "https://example.test", title: "Page" });
    const resolve = vi.fn((value: string) => `/home/rakazo/${value}`);
    await browserActFromTool(
      browser,
      computer,
      context,
      {
        actions: [
          { kind: "upload", ref: "file-ref", paths: ["shared/report.txt", "bots/b1/chart.png"] },
        ],
      },
      { resolveUploadPath: resolve, uploadRoots: ["bots/b1", "shared"] },
    );
    expect(resolve.mock.calls.map(([value]) => value)).toEqual([
      "shared/report.txt",
      "bots/b1/chart.png",
    ]);
    expect(act).toHaveBeenCalledOnce();
    expect(act.mock.calls[0]?.[1].actions).toEqual([
      {
        kind: "upload",
        ref: "file-ref",
        paths: ["/home/rakazo/shared/report.txt", "/home/rakazo/bots/b1/chart.png"],
        roots: ["bots/b1", "shared"],
      },
    ]);
  });

  it.each(["missing-roots", "outside-root"])(
    "does not dispatch any step for %s upload authorization",
    async (failure) => {
      const browser = new FakeBrowserProvider();
      const act = vi.spyOn(browser, "act");
      const result = await browserActFromTool(
        browser,
        computer,
        context,
        {
          actions: [
            { kind: "click", ref: "before" },
            { kind: "upload", ref: "file-ref", paths: ["../other-bot/file"] },
          ],
        },
        {
          uploadRoots: failure === "missing-roots" ? [] : ["bots/b1"],
          resolveUploadPath: () => {
            throw new Error("Upload path is outside this workspace");
          },
        },
      );
      expect(result).toMatchObject({ ok: false, completed: 0, uncertain: false });
      expect(act).not.toHaveBeenCalled();
    },
  );

  it("rejects eleven uploads and malformed upload batches before resolving paths", async () => {
    const browser = new FakeBrowserProvider();
    const act = vi.spyOn(browser, "act");
    const resolve = vi.fn((value: string) => value);
    for (const paths of [[], Array.from({ length: 11 }, () => "shared/file"), [""], [42]]) {
      const result = await browserActFromTool(
        browser,
        computer,
        context,
        {
          actions: [{ kind: "upload", ref: "file-ref", paths }],
        },
        { resolveUploadPath: resolve, uploadRoots: ["shared"] },
      );
      expect(result).toMatchObject({ ok: false, completed: 0, uncertain: false });
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  it("keeps structured controls in details and redacts quoted secrets from both views", async () => {
    const secret = 'synthetic"password\n🙂';
    const browser = new FakeBrowserProvider();
    vi.spyOn(browser, "act").mockResolvedValue({
      ok: true,
      completed: 1,
      url: "https://example.test",
      title: "Page",
      tree: `Readable ${JSON.stringify(secret)}`,
      elements: [{ ref: "new-ref", role: "textbox", name: "Name", value: secret }],
    });
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      {
        actions: [{ kind: "click", ref: "ref" }],
      },
      { redactions: () => [secret] },
    );
    const modeled = browserResultForModel(result) as {
      kind: string;
      content: Array<{ type: string; text: string }>;
      details: unknown;
    };
    expect(modeled.kind).toBe("agent_tool_result");
    const view = JSON.parse(modeled.content[0]!.text);
    expect(view).not.toHaveProperty("elements");
    expect(modeled.details).toMatchObject({ elements: [{ ref: "new-ref", name: "Name" }] });
    expect(JSON.stringify(modeled)).not.toContain(secret);
    expect(modeled.content[0]!.text).not.toContain(JSON.stringify(secret).slice(1, -1));
  });

  it("preserves protocol refs and outcome fields while redacting short login values", () => {
    const ref = `r2.${Buffer.from(JSON.stringify(["target", "frame", "loader", "a".repeat(32)])).toString("base64url")}`;
    const result = redactBrowserResult(
      {
        ok: false,
        completed: 1,
        uncertain: false,
        fallback: "computer_act",
        tree: `Private a\n- button "a" [${ref}]`,
        elements: [{ ref, role: "button", name: "a", tag: "button" }],
      },
      ["a", "1"],
    ) as {
      completed: number;
      fallback: string;
      tree: string;
      elements: Array<{ ref: string; role: string; name: string }>;
    };
    expect(result.completed).toBe(1);
    expect(result.fallback).toBe("computer_act");
    expect(result.elements[0]).toMatchObject({ ref, role: "button", name: "[redacted]" });
    expect(result.tree).toContain(`[${ref}]`);
    expect(result.tree).not.toContain('"a"');
  });

  it("preserves existing provider refs when they contain a short saved login", () => {
    for (const ref of ["e1", "custom-page-1"]) {
      const result = redactBrowserResult(
        {
          elements: [{ ref, role: "button", name: "Private e1" }],
          tree: `- button "Private e1" [${ref}]`,
        },
        ["e", "1"],
      ) as { tree: string; elements: Array<{ ref: string; name: string }> };
      expect(result.elements[0]!.ref).toBe(ref);
      expect(result.elements[0]!.name).not.toContain("Private e1");
      expect(result.tree).toContain(`[${ref}]`);
    }
  });

  it("redacts page-controlled role and tag values while preserving protocol enums", () => {
    const result = redactBrowserResult(
      {
        tree: "public",
        elements: [
          { ref: "e1", role: "private-role-secret", tag: "private-tag-secret", name: "Save" },
          { ref: "e2", role: "button", tag: "button", name: "Save" },
        ],
      },
      ["private-role-secret", "private-tag-secret", "button"],
    ) as { elements: Array<{ role: string; tag: string }> };
    expect(result.elements[0]).toMatchObject({ role: "[redacted]", tag: "[redacted]" });
    expect(result.elements[1]).toMatchObject({ role: "button", tag: "button" });
  });

  it("protects registered option values without exempting page values that resemble tokens", () => {
    const token = `or2.${"a".repeat(32)}`;
    const raw = `or2.${"a".repeat(31)}b`;
    const result = redactBrowserResult(
      {
        elements: [
          {
            ref: "stable-ref",
            role: "combobox",
            name: "Choice",
            options: [
              { label: "Private a", value: token, valueRef: true },
              { label: "Public", value: raw },
            ],
          },
        ],
        tree: `Choice: ${token}, other: ${raw}`,
      },
      ["a"],
    ) as {
      tree: string;
      elements: Array<{ options: Array<{ value: string }> }>;
    };
    expect(result.elements[0]!.options[0]!.value).toBe(token);
    expect(result.elements[0]!.options[1]!.value).not.toBe(raw);
    expect(result.tree).toContain(token);
    expect(result.tree).not.toContain(raw);
  });

  it("bounds the final page model view after partial outcome and fallback metadata are added", () => {
    const result = {
      ok: false,
      completed: 1,
      uncertain: true,
      fallback: "computer_act",
      url: `https://example.test/${"u".repeat(2000)}`,
      tree: "body ".repeat(1950),
      error: "Uncertain operation ".repeat(15),
      note: "Inspect before continuing. ".repeat(8),
      elements: [{ ref: "stable-ref", role: "button", name: "Save", value: "x".repeat(2000) }],
    };
    const modeled = browserResultForModel(result) as {
      kind: string;
      content: Array<{ text: string }>;
      details: unknown;
    };
    expect(modeled.kind).toBe("agent_tool_result");
    expect(modeled.content[0]!.text.length).toBeLessThanOrEqual(12_000);
    const parsed = JSON.parse(modeled.content[0]!.text);
    expect(parsed.result ?? parsed).toMatchObject({
      completed: 1,
      uncertain: true,
      fallback: "computer_act",
    });
    expect(modeled.content[0]!.text).not.toContain('"elements"');
    expect(modeled.details).toBe(result);
  });

  it("keeps every complete control ref when clipping only the page text at the final bound", () => {
    const elements = Array.from({ length: 15 }, (_, i) => ({
      ref: `r2.${Buffer.from(JSON.stringify([`target${i}`, "frame", "loader", String(i).padStart(32, "a")])).toString("base64url")}`,
      role: "button",
      name: `Save ${i}`,
    }));
    const result = {
      ok: false,
      completed: 1,
      uncertain: true,
      fallback: "computer_act",
      url: `https://example.test/${"u".repeat(3000)}`,
      tree: `${"body ".repeat(1300)}\n${elements.map((e) => `- ${e.role} ${JSON.stringify(e.name)} [${e.ref}]`).join("\n")}`,
      error: "Uncertain operation ".repeat(60),
      elements,
    };
    const modeled = browserResultForModel(result) as {
      content: Array<{ text: string }>;
      details: unknown;
    };
    expect(modeled.content[0]!.text.length).toBeLessThanOrEqual(12_000);
    const view = JSON.parse(modeled.content[0]!.text);
    expect(view).toMatchObject({ completed: 1, uncertain: true });
    for (const element of elements) expect(view.tree).toContain(`[${element.ref}]`);
    expect(view.tree).toContain("[page text truncated]");
    expect(modeled.details).toBe(result);
  });

  it("omits oversized page metadata without truncating a URL into another address", () => {
    const result = {
      ok: false,
      completed: 1,
      uncertain: true,
      url: `https://example.test/${"x".repeat(13000)}`,
      tree: '- button "Save" [stable-ref]',
      elements: [{ role: "button", name: "Save", ref: "stable-ref" }],
    };
    const modeled = browserResultForModel(result) as {
      content: Array<{ text: string }>;
      details: unknown;
    };
    const view = JSON.parse(modeled.content[0]!.text);
    expect(view).toMatchObject({ ok: false, completed: 1, uncertain: true, snapshotOmitted: true });
    expect(view).not.toHaveProperty("url");
    expect(modeled.details).toBe(result);
  });

  it("toggles checkboxes via click without undoing activation", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/form": {
          title: "Form",
          html: `<!doctype html><html><head><title>Form</title></head><body>
            <label><input type="checkbox" aria-label="Agree" /> Agree</label>
          </body></html>`,
        },
      },
    });
    await browserNavigateFromTool(browser, computer, context, { url: "https://example.test/form" });
    const before = await browserSnapshotFromTool(browser, computer, context, {});
    const agree = (
      before as { elements: Array<{ ref: string; name: string; value?: string }> }
    ).elements.find((el) => el.name.includes("Agree"))!;
    expect(agree.value).toMatch(/unchecked|false|^$/i);
    const acted = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "click", ref: agree.ref }],
    });
    expect(acted).toMatchObject({ ok: true });
    const after = await browserSnapshotFromTool(browser, computer, context, {});
    const toggled = (after as { elements: Array<{ name: string; value?: string }> }).elements.find(
      (el) => el.name.includes("Agree"),
    )!;
    expect(toggled.value).toMatch(/checked|true/i);
  });

  it("falls back to computer_act for link navigation the in-process page cannot load", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/start": {
          title: "Start",
          html: `<!doctype html><html><head><title>Start</title></head><body>
            <a href="https://example.test/next">Next</a>
          </body></html>`,
        },
      },
    });
    await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test/start",
    });
    const snap = await browserSnapshotFromTool(browser, computer, context, {});
    const link = (snap as { elements: Array<{ ref: string; name: string }> }).elements.find((el) =>
      el.name.includes("Next"),
    )!;
    const acted = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "click", ref: link.ref }],
    });
    expect(acted).toMatchObject({
      ok: false,
      fallback: "computer_act",
      error: expect.stringMatching(/cannot navigate links|computer_act/i),
    });
  });

  it("surfaces computer_act fallback from the tool layer", async () => {
    const browser = new FakeBrowserProvider();
    browser.forceFallback = "cannot attach to page";
    const result = await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test",
    });
    expect(result).toMatchObject({
      fallback: "computer_act",
      note: expect.stringMatching(/computer_act/i),
    });
  });

  it("hides page browser tools when the computer is not graphical", () => {
    const tools = [...PAGE_BROWSER_TOOL_NAMES].map((name) => ({ name }));
    expect(filterPageBrowserTools(tools, true)).toHaveLength(3);
    expect(filterPageBrowserTools(tools, false)).toEqual([]);
    expect(filterPageBrowserTools([{ name: "computer_act" }, ...tools], false)).toEqual([
      { name: "computer_act" },
    ]);
  });
});
