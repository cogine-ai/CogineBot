import type { Bot, BotCreationDraft } from "@rakazo/contracts";
import { botTemplateDraft } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createBotCreation } from "./index.js";

const draft = (): BotCreationDraft => ({
  ...botTemplateDraft(null),
  name: "Private editor",
  description: "Public role",
  instructions: "  Private rules\nKeep whitespace.  ",
});
const submission = (version = 1) => ({
  draft: draft(),
  draftVersion: version,
  template: { templateId: "research-v1" as const, version: 1 as const },
});
const bot = (spawnKey: string, values: Partial<Bot> = {}): Bot => ({
  id: "bot-a",
  spaceId: "space-a",
  threadId: "thread-a",
  spawnKey,
  name: "Private editor",
  title: "",
  description: "Public role",
  instructions: "  Private rules\nKeep whitespace.  ",
  color: "synthetic",
  notifyOnFinish: true,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  preview: "",
  status: "idle",
  runErrorId: null,
  computerMode: "team",
  updatedAt: "2026-10-24T00:00:00Z",
  createdAt: "2026-10-24T00:00:00Z",
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  disabledBuiltinTools: [],
  webhookConfigured: false,
  ...values,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const refusedBeforeWrite = new Error("Rejected before any write");
function setup() {
  let current = true;
  let counter = 0;
  const create = vi.fn(async (input: { spawnKey?: string }) => bot(input.spawnKey!));
  const list = vi.fn(async (): Promise<Bot[]> => []);
  const creator = createBotCreation({
    spaceId: "space-a",
    create,
    list,
    makeNonce: () => `nonce-${++counter}`,
    isCurrent: () => current,
    isAmbiguous: (error) => error !== refusedBeforeWrite,
  });
  return {
    creator,
    create,
    list,
    close: () => {
      current = false;
    },
  };
}

describe("bot creation intent", () => {
  it("freezes one explicit submission before dispatch and blocks synchronous duplicate creates", async () => {
    const s = setup();
    const wait = deferred<Bot>();
    s.create.mockReturnValueOnce(wait.promise);
    const live = submission();
    const first = s.creator.submit(live);
    expect(s.creator.status()).toBe("pending");
    live.draft.instructions = "New unsent rules";
    await expect(s.creator.submit(submission(2))).rejects.toMatchObject({ code: "pending" });
    expect(s.create).toHaveBeenCalledOnce();
    wait.resolve(bot("bot-create:nonce-1"));
    const receipt = await first;
    expect(receipt.submitted.draft.instructions).toBe("  Private rules\nKeep whitespace.  ");
    expect(receipt.submitted.draftVersion).toBe(1);
    expect(receipt.exampleNonce).toBe("bot-example:nonce-2");
    expect(receipt.spawnKey).toBe("bot-create:nonce-1");
    expect(receipt.source).toBe("created");
    expect(Object.isFrozen(receipt.submitted.draft)).toBe(true);
    expect(s.create.mock.calls[0]![0]).toEqual({ ...draft(), spawnKey: "bot-create:nonce-1" });
    expect(s.creator.status()).toBe("confirmed");
    expect(await s.creator.submit(submission(3))).toBe(receipt);
    expect(s.create).toHaveBeenCalledOnce();
  });
});

describe("uncertain creation receipts", () => {
  it("recovers the frozen successful intent without writing changed live fields", async () => {
    const s = setup();
    s.create.mockRejectedValueOnce(new TypeError("Connection lost"));
    s.list.mockResolvedValueOnce([
      bot("bot-create:nonce-1", { instructions: "Changed by another editor" }),
    ]);
    const receipt = await s.creator.submit(submission(4));
    expect(receipt.source).toBe("recovered");
    expect(receipt.submitted.draftVersion).toBe(4);
    expect(receipt.bot.instructions).toBe("Changed by another editor");
    expect(receipt.submitted.draft.instructions).toBe("  Private rules\nKeep whitespace.  ");
    expect(s.create).toHaveBeenCalledOnce();
    expect(s.list).toHaveBeenCalledOnce();
  });
  it("reads before explicit replay and keeps the old payload, keys and draftVersion", async () => {
    const s = setup();
    s.create.mockRejectedValueOnce(new TypeError("Connection lost"));
    await expect(s.creator.submit(submission(1))).rejects.toMatchObject({ code: "unknown" });
    expect(s.creator.status()).toBe("unknown");
    expect(s.create).toHaveBeenCalledOnce();
    s.list.mockRejectedValueOnce(new Error("Offline"));
    await expect(
      s.creator.submit({ ...submission(9), draft: { ...draft(), instructions: "Unsent edits" } }),
    ).rejects.toMatchObject({ code: "unknown" });
    expect(s.create).toHaveBeenCalledOnce();
    const receipt = await s.creator.submit(submission(10));
    expect(s.list).toHaveBeenCalledTimes(3);
    expect(s.create).toHaveBeenCalledTimes(2);
    expect(s.create.mock.calls[1]![0]).toEqual(s.create.mock.calls[0]![0]);
    expect(receipt.submitted.draftVersion).toBe(1);
    expect(receipt.exampleNonce).toBe("bot-example:nonce-2");
    expect(receipt.source).toBe("recovered");
  });
});

describe("known archived creation outcomes", () => {
  it("keeps edits and allows only explicit another intent after a validated archived receipt", async () => {
    const s = setup();
    expect(() => s.creator.startAnother()).toThrow();
    s.create.mockRejectedValueOnce(new TypeError("Connection lost"));
    s.list.mockResolvedValueOnce([
      bot("bot-create:nonce-1", { archivedAt: "2026-10-24T01:00:00Z" }),
    ]);
    const archived = await s.creator.submit(submission()).catch((error: unknown) => error);
    expect(archived).toMatchObject({ code: "archived_recovery" });
    expect(s.creator.status()).toBe("confirmed");
    const live = submission(2);
    live.draft.instructions = "New retained edit";
    await expect(s.creator.submit(live)).rejects.toBe(archived);
    expect(s.create).toHaveBeenCalledOnce();
    expect(s.list).toHaveBeenCalledOnce();
    s.creator.startAnother();
    const receipt = await s.creator.submit(live);
    expect(receipt.bot.archivedAt).toBeNull();
    expect(receipt.submitted.draft.instructions).toBe("New retained edit");
    expect(receipt.submitted.draftVersion).toBe(2);
    expect(receipt.spawnKey).toBe("bot-create:nonce-3");
    expect(receipt.exampleNonce).toBe("bot-example:nonce-4");
    expect(s.create.mock.calls[1]![0]).toMatchObject({ instructions: "New retained edit" });
  });
});

describe("creation validation and definite refusal", () => {
  it.each([
    { ...submission(), draftVersion: -1 },
    { ...submission(), draftVersion: Number.NaN },
    { ...submission(), template: { templateId: "unknown", version: 1 } },
    { ...submission(), template: { templateId: "research-v1", version: 2 } },
    { ...submission(), draft: { ...draft(), name: " " } },
    { ...submission(), draft: { ...draft(), instructions: "x".repeat(20001) } },
  ])(
    "rejects invalid local input before allocating an intent or dispatching (case %#)",
    async (input) => {
      const s = setup();
      await expect(s.creator.submit(input as ReturnType<typeof submission>)).rejects.toBeDefined();
      expect(s.create).not.toHaveBeenCalled();
      expect(s.list).not.toHaveBeenCalled();
      expect(s.creator.status()).toBe("idle");
      const receipt = await s.creator.submit(submission());
      expect(receipt.spawnKey).toBe("bot-create:nonce-1");
    },
  );
  it("permits corrected fresh intent only after a proven prewrite refusal", async () => {
    const s = setup();
    s.create.mockRejectedValueOnce(refusedBeforeWrite);
    await expect(s.creator.submit(submission())).rejects.toBe(refusedBeforeWrite);
    expect(s.creator.status()).toBe("idle");
    expect(s.list).not.toHaveBeenCalled();
    const next = submission(2);
    next.draft.instructions = "Corrected rules";
    const receipt = await s.creator.submit(next);
    expect(receipt.spawnKey).toBe("bot-create:nonce-3");
    expect(receipt.submitted.draft.instructions).toBe("Corrected rules");
  });
  it("does not erase an earlier unknown write because a later attempt was refused", async () => {
    const s = setup();
    s.create.mockRejectedValueOnce(new Error("Opaque gateway error"));
    await expect(s.creator.submit(submission())).rejects.toMatchObject({ code: "unknown" });
    s.create.mockRejectedValueOnce(refusedBeforeWrite);
    await expect(s.creator.submit(submission(2))).rejects.toMatchObject({ code: "unknown" });
    expect(s.creator.status()).toBe("unknown");
    expect(() => s.creator.startAnother()).toThrow();
    s.list.mockResolvedValueOnce([bot("bot-create:nonce-1")]);
    const recovered = await s.creator.submit(submission(3));
    expect(recovered.submitted.draftVersion).toBe(1);
    expect(s.create).toHaveBeenCalledTimes(2);
  });
});

describe("creation receipt and authority boundaries", () => {
  it.each([
    ["wrong Space", { spaceId: "space-b" }],
    ["wrong key", { spawnKey: "bot-create:other" }],
    ["legacy null key", { spawnKey: null }],
    ["empty identity", { id: "" }],
    ["empty thread", { threadId: "" }],
    ["malformed rules", { instructions: null }],
  ])(
    "does not accept a %s response as success or permission to create another",
    async (_label, override) => {
      const s = setup();
      s.create.mockResolvedValueOnce(bot("bot-create:nonce-1", override as Partial<Bot>));
      await expect(s.creator.submit(submission())).rejects.toMatchObject({ code: "unknown" });
      expect(s.creator.status()).toBe("unknown");
      expect(() => s.creator.startAnother()).toThrow();
      s.list.mockResolvedValueOnce([bot("bot-create:nonce-1")]);
      expect((await s.creator.submit(submission(8))).submitted.draftVersion).toBe(1);
      expect(s.create).toHaveBeenCalledOnce();
    },
  );
  it.each([
    ["wrong-scope row", [bot("other", { spaceId: "space-b" })]],
    ["malformed row", [{}]],
    [
      "duplicate key",
      [bot("bot-create:nonce-1"), bot("bot-create:nonce-1", { id: "another-bot" })],
    ],
    ["invalid container", null],
  ])("never replays creation after a complete-view violation: %s", async (_label, rows) => {
    const s = setup();
    s.create.mockRejectedValueOnce(new Error("Unknown response"));
    await expect(s.creator.submit(submission())).rejects.toMatchObject({ code: "unknown" });
    s.list.mockResolvedValueOnce(rows as Bot[]);
    await expect(s.creator.submit(submission(2))).rejects.toMatchObject({ code: "unknown" });
    expect(s.create).toHaveBeenCalledOnce();
    expect(s.creator.status()).toBe("unknown");
  });
  it("recognizes a validated direct archived response without a second read or active receipt", async () => {
    const s = setup();
    s.create.mockResolvedValueOnce(
      bot("bot-create:nonce-1", { archivedAt: "2026-10-24T01:00:00Z" }),
    );
    await expect(s.creator.submit(submission())).rejects.toMatchObject({
      code: "archived_recovery",
    });
    expect(s.creator.status()).toBe("confirmed");
    expect(s.list).not.toHaveBeenCalled();
  });
  it("rejects initial stale authority and never revives a closed editor", async () => {
    let current = false;
    const create = vi.fn(async () => bot("bot-create:a"));
    const creator = createBotCreation({
      spaceId: "space-a",
      create,
      list: async () => [],
      makeNonce: () => "a",
      isCurrent: () => current,
      isAmbiguous: () => true,
    });
    await expect(creator.submit(submission())).rejects.toMatchObject({ code: "closed" });
    current = true;
    await expect(creator.submit(submission())).rejects.toMatchObject({ code: "closed" });
    expect(create).not.toHaveBeenCalled();
  });
  it("rejects stale create completions before any follow-up read or confirmed outcome", async () => {
    const s = setup();
    const wait = deferred<Bot>();
    s.create.mockReturnValueOnce(wait.promise);
    const result = s.creator.submit(submission());
    s.close();
    wait.resolve(bot("bot-create:nonce-1"));
    await expect(result).rejects.toMatchObject({ code: "closed" });
    expect(s.list).not.toHaveBeenCalled();
  });
  it("stops after recovery loses authority, with no second dispatch", async () => {
    const s = setup();
    const wait = deferred<Bot[]>();
    s.create.mockRejectedValueOnce(new Error("Unknown response"));
    s.list.mockReturnValueOnce(wait.promise);
    const result = s.creator.submit(submission());
    await vi.waitFor(() => expect(s.list).toHaveBeenCalledOnce());
    s.close();
    wait.resolve([]);
    await expect(result).rejects.toMatchObject({ code: "closed" });
    expect(s.create).toHaveBeenCalledOnce();
  });
  it("checks authority again before dispatch after synchronous nonce allocation", async () => {
    let current = true;
    const create = vi.fn(async () => bot("bot-create:a"));
    const creator = createBotCreation({
      spaceId: "space-a",
      create,
      list: async () => [],
      makeNonce: () => {
        current = false;
        return "a";
      },
      isCurrent: () => current,
      isAmbiguous: () => true,
    });
    await expect(creator.submit(submission())).rejects.toMatchObject({ code: "closed" });
    expect(create).not.toHaveBeenCalled();
  });
  it("keeps blank creation separate from example insertion and allocates a fresh intent only explicitly", async () => {
    const s = setup();
    const receipt = await s.creator.submit({ ...submission(), template: null });
    expect(receipt.exampleNonce).toBeNull();
    s.creator.startAnother();
    expect((await s.creator.submit(submission(2))).spawnKey).toBe("bot-create:nonce-2");
  });
});

it("keeps an uncertain write recoverable if its adapter cannot classify the error", async () => {
  const create = vi.fn(async () => {
    throw new Error("Opaque response");
  });
  const list = vi.fn(async () => [] as Bot[]);
  const creator = createBotCreation({
    spaceId: "space-a",
    create,
    list,
    makeNonce: () => "a",
    isCurrent: () => true,
    isAmbiguous: () => {
      throw new Error("Unrecognized error shape");
    },
  });
  await expect(creator.submit(submission())).rejects.toMatchObject({ code: "unknown" });
  expect(creator.status()).toBe("unknown");
  expect(list).toHaveBeenCalledOnce();
  list.mockResolvedValueOnce([bot("bot-create:a")]);
  expect((await creator.submit(submission(2))).submitted.draftVersion).toBe(1);
  expect(create).toHaveBeenCalledOnce();
});
