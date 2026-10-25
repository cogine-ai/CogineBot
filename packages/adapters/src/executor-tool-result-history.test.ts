import type { AgentToolResultForHistory } from "@rakazo/adapter-kit";
import type * as DatabaseModule from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import { readHistory, storeToolResultHistory } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_REDACTION_MAX_DEPTH,
  CONNECTOR_REDACTION_MAX_NODES,
} from "./connector-safety.js";
import { TOOL_RESULT_HISTORY_MIN_LENGTH } from "./context-selection.js";
import { redactStoredToolResultView, storeConnectorToolResultHistory } from "./executor.js";

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
  it.each(["depth", "nodes"])(
    "skips DB storage after a %s redaction failure below the history byte cap",
    async (kind) => {
      let raw: unknown = { id: "original", body: "x".repeat(400) };
      if (kind === "depth") {
        for (let index = 0; index <= CONNECTOR_REDACTION_MAX_DEPTH; index += 1)
          raw = { nested: raw };
      } else raw = { rows: Array(CONNECTOR_REDACTION_MAX_NODES).fill(0), body: "x".repeat(400) };
      const original = JSON.stringify(raw);
      expect(original.length).toBeGreaterThan(TOOL_RESULT_HISTORY_MIN_LENGTH);
      expect(Buffer.byteLength(original)).toBeLessThanOrEqual(1_048_576);
      expect(
        await storeConnectorToolResultHistory(prisma, scope, { ...input, result: raw }, []),
      ).toBeUndefined();
      expect(storeToolResultHistory).not.toHaveBeenCalled();
      expect(JSON.stringify(raw)).toBe(original);
    },
  );
  it("persists a legitimate service redaction_error with its complete body", async () => {
    vi.mocked(storeToolResultHistory).mockResolvedValue(reference);
    const raw = { ok: false, error: "redaction_error", body: "service diagnostic ".repeat(100) };
    const original = JSON.stringify(raw);
    expect(
      await storeConnectorToolResultHistory(prisma, scope, { ...input, result: raw }, []),
    ).toEqual(reference);
    expect(vi.mocked(storeToolResultHistory).mock.calls[0]![2].text).toBe(original);
    expect(JSON.stringify(raw)).toBe(original);
  });
  it.each(["depth", "nodes"])(
    "does not page a placeholder when the stored %s view cannot be redacted",
    async (kind) => {
      let raw: unknown = { id: "original", body: "x".repeat(400) };
      if (kind === "depth") {
        for (let index = 0; index <= CONNECTOR_REDACTION_MAX_DEPTH; index += 1)
          raw = { nested: raw };
      } else raw = { rows: Array(CONNECTOR_REDACTION_MAX_NODES).fill(0), body: "x".repeat(400) };
      const text = JSON.stringify(raw);
      const query = vi.fn().mockResolvedValue([
        {
          id: "stored",
          runId: "run",
          createdAt: new Date(0),
          payload: { name: "connector.read", executionId: "call" },
          toolResult: { text, storedBytes: Buffer.byteLength(text) },
        },
      ]);
      for (const page of [
        { toolResultId: "stored" },
        { toolResultId: "stored", textOffset: 2000, viewHash: "a".repeat(64) },
      ]) {
        await expect(
          readHistory(
            { $queryRaw: query } as unknown as PrismaClient,
            { ...scope, transformToolResult: (value) => redactStoredToolResultView(value, []) },
            page,
          ),
        ).rejects.toThrow("redaction_error");
      }
      expect(query).toHaveBeenCalledTimes(2);
      expect(storeToolResultHistory).not.toHaveBeenCalled();
      expect(JSON.stringify(raw)).toBe(text);
    },
  );
  it("reads a legitimate service error body without confusing it with transform failure", async () => {
    const raw = { ok: false, error: "redaction_error", body: "service diagnostic ".repeat(40) };
    const text = JSON.stringify(raw);
    const query = vi.fn().mockResolvedValue([
      {
        id: "stored",
        runId: "run",
        createdAt: new Date(0),
        payload: { name: "connector.read", executionId: "call" },
        toolResult: { text, storedBytes: Buffer.byteLength(text) },
      },
    ]);
    const response = await readHistory(
      { $queryRaw: query } as unknown as PrismaClient,
      { ...scope, transformToolResult: (value) => redactStoredToolResultView(value, []) },
      { toolResultId: "stored" },
    );
    expect(JSON.parse(response.toolResult!.text)).toEqual(raw);
    expect(response.nextRead).toBeNull();
    expect(response.toolResult!.viewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(response.toolResult!.storageTruncated).toBe(false);
  });
  it.each(["name", "executionId"])(
    "rejects the whole page if %s metadata cannot be redacted",
    async (field) => {
      let deep: unknown = "private metadata";
      for (let index = 0; index <= CONNECTOR_REDACTION_MAX_DEPTH; index += 1)
        deep = { nested: deep };
      const text = JSON.stringify({ id: "safe body" });
      const query = vi.fn().mockResolvedValue([
        {
          id: "stored",
          runId: "run",
          createdAt: new Date(0),
          payload: { name: "connector.read", executionId: "call", [field]: JSON.stringify(deep) },
          toolResult: { text, storedBytes: Buffer.byteLength(text) },
        },
      ]);
      await expect(
        readHistory(
          { $queryRaw: query } as unknown as PrismaClient,
          { ...scope, transformToolResult: (value) => redactStoredToolResultView(value, []) },
          { toolResultId: "stored" },
        ),
      ).rejects.toThrow("redaction_error");
    },
  );
});
