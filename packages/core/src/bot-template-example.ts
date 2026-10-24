import type { BotTemplateSelection } from "@rakazo/contracts";
import { getBotTemplate } from "@rakazo/contracts";

export type BotTemplateExampleHandoff = Readonly<{
  scopeKey: string;
  botId: string;
  selection: BotTemplateSelection;
  exampleNonce: string;
  text: string;
}>;

/** Session-only examples never send a message or replace an occupied composer. */
export function createBotTemplateExamples(options: {
  isCurrent(scopeKey: string, botId: string): boolean;
}): {
  remember(input: Omit<BotTemplateExampleHandoff, "text">): void;
  read(scopeKey: string, botId: string): BotTemplateExampleHandoff | null;
  insert(
    scopeKey: string,
    botId: string,
    exampleNonce: string,
    tryInsert: (text: string) => boolean,
  ): "inserted" | "occupied" | "gone";
  clear(): void;
} {
  type Entry = { handoff: BotTemplateExampleHandoff; consumed: boolean; busy: boolean };
  const entries = new Map<string, Entry>();
  const retired = new Set<string>();
  const key = (scopeKey: string, botId: string) => JSON.stringify([scopeKey, botId]);
  const read = (scopeKey: string, botId: string) => {
    const entryKey = key(scopeKey, botId);
    const entry = entries.get(entryKey);
    if (!entry || entry.consumed) return null;
    if (!options.isCurrent(scopeKey, botId)) {
      retired.add(entryKey);
      entries.delete(entryKey);
      return null;
    }
    return entry.handoff;
  };
  return {
    remember(input) {
      if (!input.scopeKey || !input.botId || !input.exampleNonce) return;
      const entryKey = key(input.scopeKey, input.botId);
      if (retired.has(entryKey) || entries.has(entryKey)) return;
      if (!options.isCurrent(input.scopeKey, input.botId)) {
        retired.add(entryKey);
        return;
      }
      const template = getBotTemplate(input.selection.templateId, input.selection.version);
      if (!template) return;
      const handoff = Object.freeze({
        scopeKey: input.scopeKey,
        botId: input.botId,
        selection: Object.freeze({ templateId: template.templateId, version: template.version }),
        exampleNonce: input.exampleNonce,
        text: template.examplePrompt,
      });
      entries.set(key(input.scopeKey, input.botId), { handoff, consumed: false, busy: false });
    },
    read,
    insert(scopeKey, botId, exampleNonce, tryInsert) {
      const handoff = read(scopeKey, botId);
      if (!handoff || handoff.exampleNonce !== exampleNonce) return "gone";
      const entry = entries.get(key(scopeKey, botId))!;
      if (entry.busy) return "occupied";
      entry.busy = true;
      try {
        const accepted = tryInsert(handoff.text);
        if (!options.isCurrent(scopeKey, botId) || entries.get(key(scopeKey, botId)) !== entry)
          return "gone";
        if (!accepted) return "occupied";
        entry.consumed = true;
        return "inserted";
      } finally {
        entry.busy = false;
        if (!options.isCurrent(scopeKey, botId)) {
          retired.add(key(scopeKey, botId));
          entries.delete(key(scopeKey, botId));
        }
      }
    },
    clear() {
      for (const entryKey of entries.keys()) retired.add(entryKey);
      entries.clear();
    },
  };
}
