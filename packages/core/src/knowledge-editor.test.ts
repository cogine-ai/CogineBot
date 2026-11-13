import type { AgentSkill, MemoryDocument } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeSection, KnowledgeState } from "./knowledge-editor.js";
import { createKnowledgeEditor, initialKnowledgeState } from "./knowledge-editor.js";

const document = (id = "doc-a", content = "Saved"): MemoryDocument => ({
  id,
  scope: "bot",
  botId: "bot-a",
  path: "MEMORY.md",
  content,
  revision: 1,
  updatedAt: new Date(0).toISOString(),
});
const skill = (id = "skill-a", readOnly = false): AgentSkill => ({
  id,
  name: id,
  description: "Synthetic",
  content: "Saved skill",
  source: readOnly ? "builtin" : "user",
  readOnly,
  createdAt: "",
  updatedAt: "",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(section: KnowledgeSection = "bot", botId = "bot-a") {
  let state: KnowledgeState = initialKnowledgeState;
  let current = true;
  const request = vi.fn();
  request.mockImplementation(async (procedure: string) => {
    if (procedure === "memory/list") return state.documents;
    throw new Error(`Unexpected ${procedure}`);
  });
  const deliver = vi.fn(async (_text: string, valid: () => boolean) => {
    expect(valid()).toBe(true);
  });
  const editor = createKnowledgeEditor({
    client: { isCurrent: () => current, request },
    botId,
    section,
    changed: (next) => {
      state = next;
    },
    deliver,
  });
  return {
    editor,
    request,
    deliver,
    state: () => state,
    stale: () => {
      current = false;
    },
  };
}

describe("saved memory documents", () => {
  it.each(["bot", "user"] as const)(
    "reads and exports only the selected %s scope",
    async (section) => {
      const h = setup(section, "bot-b");
      h.request.mockResolvedValue([document()]);
      await h.editor.refresh();
      expect(h.request.mock.calls[0]?.slice(0, 2)).toEqual([
        "memory/list",
        section === "bot" ? { scope: "bot", botId: "bot-b" } : { scope: "user" },
      ]);
      await h.editor.openDocument(h.state().documents[0]!);
      h.editor.edit("Unsaved");
      await h.editor.exportMarkdown();
      expect(h.deliver).toHaveBeenCalledWith("# MEMORY.md\n\nSaved", expect.any(Function));
      expect(h.state().draft).toBe("Unsaved");
    },
  );
  it("keeps a failed draft but exports server readback, including an uncertain committed write", async () => {
    const h = setup();
    h.request.mockResolvedValueOnce([document()]);
    await h.editor.refresh();
    await h.editor.openDocument(document());
    h.editor.edit("Unconfirmed");
    h.request.mockRejectedValueOnce(new Error("Connection lost"));
    await h.editor.save();
    expect(h.state().error).toBe("save");
    expect(h.state().draft).toBe("Unconfirmed");
    expect(h.state().documents[0]?.content).toBe("Saved");
    h.request.mockResolvedValueOnce([document("doc-a", "Committed by server")]);
    await h.editor.exportMarkdown();
    expect(h.deliver.mock.calls[0]?.[0]).toBe("# MEMORY.md\n\nCommitted by server");
  });
  it("uses the returned saved content, and cancellation restores it", async () => {
    const h = setup();
    h.request.mockResolvedValueOnce([document()]);
    await h.editor.refresh();
    await h.editor.openDocument(document());
    h.editor.edit("Draft");
    h.request.mockResolvedValueOnce(document("doc-a", "Saved result"));
    await h.editor.save();
    expect(h.state().editor).toBeNull();
    await h.editor.openDocument(h.state().documents[0]!);
    h.editor.edit("Cancelled");
    h.editor.cancel();
    await h.editor.openDocument(h.state().documents[0]!);
    expect(h.state().draft).toBe("Saved result");
  });
  it("does not share cached data after a failed export readback", async () => {
    const h = setup();
    h.request.mockResolvedValueOnce([document()]);
    await h.editor.refresh();
    h.request.mockRejectedValueOnce(new Error("Offline"));
    await h.editor.exportMarkdown();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.state().error).toBe("export");
  });
});

describe("selection and lifetime isolation", () => {
  it.each(["resolve", "reject"] as const)(
    "ignores a late %s after cancellation and another object opens",
    async (outcome) => {
      const h = setup();
      h.request.mockResolvedValueOnce([document(), document("doc-b", "B")]);
      await h.editor.refresh();
      await h.editor.openDocument(document());
      h.editor.edit("A draft");
      const late = deferred<MemoryDocument>();
      h.request.mockReturnValueOnce(late.promise);
      const saving = h.editor.save();
      h.editor.cancel();
      h.request.mockResolvedValueOnce([document(), document("doc-b", "B")]);
      await h.editor.openDocument(document("doc-b", "B"));
      expect(h.request).toHaveBeenLastCalledWith(
        "memory/list",
        { botId: "bot-a", scope: "bot" },
        expect.any(AbortSignal),
      );
      if (outcome === "resolve") late.resolve(document("doc-a", "A result"));
      else late.reject(new Error("Late failure"));
      await saving;
      expect(h.state().draft).toBe("B");
      expect(h.state().error).toBeNull();
      expect(h.state().editor).toMatchObject({ document: { id: "doc-b" } });
    },
  );
  it.each(["dispose", "scope"] as const)("blocks export delivery after %s", async (reason) => {
    const h = setup();
    const late = deferred<MemoryDocument[]>();
    h.request.mockReturnValue(late.promise);
    const exporting = h.editor.exportMarkdown();
    if (reason === "dispose") h.editor.dispose();
    else h.stale();
    late.resolve([document()]);
    await exporting;
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.state().documents).toEqual([]);
  });
  it("invalidates an old share callback after a switch", async () => {
    const h = setup();
    h.request.mockResolvedValue([document()]);
    await h.editor.exportMarkdown();
    const valid = h.deliver.mock.calls[0]![1];
    h.editor.dispose();
    expect(valid()).toBe(false);
  });
  it("ignores a slow skill open after cancellation and a new draft", async () => {
    const h = setup("skills");
    const late = deferred<AgentSkill>();
    h.request.mockReturnValueOnce(late.promise);
    const opening = h.editor.openSkill("skill-a");
    h.editor.cancel();
    h.editor.createSkill("New draft");
    late.resolve(skill());
    await opening;
    expect(h.state().editor).toEqual({ kind: "skill", skill: null });
    expect(h.state().draft).toBe("New draft");
  });
});

