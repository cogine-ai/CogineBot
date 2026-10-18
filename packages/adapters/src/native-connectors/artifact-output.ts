import { createHash } from "node:crypto";
import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import { ARTIFACT_NAME_MAX_LENGTH, ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { NativeActionError } from "./action.js";

export async function writeNativeArtifact(
  prisma: PrismaClient,
  store: ArtifactStore,
  context: AdapterContext,
  input: { bytes: Uint8Array; name: string; mimeType: string },
): Promise<{ id: string; name: string; mimeType: string; size: number }> {
  const name = Array.from(input.name, (character) =>
    character.charCodeAt(0) < 32 ||
    character.charCodeAt(0) === 127 ||
    character === "/" ||
    character === "\\"
      ? "_"
      : character,
  )
    .join("")
    .trim()
    .slice(0, ARTIFACT_NAME_MAX_LENGTH);
  if (
    !name ||
    input.bytes.byteLength > ATTACHMENT_MAX_BYTES ||
    !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(input.mimeType)
  )
    throw new NativeActionError(
      "invalid_input",
      "Unsupported attachment name, size or media type.",
    );
  const stored = await store.put({ ...input, name }, context);
  try {
    const row = await prisma.artifact.create({
      data: {
        userId: context.userId,
        spaceId: context.spaceId,
        botId: context.botId,
        name,
        mimeType: input.mimeType,
        size: input.bytes.byteLength,
        hash: createHash("sha256").update(input.bytes).digest("hex"),
        storageKey: stored.id,
      },
    });
    return { id: row.id, name: row.name, mimeType: row.mimeType, size: row.size };
  } catch (error) {
    await store.remove(stored.id, context).catch(() => undefined);
    throw error;
  }
}
