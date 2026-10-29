import type { MessageBlock } from "@rakazo/contracts";
import { isBackgroundRunTrigger } from "./run-state.js";

export type AnnouncementSnapshot = {
  threadId: string;
  cursor?: number;
  run: { id: string; status: string; trigger?: string } | null;
  activeRuns?: readonly { id: string; status: string; trigger?: string }[];
  messages: readonly { id: string; role: string; runId?: string; blocks: MessageBlock[] }[];
};
export type AnnouncementEvent = {
  type: string;
  threadId?: string;
  seq?: number;
  runId?: string;
  payload?: Record<string, unknown>;
};
const ACTIVE = new Set(["queued", "leased", "running", "waiting_input", "waiting_takeover"]);

/** A view consumes explicit durable completion receipts, never infers success from disappearance. */
export class ReplyAnnouncements {
  private scope: string | null = null;
  private threadId: string | null = null;
  private visible = false;
  private seeded = false;
  private baselineCursor: number | undefined;
  private snapshotCursor: number | undefined;
  private eligible = new Set<string>();
  private stopped = new Set<string>();
  private consumed = new Set<string>();
  private receipts = new Map<string, string>();

  stop(scope: string, runIds: readonly string[]): void {
    if (scope !== this.scope) return;
    for (const id of runIds) {
      this.stopped.add(id);
      this.receipts.delete(id);
    }
  }

  observe(scope: string, visible: boolean, event: AnnouncementEvent): void {
    if (scope !== this.scope || event.threadId !== this.threadId) return;
    if (
      event.seq !== undefined &&
      this.baselineCursor !== undefined &&
      event.seq <= this.baselineCursor
    )
      return;
    if (event.type === "thread.cleared") {
      if (
        event.seq !== undefined &&
        this.snapshotCursor !== undefined &&
        event.seq <= this.snapshotCursor
      )
        return;
      for (const id of this.eligible) this.stopped.add(id);
      this.eligible.clear();
      this.receipts.clear();
      return;
    }
    if (!event.runId) return;
    if (
      event.type === "run.started" &&
      isBackgroundRunTrigger(event.payload?.trigger as string | undefined)
    ) {
      this.stopped.add(event.runId);
      return;
    }
    if (event.type === "run.failed" || event.type === "run.cancelled") {
      this.stopped.add(event.runId);
      this.receipts.delete(event.runId);
      return;
    }
    if (event.type === "run.started" && visible && this.visible && !this.stopped.has(event.runId)) {
      this.eligible.add(event.runId);
      return;
    }
    if (event.type !== "run.completed") return;
    const messageId = event.payload?.messageId;
    // Older servers have no exact final-message receipt; keep manual reading available.
    if (typeof messageId !== "string" || !messageId) return;
    if (!visible || !this.visible) {
      this.consumed.add(messageId);
      this.eligible.delete(event.runId);
      return;
    }
    if (!this.stopped.has(event.runId) && this.eligible.has(event.runId))
      this.receipts.set(event.runId, messageId);
  }

  update(scope: string, visible: boolean, snapshot: AnnouncementSnapshot | null): string[] {
    if (this.scope !== scope || (snapshot && this.threadId !== snapshot.threadId)) {
      this.eligible.clear();
      this.stopped.clear();
      this.consumed.clear();
      this.receipts.clear();
      this.seeded = false;
      this.scope = scope;
      this.threadId = snapshot?.threadId ?? null;
      this.baselineCursor = undefined;
      this.snapshotCursor = undefined;
    }
    this.visible = visible;
    if (!visible) {
      for (const id of this.receipts.values()) this.consumed.add(id);
      this.receipts.clear();
      this.eligible.clear();
      this.seeded = false;
      return [];
    }
    if (!snapshot) return [];
    this.snapshotCursor = snapshot.cursor;
    if (!this.seeded) {
      for (const message of snapshot.messages) this.consumed.add(message.id);
      this.baselineCursor = snapshot.cursor;
      this.seeded = true;
    }
    for (const run of [...(snapshot.activeRuns ?? []), ...(snapshot.run ? [snapshot.run] : [])]) {
      if (
        ACTIVE.has(run.status) &&
        !isBackgroundRunTrigger(run.trigger) &&
        !this.stopped.has(run.id)
      )
        this.eligible.add(run.id);
      else if (run.status === "cancelled" || run.status === "failed") this.stopped.add(run.id);
    }
    const announcements: string[] = [];
    for (const [runId, messageId] of this.receipts) {
      if (this.stopped.has(runId) || this.consumed.has(messageId)) {
        this.receipts.delete(runId);
        continue;
      }
      const message = snapshot.messages.find(
        (message) => message.id === messageId && message.role === "bot" && message.runId === runId,
      );
      if (!message) continue;
      const text = message.blocks
        .flatMap((block) => (block.kind === "text" ? [block.text] : []))
        .join("\n");
      this.consumed.add(messageId);
      this.receipts.delete(runId);
      this.eligible.delete(runId);
      if (text.trim() && !message.id.startsWith("progress:")) announcements.push(text);
    }
    return announcements;
  }
}
