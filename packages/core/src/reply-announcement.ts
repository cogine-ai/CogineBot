import type { MessageBlock } from "@rakazo/contracts";

export type AnnouncementSnapshot = {
  threadId: string;
  run: { id: string; status: string } | null;
  activeRuns?: readonly { id: string; status: string }[];
  messages: readonly { id: string; role: string; runId?: string; blocks: MessageBlock[] }[];
};
const ACTIVE = new Set(["queued", "leased", "running", "waiting_input", "waiting_takeover"]);
type RunObservation = { eligible: boolean; stopped: boolean; messages: Set<string> };

/** A view's observed Run lifecycle, separate from speech playback and durable messages. */
export class ReplyAnnouncements {
  private scope: string | null = null;
  private visible = false;
  private runs = new Map<string, RunObservation>();

  stop(scope: string, runIds: readonly string[]): void {
    if (scope !== this.scope) return;
    for (const id of runIds) {
      const run = this.runs.get(id);
      if (run) run.stopped = true;
    }
  }

  update(scope: string, visible: boolean, snapshot: AnnouncementSnapshot | null): string[] {
    const seed = this.scope !== scope || !this.visible;
    if (this.scope !== scope || !visible) this.runs.clear();
    this.scope = scope;
    this.visible = visible;
    if (!visible || !snapshot) return [];
    const current = new Map((snapshot.activeRuns ?? []).map((run) => [run.id, run]));
    if (snapshot.run) current.set(snapshot.run.id, snapshot.run);
    const announcements: string[] = [];
    for (const run of current.values()) {
      let observation = this.runs.get(run.id);
      if (!observation) {
        observation = { eligible: ACTIVE.has(run.status), stopped: false, messages: new Set() };
        this.runs.set(run.id, observation);
      }
      // A terminal Run never becomes live again because an older snapshot arrived.
      if (ACTIVE.has(run.status)) continue;
      const messages = snapshot.messages.filter(
        (message) =>
          message.role === "bot" && message.runId === run.id && !message.id.startsWith("progress:"),
      );
      for (const message of messages) {
        if (observation.messages.has(message.id)) continue;
        const text = message.blocks
          .flatMap((block) => (block.kind === "text" ? [block.text] : []))
          .join("\n");
        if (!text.trim()) continue;
        observation.messages.add(message.id);
        if (!seed && observation.eligible && !observation.stopped && run.status === "completed")
          announcements.push(text);
      }
      if (run.status !== "completed") observation.eligible = false;
    }
    // Retain only current Runs. Reintroduced terminal history seeds as ineligible.
    for (const id of this.runs.keys()) if (!current.has(id)) this.runs.delete(id);
    return announcements;
  }
}
