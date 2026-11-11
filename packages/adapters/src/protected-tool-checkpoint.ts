import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCall } from "@earendil-works/pi-ai";
import { GenerateSecretInput, PROTECTED_LOGIN_USERNAME } from "@rakazo/contracts";
import { USE_TOOL } from "./builtin-tool-bridge.js";
import { BUILTIN_AGENT_TOOL_NAMES } from "./builtin-tools.js";
import { tryRedactConnectorPayload } from "./connector-safety.js";
import { preparePageToolRequest, SAVE_PAGE_TOOL } from "./page-tool-request.js";

const REJECTED_PAGE_CALL = "The Page call had invalid or protected arguments. Send a new call.";
const UNAVAILABLE_PAGE_RESULT = "The Page result is unavailable.";
const INVALID_LOGIN_CALL =
  "The credential generation request had invalid arguments. Send a new call.";
const INVALID_BRIDGED_CALL = "The tool call had invalid arguments. Send a new call.";
const UNSTARTED_LOGIN_CALL =
  "This login request did not run before the pause. Call generate_secret again with the username.";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasLoginUsername(value: unknown): value is Record<string, unknown> {
  return record(value) && value.type === "login" && "username" in value;
}

export function withoutMisroutedLoginUsername(name: string, args: Record<string, unknown>) {
  if (name === "generate_secret" || !BUILTIN_AGENT_TOOL_NAMES.has(name) || !hasLoginUsername(args))
    return args;
  const remaining = { ...args };
  delete remaining.username;
  return remaining;
}

/** Filter protected inputs at transcript sinks without changing live Pi messages. */
export function createProtectedToolTranscriptSanitizer(
  bridgeToolNames: ReadonlySet<string> | undefined,
  secrets: () => string[],
  checkpoint?: { pendingToolCallId: string; unstartedCalls: ReadonlySet<string> },
) {
  const pageCalls = new Map<string, { name: string; rejected: boolean }>();
  const protectedErrors = new Map<string, string>();
  return function sanitize<T extends AgentMessage>(message: T): T {
    if (message.role === "assistant") {
      let changed = false;
      const content = message.content.map((part) => {
        if (part.type !== "toolCall") return part;
        protectedErrors.delete(part.id);
        pageCalls.delete(part.id);
        const bridge = part.name === USE_TOOL ? bridgeToolNames : undefined;
        const innerName = part.arguments.name;
        const innerArgs = part.arguments.arguments;
        const wrappedLogin = bridge && innerName === "generate_secret";
        if (wrappedLogin || part.name === "generate_secret") {
          const parsed = part.argumentsError
            ? undefined
            : GenerateSecretInput.safeParse(wrappedLogin ? innerArgs : part.arguments);
          if (parsed?.success && parsed.data.type === "command") return part;
          changed = true;
          const savedLogin =
            parsed?.success && parsed.data.type === "login" ? parsed.data : undefined;
          const error =
            part.argumentsError === UNSTARTED_LOGIN_CALL || checkpoint?.unstartedCalls.has(part.id)
              ? UNSTARTED_LOGIN_CALL
              : savedLogin
                ? undefined
                : INVALID_LOGIN_CALL;
          protectedErrors.set(
            part.id,
            error ?? "The protected login request could not be executed.",
          );
          const safeArgs = savedLogin
            ? {
                type: "login",
                name: savedLogin.name,
                origin: savedLogin.origin,
                purpose: "Resume protected login",
                username: PROTECTED_LOGIN_USERNAME,
              }
            : {};
          return {
            ...part,
            arguments: wrappedLogin ? { name: "generate_secret", arguments: safeArgs } : safeArgs,
            argumentsError: error,
          };
        }
        const wrapped =
          bridge &&
          (innerName === SAVE_PAGE_TOOL ||
            (innerName === undefined && /\bsave_page\b/.test(part.argumentsError ?? "")));
        if (!wrapped && part.name !== SAVE_PAGE_TOOL) {
          // Only the generator accepts this input among the built-in tools.
          // An offered connector can declare these same fields for its own use.
          const targetName = bridge ? innerName : part.name;
          const targetArgs = bridge ? innerArgs : part.arguments;
          const loginShaped = hasLoginUsername(targetArgs);
          const offeredBuiltin =
            typeof targetName === "string" &&
            BUILTIN_AGENT_TOOL_NAMES.has(targetName) &&
            (!bridge || bridge.has(targetName));
          if (
            typeof targetName !== "string" ||
            (loginShaped &&
              (BUILTIN_AGENT_TOOL_NAMES.has(targetName) ||
                (bridgeToolNames !== undefined && !bridgeToolNames.has(targetName))))
          ) {
            changed = true;
            protectedErrors.set(part.id, INVALID_BRIDGED_CALL);
            if (
              offeredBuiltin &&
              loginShaped &&
              checkpoint?.pendingToolCallId === part.id &&
              !part.argumentsError
            ) {
              // The pending call already reached its pause. Keep its route and resume inputs.
              const remaining = withoutMisroutedLoginUsername(targetName, targetArgs);
              return {
                ...part,
                arguments: bridge ? { name: targetName, arguments: remaining } : remaining,
              };
            }
            return { ...part, arguments: {}, argumentsError: INVALID_BRIDGED_CALL };
          }
          return part;
        }
        const args = wrapped ? part.arguments.arguments : part.arguments;
        const prepared =
          part.argumentsError === undefined && record(args)
            ? preparePageToolRequest(args, secrets())
            : undefined;
        const accepted = prepared?.ok === true;
        pageCalls.set(part.id, { name: part.name, rejected: !accepted });
        if (accepted && prepared.args === args && !wrapped) return part;
        changed = true;
        const safeArgs = (accepted ? prepared.args : {}) as ToolCall["arguments"];
        return {
          ...part,
          arguments: wrapped ? { name: SAVE_PAGE_TOOL, arguments: safeArgs } : safeArgs,
          // Pi checks this before dispatch, including on resume. Empty arguments alone
          // would reach the executor and could consume an already-approved replay.
          ...(!accepted ? { argumentsError: REJECTED_PAGE_CALL } : {}),
        };
      });
      return changed ? { ...message, content } : message;
    }
    if (message.role !== "toolResult") return message;
    const protectedError = protectedErrors.get(message.toolCallId);
    protectedErrors.delete(message.toolCallId);
    if (protectedError && message.isError) {
      return {
        ...message,
        content: [{ type: "text", text: protectedError }],
        details: undefined,
      };
    }
    const call = pageCalls.get(message.toolCallId);
    pageCalls.delete(message.toolCallId);
    if (message.toolName !== SAVE_PAGE_TOOL && call?.name !== message.toolName) return message;
    if (call?.rejected && message.isError) {
      // The SDK can include the complete invalid input in its error result.
      return {
        ...message,
        content: [{ type: "text", text: REJECTED_PAGE_CALL }],
        details: undefined,
      };
    }
    const liveSecrets = secrets();
    if (!liveSecrets.length) return message;
    const details = tryRedactConnectorPayload(message.details, liveSecrets);
    const content = message.content.flatMap((part) => {
      if (part.type !== "text") return [];
      const clean = tryRedactConnectorPayload(part.text, liveSecrets);
      return [
        {
          ...part,
          text: clean.ok && typeof clean.value === "string" ? clean.value : UNAVAILABLE_PAGE_RESULT,
        },
      ];
    });
    return {
      ...message,
      content,
      details: details.ok ? (details.value as typeof message.details) : undefined,
    };
  };
}
