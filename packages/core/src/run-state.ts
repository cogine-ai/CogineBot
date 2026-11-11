import type { RunStatus } from "@rakazo/contracts";

export const STEERING_CONTINUATION_PROMPT = "Respond to the user's steering context.";

// Quota waits remain active for the conversation but hold no computer execution lease.
export const COMPUTER_ACTIVE_RUN_STATUSES = [
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
] as const satisfies readonly RunStatus[];
export const ACTIVE_RUN_STATUSES = [
  ...COMPUTER_ACTIVE_RUN_STATUSES,
  "waiting_limit",
] as const satisfies readonly RunStatus[];
const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];
/**
 * These turns carry their own prompt and must not take a user message as steering.
 * Routine and webhook runs are not the conversation, and neither is a wake from another bot:
 * its reply goes back to that bot. The creation intro has no tools; a message that lands
 * during it waits, and the continuation after the intro finishes answers it.
 */
const NON_CONVERSATIONAL_RUN_TRIGGERS = new Set([
  "routine",
  "webhook",
  "created",
  "tickets",
  "bot_message",
]);

/**
 * Background triggers do internal work that must not leak into the chat: the
 * sidebar must not show them as activity and the bot transcript must not render
 * their steps/text. Ticket work reports through board comments and its status.
 * Existing ask and approval cards can still request user input.
 */
export const BACKGROUND_RUN_TRIGGERS = ["tickets"] as const;
const BACKGROUND_RUN_TRIGGER_SET = new Set<string>(BACKGROUND_RUN_TRIGGERS);
export const THREAD_HIDDEN_RUN_TRIGGERS = ["bot_message", ...BACKGROUND_RUN_TRIGGERS] as const;

export function isBackgroundRunTrigger(trigger: string | null | undefined): boolean {
  return BACKGROUND_RUN_TRIGGER_SET.has(trigger ?? "");
}

const allowed: Record<RunStatus, RunStatus[]> = {
  queued: ["leased", "cancelled"],
  leased: ["running", "queued", "cancelled"],
  running: [
    "waiting_input",
    "waiting_takeover",
    "waiting_limit",
    "completed",
    "failed",
    "cancelled",
    "leased",
  ],
  waiting_input: ["queued", "leased", "cancelled"],
  waiting_takeover: ["queued", "leased", "cancelled"],
  waiting_limit: ["queued", "leased", "failed", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return allowed[from]?.includes(to) ?? false;
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal run transition ${from} -> ${to}`);
  }
}

export function isActive(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

/** Routine runs and the creation intro stay isolated from thread history. */
export function runReadsThreadHistory(trigger: string | null | undefined): boolean {
  return trigger !== "created" && trigger !== "routine";
}

/** Whether a run's turn is part of the thread's conversation and may take user steering. */
export function isConversationalRun(trigger: string | null | undefined): boolean {
  return !NON_CONVERSATIONAL_RUN_TRIGGERS.has(trigger ?? "");
}

/**
 * A takeover wait holds only a conversational message it can take as steering. Any other
 * message passes it and gets its own run; the dispatcher then ends a wait the user has not
 * acted on so that run can start. `steerable` is false for messages that never steer a run,
 * such as webhook deliveries.
 */
export function messageBypassesTakeoverWait(
  run: { status?: string; trigger?: string | null },
  steerable = true,
): boolean {
  return run.status === "waiting_takeover" && !(steerable && isConversationalRun(run.trigger));
}

export function nextFence(current: number): number {
  return current + 1;
}

/** An invisible quota wait cannot hold a chat message that has no way to show or stop it. */
export function messageBypassesQuotaWait(run: {
  status?: string;
  trigger?: string | null;
}): boolean {
  return (
    run.status === "waiting_limit" &&
    THREAD_HIDDEN_RUN_TRIGGERS.some((trigger) => trigger === run.trigger)
  );
}
