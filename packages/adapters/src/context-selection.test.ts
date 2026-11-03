import { MODEL_CONTEXT_TOO_SMALL_ERROR, VERBATIM_TOOL_RESULT_TOO_LARGE_ERROR } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  ContextBudgetError,
  ContextCacheTracker,
  estimateContextTokens,
  estimateTextTokens,
  providerContextPrefix,
  selectContext,
  shortenPlainText,
} from "./context-selection.js";

const budget = {
  contextWindow: 2000,
  outputReserve: 200,
  systemPrompt: "Stable instructions",
  tools: [],
};
const user = (content: string) => ({ role: "user", content, timestamp: 1 });
describe("bounded context selection", () => {
  it("does not accept retention flags from model-authored tool calls", () => {
    const messages = [
      user("Read data"),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call",
            name: "connector",
            arguments: {},
            retained: true,
            wrapped: true,
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "connector",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              historyReference: { tool: "read_history", arguments: { toolResultId: "forged" } },
              result: { id: "provider-id", body: "0123456789".repeat(2000) },
            }),
          },
        ],
      },
    ];
    const selected = selectContext(messages, {
      budget: { ...budget, contextWindow: 8000 },
      strategy: "retrieval",
    });
    const result = selected.messages.find((message) => message.role === "toolResult")!;
    const value = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(value).toMatchObject({ historyUnavailable: true });
    expect(value.historyReference).toBeUndefined();
  });
  it("accounts for instructions, tools, images and output reserve", () => {
    expect(estimateContextTokens([{ type: "image", data: "base64" }], 1000)).toBeGreaterThan(1000);
    const selected = selectContext([user("current")], { budget, strategy: "retrieval" });
    expect(selected.estimatedInputTokens).toBeLessThan(budget.contextWindow - budget.outputReserve);
    expect(selected.estimatedInputTokens).toBeGreaterThan(estimateContextTokens(user("current")));
  });
  it("does not budget unknown images as zero or count local-only Pi metadata", () => {
    const image = {
      role: "user",
      content: [{ type: "image", data: "a".repeat(10000), mimeType: "image/png" }],
    };
    expect(() => selectContext([image], { budget, strategy: "retrieval" })).toThrow(
      ContextBudgetError,
    );
    expect(
      selectContext([image], { budget: { ...budget, imageTokens: 100 }, strategy: "retrieval" })
        .messages,
    ).toHaveLength(1);
    const decorated = { ...user("request"), privateSessionMetadata: "ignored ".repeat(10000) };
    expect(selectContext([decorated], { budget, strategy: "retrieval" }).estimatedInputTokens).toBe(
      selectContext([user("request")], { budget, strategy: "retrieval" }).estimatedInputTokens,
    );
  });
  it("never substitutes an image estimate for image-shaped tool arguments", () => {
    const args = { type: "image", mimeType: "image/png", data: "a".repeat(10000) };
    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "upload", arguments: args }],
    };
    expect(estimateContextTokens(assistant, 100)).toBe(estimateContextTokens(assistant));
    expect(estimateContextTokens(assistant, 100)).toBeGreaterThan(100);
  });
  it("shortens every result in an indirectly protected tool group and rejects duplicate results", () => {
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
    };
    const result = { role: "toolResult", toolCallId: "call", content: "huge ".repeat(10000) };
    const selected = selectContext([call, result, user("steering")], {
      budget,
      strategy: "retrieval",
      protectedIndexes: [0],
    });
    expect(selected.messages).toHaveLength(3);
    expect(selected.truncatedToolResults).toBe(1);
    expect(() =>
      selectContext([call, result, result, user("steering")], { budget, strategy: "retrieval" }),
    ).toThrow("Duplicate tool result");
  });
  it("preserves actual images while shortening result text and fails if the image alone cannot fit", () => {
    const image = { type: "image", data: "a".repeat(10000), mimeType: "image/png" };
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "capture", arguments: {} }],
    };
    const result = {
      role: "toolResult",
      toolCallId: "call",
      content: [image, { type: "text", text: "large text ".repeat(10000) }],
    };
    expect(() =>
      selectContext([user("objective"), call, result], { budget, strategy: "retrieval" }),
    ).toThrow(ContextBudgetError);
    const selected = selectContext([user("objective"), call, result], {
      budget: { ...budget, imageTokens: 100 },
      strategy: "retrieval",
    });
    expect(JSON.stringify(selected.messages.at(-1)!.content)).toContain(image.data);
    expect(selected.truncatedToolResults).toBe(1);
  });
  it("drops older exchanges while retaining current input and durable protected constraints", () => {
    const history = Array.from({ length: 20 }, (_, index) => user(`exchange ${index}`));
    const selected = selectContext(history, {
      budget,
      strategy: "snapshots",
      recentExchanges: 2,
      protectedIndexes: [0],
    });
    expect(selected.messages).toEqual([history[0], history[18], history[19]]);
    expect(selected.droppedMessages).toBe(17);
  });
  it("retains a warm useful prefix when budget allows, cold selection performs no summary work", () => {
    const history = Array.from({ length: 20 }, (_, index) => user(`exchange ${index}`));
    expect(
      selectContext(history, { budget, strategy: "cache-aware", cacheWarmth: "likely-warm" })
        .messages,
    ).toHaveLength(20);
    expect(
      selectContext(history, {
        budget,
        strategy: "cache-aware",
        cacheWarmth: "likely-cold",
        recentExchanges: 2,
      }).messages,
    ).toHaveLength(2);
  });
  it("drops old tool groups together during long loops", () => {
    const history = [
      user("current objective"),
      ...Array.from({ length: 40 }, (_, index) => [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: `tool-${index}`, name: "read", arguments: {} }],
        },
        { role: "toolResult", toolCallId: `tool-${index}`, content: "result ".repeat(30) },
      ]).flat(),
    ];
    const result = selectContext(history, { budget, strategy: "retrieval" });
    expect(result.messages[0]).toEqual(history[0]);
    expect(result.messages.at(-1)).toEqual(history.at(-1));
    expect(result.droppedMessages).toBeGreaterThan(0);
    for (let index = 1; index < result.messages.length; index += 2) {
      expect(result.messages[index]!.role).toBe("assistant");
      expect(result.messages[index + 1]!.role).toBe("toolResult");
    }
  });
  it("shortens an oversized latest tool result without corrupting tool references", () => {
    const history = [
      user("objective"),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call",
        content: [{ type: "text", text: "large data ".repeat(10000) }],
      },
    ];
    const selected = selectContext(history, { budget, strategy: "retrieval" });
    expect(selected.truncatedToolResults).toBeGreaterThan(0);
    expect(selected.messages[1]).toEqual(history[1]);
    expect(selected.messages[2]).toMatchObject({ toolCallId: "call" });
    expect(selected.estimatedInputTokens).toBeLessThan(budget.contextWindow - budget.outputReserve);
    expect(JSON.stringify(selected.messages[2]!.content)).toContain("Tool result truncated");
  });
  it("shortens history JSON evidence while preserving exact original offsets and pagination", () => {
    const original = 'Quoted "value" and newline\n'.repeat(500);
    const payload = {
      untrusted: true,
      messages: [
        {
          messageId: "anchor",
          text: original.slice(250, 5000),
          textOffset: 250,
          nextTextOffset: 5000,
          truncated: true,
        },
      ],
      nextRunId: "run-cursor",
      nextArtifactId: "artifact-cursor",
      nextOutcomeSeq: 90,
      runs: [],
      snapshots: [],
    };
    const selected = selectContext(
      [
        user("Read original evidence"),
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "history",
              name: "read_history",
              arguments: { messageId: "anchor" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "history",
          content: [{ type: "text", text: JSON.stringify(payload) }],
        },
      ],
      { budget: { ...budget, contextWindow: 1800 }, strategy: "retrieval" },
    );
    const content = selected.messages.at(-1)!.content as Array<{ text: string }>;
    const decoded = JSON.parse(content[0]!.text);
    expect(decoded).toMatchObject({
      nextRunId: "run-cursor",
      nextArtifactId: "artifact-cursor",
      nextOutcomeSeq: 90,
    });
    expect(decoded.messages[0].nextTextOffset).toBe(250 + decoded.messages[0].text.length);
    expect(decoded.messages[0].text).toBe(original.slice(250, decoded.messages[0].nextTextOffset));
    expect(decoded.messages[0].truncated).toBe(true);
    expect(selected.truncatedToolResults).toBe(1);
  });
  it("returns valid retry JSON when history navigation metadata cannot fit", () => {
    const selected = selectContext(
      [
        user("Read original evidence"),
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "history",
              name: "read_history",
              arguments: { messageId: "anchor" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "history",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                untrusted: true,
                messages: Array.from({ length: 100 }, (_, index) => ({
                  messageId: `anchor-${index}`,
                  text: "x",
                  textOffset: 0,
                })),
              }),
            },
          ],
        },
      ],
      { budget, strategy: "retrieval" },
    );
    const content = selected.messages.at(-1)!.content as Array<{ text: string }>;
    expect(JSON.parse(content[0]!.text)).toMatchObject({
      untrusted: true,
      needsRetry: true,
      retry: { messageId: "anchor", limit: 1 },
    });
  });
  it("preserves generic JSON controls and marks omitted diagnostic strings", () => {
    const selected = selectContext(
      [
        user("Read diagnostics"),
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "diagnostic", name: "read_diagnostic", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "diagnostic",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                nextCursor: "segment-2",
                segment: 1,
                approval: "pending",
                diagnostic: 'quoted "value"\n'.repeat(3000),
              }),
            },
          ],
        },
      ],
      { budget, strategy: "retrieval" },
    );
    const content = selected.messages.at(-1)!.content as Array<{ text: string }>;
    const decoded = JSON.parse(content[0]!.text);
    expect(decoded).toMatchObject({
      contextTruncated: true,
      result: { nextCursor: "segment-2", segment: 1, approval: "pending" },
    });
    expect(decoded.result.diagnostic).toContain("Tool result truncated");
  });
  it("fails explicitly if mandatory content cannot fit rather than silently losing the request", () => {
    expect(() =>
      selectContext([user("large ".repeat(2000))], { budget, strategy: "retrieval" }),
    ).toThrow(ContextBudgetError);
    expect(() =>
      selectContext([{ role: "toolResult", content: "orphan" }], { budget, strategy: "current" }),
    ).toThrow("Orphaned");
  });
  it("keeps the unread tool group when steering follows its result", () => {
    const selected = selectContext(
      [
        user("Objective"),
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "unread", name: "read", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "unread",
          content: [{ type: "text", text: "0123456789".repeat(1000) }],
        },
        user("Steer without dropping the unread result"),
      ],
      { budget, strategy: "retrieval" },
    );
    expect(selected.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(selected.truncatedToolResults).toBe(1);
    expect(selected.sourceIndexes).toEqual([0, 1, 2, 3]);
  });
  it("distinguishes an oversized whole MCP result from unrelated required content", () => {
    const result = (body: string, prompt = "Objective") => [
      user(prompt),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "whole", name: "mcp__office__read", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "whole", content: [{ type: "text", text: body }] },
    ];
    const options = {
      budget,
      strategy: "retrieval" as const,
      verbatimMcpServers: { ids: [], slugs: ["office"] },
    };
    const whole = "0123456789".repeat(100);
    expect(selectContext(result(whole), options).messages.at(-1)!.content).toEqual([
      { type: "text", text: whole },
    ]);
    expect(() => selectContext(result("0123456789".repeat(1000)), options)).toThrow(
      VERBATIM_TOOL_RESULT_TOO_LARGE_ERROR,
    );
    expect(() =>
      selectContext(result("0123456789".repeat(1000), "0123456789".repeat(1000)), options),
    ).toThrow("Required context exceeds");
    expect(() =>
      selectContext([user("Objective")], {
        ...options,
        budget: { ...budget, systemPrompt: "0123456789".repeat(1000) },
      }),
    ).toThrow(MODEL_CONTEXT_TOO_SMALL_ERROR);
  });
  it("shortens text without splitting a Unicode code point", () => {
    const original = "🙂甲".repeat(500);
    const shortened = shortenPlainText(original, 401);
    expect(shortened.length).toBeLessThan(original.length);
    expect(new TextDecoder().decode(new TextEncoder().encode(shortened))).toBe(shortened);
    expect(shortened).toContain("Tool result truncated");
  });
  it("selects complete tool groups within the actual image capacity", () => {
    const image = { type: "image", data: "fixture", mimeType: "image/png" };
    const messages = [
      user("Objective"),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "old", name: "mcp__office__read", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "old", content: [image, image, image] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "new", name: "read", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "new", content: [image, image] },
    ];
    const selected = selectContext(messages, {
      budget: { ...budget, imageTokens: 10, maxImages: 2 },
      strategy: "retrieval",
      protectedIndexes: [0],
      verbatimMcpServers: { ids: [], slugs: ["office"] },
    });
    expect(selected.sourceIndexes).toEqual([0, 3, 4]);
    expect(selected.messages.at(-1)!.content).toEqual([image, image]);
    expect(() =>
      selectContext(messages, {
        budget: { ...budget, imageTokens: 10, maxImages: 1 },
        strategy: "retrieval",
      }),
    ).toThrow("required context contains 2 images");
  });
  it("uses extra capacity predicates only for adding optional complete groups", () => {
    const calls: string[][] = [];
    const messages = [
      user("old"),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "old", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "old",
        content: [{ type: "text", text: "Whole evidence" }],
      },
      { role: "assistant", content: [{ type: "text", text: "Read it" }] },
      user("required"),
    ];
    const selected = selectContext(messages, {
      budget,
      strategy: "retrieval",
      canAddOptional: (candidate) => {
        calls.push(candidate.map((message) => message.role));
        return !candidate.some((message) => message.role === "toolResult");
      },
    });
    expect(selected.messages).toEqual(messages.slice(3));
    expect(calls).toEqual([
      ["assistant", "user"],
      ["assistant", "toolResult", "assistant", "user"],
    ]);
    const mandatoryOnly = selectContext([user("required")], {
      budget,
      strategy: "retrieval",
      canAddOptional: () => {
        throw new Error("mandatory must bypass predicate");
      },
    });
    expect(mandatoryOnly.messages).toHaveLength(1);
  });
  it("reserves input framing once without treating it as output", () => {
    const messages = [user("Required content")];
    const plain = selectContext(messages, { budget, strategy: "retrieval" });
    const framing = 240;
    const exactWindow = plain.estimatedInputTokens + framing + budget.outputReserve;
    const selected = selectContext(messages, {
      budget: { ...budget, contextWindow: exactWindow, inputOverhead: framing },
      strategy: "retrieval",
    });
    expect(selected.estimatedInputTokens).toBe(plain.estimatedInputTokens + framing);
    expect(selected.estimatedInputTokens + budget.outputReserve).toBe(exactWindow);
    expect(() =>
      selectContext(messages, {
        budget: { ...budget, contextWindow: exactWindow - 1, inputOverhead: framing },
        strategy: "retrieval",
      }),
    ).toThrow(ContextBudgetError);
  });
});
describe("cache request metadata", () => {
  const request = {
    accountScope: "synthetic-account",
    connectionId: "connection",
    modelId: "model",
    prefix: providerContextPrefix("stable", [], [user("first")]),
    prefixTokens: 2000,
    capabilities: { scope: "account" as const, retentionMs: 300000, minimumTokens: 1000 },
  };
  it("predicts timing with fake clock and matching appended prefixes", () => {
    let time = 0;
    const tracker = new ContextCacheTracker(() => time);
    expect(tracker.predict(request)).toBe("likely-cold");
    tracker.record(request, 1000);
    time = 10000;
    expect(
      tracker.predict({
        ...request,
        prefix: providerContextPrefix("stable", [], [user("first"), user("next")]),
      }),
    ).toBe("likely-warm");
    time = 300000;
    expect(tracker.predict(request)).toBe("likely-cold");
  });
  it("uses request-start time even when completion arrives after retention expires", () => {
    let time = 0;
    const tracker = new ContextCacheTracker(() => time);
    const started = tracker.stamp(request);
    time = 300001;
    tracker.record(started, 1000);
    expect(tracker.predict(request)).toBe("likely-cold");
    const next = tracker.stamp(request);
    time += 100;
    tracker.record(next, 1000);
    expect(tracker.predict({ ...request, startedAt: -99999 })).toBe("likely-warm");
    // A late completion from an older request cannot replace the newer start time.
    tracker.record(started, 0);
    expect(tracker.predict(request)).toBe("likely-warm");
  });
  it("does not retain a warm prediction when caching is explicitly disabled", () => {
    const tracker = new ContextCacheTracker(() => 0);
    const disabled = {
      ...request,
      capabilities: { ...request.capabilities, retentionMode: "none" as const },
    };
    tracker.record(disabled, 1000);
    expect(tracker.predict(disabled)).toBe("likely-cold");
  });
  it("does not treat user activity, model/account changes or changed prefixes as cache hits", () => {
    const tracker = new ContextCacheTracker(() => 0);
    tracker.record(request);
    for (const change of [
      { modelId: "other" },
      { accountScope: "other" },
      { connectionId: "other" },
      { prefix: "changed" },
    ]) {
      expect(tracker.predict({ ...request, ...change })).toBe("likely-cold");
    }
    expect(tracker.predict({ ...request, capabilities: undefined })).toBe("unknown");
  });
  it("ignores transient Pi timestamps in prefix fingerprints", () => {
    expect(providerContextPrefix("stable", [], [user("first")])).toEqual(
      providerContextPrefix("stable", [], [{ ...user("first"), timestamp: 999 }]),
    );
  });
  it("fingerprints transcript instruction sections and tool changes", () => {
    const system = {
      role: "system",
      content: "Stable instructions",
      sections: { approval: "Pending" },
      toolsAdded: [{ name: "read_history", parameters: { type: "object" } }],
      toolsRemoved: [{ name: "old_tool" }],
      timestamp: 1,
    };
    const prefix = providerContextPrefix("", [], [system]);
    expect(prefix).toEqual(providerContextPrefix("", [], [{ ...system, timestamp: 2 }]));
    for (const changed of [
      { ...system, sections: { approval: "Granted" } },
      { ...system, toolsAdded: [] },
      { ...system, toolsRemoved: [] },
    ]) {
      expect(providerContextPrefix("", [], [changed])).not.toEqual(prefix);
    }
  });
  it("records observed cache reuse without pretending unknown measurements are zero", () => {
    const tracker = new ContextCacheTracker(() => 0);
    expect(tracker.record(request)).toEqual({ observedReuse: null });
    expect(tracker.record(request, 0)).toEqual({ observedReuse: false });
    expect(tracker.record(request, 1)).toEqual({ observedReuse: true });
  });
});

