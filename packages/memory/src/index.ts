import { createHash } from "node:crypto";
import type {
  AdapterContext,
  MemoryCommitRequest,
  MemoryExportRequest,
  MemoryReadRequest,
  MemoryRevision,
  MemorySearchRequest,
  MemorySearchResult,
  MemorySnapshot,
  MemoryStore,
  PortableFile,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR, MemoryCommitIdentityError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, withTransactionRetry } from "@rakazo/db";

export class MarkdownMemoryStore implements MemoryStore {
  constructor(private readonly prisma: PrismaClient) {}

  describe() {
    return {
      id: "markdown",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, revisions: true, markdownPortable: true },
    };
  }

  async read(request: MemoryReadRequest, context: AdapterContext): Promise<MemorySnapshot> {
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        scope: request.scope,
        ...(request.botId ? { botId: request.botId } : {}),
        ...(request.path ? { path: request.path } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
    return {
      documents: documents.map((doc) => ({
        id: doc.id,
        path: doc.path,
        content: doc.content,
        revision: doc.revision,
        updatedAt: doc.updatedAt.toISOString(),
      })),
    };
  }

  async search(
    request: MemorySearchRequest,
    context: AdapterContext,
  ): Promise<MemorySearchResult[]> {
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        ...(request.scope === "all" ? {} : { scope: request.scope }),
        ...(request.botId ? { botId: request.botId } : {}),
      },
    });
    const q = request.query.toLowerCase();
    return documents
      .filter((doc) => doc.content.toLowerCase().includes(q) || doc.path.toLowerCase().includes(q))
      .map((doc) => ({
        path: doc.path,
        snippet: snippet(doc.content, q),
        score: 1,
      }));
  }

  async commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision> {
    if (request.idempotencyKey === "") {
      throw new MemoryCommitIdentityError("empty");
    }
    const receiptId =
      request.idempotencyKey === undefined
        ? undefined
        : `memory-commit:${createHash("sha256")
            .update(JSON.stringify([context.spaceId, context.userId, request.idempotencyKey]))
            .digest("hex")}`;
    // A save replaces the current content and appends its history atomically.
    // Conflicts retry the whole transaction so revision numbers use fresh state.
    try {
      return await withTransactionRetry(() =>
        this.prisma.$transaction(
          async (tx) => {
            if (receiptId) {
              const committed = await committedMemory(tx, receiptId, request, context);
              if (committed) return committed;
            }
            const existing = await tx.memoryDocument.findFirst({
              where: {
                spaceId: context.spaceId,
                userId: context.userId,
                scope: request.scope,
                botId: request.botId ?? null,
                path: request.path,
              },
            });
            if (request.expectedRevision !== undefined) {
              const live = existing?.revision ?? 0;
              if (live !== request.expectedRevision)
                throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
            }
            const doc = existing
              ? await tx.memoryDocument.update({
                  where: { id: existing.id },
                  data: { content: request.content, revision: existing.revision + 1 },
                })
              : await tx.memoryDocument.create({
                  data: {
                    spaceId: context.spaceId,
                    userId: context.userId,
                    botId: request.botId,
                    scope: request.scope,
                    path: request.path,
                    content: request.content,
                  },
                });
            await tx.memoryRevision.create({
              data: {
                ...(receiptId ? { id: receiptId } : {}),
                documentId: doc.id,
                revision: doc.revision,
                content: request.content,
                sourceRunId: request.sourceRunId,
                sourceThreadId: request.sourceThreadId,
              },
            });
            return { id: doc.id, path: doc.path, revision: doc.revision, content: doc.content };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
    } catch (error) {
      if (
        receiptId &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2002"
      ) {
        // A concurrent winner may have saved this receipt. The failed transaction
        // has rolled back; return only a verified result for this exact request.
        const committed = await committedMemory(this.prisma, receiptId, request, context);
        if (committed) return committed;
      }
      throw error;
    }
  }

  async *exportMarkdown(
    request: MemoryExportRequest,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const snapshot = await this.read(
      { scope: request.scope === "all" ? "user" : request.scope, botId: request.botId },
      context,
    );
    for (const doc of snapshot.documents) {
      yield { path: doc.path, content: new TextEncoder().encode(doc.content) };
    }
  }

  async importMarkdown(
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<MemoryRevision> {
    let last: MemoryRevision | undefined;
    for await (const file of files) {
      last = await this.commit(
        {
          scope: "user",
          path: file.path,
          content: new TextDecoder().decode(file.content),
        },
        context,
      );
    }
    if (!last) throw new Error("No memory files to import");
    return last;
  }
}

async function committedMemory(
  prisma: Pick<PrismaClient, "memoryRevision">,
  receiptId: string,
  request: MemoryCommitRequest,
  context: AdapterContext,
): Promise<MemoryRevision | undefined> {
  const saved = await prisma.memoryRevision.findUnique({
    where: { id: receiptId },
    select: {
      documentId: true,
      revision: true,
      content: true,
      sourceRunId: true,
      sourceThreadId: true,
      document: {
        select: { spaceId: true, userId: true, scope: true, botId: true, path: true },
      },
    },
  });
  if (!saved) return undefined;
  const doc = saved.document;
  if (
    doc.spaceId !== context.spaceId ||
    doc.userId !== context.userId ||
    doc.scope !== request.scope ||
    doc.botId !== (request.botId ?? null) ||
    doc.path !== request.path ||
    saved.content !== request.content ||
    saved.sourceRunId !== (request.sourceRunId ?? null) ||
    saved.sourceThreadId !== (request.sourceThreadId ?? null)
  ) {
    throw new MemoryCommitIdentityError("mismatch");
  }
  return {
    id: saved.documentId,
    path: doc.path,
    revision: saved.revision,
    content: saved.content,
  };
}

function snippet(content: string, q: string): string {
  const idx = content.toLowerCase().indexOf(q);
  if (idx < 0) return content.slice(0, 140);
  return content.slice(Math.max(0, idx - 40), idx + q.length + 80);
}
