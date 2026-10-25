import type { AgentToolResultForHistory } from "@rakazo/adapter-kit";
import type * as DatabaseModule from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import { storeToolResultHistory } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_RESULT_HISTORY_MIN_LENGTH } from "./context-selection.js";
import { storeConnectorToolResultHistory } from "./executor.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof DatabaseModule>()),
  storeToolResultHistory: vi.fn(),
}));

const prisma = {} as PrismaClient;
const scope = {
  spaceId: "space",
  userId: "user",
  threadId: "thread",
  botId: "bot",
  activeRunId: "run",
};
const reference = { tool: "read_history" as const, arguments: { toolResultId: "stored-result" } };
const result = {
  content: [{ type: "text", text: "record ".repeat(2000) }],
  structuredContent: { id: "item", cursor: "cursor" },
};
const input: AgentToolResultForHistory = {
  name: "connector.read",
  executionId: "call",
  route: { connectorId: "connector", toolName: "read" },
  result,
};

describe("connector result history persistence", () => {
  beforeEach(() => vi.mocked(storeToolResultHistory).mockReset());
  it("stores large redacted multipart results before model clipping", async () => {
    vi.mocked(storeToolResultHistory).mockResolvedValue(reference);
    const secrets = ['synthetic"quoted-secret', "synthetic\nline-secret", "987654321"];
    const raw = {
      ...result,
      content: [
        ...result.content,
        { type: "text", text: JSON.stringify({ credential: secrets[0] }) },
        { type: "image", data: "synthetic-image", mimeType: "image/png" },
      ],
      structuredContent: {
        id: "preserved-id",
        cursor: "exact-cursor",
        password: secrets[1],
        account: 987654321,
      },
    };
    expect(
      await storeConnectorToolResultHistory(prisma, scope, { ...input, result: raw }, secrets),
    ).toEqual(reference);
    const stored = vi.mocked(storeToolResultHistory).mock.calls[0]![2];
    expect(stored).toMatchObject({ name: input.name, executionId: input.executionId });
    for (const secret of secrets) expect(stored.text).not.toContain(secret);
    const decoded = JSON.parse(stored.text);
    expect(decoded.structuredContent).toEqual({
      id: "preserved-id",
      cursor: "exact-cursor",
      password: "[redacted]",
      account: "[redacted]",
    });
    expect(JSON.parse(decoded.content[1].text)).toEqual({ credential: "[redacted]" });
    expect(decoded.content[2]).toMatchObject({ type: "image", data: "synthetic-image" });
    expect(raw.structuredContent.password).toBe(secrets[1]);
  });
  it.each([
    { ...input, route: undefined },
    { ...input, name: "request_secret" },
    { ...input, name: "read_history" },
    { ...input, name: "skill_read" },
    { ...input, route: { connectorId: "connector", toolName: "__catalog_search" } },
    { ...input, route: { connectorId: "connector", toolName: "__catalog_load" } },
    { ...input, result: { id: "small", body: "x".repeat(100) } },
  ])("does not retain control or small outputs: $name", async (candidate) => {
    expect(await storeConnectorToolResultHistory(prisma, scope, candidate, [])).toBeUndefined();
    expect(storeToolResultHistory).not.toHaveBeenCalled();
  });
  it("permits the authorized lazy connector execution route", async () => {
    vi.mocked(storeToolResultHistory).mockResolvedValue(reference);
    expect(
      await storeConnectorToolResultHistory(
        prisma,
        scope,
        { ...input, route: { connectorId: "connector", toolName: "__catalog_execute" } },
        [],
      ),
    ).toEqual(reference);
  });
  it("stores a result below the final clip budget when context selection can shorten it", async () => {
    vi.mocked(storeToolResultHistory).mockResolvedValue(reference);
    const smallResult = { id: "exact-id", cursor: "exact-cursor", body: "x".repeat(2800) };
    expect(JSON.stringify(smallResult).length).toBeGreaterThan(TOOL_RESULT_HISTORY_MIN_LENGTH);
    expect(JSON.stringify(smallResult).length).toBeLessThan(12000);
    expect(
      await storeConnectorToolResultHistory(prisma, scope, { ...input, result: smallResult }, []),
    ).toEqual(reference);
    expect(JSON.parse(vi.mocked(storeToolResultHistory).mock.calls[0]![2].text)).toEqual(
      smallResult,
    );
  });
  it("returns no invented reference after storage failure or a storage cap rejection", async () => {
    vi.mocked(storeToolResultHistory).mockRejectedValueOnce(new Error("database unavailable"));
    expect(await storeConnectorToolResultHistory(prisma, scope, input, [])).toBeUndefined();
    vi.mocked(storeToolResultHistory).mockResolvedValueOnce(undefined);
    expect(await storeConnectorToolResultHistory(prisma, scope, input, [])).toBeUndefined();
  });
});
