import type {
  Actor,
  Bot,
  BotSection,
  MessageBlock,
  RemovedBotSection,
  SpaceBot,
} from "@rakazo/contracts";
import {
  BOT_COLORS,
  BotSectionNameSchema,
  BotSectionStoredNameSchema,
  RemovedBotSectionSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import type { ComputerMode } from "./computers.js";
import { ensureComputerRecord, parseComputerMode } from "./computers.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { BotSectionNameConflictError, IsolationError } from "./scope.js";
import { lockSpaceForContentCreation } from "./spaces.js";
import {
  activeRunSelection,
  latestBotRunSelection,
  loadThreadAttention,
  loadThreadPreviews,
  SIDEBAR_PREVIEW_MESSAGE_WINDOW,
} from "./thread-listing.js";
import { withTransactionRetry } from "./transaction-retry.js";

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function mapBotSection(section: {
  id: string;
  name: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}): BotSection {
  return {
    id: section.id,
    name: section.name,
    position: section.position,
    createdAt: section.createdAt.toISOString(),
    updatedAt: section.updatedAt.toISOString(),
  };
}

function isSpawnKeyConflict(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const target = (error as { meta?: { target?: string[] | string } }).meta?.target;
  if (target == null) return true;
  const fields = Array.isArray(target) ? target : [target];
  return fields.some((field) => field === "spawnKey" || field.includes("spawnKey"));
}

function rosterRunErrorId(
  latestRun: { id: string; status: string } | undefined,
  activeRun: { status: string } | undefined,
): string | null {
  if (
    latestRun?.status !== "failed" ||
    activeRun?.status === "waiting_input" ||
    activeRun?.status === "waiting_takeover"
  ) {
    return null;
  }
  return latestRun.id;
}

function mapBot(
  bot: {
    id: string;
    spaceId: string;
    name: string;
    title: string;
    description: string;
    instructions: string;
    color: string;
    notifyOnFinish: boolean;
    pinned: boolean;
    sectionId: string | null;
    archivedAt: Date | null;
    parentBotId: string | null;
    memoryScope: string | null;
    createdAt: Date;
    updatedAt: Date;
    thread: { id: string; unread: boolean } | null;
    computer: { scope: string } | null;
    voiceId?: string | null;
    autoSpeak?: boolean;
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: string | null;
    teamChatAmbientEnabled?: boolean;
    teamChatRules?: string;
    disabledBuiltinTools?: string[];
    webhookSecretId?: string | null;
    spawnKey?: string | null;
  },
  preview = "",
  status = "idle",
  attentionMessageId: string | null = null,
  runErrorId: string | null = null,
): Bot {
  if (!bot.thread) {
    throw new IsolationError("Bot is missing its thread");
  }
  return {
    id: bot.id,
    spaceId: bot.spaceId,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    instructions: bot.instructions,
    color: bot.color,
    notifyOnFinish: bot.notifyOnFinish,
    pinned: bot.pinned,
    sectionId: bot.sectionId,
    archivedAt: bot.archivedAt?.toISOString() ?? null,
    unread: bot.thread.unread,
    attentionMessageId,
    parentBotId: bot.parentBotId,
    memoryScope: bot.memoryScope as "isolated" | "shared" | null,
    threadId: bot.thread.id,
    preview,
    status,
    runErrorId,
    computerMode: bot.computer ? parseComputerMode(bot.computer.scope) : "team",
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt.toISOString(),
    voiceId: bot.voiceId ?? null,
    autoSpeak: bot.autoSpeak ?? false,
    modelProvider: bot.modelProvider ?? null,
    modelId: bot.modelId ?? null,
    thinkingLevel: (bot.thinkingLevel as Bot["thinkingLevel"]) ?? null,
    teamChatAmbientEnabled: bot.teamChatAmbientEnabled ?? false,
    teamChatRules: bot.teamChatRules ?? "",
    disabledBuiltinTools: bot.disabledBuiltinTools ?? [],
    webhookConfigured: Boolean(bot.webhookSecretId),
    spawnKey: bot.spawnKey ?? null,
  };
}

export function createRepos(prisma: PrismaClient) {
  async function listBotSectionsForSpaces(
    actor: Actor,
    spaceIds: string[],
  ): Promise<Array<BotSection & { spaceId: string }>> {
    if (spaceIds.length === 0) return [];
    const sections = await prisma.botSection.findMany({
      where: { spaceId: { in: spaceIds }, userId: actor.userId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    return sections.map((section) => ({
      id: section.id,
      spaceId: section.spaceId,
      name: section.name,
      position: section.position,
      createdAt: section.createdAt.toISOString(),
      updatedAt: section.updatedAt.toISOString(),
    }));
  }

  async function listSpaceBotsForSpaces(actor: Actor, spaceIds: string[]): Promise<SpaceBot[]> {
    if (spaceIds.length === 0) return [];
    const bots = await prisma.bot.findMany({
      where: {
        spaceId: { in: spaceIds },
        userId: actor.userId,
        archivedAt: null,
      },
      select: {
        id: true,
        spaceId: true,
        name: true,
        title: true,
        color: true,
        notifyOnFinish: true,
        pinned: true,
        sectionId: true,
        updatedAt: true,
        parentBotId: true,
        thread: {
          select: {
            id: true,
            unread: true,
            messages: {
              orderBy: { seq: "desc" },
              take: SIDEBAR_PREVIEW_MESSAGE_WINDOW,
              select: { blocks: true, runId: true, seq: true },
            },
            runs: latestBotRunSelection,
          },
        },
        runs: activeRunSelection,
      },
      orderBy: [{ pinned: "desc" }, { position: "asc" }, { createdAt: "asc" }],
    });
    const [previews, attention] = await Promise.all([
      loadThreadPreviews(
        prisma,
        bots.map((bot) => bot.thread),
      ),
      loadThreadAttention(
        prisma,
        bots.flatMap((bot) => (bot.thread ? [bot.thread.id] : [])),
      ),
    ]);
    return bots.map((bot) => {
      if (!bot.thread) throw new IsolationError("Bot is missing its thread");
      return {
        id: bot.id,
        spaceId: bot.spaceId,
        name: bot.name,
        title: bot.title,
        color: bot.color,
        notifyOnFinish: bot.notifyOnFinish,
        pinned: bot.pinned,
        sectionId: bot.sectionId,
        unread: bot.thread.unread,
        attentionMessageId: attention.get(bot.thread.id)?.attentionMessageId ?? null,
        parentBotId: bot.parentBotId,
        preview: previews.get(bot.thread.id) ?? "",
        status: bot.runs[0]?.status ?? "idle",
        runErrorId: rosterRunErrorId(bot.thread.runs[0], bot.runs[0]),
        updatedAt: bot.updatedAt.toISOString(),
      };
    });
  }

  return {
    async listBotSections(actor: Actor): Promise<BotSection[]> {
      return listBotSectionsForSpaces(actor, [actor.spaceId]);
    },

    listBotSectionsForSpaces,

    async createBotSection(
      actor: Actor,
      input: { botId?: string; groupId?: string; name: string },
    ) {
      const name = BotSectionNameSchema.parse(input.name);
      if (Boolean(input.botId) === Boolean(input.groupId)) throw new IsolationError();
      return prisma.$transaction(async (tx) => {
        const target = input.botId
          ? await tx.bot.findFirst({
              where: {
                id: input.botId,
                spaceId: actor.spaceId,
                userId: actor.userId,
                archivedAt: null,
              },
              select: { id: true },
            })
          : await tx.chatGroup.findFirst({
              where: {
                id: input.groupId,
                spaceId: actor.spaceId,
                userId: actor.userId,
                archivedAt: null,
              },
              select: { id: true },
            });
        if (!target) throw new IsolationError();

        const aggregate = await tx.botSection.aggregate({
          where: { spaceId: actor.spaceId, userId: actor.userId },
          _max: { position: true },
        });
        const created = await tx.botSection.createMany({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            name,
            position: (aggregate._max.position ?? -1) + 1,
          },
          skipDuplicates: true,
        });
        if (created.count === 0) throw new BotSectionNameConflictError();
        const section = await tx.botSection.findUniqueOrThrow({
          where: {
            spaceId_userId_name: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              name,
            },
          },
        });
        if (input.botId) {
          await tx.bot.update({
            where: { id: target.id },
            data: { sectionId: section.id, pinned: false },
          });
        } else {
          await tx.chatGroup.update({
            where: { id: target.id },
            data: { sectionId: section.id, pinned: false },
          });
        }
        return mapBotSection(section);
      });
    },

    async updateBotSection(actor: Actor, input: { sectionId: string; name: string }) {
      const name = BotSectionStoredNameSchema.parse(input.name);
      const existing = await prisma.botSection.findFirst({
        where: {
          id: input.sectionId,
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
      });
      if (!existing) throw new IsolationError();
      if (existing.name === name) return mapBotSection(existing);
      try {
        const section = await prisma.botSection.update({
          where: { id: existing.id },
          data: { name },
        });
        return mapBotSection(section);
      } catch (error) {
        if (isUniqueViolation(error)) throw new BotSectionNameConflictError();
        throw error;
      }
    },

    async reorderBotSections(actor: Actor, sectionIds: string[]): Promise<BotSection[]> {
      return withTransactionRetry(() =>
        prisma.$transaction(
          async (tx) => {
            const sections = await tx.botSection.findMany({
              where: { spaceId: actor.spaceId, userId: actor.userId },
            });
            const ids = new Set(sectionIds);
            if (
              ids.size !== sectionIds.length ||
              ids.size !== sections.length ||
              sections.some((section) => !ids.has(section.id))
            ) {
              throw new IsolationError();
            }
            const reordered = [];
            for (const [position, id] of sectionIds.entries()) {
              const section = await tx.botSection.update({ where: { id }, data: { position } });
              reordered.push(mapBotSection(section));
            }
            return reordered;
          },
          { isolationLevel: "Serializable" },
        ),
      );
    },

    async removeBotSection(actor: Actor, sectionId: string): Promise<RemovedBotSection> {
      return withTransactionRetry(() =>
        prisma.$transaction(
          async (tx) => {
            const scope = { spaceId: actor.spaceId, userId: actor.userId };
            const section = await tx.botSection.findFirst({ where: { id: sectionId, ...scope } });
            if (!section) throw new IsolationError();
            // Archived conversations keep their organization too, including on undo.
            const [bots, groups] = await Promise.all([
              tx.bot.findMany({ where: { ...scope, sectionId }, select: { id: true } }),
              tx.chatGroup.findMany({ where: { ...scope, sectionId }, select: { id: true } }),
            ]);
            await tx.bot.updateMany({ where: { ...scope, sectionId }, data: { sectionId: null } });
            await tx.chatGroup.updateMany({
              where: { ...scope, sectionId },
              data: { sectionId: null },
            });
            await tx.botSection.delete({ where: { id: sectionId } });
            return {
              section: mapBotSection(section),
              botIds: bots.map((bot) => bot.id),
              groupIds: groups.map((group) => group.id),
            };
          },
          { isolationLevel: "Serializable" },
        ),
      );
    },

    async restoreBotSection(actor: Actor, snapshot: RemovedBotSection): Promise<BotSection> {
      const {
        section: { name },
      } = RemovedBotSectionSchema.parse(snapshot);
      const restore = () =>
        withTransactionRetry(() =>
          prisma.$transaction(
            async (tx) => {
              const scope = { spaceId: actor.spaceId, userId: actor.userId };
              const botIds = [...new Set(snapshot.botIds)];
              const groupIds = [...new Set(snapshot.groupIds)];
              const [bots, groups, original] = await Promise.all([
                tx.bot.findMany({
                  where: { id: { in: botIds } },
                  select: { id: true, spaceId: true, userId: true },
                }),
                tx.chatGroup.findMany({
                  where: { id: { in: groupIds } },
                  select: { id: true, spaceId: true, userId: true },
                }),
                tx.botSection.findUnique({ where: { id: snapshot.section.id } }),
              ]);
              // Deleted members no longer need restoring. Authorize every remaining
              // record, including archived or already moved items, before any write.
              if (
                [...bots, ...groups].some(
                  (item) => item.spaceId !== actor.spaceId || item.userId !== actor.userId,
                ) ||
                (original &&
                  (original.spaceId !== actor.spaceId || original.userId !== actor.userId))
              ) {
                throw new IsolationError();
              }
              let section =
                original ?? (await tx.botSection.findFirst({ where: { ...scope, name } }));
              if (!section) {
                const aggregate = await tx.botSection.aggregate({
                  where: scope,
                  _max: { position: true },
                });
                const position = Math.min(
                  snapshot.section.position,
                  (aggregate._max.position ?? -1) + 1,
                );
                await tx.botSection.updateMany({
                  where: { ...scope, position: { gte: position } },
                  data: { position: { increment: 1 } },
                });
                section = await tx.botSection.create({
                  data: { ...scope, id: snapshot.section.id, name, position },
                });
              }
              // A subsequent move wins over undo; pin choices also remain unchanged.
              await tx.bot.updateMany({
                where: { ...scope, id: { in: botIds }, sectionId: null },
                data: { sectionId: section.id },
              });
              await tx.chatGroup.updateMany({
                where: { ...scope, id: { in: groupIds }, sectionId: null },
                data: { sectionId: section.id },
              });
              return mapBotSection(section);
            },
            { isolationLevel: "Serializable" },
          ),
        );
      // A concurrent regular create can win the name/id after our snapshot read
      // and surface P2002 instead of a serialization conflict. Re-read and reuse
      // the winner, including repeating every authorization check.
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await restore();
        } catch (error) {
          if (!isUniqueViolation(error) || attempt >= 3) throw error;
        }
      }
    },

    async listBots(actor: Actor, options: { archived?: boolean } = {}): Promise<Bot[]> {
      const bots = await prisma.bot.findMany({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          archivedAt: options.archived ? { not: null } : null,
        },
        include: {
          thread: {
            include: {
              messages: { orderBy: { seq: "desc" }, take: SIDEBAR_PREVIEW_MESSAGE_WINDOW },
              runs: latestBotRunSelection,
            },
          },
          runs: activeRunSelection,
          computer: { select: { scope: true } },
        },
        orderBy: [{ pinned: "desc" }, { position: "asc" }, { createdAt: "asc" }],
      });
      const [previews, attention] = await Promise.all([
        loadThreadPreviews(
          prisma,
          bots.map((bot) => bot.thread),
        ),
        loadThreadAttention(
          prisma,
          bots.flatMap((bot) => (bot.thread ? [bot.thread.id] : [])),
        ),
      ]);
      return bots.map((bot) =>
        mapBot(
          bot,
          previews.get(bot.thread?.id ?? "") ?? "",
          bot.runs[0]?.status ?? "idle",
          attention.get(bot.thread?.id ?? "")?.attentionMessageId ?? null,
          rosterRunErrorId(bot.thread?.runs[0], bot.runs[0]),
        ),
      );
    },

    listSpaceBotsForSpaces,

    async getBot(actor: Actor, botId: string, options: { includeArchived?: boolean } = {}) {
      const bot = await prisma.bot.findFirst({
        where: {
          id: botId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          ...(options.includeArchived ? {} : { archivedAt: null }),
        },
        include: { thread: true, computer: true },
      });
      if (!bot) throw new IsolationError();
      return bot;
    },

    async createBot(
      actor: Actor,
      input: {
        name: string;
        title: string;
        description: string;
        instructions: string;
        notifyOnFinish: boolean;
        color?: string;
        parentBotId?: string | null;
        computerMode?: ComputerMode;
        spawnKey?: string;
        modelProvider?: string | null;
        modelId?: string | null;
        thinkingLevel?: string | null;
        disabledBuiltinTools?: string[];
        initialMessage?: {
          role: "user" | "bot" | "system";
          blocks: MessageBlock[];
          runId?: string;
        };
      },
    ): Promise<Bot> {
      let color = input.color;
      if (color === undefined) {
        const count = await prisma.bot.count({
          where: { spaceId: actor.spaceId, userId: actor.userId },
        });
        color = BOT_COLORS[count % BOT_COLORS.length] ?? BOT_COLORS[0];
      }
      let modelProvider = input.modelProvider ?? null;
      let modelId = input.modelId ?? null;
      let thinkingLevel = input.thinkingLevel ?? null;
      let disabledBuiltinTools = input.disabledBuiltinTools ?? [];
      if (input.parentBotId) {
        const parent = await prisma.bot.findFirst({
          where: {
            id: input.parentBotId,
            spaceId: actor.spaceId,
            userId: actor.userId,
          },
        });
        if (!parent) throw new IsolationError();
        if (!modelId) {
          modelProvider = parent.modelProvider ?? null;
          modelId = parent.modelId ?? null;
        }
        if (thinkingLevel == null) thinkingLevel = parent.thinkingLevel ?? null;
        if (input.disabledBuiltinTools === undefined) {
          disabledBuiltinTools = parent.disabledBuiltinTools;
        }
      }
      const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
      const envKind = process.env.SANDBOX_PROVIDER ?? "docker";
      const kind =
        envKind === "docker" && settings?.computerHost === "this-mac" ? "desktop" : envKind;
      const insertBot = () =>
        prisma.$transaction(async (tx) => {
          await lockSpaceForContentCreation(tx, {
            spaceId: actor.spaceId,
            userId: actor.userId,
          });
          const positions = await tx.bot.aggregate({
            where: { spaceId: actor.spaceId, userId: actor.userId },
            _max: { position: true },
          });
          const teamComputer = await ensureComputerRecord(tx, {
            mode: "team",
            spaceId: actor.spaceId,
            userId: actor.userId,
            kind,
          });
          const created = await tx.bot.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              name: input.name,
              title: input.title,
              description: input.description,
              instructions: input.instructions,
              notifyOnFinish: input.notifyOnFinish,
              color,
              position: (positions._max.position ?? -1) + 1,
              parentBotId: input.parentBotId ?? null,
              computerId: teamComputer.id,
              spawnKey: input.spawnKey,
              modelProvider,
              modelId,
              thinkingLevel,
              disabledBuiltinTools,
            },
          });
          const thread = await tx.thread.create({
            data: {
              spaceId: actor.spaceId,
              botId: created.id,
              userId: actor.userId,
            },
          });
          if (input.initialMessage) {
            await createThreadMessageInTransaction(tx, {
              threadId: thread.id,
              ...input.initialMessage,
            });
          }
          if (input.computerMode === "dedicated") {
            const dedicated = await ensureComputerRecord(tx, {
              mode: "dedicated",
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: created.id,
              kind,
            });
            await tx.bot.update({ where: { id: created.id }, data: { computerId: dedicated.id } });
          }
          await tx.browserProfile.create({
            data: {
              spaceId: actor.spaceId,
              botId: created.id,
              userId: actor.userId,
            },
          });
          await tx.memoryDocument.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: created.id,
              scope: "bot",
              path: "MEMORY.md",
              content: `# ${input.name}\n\n`,
            },
          });
          return tx.bot.findFirstOrThrow({
            where: { id: created.id },
            include: { thread: true, computer: true },
          });
        });

      const findBySpawnKey = async () => {
        if (!input.spawnKey) return null;
        return prisma.bot.findUnique({
          where: {
            spaceId_spawnKey: {
              spaceId: actor.spaceId,
              spawnKey: input.spawnKey,
            },
          },
          include: { thread: true, computer: true },
        });
      };

      let bot: Awaited<ReturnType<typeof insertBot>>;
      try {
        bot = await insertBot();
      } catch (error) {
        if (!input.spawnKey || !isSpawnKeyConflict(error)) throw error;
        const existing = await findBySpawnKey();
        if (!existing || existing.userId !== actor.userId) throw error;
        if (!existing.archivedAt) {
          bot = existing;
        } else {
          // Free the key from the archived bot so empty-space onboarding
          // creates a fresh first bot (stale thread/runtime must not return).
          await prisma.bot.update({
            where: { id: existing.id },
            data: { spawnKey: null },
          });
          try {
            bot = await insertBot();
          } catch (retryError) {
            if (!isSpawnKeyConflict(retryError)) throw retryError;
            const winner = await findBySpawnKey();
            if (!winner || winner.userId !== actor.userId || winner.archivedAt) throw retryError;
            bot = winner;
          }
        }
      }
      return mapBot(bot);
    },

    async reorderBots(actor: Actor, botIds: string[]): Promise<void> {
      await prisma.$transaction(async (tx) => {
        const bots = await tx.bot.findMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            archivedAt: null,
          },
          select: { id: true },
        });
        const existing = new Set(bots.map((bot) => bot.id));
        if (existing.size !== botIds.length || botIds.some((id) => !existing.has(id))) {
          throw new IsolationError();
        }
        // ponytail: rosters are small; switch to one SQL CASE update only if this becomes hot.
        await Promise.all(
          botIds.map((id, position) => tx.bot.update({ where: { id }, data: { position } })),
        );
      });
    },

    async setBotComputer(actor: Actor, botId: string, mode: ComputerMode): Promise<Bot> {
      const bot = await prisma.bot.findFirst({
        where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
        include: { computer: true },
      });
      if (!bot?.computer) throw new IsolationError();
      const kind = bot.computer.kind;
      // Keep ensure + bot link in one transaction so a capped quota lock covers
      // both steps (a computer row alone does not count until a live bot refs it).
      const updated = await withTransactionRetry(() =>
        prisma.$transaction(async (tx) => {
          const computer = await ensureComputerRecord(tx, {
            mode,
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId,
            kind,
          });
          return tx.bot.update({
            where: { id: botId },
            data: { computerId: computer.id },
            include: { thread: true, computer: true },
          });
        }),
      );
      return mapBot(updated);
    },
  };
}