describe("shared skills", () => {
  it("creates, opens, updates and deletes through existing authenticated procedures", async () => {
    const h = setup("skills");
    h.request.mockResolvedValueOnce([]);
    await h.editor.refresh();
    h.editor.createSkill("New");
    h.request.mockResolvedValueOnce(skill());
    await h.editor.save();
    expect(h.state().skills).toEqual([skill()]);
    h.request.mockResolvedValueOnce(skill());
    await h.editor.openSkill("skill-a");
    h.editor.edit("Edited");
    h.request.mockResolvedValueOnce({ ...skill(), content: "Edited" });
    await h.editor.save();
    expect(h.request).toHaveBeenCalledWith(
      "agentSkills/update",
      { skillId: "skill-a", content: "Edited" },
      expect.any(AbortSignal),
    );
    h.request.mockResolvedValueOnce(skill());
    await h.editor.openSkill("skill-a");
    h.request.mockResolvedValueOnce({ ok: true });
    await h.editor.remove("skill-a");
    expect(h.state().skills).toEqual([]);
  });
  it("never mutates a read-only skill and ignores an old deletion confirmation", async () => {
    const h = setup("skills");
    h.request.mockResolvedValueOnce(skill("builtin", true));
    await h.editor.openSkill("builtin");
    h.editor.edit("Forbidden");
    await h.editor.save();
    await h.editor.remove();
    expect(h.state().draft).toBe("Saved skill");
    expect(h.request).toHaveBeenCalledTimes(1);
    h.editor.cancel();
    h.request.mockResolvedValueOnce(skill("skill-b"));
    await h.editor.openSkill("skill-b");
    await h.editor.remove("skill-a");
    expect(h.request).toHaveBeenCalledTimes(2);
  });
  it("retains editable content on save/delete failures and serializes double taps", async () => {
    const h = setup("skills");
    h.request.mockResolvedValueOnce(skill());
    await h.editor.openSkill("skill-a");
    h.editor.edit("Retain me");
    const late = deferred<AgentSkill>();
    h.request.mockReturnValueOnce(late.promise);
    const save = h.editor.save();
    await h.editor.save();
    expect(h.request).toHaveBeenCalledTimes(2);
    late.reject(new Error("Denied"));
    await save;
    expect(h.state().draft).toBe("Retain me");
    h.request.mockRejectedValueOnce(new Error("Denied"));
    await h.editor.remove();
    expect(h.state().error).toBe("delete");
    expect(h.state().draft).toBe("Retain me");
  });
});

