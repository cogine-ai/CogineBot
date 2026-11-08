// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { SANDBOXED_ARTIFACT_CSP } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HTML_VIEWER_PATH, PREVIEW_CSP, SandboxedHtmlViewer } from "./SandboxedHtmlViewer";

const shell = readFileSync(
  path.join(import.meta.dirname, "../../public", HTML_VIEWER_PATH),
  "utf8",
);

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountViewer() {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  return {
    async render(
      html: string,
      documentKey?: string,
      onFrameMessage?: Parameters<typeof SandboxedHtmlViewer>[0]["onFrameMessage"],
      kind?: Parameters<typeof SandboxedHtmlViewer>[0]["kind"],
    ) {
      await act(async () =>
        root.render(
          <SandboxedHtmlViewer
            html={html}
            title="Notes"
            documentKey={documentKey}
            onFrameMessage={onFrameMessage}
            kind={kind}
          />,
        ),
      );
      return container.querySelector("iframe")!;
    },
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function watchFrame(frame: HTMLIFrameElement) {
  const source = frame.contentWindow!;
  const post = vi.spyOn(source, "postMessage").mockImplementation(() => {});
  return {
    source,
    post,
    load() {
      frame.dispatchEvent(new Event("load"));
      return post.mock.lastCall?.[0] as { instance: string; document: string };
    },
  };
}

it("posts the guarded document to a network shell and mounts a new frame per document identity", async () => {
  const view = await mountViewer();
  try {
    const html = '<img src="https://example.invalid/pixel.png">';
    const first = await view.render(html, "page-1:1");
    const a = watchFrame(first);
    expect(first.getAttribute("src")).toBe(HTML_VIEWER_PATH);
    expect(first.hasAttribute("srcdoc")).toBe(false);
    expect(first.getAttribute("sandbox")).toBe("allow-scripts");
    expect(first.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(first.hasAttribute("allow")).toBe(false);
    expect(a.post).not.toHaveBeenCalled();
    const initial = a.load();
    expect(a.post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "rakazo-viewer:load",
        interactive: false,
        instance: expect.stringMatching(/^[0-9a-f]{32}$/),
      }),
      "*",
    );
    expect(initial.document).toContain(SANDBOXED_ARTIFACT_CSP);
    expect(initial.document).not.toContain("media-src");
    expect(initial.document).toContain('<meta name="referrer" content="no-referrer">');
    expect(initial.document).toContain(html);
    expect(await view.render(html, "page-1:1")).toBe(first);
    const changedVersion = await view.render(html, "page-1:2");
    expect(changedVersion).not.toBe(first);
    const next = watchFrame(changedVersion);
    expect(next.load().instance).not.toBe(initial.instance);
    expect(await view.render("<p>Changed HTML</p>", "page-1:2")).not.toBe(changedVersion);
  } finally {
    await view.cleanup();
  }
});

it("remounts when switching the same document from Artifact policy to Page policy", async () => {
  const view = await mountViewer();
  try {
    const html = "<audio></audio>";
    const artifact = await view.render(html, "same");
    const page = await view.render(html, "same", undefined, "page");
    expect(page).not.toBe(artifact);
    expect(watchFrame(page).load().document).toContain(PREVIEW_CSP);
  } finally {
    await view.cleanup();
  }
});

it("accepts only the active opaque Window and instance, including when the same frame reloads", async () => {
  const view = await mountViewer();
  const received = vi.fn();
  const send = (source: Window, instance: string, origin = "null") =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source,
        origin,
        data: {
          type: "rakazo-viewer:message",
          instance,
          message: { type: "rakazo-page:height", height: 240 },
        },
      }),
    );
  try {
    const first = watchFrame(await view.render("<p>Same</p>", "page-1", received));
    const initial = first.load();
    send(window, initial.instance);
    send(first.source, "wrong");
    send(first.source, initial.instance, "https://example.invalid");
    expect(received).not.toHaveBeenCalled();
    send(first.source, initial.instance);
    const answerOldLoad = received.mock.lastCall?.[1] as (message: object) => void;

    const reload = first.load();
    send(first.source, initial.instance);
    answerOldLoad({ type: "rakazo-page:copied" });
    expect(first.post).toHaveBeenCalledTimes(2);
    expect(received).toHaveBeenCalledTimes(1);
    send(first.source, reload.instance);
    const answerOldFrame = received.mock.lastCall?.[1] as (message: object) => void;

    const second = watchFrame(await view.render("<p>Same</p>", "page-2", received));
    const current = second.load();
    send(first.source, current.instance);
    send(second.source, reload.instance);
    answerOldFrame({ type: "rakazo-page:copied" });
    expect(second.post).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledTimes(2);
    send(second.source, current.instance);
    const answerCurrent = received.mock.lastCall?.[1] as (message: object) => void;
    const result = { type: "rakazo-page:copied", id: "copy-1", ok: true };
    answerCurrent(result);
    expect(second.post).toHaveBeenLastCalledWith(
      { type: "rakazo-viewer:answer", instance: current.instance, message: result },
      "*",
    );
  } finally {
    await view.cleanup();
  }
});

