import { randomUUID } from "node:crypto";
import { bootstrapUserSpace, createDb } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { McpConnector } from "./mcp-connector.js";
import { mcpHealthError, mcpServerHealthDto, recordMcpServerHealth } from "./mcp-server-health.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("MCP health observations", () => {
  it("limits repeat writes and fences the owner, configuration revision and observation time", async () => {
    const database = createDb(process.env.DATABASE_URL!);
    const { prisma } = database;
    const userId = randomUUID();
    let organizationId: string | undefined;
    try {
      await prisma.user.create({
        data: { id: userId, name: "Fixture", email: `${userId}@example.test` },
      });
      const { spaceId } = await bootstrapUserSpace(
        prisma,
        { id: userId },
        { signupsEnabled: "true", signupAllowlist: "" },
        { claimDeploymentOwner: false },
      );
      organizationId = (await prisma.space.findUniqueOrThrow({ where: { id: spaceId } }))
        .organizationId;
      const server = await prisma.mcpServer.create({
        data: {
          spaceId,
          userId,
          slug: "fixture",
          name: "Fixture",
          transport: "stdio",
          command: "fixture",
        },
      });
      const get = () => prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
      const error = mcpHealthError(new Error("failed with fixture-secret"), ["fixture-secret"]);
      const ok = { status: "ok", message: null, toolCount: 2, code: null } as const;
      const at = (seconds: number) => new Date(seconds * 1_000);
      expect(mcpServerHealthDto(await get()).status).toBe("unknown");

      await recordMcpServerHealth(prisma, server, error, at(10));
      await recordMcpServerHealth(prisma, server, error, at(30));
      expect(await get()).toMatchObject({
        healthRevision: 1,
        healthStatus: "error",
        healthMessage: "failed with [redacted]",
        healthCheckedAt: at(10),
      });
      await recordMcpServerHealth(prisma, server, ok, at(40), true);
      await recordMcpServerHealth(prisma, server, error, at(20), true);
      await recordMcpServerHealth(prisma, { ...server, userId: "foreign" }, error, at(50), true);
      expect(await get()).toMatchObject({
        healthStatus: "ok",
        healthToolCount: 2,
        healthCheckedAt: at(40),
      });

      const edited = await prisma.mcpServer.update({
        where: { id: server.id },
        data: { revision: { increment: 1 } },
      });
      expect(mcpServerHealthDto(edited).status).toBe("unknown");
      await recordMcpServerHealth(prisma, edited, ok, at(60));
      await recordMcpServerHealth(prisma, server, error, at(70), true);
      expect(await get()).toMatchObject({
        revision: 2,
        healthRevision: 2,
        healthStatus: "ok",
        healthCheckedAt: at(60),
      });

      const install = await prisma.capabilityInstall.create({
        data: {
          spaceId,
          userId,
          kind: "plugin",
          name: "Fixture",
          source: "fixture",
          clientNonce: "fixture-install",
          requestBinding: "a".repeat(64),
          version: "b".repeat(40),
          digest: `sha256:${"c".repeat(64)}`,
          status: "installing",
        },
      });
      const provisioning = await prisma.mcpServer.update({
        where: { id: server.id },
        data: { installId: install.id, revision: { increment: 1 }, allowAllTools: true },
      });
      const connector = new McpConnector(prisma, {} as never);
      const context = {
        operationId: "fixture",
        traceId: "fixture",
        spaceId,
        userId,
        botId: "fixture",
        signal: new AbortController().signal,
      };
      try {
        await expect(connector.discoverTools(context)).resolves.toEqual([]);
        const health = await connector.check(provisioning, context);
        expect(health.status).toBe("installing");
        expect(mcpServerHealthDto(await get()).status).toBe("installing");
        await prisma.capabilityInstall.update({
          where: { id: install.id },
          data: { status: "installed" },
        });
        const failed = await connector.check(provisioning, context);
        expect(failed).toMatchObject({ status: "error", message: "MCP stdio is disabled" });
        await recordMcpServerHealth(
          prisma,
          provisioning,
          {
            status: "installing",
            message: null,
            code: null,
            toolCount: null,
          },
          new Date(Date.now() + 10_000),
          true,
        );
        expect(mcpServerHealthDto(await get()).status).toBe("error");
      } finally {
        await connector.close();
      }
    } finally {
      if (organizationId) await prisma.organization.delete({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
      await database.pool.end();
    }
  });
});