it("preserves the unresolved save failure across successful and failed exports until save or cancel", async () => {
  const h = setup();
  h.request.mockResolvedValueOnce([document()]);
  await h.editor.refresh();
  await h.editor.openDocument(document());
  h.editor.edit("Unsaved");
  h.request.mockRejectedValueOnce(new Error("Lost save"));
  await h.editor.save();
  h.request.mockResolvedValueOnce([document()]);
  await h.editor.exportMarkdown();
  expect(h.state()).toMatchObject({ draft: "Unsaved", saveError: true });
  expect(h.deliver.mock.calls[0]?.[0]).toBe("# MEMORY.md\n\nSaved");
  h.request.mockRejectedValueOnce(new Error("Offline"));
  await h.editor.exportMarkdown();
  expect(h.state()).toMatchObject({ error: "export", saveError: true });
  h.request.mockResolvedValueOnce(document("doc-a", "Unsaved"));
  await h.editor.save();
  expect(h.state()).toMatchObject({ editor: null, saveError: false });
  await h.editor.openDocument(document());
  h.request.mockRejectedValueOnce(new Error("Offline"));
  await h.editor.save();
  h.editor.cancel();
  expect(h.state()).toMatchObject({ error: null, saveError: false });
});

it("does not reopen uncertain memory from cache when verification fails or scope changes", async () => {
  const h = setup();
  h.request.mockResolvedValueOnce([document()]);
  await h.editor.refresh();
  await h.editor.openDocument(document());
  h.editor.edit("Committed but unacknowledged");
  h.request.mockRejectedValueOnce(new Error("Lost response"));
  await h.editor.save();
  h.request.mockRejectedValueOnce(new Error("Readback offline"));
  await h.editor.openDocument(document());
  expect(h.state().draft).toBe("Committed but unacknowledged");
  expect(h.state()).toMatchObject({ error: "load", saveError: true });
  h.editor.cancel();
  h.request.mockRejectedValueOnce(new Error("Still offline"));
  await h.editor.openDocument(document());
  expect(h.state().editor).toBeNull();
  const late = deferred<MemoryDocument[]>();
  h.request.mockReturnValueOnce(late.promise);
  const opening = h.editor.openDocument(document());
  h.stale();
  late.resolve([document("doc-a", "Late private content")]);
  await opening;
  expect(h.state().editor).toBeNull();
  expect(h.state().draft).toBe("");
});

it("binds recovered creation identity before a failed follow-up and keeps the same nonce", async () => {
  const h = setup("skills");
  h.editor.createSkill("Initial");
  h.request.mockRejectedValueOnce(new Error("Unknown commit"));
  await h.editor.save();
  const nonce = h.request.mock.calls[0]![1].clientNonce;
  expect(nonce).toEqual(expect.any(String));
  h.editor.edit("Renamed draft");
  h.request.mockResolvedValueOnce(skill()).mockRejectedValueOnce(new Error("Update offline"));
  await h.editor.save();
  expect(h.request.mock.calls[1]!.slice(0, 2)).toEqual([
    "agentSkills/create",
    { clientNonce: nonce, content: "Renamed draft" },
  ]);
  expect(h.state()).toMatchObject({
    editor: { skill: { id: "skill-a" } },
    draft: "Renamed draft",
    saveError: true,
  });
  h.request.mockResolvedValueOnce({ ...skill(), content: "Renamed draft" });
  await h.editor.save();
  expect(h.request.mock.calls[3]!.slice(0, 2)).toEqual([
    "agentSkills/update",
    { skillId: "skill-a", content: "Renamed draft" },
  ]);
  expect(h.state()).toMatchObject({ editor: null, saveError: false });
});