it("uses the same networkless policy for the shell and nested opaque preview", () => {
  const preview = shell.match(/<iframe id="preview"[^>]*>/)?.[0] ?? "";
  const policy = shell.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];
  expect(preview).toContain('sandbox="allow-scripts"');
  expect(preview).toContain('referrerpolicy="no-referrer"');
  expect(preview).toContain(`csp="${PREVIEW_CSP}"`);
  expect(policy).toContain(
    PREVIEW_CSP.replace("form-action", "frame-src about:; child-src 'none'; form-action"),
  );
  expect(shell).not.toContain("allow-same-origin");
  expect(PREVIEW_CSP).not.toMatch(/https?:/);
});

function mountShell(embedded = true) {
  const script = shell.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("shell script missing");
  const child = { postMessage: vi.fn() };
  const preview = { srcdoc: "", contentWindow: child };
  const parent = { postMessage: vi.fn() };
  const activation = { isActive: true };
  let listener: ((event: { source: unknown; data: unknown; origin: string }) => void) | undefined;
  new Function("addEventListener", "parent", "window", "document", "navigator", script)(
    (_type: string, handler: typeof listener) => {
      listener = handler;
    },
    parent,
    embedded ? {} : parent,
    { getElementById: () => preview },
    { userActivation: activation },
  );
  const instance = "a".repeat(32);
  return {
    preview,
    child,
    parent,
    activation,
    instance,
    load: (interactive: boolean, source = parent) =>
      listener?.({
        source,
        origin: "https://example.invalid",
        data: {
          type: "rakazo-viewer:load",
          instance,
          document: "<!DOCTYPE html><p>Hello</p>",
          interactive,
        },
      }),
    parentMessage: (data: object) =>
      listener?.({ source: parent, data, origin: "https://example.invalid" }),
    page: (data: object, origin = "null") => listener?.({ source: child, data, origin }),
  };
}

it("loads only a single host document in a shell, and never forwards actions from a preview", () => {
  const view = mountShell();
  view.load(true, { postMessage: vi.fn() });
  expect(view.preview.srcdoc).toBe("");
  view.load(false);
  expect(view.preview.srcdoc).toBe("<!DOCTYPE html><p>Hello</p>");
  view.load(true);
  view.page({ type: "rakazo-page:copy", id: "x", text: "no" });
  view.page({ type: "rakazo-page:height", height: Infinity });
  view.page({ type: "rakazo-page:height", height: 240 }, "https://example.invalid");
  view.page({ type: "rakazo-page:height", height: 240 });
  expect(view.parent.postMessage.mock.calls).toEqual([
    [
      {
        type: "rakazo-viewer:message",
        instance: view.instance,
        message: { type: "rakazo-page:height", height: 240 },
      },
      "*",
    ],
  ]);
  const direct = mountShell(false);
  direct.load(true);
  expect(direct.preview.srcdoc).toBe("");
});

it("vouches only for a fresh active gesture and forwards only a matching copy receipt", () => {
  const view = mountShell();
  view.load(true);
  expect(view.preview.srcdoc).toMatch(/^<!DOCTYPE html><script>/);
  const key = /key = "([a-f0-9]+)"/.exec(view.preview.srcdoc)?.[1];
  expect(key).toBeTruthy();
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const signal = (value = key) => view.page({ type: "rakazo-page:gesture", key: value });
  const copy = (id: string) => view.page({ type: "rakazo-page:copy", id, text: id });
  copy("automatic");
  signal("fake");
  copy("forged");
  signal();
  copy("first");
  now.mockReturnValue(2_001);
  copy("expired");
  view.activation.isActive = false;
  signal();
  copy("inactive");
  expect(view.parent.postMessage.mock.calls).toEqual([
    [
      {
        type: "rakazo-viewer:message",
        instance: view.instance,
        message: { type: "rakazo-page:copy", id: "first", text: "first", gesture: `${key}:1` },
      },
      "*",
    ],
  ]);
  const receipt = { type: "rakazo-page:copied", id: "first", ok: true };
  view.parentMessage({ type: "rakazo-viewer:answer", instance: "stale", message: receipt });
  view.parentMessage({
    type: "rakazo-viewer:answer",
    instance: view.instance,
    message: { ...receipt, ok: "true" },
  });
  view.parentMessage({ type: "rakazo-viewer:answer", instance: view.instance, message: receipt });
  expect(view.child.postMessage.mock.calls).toEqual([[receipt, "*"]]);
});

it("relays draw results only with the current interactive frame's private key", () => {
  const view = mountShell();
  view.load(true);
  const key = /key = "([a-f0-9]+)"/.exec(view.preview.srcdoc)?.[1];
  expect(key).toBeTruthy();
  expect(view.preview.srcdoc).toContain("__coginePageReportDraw");
  view.page({ type: "rakazo-page:drawn", drawn: true });
  view.page({ type: "rakazo-page:drawn", key: "stale", drawn: true });
  view.page({ type: "rakazo-page:drawn", key, drawn: "true" });
  view.page({ type: "rakazo-page:drawn", key, drawn: true }, "https://example.invalid");
  expect(view.parent.postMessage).not.toHaveBeenCalled();

  for (const drawn of [true, false]) {
    view.page({ type: "rakazo-page:drawn", key, drawn });
  }
  expect(view.parent.postMessage.mock.calls).toEqual(
    [true, false].map((drawn) => [
      {
        type: "rakazo-viewer:message",
        instance: view.instance,
        message: { type: "rakazo-page:drawn", drawn },
      },
      "*",
    ]),
  );
});
