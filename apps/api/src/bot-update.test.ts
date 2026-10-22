import { describe, expect, it, vi } from "vitest";

vi.mock("@rakazo/db", () => ({
  appendEventInTransaction: vi.fn(),
  withTransactionRetry: async (operation: () => Promise<unknown>) => operation(),
}));

import { botProfileChanged, commitBotUpdate } from "./bot-update.js";

describe("botProfileChanged", () => {
  it("is true when name, title, description, or color is present", () => {
    expect(botProfileChanged({})).toBe(false);
    expect(botProfileChanged({ name: "SEO" })).toBe(true);
    expect(botProfileChanged({ title: "Strategist" })).toBe(true);
    expect(botProfileChanged({ description: "Helps with SEO" })).toBe(true);
    expect(botProfileChanged({ color: "#8B5CF6::shape_1" })).toBe(true);
  });
  it("includes an explicit notification preference and omits an absent one", () => {
    expect(botProfileChanged({ notifyOnFinish: false })).toBe(true);
    expect(botProfileChanged({ notifyOnFinish: true })).toBe(true);
    expect(botProfileChanged({ notifyOnFinish: undefined })).toBe(false);
  });
});

describe("commitBotUpdate", () => {
  it("commits a notification preference before a best-effort realtime failure", async () => {
    let committed = false;
    const updated = { id: "bot-1", name: "Chief", title: "", description: "" };
    const update = vi.fn().mockResolvedValue(updated);
    const tx = { bot: { update } };
    const transaction = vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => {
      const result = await operation(tx);
      committed = true;
      return result;
    });
    const append = vi.fn().mockResolvedValue({ seq: 17 });
    const notify = vi.fn(async () => {
      expect(committed).toBe(true);
      throw new Error("realtime unavailable");
    });
    await expect(
      commitBotUpdate(
        {
          prisma: { $transaction: transaction } as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { notifyOnFinish: false },
          emitBotUpdated: true,
        },
        append,
      ),
    ).resolves.toEqual(updated);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { notifyOnFinish: false } }),
    );
    expect(append).toHaveBeenCalledWith(tx, expect.objectContaining({ type: "bot.updated" }));
    expect(notify).toHaveBeenCalledWith("thread-1", 17);
  });
  it("validates a model binding in the same serializable transaction before writing", async () => {
    const update = vi
      .fn()
      .mockResolvedValue({ id: "bot-1", name: "Chief", title: "", description: "" });
    const tx = { bot: { update } };
    const transaction = vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
      operation(tx),
    );
    const validate = vi.fn(async (client: unknown) => {
      expect(client).toBe(tx);
      expect(update).not.toHaveBeenCalled();
    });
    const notify = vi.fn();
    await commitBotUpdate({
      prisma: { $transaction: transaction } as never,
      notify,
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      data: { modelCredentialId: "connection-a" },
      emitBotUpdated: false,
      validate,
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(validate).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not write or emit when transactional model validation rejects", async () => {
    const update = vi.fn();
    const tx = { bot: { update } };
    const transaction = vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
      operation(tx),
    );
    const notify = vi.fn();
    const append = vi.fn();
    await expect(
      commitBotUpdate(
        {
          prisma: { $transaction: transaction } as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { name: "New", modelCredentialId: "connection-a" },
          emitBotUpdated: true,
          validate: async () => {
            throw new Error("connection changed");
          },
        },
        append,
      ),
    ).rejects.toThrow("connection changed");
    expect(update).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  it("writes the bot row and bot.updated in one transaction when labels change", async () => {
    const updated = {
      id: "bot-1",
      name: "SEO Strategist",
      title: "SEO Strategist",
      description: "Helps with keyword research",
    };
    const botUpdate = vi.fn().mockResolvedValue(updated);
    const tx = { bot: { update: botUpdate } };
    const transaction = vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
    const notify = vi.fn().mockResolvedValue(undefined);
    const appendEvent = vi.fn().mockResolvedValue({ seq: 9 });
    const prisma = {
      $transaction: transaction,
      bot: { update: vi.fn() },
    };

    await expect(
      commitBotUpdate(
        {
          prisma: prisma as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { name: "SEO Strategist", title: "SEO Strategist" },
          emitBotUpdated: true,
        },
        appendEvent,
      ),
    ).resolves.toEqual(updated);

    expect(transaction).toHaveBeenCalledOnce();
    expect(botUpdate).toHaveBeenCalledOnce();
    expect(appendEvent).toHaveBeenCalledWith(tx, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      type: "bot.updated",
      payload: {
        botId: "bot-1",
        name: "SEO Strategist",
        title: "SEO Strategist",
        description: "Helps with keyword research",
      },
    });
    expect(notify).toHaveBeenCalledWith("thread-1", 9);
    expect(prisma.bot.update).not.toHaveBeenCalled();
  });

  it("fails the whole update when the durable event write fails", async () => {
    const appendEvent = vi.fn().mockRejectedValue(new Error("event store unavailable"));
    const transaction = vi.fn(async (run: (client: unknown) => Promise<unknown>) =>
      run({
        bot: {
          update: vi.fn().mockResolvedValue({
            id: "bot-1",
            name: "SEO",
            title: "SEO",
            description: "",
          }),
        },
      }),
    );
    const notify = vi.fn();
    const prisma = {
      $transaction: transaction,
      bot: { update: vi.fn() },
    };

    await expect(
      commitBotUpdate(
        {
          prisma: prisma as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { name: "SEO" },
          emitBotUpdated: true,
        },
        appendEvent,
      ),
    ).rejects.toThrow("event store unavailable");
    expect(notify).not.toHaveBeenCalled();
    expect(prisma.bot.update).not.toHaveBeenCalled();
  });

  it("updates without an event when profile labels are unchanged", async () => {
    const update = vi.fn().mockResolvedValue({
      id: "bot-1",
      name: "Chief",
      title: "Chief",
      description: "",
    });
    const prisma = {
      $transaction: vi.fn(),
      bot: { update },
    };
    const notify = vi.fn();
    const appendEvent = vi.fn();

    await expect(
      commitBotUpdate(
        {
          prisma: prisma as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { pinned: true },
          emitBotUpdated: false,
        },
        appendEvent,
      ),
    ).resolves.toMatchObject({ id: "bot-1" });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });
});
