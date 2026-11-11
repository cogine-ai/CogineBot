import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCall } from "@earendil-works/pi-ai";
import { GenerateSecretInput, PROTECTED_LOGIN_USERNAME } from "@rakazo/contracts";
import { USE_TOOL } from "./builtin-tool-bridge.js";
import { tryRedactConnectorPayload } from "./connector-safety.js";
import { preparePageToolRequest, SAVE_PAGE_TOOL } from "./page-tool-request.js";

const REJECTED_PAGE_CALL = "The Page call had invalid or protected arguments. Send a new call.";
const UNAVAILABLE_PAGE_RESULT = "The Page result is unavailable.";
const INVALID_LOGIN_CALL =
  "The credential generation request had invalid arguments. Send a new call.";
const UNSTARTED_LOGIN_CALL =
  "This login request did not run before the pause. Call generate_secret again with the username.";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Filter protected inputs at transcript sinks without changing live Pi messages. */
export function createProtectedToolTranscriptSanitizer(
  hasBuiltinBridge: boolean,
  secrets: () => string[],
  unstartedCalls?: ReadonlySet<string>,
) {
  const pageCalls = new Map<string, { name: string; rejected: boolean }>();
  const loginCalls = new Map<string, string>();
  return function sanitize<T extends AgentMessage>(message: T): T {
    if (message.role === "assistant") {
      let changed = false;
      const content = message.content.map((part) => {
        if (part.type !== "toolCall") return part;
        const wrappedLogin =
          hasBuiltinBridge &&
          part.name === USE_TOOL &&
          (part.arguments.name === "generate_secret" ||
            (part.arguments.name === undefined &&
              /\bgenerate_secret\b/.test(part.argumentsError ?? "")));
        const loginArgs = wrappedLogin ? part.arguments.arguments : part.arguments;
        const isLogin = record(loginArgs) && loginArgs.type === "login";
        if ((wrappedLogin || part.name === "generate_secret") && (part.argumentsError || isLogin)) {
          changed = true;
          const parsed =
            isLogin && !part.argumentsError ? GenerateSecretInput.safeParse(loginArgs) : undefined;
          const savedLogin =
            parsed?.success && parsed.data.type === "login" ? parsed.data : undefined;
          const error =
            part.argumentsError === UNSTARTED_LOGIN_CALL || unstartedCalls?.has(part.id)
              ? UNSTARTED_LOGIN_CALL
              : savedLogin
                ? undefined
                : INVALID_LOGIN_CALL;
          loginCalls.set(part.id, error ?? "The protected login request could not be executed.");
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
          hasBuiltinBridge &&
          part.name === USE_TOOL &&
          (part.arguments.name === SAVE_PAGE_TOOL ||
            (part.arguments.name === undefined && /\bsave_page\b/.test(part.argumentsError ?? "")));
        if (!wrapped && part.name !== SAVE_PAGE_TOOL) {
          pageCalls.delete(part.id);
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
    const loginError = loginCalls.get(message.toolCallId);
    if (loginError && message.isError) {
      return {
        ...message,
        content: [{ type: "text", text: loginError }],
        details: undefined,
      };
    }
    const call = pageCalls.get(message.toolCallId);
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
