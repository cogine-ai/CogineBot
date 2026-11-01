import { createHash, randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { SecretRecord } from "@rakazo/adapter-kit";
import type { ParsedPlugin } from "@rakazo/adapters";
import {
  BUILTIN_AGENT_SKILLS,
  buildMcpCredentialBlob,
  fetchGitHubPlugin,
  parsePluginSource,
  toPluginPreview,
} from "@rakazo/adapters";
import type { Actor, PluginInstallInput, PluginInstallReceipt } from "@rakazo/contracts";
import type { PluginCredentialCleanupEntry, Prisma } from "@rakazo/db";
import { lockPluginInstall, readPluginCleanupRefs, Prisma as Sql } from "@rakazo/db";
import { pluginInstallReceipt } from "./plugin-install-receipt.js";
import type { RouterDeps } from "./router.js";

type Context = {
  actor: Actor;
  sessionId?: string;
  signal?: AbortSignal;
  stillAuthorized?: () => Promise<boolean>;
};
type Deps = Pick<RouterDeps, "prisma" | "secrets" | "pluginRead"> & {
  assertEndpoint: (endpoint: string, actor: Actor) => Promise<void>;
  uninstall: (
    actor: Actor,
    input: { installId: string; expectedRevision: number },
  ) => Promise<PluginInstallReceipt>;
};
const includeChildren = { agentSkills: true, mcpServers: true } as const;
type Row = Prisma.CapabilityInstallGetPayload<{ include: typeof includeChildren }>;
type Prepared = {
  server: ParsedPlugin["mcpServers"][number];
  stored: SecretRecord | null;
  index: number;
};

async function authorized(context: Context) {
  context.signal?.throwIfAborted();
  if (context.stillAuthorized && !(await context.stillAuthorized()))
    throw new ORPCError("UNAUTHORIZED");
}

/** Keep the authenticated parents alive through the atomic child commit. */
async function lockScope(tx: Prisma.TransactionClient, context: Context) {
  const { userId, spaceId } = context.actor;
  const users = await tx.$queryRaw<Array<{ id: string }>>(
    Sql.sql`SELECT id FROM "user" WHERE id=${userId} FOR SHARE`,
  );
  const spaces = await tx.$queryRaw<Array<{ id: string; deletingAt: Date | null }>>(
    Sql.sql`SELECT id, "deletingAt" FROM spaces WHERE id=${spaceId} FOR SHARE`,
  );
  const members = await tx.$queryRaw<Array<{ id: string }>>(
    Sql.sql`SELECT id FROM space_members WHERE "spaceId"=${spaceId} AND "userId"=${userId} FOR SHARE`,
  );
  if (!users.length || !spaces.length || spaces[0]!.deletingAt || !members.length)
    throw new ORPCError("FORBIDDEN");
  if (context.sessionId) {
    const sessions = await tx.$queryRaw<Array<{ id: string }>>(
      Sql.sql`SELECT id FROM "session" WHERE id=${context.sessionId} AND "userId"=${userId} AND "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') FOR SHARE`,
    );
    if (!sessions.length) throw new ORPCError("UNAUTHORIZED");
  }
  context.signal?.throwIfAborted();
}

function binding(input: PluginInstallInput) {
  return createHash("sha256")
    .update(JSON.stringify([input.source.trim(), input.sourceSha, input.digest]))
    .digest("hex");
}

function requireSameIntent(row: Row, input: PluginInstallInput) {
  if (row.kind !== "plugin" || row.requestBinding !== binding(input))
    throw new ORPCError("CONFLICT", {
      message: "This install request was already used for different content.",
    });
  return pluginInstallReceipt(row);
}

function publicConfig(plugin: ParsedPlugin) {
  const preview = toPluginPreview(plugin);
  return {
    plugin: {
      ...preview,
      skills: preview.skills.map(({ name, description }) => ({ name, description })),
    },
    repositorySource: repositorySource(plugin.source),
    installedChildren: { skills: [], mcpServers: [] },
  };
}

function repositorySource(source: string) {
  const parsed = parsePluginSource(source);
  return `${parsed.gitUrl.toLowerCase()}#${parsed.subdir ?? ""}`;
}

/** A nonce is a durable outcome, including failed/removed receipts; it never means retry a write. */
export function createPluginInstallsService(deps: Deps) {
  const findNonce = (actor: Actor, clientNonce: string) =>
    deps.prisma.capabilityInstall.findUnique({
      where: {
        spaceId_userId_clientNonce: { spaceId: actor.spaceId, userId: actor.userId, clientNonce },
      },
      include: includeChildren,
    });
  async function scope(context: Context) {
    await authorized(context);
    const member = await deps.prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: context.actor.spaceId, userId: context.actor.userId } },
      select: { space: { select: { deletingAt: true } } },
    });
    if (!member || member.space.deletingAt) throw new ORPCError("FORBIDDEN");
  }
  async function fetchPlugin(context: Context, source: string, sourceSha?: string) {
    try {
      return await fetchGitHubPlugin(source, {
        sourceSha,
        signal: context.signal,
        read: deps.pluginRead,
      });
    } catch {
      context.signal?.throwIfAborted();
      throw new ORPCError("BAD_REQUEST", {
        message: "Could not load a supported plugin from this repository.",
      });
    }
  }
  async function conflictNames(tx: Prisma.TransactionClient, actor: Actor, plugin: ParsedPlugin) {
    const builtin = new Set(BUILTIN_AGENT_SKILLS.map((skill) => skill.name.toLowerCase()));
    const rows = plugin.skills.length
      ? await tx.agentSkill.findMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            OR: plugin.skills.map((skill) => ({
              name: { equals: skill.name, mode: "insensitive" as const },
            })),
          },
          select: { name: true },
        })
      : [];
    const names = [
      ...new Set([
        ...rows.map((row) => row.name),
        ...plugin.skills
          .filter((skill) => builtin.has(skill.name.toLowerCase()))
          .map((skill) => skill.name),
      ]),
    ];
    if (names.length)
      throw new ORPCError("CONFLICT", {
        message: `Skill names already in use: ${names.join(", ")}`.slice(0, 4000),
        data: { conflicts: names },
      });
  }
  async function readInstalling(tx: Prisma.TransactionClient, context: Context, id: string) {
    const row = await tx.capabilityInstall.findFirst({
      where: {
        id,
        spaceId: context.actor.spaceId,
        userId: context.actor.userId,
        status: "installing",
      },
      include: includeChildren,
    });
    if (!row)
      throw new ORPCError("CONFLICT", {
        message: "This plugin installation changed. Check its status.",
      });
    return row;
  }
  async function changeCleanup(
    context: Context,
    id: string,
    update: (entries: PluginCredentialCleanupEntry[]) => PluginCredentialCleanupEntry[],
  ) {
    await deps.prisma.$transaction(async (tx) => {
      await lockPluginInstall(tx, id);
      const row = await tx.capabilityInstall.findFirst({
        where: { id, userId: context.actor.userId, spaceId: context.actor.spaceId },
      });
      if (!row)
        throw new ORPCError("CONFLICT", {
          message: "This plugin installation changed. Check its status.",
        });
      await tx.capabilityInstall.update({
        where: { id },
        data: {
          cleanupRefs: update(readPluginCleanupRefs(row.cleanupRefs)) as Prisma.InputJsonValue,
          revision: { increment: 1 },
        },
      });
    });
  }
  async function prepare(context: Context, id: string, plugin: ParsedPlugin) {
    const prepared: Prepared[] = [];
    for (const [index, server] of plugin.mcpServers.entries()) {
      await authorized(context);
      const material = buildMcpCredentialBlob({ headers: server.headers });
      if (!material) {
        prepared.push({ server, stored: null, index });
        continue;
      }
      const recordId = randomUUID();
      // This intent commits before a provider can create a credential. Missing acknowledgements
      // remain explicit pending entries rather than being mistaken for successful cleanup.
      await deps.prisma.$transaction(async (tx) => {
        await lockScope(tx, context);
        await lockPluginInstall(tx, id);
        const row = await readInstalling(tx, context, id);
        const refs = readPluginCleanupRefs(row.cleanupRefs);
        await tx.capabilityInstall.update({
          where: { id },
          data: {
            cleanupRefs: [...refs, { id: recordId, pending: true }],
            revision: { increment: 1 },
          },
        });
      });
      let invoked = false;
      let pending: Promise<SecretRecord> | undefined;
      let dispatchFailure: unknown;
      try {
        await deps.prisma.$transaction(async (tx) => {
          await lockScope(tx, context);
          await lockPluginInstall(tx, id);
          await readInstalling(tx, context, id);
          context.signal?.throwIfAborted();
          invoked = true;
          pending = deps.secrets.put(
            material,
            {
              ...context.actor,
              operationId: "plugins.install",
              traceId: "plugins.install",
              signal: context.signal ?? new AbortController().signal,
            },
            { recordId },
          );
          // Observe rejection immediately, while retaining the original outcome for adoption.
          void pending.catch(() => undefined);
        });
      } catch (error) {
        dispatchFailure = error;
      }
      if (!invoked) {
        await changeCleanup(context, id, (refs) => refs.filter((entry) => entry.id !== recordId));
        throw dispatchFailure;
      }
      if (!pending) throw dispatchFailure;
      const stored = await pending;
      await changeCleanup(context, id, (refs) => [
        ...refs.filter((entry) => entry.id !== recordId),
        { id: stored.id, ref: stored.ciphertext },
      ]);
      if (dispatchFailure) throw dispatchFailure;
      prepared.push({ server, stored, index });
    }
    return prepared;
  }
  async function fail(context: Context, id: string) {
    let row = await deps.prisma.capabilityInstall.findFirst({
      where: { id, userId: context.actor.userId, spaceId: context.actor.spaceId },
      include: includeChildren,
    });
    if (!row)
      throw new ORPCError("CONFLICT", {
        message: "Could not confirm installation. Check its status before retrying.",
      });
    if (row.status === "installed" || row.status === "removed" || row.status === "failed")
      return pluginInstallReceipt(row);
    try {
      const result = await deps.uninstall(context.actor, {
        installId: id,
        expectedRevision: row.revision,
      });
      if (result.status !== "removed") return result;
      await deps.prisma.capabilityInstall.updateMany({
        where: { id, installedAt: null, status: "removed" },
        data: { status: "failed", revision: { increment: 1 } },
      });
    } catch {
      await deps.prisma.capabilityInstall.updateMany({
        where: { id, status: "installing" },
        data: { status: "cleanup_failed", revision: { increment: 1 } },
      });
    }
    row = await deps.prisma.capabilityInstall.findUniqueOrThrow({
      where: { id },
      include: includeChildren,
    });
    return pluginInstallReceipt(row);
  }
  return {
    async list(context: Context): Promise<PluginInstallReceipt[]> {
      await scope(context);
      const rows = await deps.prisma.capabilityInstall.findMany({
        where: {
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
          kind: "plugin",
          clientNonce: { not: null },
        },
        include: includeChildren,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      return rows.map(pluginInstallReceipt);
    },
    async preview(context: Context, input: { source: string }) {
      await scope(context);
      const plugin = await fetchPlugin(context, input.source);
      for (const server of plugin.mcpServers)
        await deps.assertEndpoint(server.endpoint, context.actor);
      await authorized(context);
      return toPluginPreview(plugin);
    },
    async install(context: Context, input: PluginInstallInput): Promise<PluginInstallReceipt> {
      await scope(context);
      const previous = await findNonce(context.actor, input.clientNonce);
      if (previous) return requireSameIntent(previous, input);
      const plugin = await fetchPlugin(context, input.source, input.sourceSha);
      if (plugin.digest !== input.digest || plugin.sourceSha !== input.sourceSha)
        throw new ORPCError("CONFLICT", {
          message: "Plugin content changed. Preview it again before installing.",
        });
      if (!plugin.skills.length && !plugin.mcpServers.length)
        throw new ORPCError("BAD_REQUEST", {
          message: "This plugin has no supported skills or remote servers.",
        });
      for (const server of plugin.mcpServers)
        await deps.assertEndpoint(server.endpoint, context.actor);
      await authorized(context);
      const claimed = await deps.prisma.$transaction(async (tx) => {
        await lockScope(tx, context);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`plugin:${context.actor.spaceId}:${context.actor.userId}`}, 0))::text`;
        const duplicate = await tx.capabilityInstall.findUnique({
          where: {
            spaceId_userId_clientNonce: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              clientNonce: input.clientNonce,
            },
          },
          include: includeChildren,
        });
        if (duplicate) {
          requireSameIntent(duplicate, input);
          return { row: duplicate, owned: false };
        }
        const installed = await tx.capabilityInstall.findFirst({
          where: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            kind: "plugin",
            clientNonce: { not: null },
            status: { notIn: ["removed", "failed"] },
            config: { path: ["repositorySource"], equals: repositorySource(plugin.source) },
          },
        });
        if (installed)
          throw new ORPCError("CONFLICT", {
            message: "This plugin already has an active installation. Check its status.",
          });
        await conflictNames(tx, context.actor, plugin);
        const row = await tx.capabilityInstall.create({
          data: {
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            kind: "plugin",
            name: plugin.name,
            source: plugin.source,
            version: plugin.sourceSha,
            digest: plugin.digest,
            clientNonce: input.clientNonce,
            requestBinding: binding(input),
            status: "installing",
            config: publicConfig(plugin),
          },
          include: includeChildren,
        });
        return { row, owned: true };
      });
      if (!claimed.owned) return pluginInstallReceipt(claimed.row);
      try {
        const servers = await prepare(context, claimed.row.id, plugin);
        await authorized(context);
        return await deps.prisma.$transaction(async (tx) => {
          await lockScope(tx, context);
          await lockPluginInstall(tx, claimed.row.id);
          const row = await readInstalling(tx, context, claimed.row.id);
          await conflictNames(tx, context.actor, plugin);
          const skills = [];
          for (const skill of plugin.skills) {
            const created = await tx.agentSkill.create({
              data: {
                ...skill,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                source: "plugin",
                installId: row.id,
              },
            });
            skills.push({ id: created.id, name: created.name });
          }
          const mcpServers = [];
          for (const { server, stored, index } of servers) {
            if (stored)
              await tx.secret.create({
                data: {
                  id: stored.id,
                  userId: context.actor.userId,
                  spaceId: context.actor.spaceId,
                  kind: "mcp",
                  ciphertext: stored.ciphertext,
                },
              });
            const suffix = createHash("sha256")
              .update(`${row.id}:${index}`)
              .digest("hex")
              .slice(0, 12);
            const created = await tx.mcpServer.create({
              data: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                installId: row.id,
                slug: `${plugin.name.slice(0, 48)}-${suffix}`,
                name: `${plugin.name}: ${server.name}`.slice(0, 120),
                description: `Installed from plugin ${plugin.name}`,
                transport: server.transport,
                endpoint: server.endpoint,
                headers: Object.fromEntries(Object.keys(server.headers).map((key) => [key, true])),
                secretId: stored?.id,
                enabled: false,
                allowAllTools: false,
                allowedTools: [],
                args: [],
                env: {},
              },
            });
            mcpServers.push({
              id: created.id,
              name: created.name,
              endpoint: server.endpoint,
              transport: server.transport,
            });
          }
          context.signal?.throwIfAborted();
          return pluginInstallReceipt(
            await tx.capabilityInstall.update({
              where: { id: row.id },
              data: {
                status: "installed",
                installedAt: new Date(),
                cleanupRefs: [],
                revision: { increment: 1 },
                config: { ...publicConfig(plugin), installedChildren: { skills, mcpServers } },
              },
              include: includeChildren,
            }),
          );
        });
      } catch {
        // Read the durable outcome before compensating an uncertain transaction acknowledgement.
        return fail(context, claimed.row.id);
      }
    },
  };
}
