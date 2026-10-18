import type { AdapterContext, ConnectorCall } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { boundDirectApprovalRequest, catalogApprovalRequest } from "../approval-effect.js";
import { redactConnectorPayload } from "../connector-safety.js";
import { nativeEffectCheckpoint } from "./effect.js";

const route = {
  connectorId: "native",
  resourceId: "notion",
  toolName: "notion.pages.create",
  connectionId: "connection-a",
  resourceRevision: "generation-a",
};
const context: AdapterContext = {
  userId: "user-a",
  spaceId: "space-a",
  botId: "bot-a",
  runId: "run-a",
  operationId: "trace",
  traceId: "trace",
  signal: new AbortController().signal,
};
const args = { parent: "page-a", title: "Fixture" };
const call: ConnectorCall = { tool: route.toolName, args, route, executionId: "stable-effect-key" };
const protect = (value: Record<string, unknown>) =>
  redactConnectorPayload(value, ["fixture-credential"]) as Record<string, unknown>;
function setup(request: unknown, status = "executing") {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const findFirst = vi.fn(async () => ({
    id: "effect-a",
    status,
    request,
    result: { nativeRecovery: { remoteId: "remote-a", reply: "fixture-credential" } },
  }));
  return {
    prisma: { externalEffect: { findFirst, updateMany } } as unknown as PrismaClient,
    findFirst,
    updateMany,
  };
}
describe("native receipt uses the existing exact approved effect", () => {
  for (const mode of ["direct", "catalog"] as const)
    it(`accepts ${mode}, protects loaded/written recovery and preserves stable IDs`, async () => {
      const request =
        mode === "direct"
          ? boundDirectApprovalRequest(route, args, "__rakazoCatalogTool")
          : catalogApprovalRequest(
              "native_execute_tool",
              { id: "tool-a", arguments: args },
              "__rakazoCatalogTool",
              route,
            );
      const { prisma, updateMany, findFirst } = setup(request);
      const revalidate = vi.fn(async () => {});
      const receipt = await nativeEffectCheckpoint(prisma, call, context, revalidate, protect);
      expect(receipt.recovery).toEqual({ remoteId: "remote-a", reply: "[redacted]" });
      await receipt.checkpoint({ remoteId: "remote-b", reply: "fixture-credential" });
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "effect-a",
            status: "executing",
            runId: "run-a",
            spaceId: "space-a",
            request: { equals: request },
          }),
          data: { result: { nativeRecovery: { remoteId: "remote-b", reply: "[redacted]" } } },
        }),
      );
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            idempotencyKey: "stable-effect-key",
            run: { userId: "user-a", botId: "bot-a", status: "running" },
          }),
        }),
      );
      expect(revalidate).toHaveBeenCalledTimes(1);
    });
  for (const changed of [
    { ...route, connectionId: "connection-b" },
    { ...route, resourceRevision: "generation-b" },
    { ...route, toolName: "notion.pages.delete" },
  ])
    it(`rejects a changed route ${JSON.stringify(changed)}`, async () => {
      const { prisma, updateMany } = setup(
        boundDirectApprovalRequest(changed, args, "__rakazoCatalogTool"),
      );
      await expect(
        nativeEffectCheckpoint(prisma, call, context, async () => {}, protect),
      ).rejects.toMatchObject({ kind: "invalid_input" });
      expect(updateMany).not.toHaveBeenCalled();
    });
  it("rejects a changed approved payload", async () => {
    const { prisma } = setup(
      catalogApprovalRequest(
        "native_execute_tool",
        { id: "tool-a", arguments: { ...args, title: "changed" } },
        "__rakazoCatalogTool",
        route,
      ),
    );
    await expect(
      nativeEffectCheckpoint(prisma, call, context, async () => {}, protect),
    ).rejects.toMatchObject({ kind: "invalid_input" });
  });
  it("does not continue a write if the current run fence was lost", async () => {
    const { prisma, updateMany } = setup(
      boundDirectApprovalRequest(route, args, "__rakazoCatalogTool"),
    );
    updateMany.mockResolvedValue({ count: 0 });
    const receipt = await nativeEffectCheckpoint(prisma, call, context, async () => {}, protect);
    await expect(
      receipt.checkpoint({ remoteId: "remote-a", reply: "fixture-credential" }),
    ).rejects.toMatchObject({
      kind: "result_unknown",
      options: { uncertain: true, recovery: { remoteId: "remote-a", reply: "[redacted]" } },
    });
  });
});
