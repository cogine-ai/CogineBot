import type { Message } from "@earendil-works/pi-ai";

export const AUTOMATED_MESSAGE_LABEL = "[Automated message from CogineBot, not from the user]";

export function automated(text: string): string {
  return `${AUTOMATED_MESSAGE_LABEL} ${text}`;
}

/** Only typed tool results own these labels. Human text never establishes provenance. */
export function automatedToolMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== "toolResult") return message;
    const labels: string[] = [];
    if (message.toolName === "run_subagent") {
      labels.push(automated("Result from your helper, not a message from the user."));
    }
    if (message.content.some((part) => part.type === "image")) {
      labels.push(automated("Screenshot(s) returned by this tool call. The user has not replied."));
    }
    if (labels.length === 0) return message;
    return {
      ...message,
      content: [{ type: "text", text: labels.join("\n") }, ...message.content],
    };
  });
}
