import { posix } from "node:path";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import type { ComputerMode, MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  BOT_MESSAGE_TOO_LONG,
  redactSecrets,
  resolveBotAddress,
} from "@rakazo/core";
import { messageBot } from "./bot-messages.js";
import type { PeerDispatchDeps } from "./collaboration-policy.js";
import { normalizeWorkspacePath, resolveBotWorkspacePath } from "./computer-support.js";
import type { ExecutorDeps } from "./executor.js";
import { handoffToGroupBot } from "./group-handoff.js";
import { attachWorkspaceFileToThread, readWorkspaceFile as readFile } from "./thread-artifacts.js";

type AttachmentBlock = Extract<MessageBlock, { kind: "image" | "file" }>;
export type BotFileContext = {
  deps: PeerDispatchDeps & Pick<ExecutorDeps, "sandbox" | "artifacts">;
  run: Parameters<typeof messageBot>[1];
  bot: { id: string; name: string; computerId: string | null; computerSwitching: boolean };
  thread: { groupId: string | null };
  computer: { mode: ComputerMode; get: () => Promise<ComputerRef> };
  context: AdapterContext;
  secrets: string[];
};
export type BotFileCall = {
  args: Record<string, unknown>;
  executionId: string;
  effectKey?: string;
};

async function readWorkspaceFile(ctx: BotFileContext, _call: BotFileCall, filePath: string) {
  return readFile(ctx.deps, {
    context: ctx.context,
    computer: ctx.computer.get,
    computerMode: ctx.computer.mode,
    botId: ctx.bot.id,
    filePath,
  });
}

async function saveWorkspaceFile(
  ctx: BotFileContext,
  call: BotFileCall,
  filePath: string,
  bytes: Uint8Array,
  owner: { botId: string; groupId?: string },
) {
  if (!ctx.deps.artifacts) throw new Error("artifact storage unavailable");
  return attachWorkspaceFileToThread(
    { prisma: ctx.deps.prisma, artifacts: ctx.deps.artifacts },
    {
      spaceId: ctx.run.spaceId,
      userId: ctx.run.userId,
      botId: owner.botId,
      groupId: owner.groupId,
      runId: ctx.run.id,
      filePath,
      bytes,
      operationId: call.executionId,
    },
  );
}

const ZIP_HELPS = new Set(["file not found or unreadable", "unsupported attachment type"]);

/** `recipientId` is the bot the files were prepared for; delivery must go to that same bot. */
type SentFiles = { files: AttachmentBlock[]; sharedPaths: string[]; recipientId?: string };

/**
 * Files a bot passes by path to another bot. A recipient on the same computer reads them
 * where they are. One elsewhere, or one that cannot be told apart, gets saved copies, filed
 * under the chat that shows them: its own, or the group's for a handoff. Every file is read
 * before any is saved, so a bad path leaves nothing behind.
 */
async function prepareSentFiles(
  ctx: BotFileContext,
  call: BotFileCall,
  recipient: { botId?: string; name?: string; groupId?: string },
): Promise<{ error: string } | SentFiles> {
  const raw = call.args.files;
  if (raw === undefined || raw === null) return { files: [], sharedPaths: [] };
  if (!Array.isArray(raw) || raw.some((path) => typeof path !== "string" || !path.trim())) {
    return { error: "files must be a list of file paths" };
  }
  const paths = [...new Set(raw.map((path: string) => path.trim()))];
  if (!paths.length) return { files: [], sharedPaths: [] };
  if (paths.length > ATTACHMENT_MAX_COUNT) {
    return { error: `send at most ${ATTACHMENT_MAX_COUNT} files; zip the rest into one file` };
  }
  const target = await findRecipient(ctx, recipient);
  if (!target) return { error: "no bot found with that id or name. Nothing was sent." };
  const { bot } = ctx;
  if (
    bot.computerId &&
    !bot.computerSwitching &&
    !target.computerSwitching &&
    target.computerId === bot.computerId
  )
    return withRecipient(await sharedFiles(ctx, paths), target.id);
  const read: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const path of paths) {
    const file = await readWorkspaceFile(ctx, call, path);
    if ("error" in file) {
      // The recipient has its own computer, so a folder or raw source file has to travel zipped.
      const hint = ZIP_HELPS.has(file.error) ? "; zip it and send the zip" : "";
      return { error: `${path}: ${file.error}${hint}. Nothing was sent.` };
    }
    read.push({ path, bytes: file.bytes });
  }
  const owner = recipient.groupId
    ? { botId: bot.id, groupId: recipient.groupId }
    : { botId: target.id };
  const files: AttachmentBlock[] = [];
  for (const file of read) {
    try {
      files.push((await saveWorkspaceFile(ctx, call, file.path, file.bytes, owner)).block);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "could not save the file";
      return { error: `${file.path}: ${reason}. Nothing was sent.` };
    }
  }
  return { files, sharedPaths: [], recipientId: target.id };
}

function withRecipient(prepared: { error: string } | SentFiles, recipientId: string) {
  return "error" in prepared ? prepared : { ...prepared, recipientId };
}

/** The bot a message or handoff names, among the sender's bots or the group's members. */
async function findRecipient(
  ctx: BotFileContext,
  recipient: { botId?: string; name?: string; groupId?: string },
) {
  const { run, deps, bot } = ctx;
  const candidates = await deps.prisma.bot.findMany({
    where: {
      spaceId: run.spaceId,
      userId: run.userId,
      archivedAt: null,
      ...(recipient.groupId ? { groupMembers: { some: { groupId: recipient.groupId } } } : {}),
    },
    select: { id: true, name: true, computerId: true, computerSwitching: true },
  });
  const target = resolveBotAddress(candidates, recipient);
  return target && target.id !== bot.id ? target : undefined;
}

