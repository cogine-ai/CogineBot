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
  /** A different successful operation cannot acknowledge a failed save. */
  saveError: boolean;
  error: "load" | "save" | "delete" | "export" | null;
};
export const initialKnowledgeState: KnowledgeState = {
  documents: [],
  skills: [],
  editor: null,
  draft: "",
  busy: false,
  loaded: false,
  saveError: false,
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
  let creation: { nonce: string; attempted: boolean } | null = null;
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
  const receiveDocuments = (documents: MemoryDocument[]) => {
    const editor = state.editor;
    const saved =
      editor?.kind === "memory" ? documents.find((d) => d.id === editor.document.id) : undefined;
    // Readback updates the saved baseline, never the user's draft or unresolved save result.
    emit({
      documents,
      loaded: true,
      ...(saved ? { editor: { kind: "memory" as const, document: saved } } : {}),
    });
  };
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
      if (valid() && error === "save") emit({ saveError: false });
    } catch {
      if (valid()) emit({ error, ...(error === "save" ? { saveError: true } : {}) });
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
          if (valid()) receiveDocuments(documents);
        }
      });
    },
    openDocument(document: MemoryDocument) {
      if (!current() || state.busy) return;
      const select = (saved: MemoryDocument) => {
        creation = null;
        const keepDraft =
          state.saveError &&
          state.editor?.kind === "memory" &&
          state.editor.document.id === saved.id;
        emit({
          editor: { kind: "memory", document: saved },
          ...(keepDraft ? {} : { draft: saved.content, saveError: false }),
          error: null,
        });
      };
      // Reads are snapshots, never receipts for an earlier uncertain write. Every
      // explicit open reads again, even after cancellation or a new editor lifetime.
      return run("load", async (signal, valid) => {
        const documents = await client.request<MemoryDocument[]>(
          "memory/list",
          memoryInput,
          signal,
        );
        if (!valid()) return;
        const saved = documents.find((d) => d.id === document.id);
        if (!saved) throw new Error("Document is no longer available");
        receiveDocuments(documents);
        select(saved);
      });
    },
    openSkill(skillId: string) {
      return run("load", async (signal, valid) => {
        const skill = await client.request<AgentSkill>("agentSkills/get", { skillId }, signal);
        if (valid()) {
          creation = null;
          emit({ editor: { kind: "skill", skill }, draft: skill.content, saveError: false });
        }
      });
    },
    createSkill(template: string) {
      if (!current() || state.busy || section !== "skills") return;
      invalidate();
      creation = {
        nonce:
          globalThis.crypto?.randomUUID?.() ??
          `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,
        attempted: false,
      };
      emit({
        editor: { kind: "skill", skill: null },
        draft: template,
        error: null,
        saveError: false,
      });
    },
    edit(draft: string) {
      if (!state.busy && !(state.editor?.kind === "skill" && state.editor.skill?.readOnly))
        emit({ draft });
    },
    cancel() {
      // Cancellation abandons the selection, never claims to roll back a server mutation.
      invalidate();
      creation = null;
      emit({ editor: null, draft: "", busy: false, error: null, saveError: false });
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
          if (valid()) {
            emit({
              documents: state.documents.map((d) => (d.id === saved.id ? saved : d)),
              editor: null,
              draft: "",
            });
          }
        } else {
          let saved: AgentSkill;
          if (editor.skill) {
            saved = await client.request<AgentSkill>(
              "agentSkills/update",
              { skillId: editor.skill.id, content },
              signal,
            );
          } else {
            const intent = creation;
            if (!intent) throw new Error("Missing creation intent");
            const recovering = intent.attempted;
            intent.attempted = true;
            saved = await client.request<AgentSkill>(
              "agentSkills/create",
              { content, clientNonce: intent.nonce },
              signal,
            );
            if (!valid()) return;
            // A replay acknowledges identity, not the latest edited draft. Bind first so
            // any failed follow-up is retried as an update, never another creation.
            creation = null;
            emit({
              editor: { kind: "skill", skill: saved },
              skills: [...state.skills.filter((s) => s.id !== saved.id), saved],
            });
            if (recovering) {
              saved = await client.request<AgentSkill>(
                "agentSkills/update",
                { skillId: saved.id, content },
                signal,
              );
            }
          }
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
          emit({
            skills: state.skills.filter((s) => s.id !== skillId),
            editor: null,
            draft: "",
            saveError: false,
          });
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
        receiveDocuments(documents);
        await options.deliver(memoryDocumentsMarkdown(documents), valid);
      });
    },
    dispose() {
      disposed = true;
      invalidate();
    },
  };
}
