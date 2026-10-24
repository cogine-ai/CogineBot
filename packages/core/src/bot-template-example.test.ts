import { describe, expect, it, vi } from "vitest";
import { createBotTemplateExamples } from "./index.js";

const handoff = () => ({
  scopeKey: "scope-a",
  botId: "bot-a",
  selection: { templateId: "research-v1" as const, version: 1 as const },
  exampleNonce: "example-1",
});

describe("bot template example handoff", () => {
  it("derives the example from the catalog and inserts it once only when the real composer accepts", () => {
    const store = createBotTemplateExamples({ isCurrent: (scope) => scope === "scope-a" });
    store.remember({ ...handoff(), text: "Untrusted route content" } as ReturnType<typeof handoff>);
    expect(store.read("scope-a", "bot-a")?.text).toBe(
      "比较这三个方案的功能与限制，给出来源和需要验证的问题。",
    );
    const occupied = vi.fn(() => false);
    expect(store.insert("scope-a", "bot-a", "example-1", occupied)).toBe("occupied");
    expect(store.read("scope-a", "bot-a")).not.toBeNull();
    const insert = vi.fn(() => true);
    expect(store.insert("scope-a", "bot-a", "example-1", insert)).toBe("inserted");
    expect(insert).toHaveBeenCalledExactlyOnceWith(
      "比较这三个方案的功能与限制，给出来源和需要验证的问题。",
    );
    expect(store.read("scope-a", "bot-a")).toBeNull();
    expect(store.insert("scope-a", "bot-a", "example-1", insert)).toBe("gone");
    expect(insert).toHaveBeenCalledOnce();
  });
});

describe("example receipt lifetime", () => {
  it("blocks reentrant insertion before calling the actual composer", () => {
    const store = createBotTemplateExamples({ isCurrent: () => true });
    store.remember(handoff());
    const nested = vi.fn(() => true);
    let result: string | undefined;
    expect(
      store.insert("scope-a", "bot-a", "example-1", () => {
        result = store.insert("scope-a", "bot-a", "example-1", nested);
        return true;
      }),
    ).toBe("inserted");
    expect(result).toBe("occupied");
    expect(nested).not.toHaveBeenCalled();
  });
  it("does not replace the authoritative example or resurrect a consumed nonce", () => {
    const store = createBotTemplateExamples({ isCurrent: () => true });
    store.remember(handoff());
    store.remember({
      ...handoff(),
      exampleNonce: "older-result",
      selection: { templateId: "documents-v1", version: 1 },
    });
    expect(store.read("scope-a", "bot-a")?.exampleNonce).toBe("example-1");
    store.insert("scope-a", "bot-a", "example-1", () => true);
    store.remember(handoff());
    expect(store.read("scope-a", "bot-a")).toBeNull();
  });
  it("preserves the unconsumed entry after a throwing composer", () => {
    const store = createBotTemplateExamples({ isCurrent: () => true });
    store.remember(handoff());
    const error = new Error("Composer refused");
    expect(() =>
      store.insert("scope-a", "bot-a", "example-1", () => {
        throw error;
      }),
    ).toThrow(error);
    expect(store.insert("scope-a", "bot-a", "example-1", () => true)).toBe("inserted");
  });
  it("never revives an observed stale scope, while a new scope can remember its own example", () => {
    let scope = "scope-a";
    const store = createBotTemplateExamples({ isCurrent: (key) => key === scope });
    store.remember(handoff());
    scope = "scope-b";
    expect(store.read("scope-a", "bot-a")).toBeNull();
    scope = "scope-a";
    store.remember(handoff());
    expect(store.read("scope-a", "bot-a")).toBeNull();
    scope = "scope-b";
    store.remember({ ...handoff(), scopeKey: "scope-b", exampleNonce: "new-example" });
    expect(store.read("scope-b", "bot-a")?.exampleNonce).toBe("new-example");
  });
  it("clears old registrations without permitting late callbacks to re-register them", () => {
    const store = createBotTemplateExamples({ isCurrent: () => true });
    store.remember(handoff());
    store.clear();
    store.remember(handoff());
    expect(store.read("scope-a", "bot-a")).toBeNull();
    store.remember({ ...handoff(), botId: "new-bot", exampleNonce: "new-example" });
    expect(store.read("scope-a", "new-bot")?.exampleNonce).toBe("new-example");
  });
  it("does not accept missing identities, empty nonces or unknown template versions", () => {
    const store = createBotTemplateExamples({ isCurrent: () => true });
    for (const input of [
      { ...handoff(), scopeKey: "" },
      { ...handoff(), botId: "" },
      { ...handoff(), exampleNonce: "" },
      { ...handoff(), selection: { templateId: "research-v1", version: 2 } },
    ]) {
      store.remember(input as ReturnType<typeof handoff>);
      expect(store.read(input.scopeKey, input.botId)).toBeNull();
    }
  });
  it("keeps wrong thread and nonce clicks away from the real composer", () => {
    const store = createBotTemplateExamples({ isCurrent: () => true });
    store.remember(handoff());
    const insert = vi.fn(() => true);
    expect(store.insert("scope-a", "bot-b", "example-1", insert)).toBe("gone");
    expect(store.insert("scope-a", "bot-a", "other", insert)).toBe("gone");
    expect(insert).not.toHaveBeenCalled();
    expect(store.read("scope-a", "bot-a")).not.toBeNull();
  });
});

it("retires an example when the composer callback loses authority, including refusal or throw", () => {
  for (const throws of [false, true]) {
    let current = true;
    const store = createBotTemplateExamples({ isCurrent: () => current });
    store.remember(handoff());
    const error = new Error("Composer changed target");
    const insert = () =>
      store.insert("scope-a", "bot-a", "example-1", () => {
        current = false;
        if (throws) throw error;
        return false;
      });
    if (throws) expect(insert).toThrow(error);
    else expect(insert()).toBe("gone");
    current = true;
    store.remember(handoff());
    expect(store.read("scope-a", "bot-a")).toBeNull();
  }
});