/** Paths on the shared computer, checked to exist, as any bot on it can address them. */
async function sharedFiles(
  ctx: BotFileContext,
  paths: string[],
): Promise<{ error: string } | SentFiles> {
  let computer: Awaited<ReturnType<typeof ctx.computer.get>>;
  try {
    computer = await ctx.computer.get();
  } catch {
    return { error: "could not reach your computer. Nothing was sent." };
  }
  const sharedPaths: string[] = [];
  for (const path of paths) {
    let stored: string;
    try {
      stored = normalizeWorkspacePath(resolveBotWorkspacePath(ctx.computer.mode, ctx.bot.id, path));
    } catch {
      return { error: `${path}: path is outside the computer. Nothing was sent.` };
    }
    const parent = posix.dirname(stored);
    // A folder that does not exist fails to list on real computers too, so a listing error
    // cannot be told apart from a wrong path; the error names both.
    const entries = await ctx.deps.sandbox
      .listFiles(computer, parent === "." ? "" : parent, ctx.context)
      .catch(() => undefined);
    if (!entries) {
      return {
        error: `${path}: not found, or your computer could not be read. Nothing was sent.`,
      };
    }
    if (!stored || !entries.some((entry) => normalizeWorkspacePath(entry.path) === stored)) {
      return { error: `${path}: not found. Nothing was sent.` };
    }
    // A path is shown verbatim, so one that holds a secret is refused rather than shown redacted.
    if (redactSecrets(stored, ctx.secrets) !== stored) {
      return { error: "one of the paths can't be shared. Nothing was sent." };
    }
    sharedPaths.push(stored);
  }
  return { files: [], sharedPaths };
}

/**
 * Checked before any file is read or copied: shared paths are added to the message, so a blank
 * one must be caught first, and an oversized one would leave copies behind for nothing.
 */
function messageError(ctx: BotFileContext, message: unknown): string | undefined {
  const text = redactSecrets(String(message ?? ""), ctx.secrets).trim();
  if (!text) return "message is required";
  if (text.length > BOT_MESSAGE_MAX_LENGTH) return BOT_MESSAGE_TOO_LONG;
}

/**
 * The message as delivered: shared paths are listed where the recipient reads its task. The list
 * counts toward the message limit, so a message it would push over is refused with the room left.
 */
function deliveredMessage(
  ctx: BotFileContext,
  message: unknown,
  sharedPaths: string[],
): { error: string } | { message: string } {
  const text = redactSecrets(String(message ?? ""), ctx.secrets);
  if (!sharedPaths.length) return { message: text };
  const list = `\n\nFiles on our shared computer:\n${sharedPaths.map((path) => `- ${path}`).join("\n")}`;
  const room = BOT_MESSAGE_MAX_LENGTH - list.length;
  if (text.trim().length > room) {
    return {
      error: `with the file list added, the message must stay under ${Math.max(room, 0)} characters. Nothing was sent.`,
    };
  }
  return { message: `${text.trim()}${list}` };
}

export async function messageBotWithFiles(ctx: BotFileContext, call: BotFileCall) {
  const { deps, run, bot } = ctx;
  const { args, effectKey } = call;
  const invalid = messageError(ctx, args.message);
  if (invalid) return { ok: false as const, error: invalid };
  const stored = await prepareSentFiles(ctx, call, {
    botId: args.bot_id ? String(args.bot_id) : undefined,
    name: args.confirm_name ? String(args.confirm_name) : undefined,
  });
  if ("error" in stored) return { ok: false as const, error: stored.error };
  const delivered = deliveredMessage(ctx, args.message, stored.sharedPaths);
  if ("error" in delivered) return { ok: false as const, error: delivered.error };
  return messageBot(
    deps,
    run,
    { id: bot.id, name: bot.name },
    {
      bot_id: stored.recipientId ?? (args.bot_id ? String(args.bot_id) : undefined),
      confirm_name: stored.recipientId
        ? undefined
        : args.confirm_name
          ? String(args.confirm_name)
          : undefined,
      message: delivered.message,
      intent: args.intent as "request" | "result" | "question" | "status" | "fyi" | undefined,
      deliveryKey: effectKey,
      files: stored.files,
    },
  );
}

export async function handoffToBotWithFiles(ctx: BotFileContext, call: BotFileCall) {
  const { args, effectKey } = call;
  const groupId = args.group_id ? String(args.group_id).trim() : ctx.thread.groupId;
  if (!groupId) return { error: "group_id is required outside a group chat" };
  const invalid = messageError(ctx, args.message);
  if (invalid) return { error: invalid };
  const stored = await prepareSentFiles(ctx, call, {
    botId: args.bot_id ? String(args.bot_id) : undefined,
    name: args.confirm_name ? String(args.confirm_name) : undefined,
    groupId,
  });
  if ("error" in stored) return stored;
  const delivered = deliveredMessage(ctx, args.message, stored.sharedPaths);
  if ("error" in delivered) return delivered;
  return handoffToGroupBot(ctx.deps, ctx.run, groupId, {
    bot_id: stored.recipientId ?? (args.bot_id ? String(args.bot_id) : undefined),
    confirm_name: stored.recipientId
      ? undefined
      : args.confirm_name
        ? String(args.confirm_name)
        : undefined,
    message: delivered.message,
    deliveryKey: effectKey,
    files: stored.files,
  });
}