it.each(["cancel", "scope"] as const)(
  "discards recovered identity after %s without dispatching an update",
  async (change) => {
    const h = setup("skills");
    h.editor.createSkill("Initial");
    h.request.mockRejectedValueOnce(new Error("Lost response"));
    await h.editor.save();
    const delayed = deferred<AgentSkill>();
    h.request.mockReturnValueOnce(delayed.promise);
    const recovering = h.editor.save();
    if (change === "cancel") {
      h.editor.cancel();
      h.editor.createSkill("Different intent");
    } else h.stale();
    delayed.resolve(skill());
    await recovering;
    expect(h.request.mock.calls.filter(([p]) => p === "agentSkills/update")).toHaveLength(0);
    expect(h.state().editor).toMatchObject({ skill: null });
    if (change === "cancel") expect(h.state().draft).toBe("Different intent");
  },
);

it("readback refreshes saved memory without discarding a failed draft or its error", async () => {
  const h = setup();
  h.request.mockResolvedValueOnce([document()]);
  await h.editor.refresh();
  await h.editor.openDocument(document());
  h.editor.edit("Unsaved local draft");
  h.request.mockRejectedValueOnce(new Error("Uncertain save"));
  await h.editor.save();
  h.request.mockResolvedValueOnce([document("doc-a", "Server version")]);
  await h.editor.openDocument(document());
  expect(h.state()).toMatchObject({
    draft: "Unsaved local draft",
    saveError: true,
    editor: { document: { content: "Server version" } },
  });
  h.editor.cancel();
  await h.editor.openDocument(document());
  expect(h.state()).toMatchObject({ draft: "Server version", saveError: false });
});

it("export readback updates the saved baseline without treating the remaining draft as saved", async () => {
  const h = setup();
  h.request.mockResolvedValueOnce([document()]);
  await h.editor.refresh();
  await h.editor.openDocument(document());
  h.editor.edit("First submitted draft");
  h.request.mockRejectedValueOnce(new Error("Lost response"));
  await h.editor.save();
  h.editor.edit("Saved"); // User now wants to restore the original text.
  h.request.mockResolvedValueOnce([document("doc-a", "First submitted draft")]);
  await h.editor.exportMarkdown();
  expect(h.state()).toMatchObject({
    draft: "Saved",
    saveError: true,
    editor: { document: { content: "First submitted draft" } },
  });
  expect(h.deliver.mock.calls[0]?.[0]).toBe("# MEMORY.md\n\nFirst submitted draft");
});

it.each(["cancel", "scope"] as const)(
  "ignores a delayed memory open after %s without replacing another draft",
  async (change) => {
    const h = setup();
    const first = document();
    const second = document("doc-b", "B saved");
    h.request.mockResolvedValueOnce([first, second]);
    await h.editor.refresh();
    const late = deferred<MemoryDocument[]>();
    h.request.mockReturnValueOnce(late.promise);
    const opening = h.editor.openDocument(first);
    h.editor.cancel();
    if (change === "scope") h.stale();
    else {
      h.request.mockResolvedValueOnce([first, second]);
      await h.editor.openDocument(second);
      h.editor.edit("B local draft");
    }
    late.resolve([document("doc-a", "A late response"), second]);
    await opening;
    if (change === "scope") expect(h.state().editor).toBeNull();
    else
      expect(h.state()).toMatchObject({
        draft: "B local draft",
        editor: { document: { id: "doc-b" } },
      });
  },
);
