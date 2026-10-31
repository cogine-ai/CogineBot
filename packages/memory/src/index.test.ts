import type { AdapterContext } from "@rakazo/adapter-kit";
import { MemoryCommitIdentityError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const context: AdapterContext = {
  operationId: "read-memory",
  traceId: "read-memory",
  spaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("memory store contract shape", () => {
  it("declares markdown portability", () => {
    const store = new MarkdownMemoryStore({} as never);
    expect(store.describe().capabilities.markdownPortable).toBe(true);
  });

  it("reads the most recently updated documents first", async () => {
    const updatedAt = new Date("2026-08-16T10:00:00.000Z");
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { id: "memory-1", path: "facts.md", content: "A fact", revision: 3, updatedAt },
      ]);
    const store = new MarkdownMemoryStore({ memoryDocument: { findMany } } as never);

    await expect(store.read({ scope: "bot", botId: "bot-1" }, context)).resolves.toEqual({
      documents: [
        {
          id: "memory-1",
          path: "facts.md",
          content: "A fact",
          revision: 3,
          updatedAt: updatedAt.toISOString(),
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "workspace-1",
        userId: "user-1",
        scope: "bot",
        botId: "bot-1",
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
  });
});

describe("memory commit retry receipts", () => {
  const request = {
    scope: "user" as const,
    path: "facts.md",
    content: "saved fact",
    sourceRunId: "run-1",
    sourceThreadId: "thread-1",
    idempotencyKey: "intent-1",
  };
  function receipt() {
    return {
      documentId: "document-1",
      revision: 2,
      content: request.content,
      sourceRunId: request.sourceRunId,
      sourceThreadId: request.sourceThreadId,
      document: {
        spaceId: context.spaceId,
        userId: context.userId,
        scope: request.scope,
        botId: null,
        path: request.path,
      },
    };
  }

  it("returns a verified concurrent winner after a unique conflict rolls back", async () => {
    const conflict = Object.assign(new Error("unique conflict"), { code: "P2002" });
    const transaction = vi.fn().mockRejectedValue(conflict);
    const findUnique = vi.fn().mockResolvedValue(receipt());
    const store = new MarkdownMemoryStore({
      $transaction: transaction,
      memoryRevision: { findUnique },
    } as never);

    await expect(store.commit(request, context)).resolves.toEqual({
      id: "document-1",
      path: request.path,
      content: request.content,
      revision: 2,
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(findUnique).toHaveBeenCalledOnce();
    expect(transaction.mock.invocationCallOrder[0]).toBeLessThan(
      findUnique.mock.invocationCallOrder[0]!,
    );
  });

  it("preserves a unique conflict when no matching committed receipt exists", async () => {
    const conflict = Object.assign(new Error("unrelated unique conflict"), { code: "P2002" });
    const findUnique = vi.fn().mockResolvedValue(null);
    const store = new MarkdownMemoryStore({
      $transaction: vi.fn().mockRejectedValue(conflict),
      memoryRevision: { findUnique },
    } as never);
    await expect(store.commit(request, context)).rejects.toBe(conflict);
    expect(findUnique).toHaveBeenCalledOnce();
  });

  it("does not reinterpret a non-unique database failure as a successful retry", async () => {
    const fault = new Error("database unavailable");
    const findUnique = vi.fn();
    const store = new MarkdownMemoryStore({
      $transaction: vi.fn().mockRejectedValue(fault),
      memoryRevision: { findUnique },
    } as never);
    await expect(store.commit(request, context)).rejects.toBe(fault);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("does not enable receipt fallback for an ordinary unkeyed save", async () => {
    const conflict = Object.assign(new Error("unique conflict"), { code: "P2002" });
    const findUnique = vi.fn();
    const store = new MarkdownMemoryStore({
      $transaction: vi.fn().mockRejectedValue(conflict),
      memoryRevision: { findUnique },
    } as never);
    await expect(store.commit({ ...request, idempotencyKey: undefined }, context)).rejects.toBe(
      conflict,
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each(["spaceId", "userId"] as const)(
    "refuses a conflicting receipt with a different %s",
    async (field) => {
      const saved = receipt();
      saved.document[field] = "other";
      const conflict = Object.assign(new Error("unique conflict"), { code: "P2002" });
      const store = new MarkdownMemoryStore({
        $transaction: vi.fn().mockRejectedValue(conflict),
        memoryRevision: { findUnique: vi.fn().mockResolvedValue(saved) },
      } as never);
      const result = store.commit(request, context);
      await expect(result).rejects.toThrow(
        "Memory commit identity does not match its saved revision",
      );
      await expect(result).rejects.toBeInstanceOf(MemoryCommitIdentityError);
    },
  );

  it("rejects an empty key before accessing the database", async () => {
    const transaction = vi.fn();
    const store = new MarkdownMemoryStore({ $transaction: transaction } as never);
    const result = store.commit({ ...request, idempotencyKey: "" }, context);
    await expect(result).rejects.toThrow("Memory commit idempotency key must not be empty");
    await expect(result).rejects.toBeInstanceOf(MemoryCommitIdentityError);
    expect(transaction).not.toHaveBeenCalled();
  });
});
