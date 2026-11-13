import type { AgentSkill, AgentSkillCatalogEntry, MemoryDocument } from "@rakazo/contracts";

/** The transport pins the authenticated user and Space; the editor pins its Bot and selection. */
export type KnowledgeClient = {
  isCurrent(): boolean;
  request<T>(procedure: string, input: unknown, signal?: AbortSignal): Promise<T>;
};
export type KnowledgeSection = "bot" | "user" | "skills";
type Editor =
  | { kind: "memory"; document: MemoryDocument }
  | { kind: "skill"; skill: AgentSkill | null };
export type KnowledgeState = {
  documents: MemoryDocument[];
  skills: AgentSkillCatalogEntry[];
  editor: Editor | null;
  draft: string;
  busy: boolean;
  loaded: boolean;
  error: "load" | "save" | "delete" | "export" | null;
};
export const initialKnowledgeState: KnowledgeState = {
  documents: [],
  skills: [],
  editor: null,
  draft: "",
  busy: false,
  loaded: false,
  error: null,
};

export function memoryDocumentsMarkdown(documents: readonly MemoryDocument[]): string {
  return documents.map((doc) => `# ${doc.path}\n\n${doc.content}`).join("\n\n");
}

export function createKnowledgeEditor(options: {
  client: KnowledgeClient;
  botId: string;
  section: KnowledgeSection;
  changed(state: KnowledgeState): void;
  deliver(markdown: string, isCurrent: () => boolean): Promise<void>;
}) {
  const { client, section, botId } = options;
  let state = { ...initialKnowledgeState };
  let generation = 0;
  let disposed = false;
  let pending: AbortController | null = null;
  const current = () => !disposed && client.isCurrent();
  const emit = (patch: Partial<KnowledgeState>) => {
    if (!current()) return;
    state = { ...state, ...patch };
    options.changed(state);
  };
  const invalidate = () => {
    generation += 1;
    pending?.abort();
    pending = null;
  };
  const memoryInput = section === "bot" ? { botId, scope: "bot" } : { scope: "user" };
  async function run(
    error: NonNullable<KnowledgeState["error"]>,
    work: (signal: AbortSignal, valid: () => boolean) => Promise<void>,
  ) {
    if (!current() || state.busy) return;
    invalidate();
    const ticket = generation;
    const controller = new AbortController();
    pending = controller;
    const valid = () => current() && generation === ticket;
    emit({ busy: true, error: null });
    try {
      await work(controller.signal, valid);
    } catch {
      if (valid()) emit({ error });
    } finally {
      if (valid()) {
        pending = null;
        emit({ busy: false });
      }
    }
  }
  return {
    refresh() {
      return run("load", async (signal, valid) => {
        if (section === "skills") {
          const skills = await client.request<AgentSkillCatalogEntry[]>(
            "agentSkills/list",
            {},
            signal,
          );
          if (valid()) emit({ skills, loaded: true });
        } else {
          const documents = await client.request<MemoryDocument[]>(
            "memory/list",
            memoryInput,
            signal,
          );
          if (valid()) emit({ documents, loaded: true });
        }
      });
    },
    openDocument(document: MemoryDocument) {
      const saved = state.documents.find((d) => d.id === document.id);
      if (!current() || state.busy || !saved) return;
      invalidate();
      emit({ editor: { kind: "memory", document: saved }, draft: saved.content, error: null });
    },
    openSkill(skillId: string) {
      return run("load", async (signal, valid) => {
        const skill = await client.request<AgentSkill>("agentSkills/get", { skillId }, signal);
        if (valid()) emit({ editor: { kind: "skill", skill }, draft: skill.content });
      });
    },
    createSkill(template: string) {
      if (!current() || state.busy || section !== "skills") return;
      invalidate();
      emit({ editor: { kind: "skill", skill: null }, draft: template, error: null });
    },
    edit(draft: string) {
      if (!state.busy && !(state.editor?.kind === "skill" && state.editor.skill?.readOnly))
        emit({ draft });
    },
    cancel() {
      // Cancellation abandons the selection, never claims to roll back a server mutation.
      invalidate();
      emit({ editor: null, draft: "", busy: false, error: null });
    },
    save() {
      const editor = state.editor;
      const content = state.draft;
      if (!editor || (editor.kind === "skill" && (editor.skill?.readOnly || !content.trim())))
        return Promise.resolve();
      return run("save", async (signal, valid) => {
        if (editor.kind === "memory") {
          const saved = await client.request<MemoryDocument>(
            "memory/update",
            { documentId: editor.document.id, content },
            signal,
          );
          if (valid())
            emit({
              documents: state.documents.map((d) => (d.id === saved.id ? saved : d)),
              editor: null,
              draft: "",
            });
        } else {
          const saved = await client.request<AgentSkill>(
            editor.skill ? "agentSkills/update" : "agentSkills/create",
            editor.skill ? { skillId: editor.skill.id, content } : { content },
            signal,
          );
          if (valid())
            emit({
              skills: [...state.skills.filter((s) => s.id !== saved.id), saved],
              editor: null,
              draft: "",
            });
        }
      });
    },
    remove(expectedId?: string) {
      const editor = state.editor;
      if (
        editor?.kind !== "skill" ||
        !editor.skill ||
        editor.skill.readOnly ||
        (expectedId !== undefined && editor.skill.id !== expectedId)
      )
        return Promise.resolve();
      const skillId = editor.skill.id;
      return run("delete", async (signal, valid) => {
        await client.request("agentSkills/remove", { skillId }, signal);
        if (valid())
          emit({ skills: state.skills.filter((s) => s.id !== skillId), editor: null, draft: "" });
      });
    },
    exportMarkdown() {
      if (section === "skills") return Promise.resolve();
      return run("export", async (signal, valid) => {
        // Read back committed documents, never editor drafts or an uncertain write result.
        const documents = await client.request<MemoryDocument[]>(
          "memory/list",
          memoryInput,
          signal,
        );
        if (!valid()) return;
        emit({ documents });
        await options.deliver(memoryDocumentsMarkdown(documents), valid);
      });
    },
    dispose() {
      disposed = true;
      invalidate();
    },
  };
}
