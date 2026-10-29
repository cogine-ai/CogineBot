// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarAnnouncements } from "../lib/use-sidebar-announcements";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${index ? values[index - 1] : ""}${part}`, ""),
  }),
}));
const testFileUrl = import.meta.url;
const source = readFileSync(new URL("./Shell.tsx", testFileUrl), "utf8");
function slice(from: string, to: string) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`Sidebar implementation not found: ${from}`);
  return source.slice(start, end);
}
const move = slice("  const moveChatToSection =", "  const renameSection =");
const reorder = slice("  const reorderSection =", "  const stepSection =");
const drop = `${slice(
  "                    onDrop={(event) => {",
  "                      setDraggedBotId(null);",
).replace("                    onDrop={", "")}\n setDraggedBotId(null); }`;

type Chat = {
  kind: "bot" | "group";
  chat: { id: string; spaceId: string; sectionId: string | null; pinned: boolean };
};
let cleanup = async () => {};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function setup({
  chat,
  section,
  target = "target",
  failure = false,
}: {
  chat?: Chat;
  section?: string;
  target?: string | null;
  failure?: boolean;
}) {
  let controls!: ReturnType<typeof useSidebarAnnouncements>;
  function Sidebar() {
    controls = useSidebarAnnouncements("scope");
    return <div role="status">{controls.text}</div>;
  }
  const view = document.createElement("div"),
    root = createRoot(view);
  cleanup = async () => {
    await act(async () => root.unmount());
  };
  await act(async () => root.render(<Sidebar />));
  let finish!: () => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((yes, no) => {
    finish = yes;
    reject = no;
  });
  const saveChat = vi.fn(() => pending),
    saveOrder = vi.fn(() => pending);
  const report = vi.fn();
  const env = {
    saveChatOrganization: saveChat,
    expandSection: vi.fn(),
    setSidebarNotice: vi.fn(),
    t: (parts: TemplateStringsArray) => parts.join(""),
    sectionsForSpace: () => [{ id: "source" }, { id: "target" }],
    saveSectionOrder: saveOrder,
    sidebarAnnouncements: controls,
    draggedSection: section ? { id: section, spaceId: "space" } : null,
    draggedChat: chat ?? null,
    group: { sectionId: target, spaceId: "space", kind: "section" },
    setDraggedChat: vi.fn(),
    setDraggedSection: vi.fn(),
    setDraggedBotId: vi.fn(),
    reportSidebarError: report,
  };
  const handler = new Function(
    ...Object.keys(env),
    stripTypeScriptTypes(`function createDrop() { ${move}\n${reorder}\nreturn (${drop}); }`) +
      "; return createDrop();",
  )(...Object.values(env)) as (event: { preventDefault(): void }) => void;
  await act(async () => {
    controls.start("Research");
    controls.target("Product");
    handler({ preventDefault() {} });
    controls.end();
  });
  const flush = async () => {
    await act(async () => vi.runOnlyPendingTimers());
  };
  await flush();
  const settle = async () => {
    await act(async () => {
      if (failure) reject(new Error("Offline"));
      else finish();
    });
    await flush();
  };
  return { view, saveChat, saveOrder, report, settle };
}
function chat(sectionId: string | null, pinned = false, kind: Chat["kind"] = "bot"): Chat {
  return { kind, chat: { id: "chat", spaceId: "space", sectionId, pinned } };
}
describe("actual Shell drop persistence announcements", () => {
  it.each(["bot-current", "group-unassigned", "section-self", "missing-section"])(
    "announces cancellation rather than a saved move for %s",
    async (kind) => {
      const value = await setup(
        kind === "bot-current"
          ? { chat: chat("target") }
          : kind === "group-unassigned"
            ? { chat: chat(null, false, "group"), target: null }
            : kind === "section-self"
              ? { section: "target" }
              : { section: "missing" },
      );
      expect(value.saveChat).not.toHaveBeenCalled();
      expect(value.saveOrder).not.toHaveBeenCalled();
      expect(value.view.textContent).toContain("Move cancelled");
      expect(value.view.textContent).not.toContain("Moved Research");
    },
  );
  it.each(["chat", "pinned-current", "section"])(
    "waits for the actual %s save before success",
    async (kind) => {
      const value = await setup(
        kind === "section"
          ? { section: "source" }
          : {
              chat: chat(
                kind === "pinned-current" ? "target" : "source",
                kind === "pinned-current",
              ),
            },
      );
      expect(value.saveChat.mock.calls.length + value.saveOrder.mock.calls.length).toBe(1);
      expect(value.view.textContent).not.toContain("Moved Research");
      await value.settle();
      expect(value.view.textContent).toBe("Moved Research");
    },
  );
  it.each(["chat", "section"])("does not announce a failed %s save as moved", async (kind) => {
    const value = await setup({
      ...(kind === "chat" ? { chat: chat("source") } : { section: "source" }),
      failure: true,
    });
    await value.settle();
    expect(value.report).toHaveBeenCalledOnce();
    expect(value.view.textContent).toBe("Could not move Research");
  });
});
