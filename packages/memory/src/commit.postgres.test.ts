import type { AdapterContext, MemoryCommitRequest } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { createDb, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("memory commits (PostgreSQL)", () => {
  const context: AdapterContext = {
    operationId: "memory-commit-test",
    traceId: "memory-commit-test",
    spaceId: "memory-commit-space",
    userId: "memory-commit-user",
    signal: new AbortController().signal,
  };
  let prisma: PrismaClient;
  let store: MarkdownMemoryStore;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    store = new MarkdownMemoryStore(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: {
        id: context.spaceId,
        name: "Memory Test Organization",
        slug: context.spaceId,
        createdAt: new Date(),
        spaces: {
          create: {
            id: context.spaceId,
            name: "Memory Test Space",
            bots: {
              create: {
                id: "memory-commit-bot",
                userId: context.userId,
                name: "Memory Test Bot",
                color: "ink",
              },
            },
          },
        },
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: context.spaceId } });
    } finally {
      await close();
    }
  });

  function request(path: string, content: string): MemoryCommitRequest {
    return {
      scope: "user",
      path,
      content,
      sourceRunId: `run-${content}`,
      sourceThreadId: `thread-${content}`,
    };
  }

  async function document(path: string) {
    return prisma.memoryDocument.findFirstOrThrow({
      where: { spaceId: context.spaceId, path },
      include: { revisions: { orderBy: { revision: "asc" } } },
    });
  }

  function concurrentStore() {
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    return new MarkdownMemoryStore(
      prisma.$extends({
        query: {
          memoryDocument: {
            async findFirst({ args, query }) {
              const result = await query(args);
              reads += 1;
              if (reads === 2) release();
              if (reads <= 2) await bothRead;
              return result;
            },
          },
        },
      }) as PrismaClient,
    );
  }

  it.each(["user", "bot"] as const)(
    "creates only at revision zero and rejects stale %s saves without adding history",
    async (scope) => {
      const path = `conditional-${scope}.md`;
      const write = (content: string, expectedRevision: number): MemoryCommitRequest => ({
        ...request(path, content),
        scope,
        botId: scope === "bot" ? "memory-commit-bot" : undefined,
        expectedRevision,
      });

      await expect(store.commit(write("missing", 1), context)).rejects.toThrow(
        MEMORY_REVISION_CONFLICT_ERROR,
      );
      const initial = await store.commit(write("initial", 0), context);
      expect(initial.revision).toBe(1);
      await expect(store.commit(write("stale-create", 0), context)).rejects.toThrow(
        MEMORY_REVISION_CONFLICT_ERROR,
      );
      const updated = await store.commit(write("updated", 1), context);
      await expect(store.commit(write("stale-update", 1), context)).rejects.toThrow(
        MEMORY_REVISION_CONFLICT_ERROR,
      );

      const current = await document(path);
      expect(current).toMatchObject({
        id: initial.id,
        scope,
        content: "updated",
        revision: 2,
      });
      expect(updated.id).toBe(initial.id);
      expect(
        current.revisions.map(({ revision, content, sourceRunId, sourceThreadId }) => ({
          revision,
          content,
          sourceRunId,
          sourceThreadId,
        })),
      ).toEqual([
        {
          revision: 1,
          content: "initial",
          sourceRunId: "run-initial",
          sourceThreadId: "thread-initial",
        },
        {
          revision: 2,
          content: "updated",
          sourceRunId: "run-updated",
          sourceThreadId: "thread-updated",
        },
      ]);
    },
  );

  it("rejects one overlapping conditional save and preserves only the committed revision", async () => {
    const path = "conditional-overlap.md";
    const initial = await store.commit(request(path, "initial"), context);
    const racingStore = concurrentStore();
    const results = await Promise.allSettled([
      racingStore.commit({ ...request(path, "first"), expectedRevision: 1 }, context),
      racingStore.commit({ ...request(path, "second"), expectedRevision: 1 }, context),
    ]);
    const saved = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const rejected = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );

    expect(saved).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ message: MEMORY_REVISION_CONFLICT_ERROR });
    const current = await document(path);
    expect(current).toMatchObject({ id: initial.id, revision: 2, content: saved[0]!.content });
    expect(current.revisions).toHaveLength(2);
    expect(current.revisions[1]).toMatchObject({
      revision: 2,
      content: saved[0]!.content,
      sourceRunId: `run-${saved[0]!.content}`,
      sourceThreadId: `thread-${saved[0]!.content}`,
    });
  });

  it.each([false, true])(
    "re-reads overlapping Bot appends and retains every fact and its provenance (existing: %s)",
    async (existing) => {
      const path = `append-overlap-${existing}.md`;
      if (existing) {
        await store.commit(
          {
            ...request(path, "initial\n"),
            scope: "bot",
            botId: "memory-commit-bot",
          },
          context,
        );
      }
      const racingStore = concurrentStore();
      let snapshots = 0;
      let conflicts = 0;
      const append = async (fact: string) => {
        for (let attempt = 1; ; attempt += 1) {
          const snapshot = await racingStore.read(
            {
              scope: "bot",
              botId: "memory-commit-bot",
              path,
            },
            context,
          );
          snapshots += 1;
          const current = snapshot.documents[0];
          try {
            return await racingStore.commit(
              {
                ...request(path, fact),
                scope: "bot",
                botId: "memory-commit-bot",
                content: `${current?.content ?? ""}${fact}\n`,
                expectedRevision: current?.revision ?? 0,
              },
              context,
            );
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.message !== MEMORY_REVISION_CONFLICT_ERROR ||
              attempt >= 3
            ) {
              throw error;
            }
            conflicts += 1;
          }
        }
      };

      const results = await Promise.allSettled([append("first"), append("second")]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(conflicts).toBe(1);
      expect(snapshots).toBe(3);
      const saved = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(saved.map((result) => result.revision).sort()).toEqual(existing ? [2, 3] : [1, 2]);
      const current = await document(path);
      expect(await prisma.memoryDocument.count({ where: { spaceId: context.spaceId, path } })).toBe(
        1,
      );
      expect(current.revision).toBe(existing ? 3 : 2);
      expect(current.content.trim().split("\n").sort()).toEqual(
        existing ? ["first", "initial", "second"] : ["first", "second"],
      );
      expect(current.revisions).toHaveLength(current.revision);
      for (const result of saved) {
        const fact = result.content.trim().split("\n").at(-1)!;
        expect(
          current.revisions.find((revision) => revision.revision === result.revision),
        ).toMatchObject({
          documentId: result.id,
          content: result.content,
          sourceRunId: `run-${fact}`,
          sourceThreadId: `thread-${fact}`,
        });
      }
    },
  );

  it.each(["user", "bot"] as const)(
    "retries overlapping %s saves with fresh revisions and matching history",
    async (scope) => {
      const path = `concurrent-${scope}.md`;
      const write = (content: string): MemoryCommitRequest => ({
        ...request(path, content),
        scope,
        botId: scope === "bot" ? "memory-commit-bot" : undefined,
      });
      const initial = await store.commit(write("initial"), context);
      let reads = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      const concurrentStore = new MarkdownMemoryStore(
        prisma.$extends({
          query: {
            memoryDocument: {
              async findFirst({ args, query }) {
                const result = await query(args);
                reads += 1;
                // Both first attempts see revision 1 before either can write.
                if (reads === 2) release();
                if (reads <= 2) await bothRead;
                return result;
              },
            },
          },
        }) as PrismaClient,
      );

      const results = await Promise.allSettled([
        concurrentStore.commit(write("first"), context),
        concurrentStore.commit(write("second"), context),
      ]);

      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(reads).toBe(3);
      const saved = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(saved.map((result) => result.revision).sort()).toEqual([2, 3]);
      const current = await document(path);
      expect(current.revision).toBe(3);
      expect(current.content).toBe(saved.find((result) => result.revision === 3)!.content);
      expect(current.revisions).toHaveLength(3);
      for (const result of [initial, ...saved]) {
        expect(
          current.revisions.find((revision) => revision.revision === result.revision),
        ).toMatchObject({
          documentId: result.id,
          revision: result.revision,
          content: result.content,
          sourceRunId: `run-${result.content}`,
          sourceThreadId: `thread-${result.content}`,
        });
      }
    },
  );

  it.each([false, true])(
    "rolls back a rejected history insert and permits a caller retry (existing: %s)",
    async (existing) => {
      const path = `rejected-${existing}.md`;
      if (existing) await store.commit(request(path, "initial"), context);
      const before = await prisma.memoryDocument.findMany({
        where: { spaceId: context.spaceId, path },
        include: { revisions: true },
      });
      let inserts = 0;
      const rejectingStore = new MarkdownMemoryStore(
        prisma.$extends({
          query: {
            memoryRevision: {
              async create({ args, query }) {
                inserts += 1;
                // Make PostgreSQL reject the history row after the document write.
                return query({
                  ...args,
                  data: {
                    ...args.data,
                    document: undefined,
                    documentId: "missing-memory-document",
                  },
                });
              },
            },
          },
        }) as PrismaClient,
      );

      await expect(rejectingStore.commit(request(path, "rejected"), context)).rejects.toMatchObject(
        {
          code: "P2003",
        },
      );
      expect(inserts).toBe(1);
      expect(
        await prisma.memoryDocument.findMany({
          where: { spaceId: context.spaceId, path },
          include: { revisions: true },
        }),
      ).toEqual(before);

      const retried = await store.commit(request(path, "rejected"), context);
      expect(retried.revision).toBe(existing ? 2 : 1);
      const current = await document(path);
      expect(current.revisions).toHaveLength(retried.revision);
      expect(current.revisions.at(-1)).toMatchObject({
        revision: retried.revision,
        content: retried.content,
      });
    },
  );

  it("bounds conflict retries, preserves only committed saves, and allows a later retry", async () => {
    const path = "exhausted.md";
    await store.commit(request(path, "initial"), context);
    let attempts = 0;
    const conflictingStore = new MarkdownMemoryStore(
      prisma.$extends({
        query: {
          memoryDocument: {
            async findFirst({ args, query }) {
              const result = await query(args);
              attempts += 1;
              // Invalidate every attempted snapshot with a separate committed save.
              await store.commit(request(path, `winner-${attempts}`), context);
              return result;
            },
          },
        },
      }) as PrismaClient,
    );

    await expect(conflictingStore.commit(request(path, "rejected"), context)).rejects.toMatchObject(
      {
        code: "P2034",
      },
    );
    expect(attempts).toBe(3);
    const current = await document(path);
    expect(current).toMatchObject({ revision: 4, content: "winner-3" });
    expect(current.revisions.map(({ revision, content }) => ({ revision, content }))).toEqual([
      { revision: 1, content: "initial" },
      { revision: 2, content: "winner-1" },
      { revision: 3, content: "winner-2" },
      { revision: 4, content: "winner-3" },
    ]);

    const retried = await store.commit(request(path, "rejected"), context);
    expect(retried.revision).toBe(5);
    const afterRetry = await document(path);
    expect(afterRetry).toMatchObject({ revision: 5, content: "rejected" });
    expect(afterRetry.revisions).toHaveLength(5);
    expect(afterRetry.revisions.at(-1)).toMatchObject({ revision: 5, content: "rejected" });
  });
});
