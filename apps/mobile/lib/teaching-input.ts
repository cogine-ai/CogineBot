import { computerInputForDomKey } from "@rakazo/core";
import type { ComputerKeyboardCommand } from "./computer-keyboard";

export type TeachingInput = {
  kind: "pointer" | "key" | "clipboard" | "scroll";
  payload: Record<string, string | number>;
};

export function teachingKeyboardInputs(command: ComputerKeyboardCommand): TeachingInput[] {
  if (command.type === "text") return [{ kind: "clipboard", payload: { text: command.text } }];
  if (command.type === "backspace")
    return Array.from({ length: command.count }, () => ({
      kind: "key" as const,
      payload: { key: "BackSpace" },
    }));
  const value = command.type === "char" ? command.text : command.name;
  const mapped = computerInputForDomKey(value);
  if (command.control) {
    const key = mapped.kind === "key" ? mapped.key : mapped.text;
    return [{ kind: "key", payload: { key: `ctrl+${key}` } }];
  }
  return [
    mapped.kind === "key"
      ? { kind: "key", payload: { key: mapped.key } }
      : { kind: "clipboard", payload: { text: mapped.text } },
  ];
}

/** Serialize executed/recorded input; discard queued work after a failure or owner change. */
export function createTeachingInputQueue(
  send: (input: TeachingInput) => Promise<unknown>,
  current: () => boolean,
  onError: (error: unknown) => void,
) {
  let chain = Promise.resolve();
  let failed = false;
  return {
    push(input: TeachingInput) {
      chain = chain.then(async () => {
        if (failed || !current()) return;
        try {
          await send(input);
        } catch (error) {
          failed = true;
          if (current()) onError(error);
        }
      });
    },
    flush: () => chain,
    async recover() {
      await chain;
      if (current()) failed = false;
    },
  };
}
