import { createHash } from "node:crypto";
import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { writeNativeArtifact } from "./artifact-output.js";

const context: AdapterContext = {
  userId: "owner-a",
  spaceId: "space-a",
  botId: "bot-a",
  operationId: "operation-a",
  traceId: "trace-a",
  signal: new AbortController().signal,
};
function fixture(fail = false) {
  const put = vi.fn(async () => ({ id: "owned-storage-key" })),
    remove = vi.fn(async () => undefined);
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    if (fail) throw new Error("fixture db failure");
    return { id: "artifact-a", ...data };
  });
  return {
    put,
    remove,
    create,
    store: { put, remove } as unknown as ArtifactStore,
    db: { artifact: { create } } as unknown as PrismaClient,
  };
}
describe("native connector download artifacts", () => {
  it("stores exact bytes and owner scope and returns only an owned artifact reference", async () => {
    const f = fixture(),
      bytes = new Uint8Array([0, 255, 10, 128]);
    const result = await writeNativeArtifact(f.db, f.store, context, {
      bytes,
      name: "folder/report\u0000.pdf",
      mimeType: "application/pdf",
    });
    expect(f.put).toHaveBeenCalledWith(
      { bytes, name: "folder_report_.pdf", mimeType: "application/pdf" },
      context,
    );
    expect(f.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "owner-a",
        spaceId: "space-a",
        botId: "bot-a",
        storageKey: "owned-storage-key",
        hash: createHash("sha256").update(bytes).digest("hex"),
        size: 4,
      }),
    });
    expect(result).toEqual({
      id: "artifact-a",
      name: "folder_report_.pdf",
      mimeType: "application/pdf",
      size: 4,
    });
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("removes only its newly stored object if the owned database receipt fails", async () => {
    const f = fixture(true);
    await expect(
      writeNativeArtifact(f.db, f.store, context, {
        bytes: new Uint8Array([1]),
        name: "sample.txt",
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("fixture db failure");
    expect(f.remove).toHaveBeenCalledExactlyOnceWith("owned-storage-key", context);
  });
  it.each([
    { name: " ", mimeType: "text/plain", size: 0 },
    { name: "x", mimeType: "text/plain\r\nX:inject", size: 0 },
    { name: "x", mimeType: "text/plain", size: 10 * 1024 * 1024 + 1 },
  ])("rejects invalid artifacts before storage: $name/$size", async (input) => {
    const f = fixture();
    await expect(
      writeNativeArtifact(f.db, f.store, context, {
        bytes: new Uint8Array(input.size),
        name: input.name,
        mimeType: input.mimeType,
      }),
    ).rejects.toMatchObject({ kind: "invalid_input" });
    expect(f.put).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
});