const tokenizedSamples = [
  {
    name: "prose",
    text: "You are a helpful assistant for a small bakery. Answer customer questions about opening hours, prices, allergens and custom cake orders. Keep replies short and friendly, and never promise a delivery time you cannot confirm.\n\nWhen someone asks for a custom cake, collect the date they need it, the number of guests, any dietary restrictions, and the flavor they prefer. Repeat the details back before you save the order, and ask them to confirm. If the requested date is less than three days away, explain that rush orders cost extra and need approval from the owner.",
    fewest: 111,
    most: 119,
  },
  {
    name: "code",
    text: "export function retryDelay(attempt: number, baseMs = 500): number {\n  // Exponential backoff with a ceiling, so a flaky provider is not hammered.\n  const capped = Math.min(attempt, 6);\n  const jitter = (attempt * 37) % 100;\n  return baseMs * 2 ** capped + jitter;\n}\n\nfor (const [index, item] of items.entries()) {\n  if (!item.ready) continue;\n  results.push({ id: item.id, position: index, label: item.name.trim() });\n}\n",
    fewest: 116,
    most: 148,
  },
  {
    name: "a JSON tool schema",
    text: JSON.stringify({
      name: "ask_user",
      description:
        "Ask the user one short multiple-choice question with tappable options, then wait for their selection. Use this instead of asking them to type when two to four concise choices are enough.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", maxLength: 240 },
          options: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 80 },
            minItems: 2,
            maxItems: 4,
            uniqueItems: true,
          },
        },
        required: ["question", "options"],
      },
    }),
    fewest: 106,
    most: 125,
  },
  {
    name: "Chinese",
    text: "订阅凭据已安全存储。\n添加要监视的文件或文件夹\n请在设置中添加模型后再使用。\n添加通行密钥以更快登录？\n为此一次性任务添加运行时间。\n请填写服务器名称。\n添加触发器以运行此例程。\n请填写 HTTPS 服务器 URL。",
    fewest: 61,
    most: 104,
  },
  {
    name: "Japanese",
    text: "サブスクリプションの認証情報は安全に保存されています。\nアクセストークン（任意）\nアカウントのデフォルト\n実行するコマンドを追加\n監視するファイルまたはフォルダーを追加\nこれを使用するには、設定でモデルを追加してください。",
    fewest: 68,
    most: 114,
  },
  {
    name: "Russian",
    text: "Учётные данные подписки надежно сохранены.\nО пространствах\nТокен доступа (необязательно)\nУчетная запись по умолчанию\nЯрлык аккаунта\nДействия для пространства",
    fewest: 44,
    most: 72,
  },
  {
    name: "hex digests",
    text: "a5bb10eb6bdc95823faeb67d6545b23e0f9ab45fc9ec31eba52c13dfaff8ade7 0899cd856fba9b131050135138cd87c5e5222f0a0657b94730901988d5cabdbb 2be9fec91c2c7e4b40fedb0d2bf11da0f6fe4a7047946e3bd492a7377e7c6154 73014671303fd8235351b0a5e8aa8c6c6d19caf70d0d13900454afde0083d2a4",
    fewest: 154,
    most: 227,
  },
];
describe("text token estimate", () => {
  it.each(tokenizedSamples)(
    "stays near the least efficient tokenizer for $name",
    ({ text, fewest, most }) => {
      const estimate = estimateTextTokens(text);
      expect(estimate).toBeGreaterThanOrEqual(Math.floor(most * 0.9));
      expect(estimate).toBeLessThanOrEqual(Math.ceil(most * 1.5));
      expect(estimate).toBeLessThanOrEqual(fewest * 2.1);
      expect(estimate).toBeLessThanOrEqual(Buffer.byteLength(text, "utf8"));
    },
  );
  it("counts UTF-16 units instead of bytes", () => {
    const prose = tokenizedSamples[0]!.text;
    expect(estimateTextTokens(prose)).toBeLessThan(Buffer.byteLength(prose, "utf8") / 3);
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("🙂🙂")).toBe(5);
  });
});
