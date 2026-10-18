import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { ownedConnectionSelection, updateTaskConnectionSelection } from "./connection-selection.js";
import { IsolationError } from "./scope.js";

const scope = { spaceId: "space", userId: "user" };
const references = [
  { id: "gmail-1", connectorId: "pipedream", provider: "gmail" },
  { id: "gmail-2", connectorId: "composio", provider: "gmail" },
  { id: "calendar-1", connectorId: "pipedream", provider: "googlecalendar" },
  { id: "gmail-other-source", connectorId: "composio", provider: "gmail" },
];

function fixture(previous = ["gmail-1", "calendar-1", "gmail-other-source"]) {
  const tx = {
    task: {
      findFirst: vi.fn(async () => ({ connectionIds: previous })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    connection: { findMany: vi.fn(async () => references) },
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}

describe("owned connection selection", () => {
  it("queries only the exact references in the task and consumed batches, under both owner and Space", async () => {
    const { tx, client } = fixture();
    expect(
      await ownedConnectionSelection(
        client,
        scope,
        ["gmail-1", "calendar-1", "gmail-other-source"],
        [["gmail-2"], ["gmail-2"]],
      ),
    ).toEqual(["calendar-1", "gmail-2"]);
    expect(tx.connection.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["gmail-1", "calendar-1", "gmail-other-source", "gmail-2"] }, ...scope },
      select: { id: true, connectorId: true, provider: true },
    });
    expect(tx.connection.findMany).toHaveBeenCalledOnce();
  });

  it("retains deleted, foreign or unavailable references for the executor to reject", async () => {
    const { tx, client } = fixture();
    tx.connection.findMany.mockResolvedValue([references[2]!]);
    expect(
      await ownedConnectionSelection(
        client,
        scope,
        ["deleted-target", "calendar-1"],
        [["foreign-target"]],
      ),
    ).toEqual(["deleted-target", "calendar-1", "foreign-target"]);
    expect(tx.connection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["deleted-target", "calendar-1", "foreign-target"] }, ...scope },
      }),
    );
  });

  it("does not query when there are no references at all", async () => {
    const { tx, client } = fixture();
    expect(await ownedConnectionSelection(client, scope, [], [[], []])).toEqual([]);
    expect(tx.connection.findMany).not.toHaveBeenCalled();
  });

  it("retains a revoked account's exact identity rather than authorizing a connected sibling", async () => {
    const { tx, client } = fixture();
    tx.connection.findMany.mockResolvedValue([
      ...references,
      { id: "gmail-revoked", connectorId: "pipedream", provider: "gmail" },
    ]);
    expect(
      await ownedConnectionSelection(client, scope, ["gmail-1", "calendar-1"], [["gmail-revoked"]]),
    ).toEqual(["calendar-1", "gmail-revoked"]);
    expect(tx.connection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["gmail-1", "calendar-1", "gmail-revoked"] }, ...scope },
      }),
    );
  });
});

describe("updateTaskConnectionSelection", () => {
  it("does not read or write a task or connection for ordinary steering without an @ selection", async () => {
    const { tx, client } = fixture();
    await updateTaskConnectionSelection(client, scope, "task", [[], []]);
    expect(tx.task.findFirst).not.toHaveBeenCalled();
    expect(tx.connection.findMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });

  it("updates only the exact owned task metadata and keeps other apps while replacing known aliases across sources", async () => {
    const { tx, client } = fixture();
    await updateTaskConnectionSelection(client, scope, "task", [["gmail-2"]]);
    expect(tx.task.findFirst).toHaveBeenCalledWith({
      where: { id: "task", ...scope },
      select: { connectionIds: true },
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: "task", ...scope },
      data: { connectionIds: ["calendar-1", "gmail-2"] },
    });
  });

  it("cannot use a missing or foreign task as the owner for a reference lookup", async () => {
    const { tx, client } = fixture();
    tx.task.findFirst.mockResolvedValue(null as never);
    await expect(
      updateTaskConnectionSelection(client, scope, "foreign-task", [["gmail-2"]]),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(tx.connection.findMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });

  it("fails if the scoped task disappears before the metadata update", async () => {
    const { tx, client } = fixture();
    tx.task.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      updateTaskConnectionSelection(client, scope, "task", [["gmail-2"]]),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(tx.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "task", ...scope } }),
    );
  });
});
