import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { NativeActionError } from "./action.js";
import { nativeAbortable } from "./network.js";

/** Read one bounded private file. Never decode binary as text or return a truncated file. */
export async function readNativeBytes(
  response: Response,
  signal: AbortSignal,
  maxBytes = ATTACHMENT_MAX_BYTES,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ATTACHMENT_MAX_BYTES)
    throw new NativeActionError("invalid_input", "Invalid file size limit.");
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    await response.body?.cancel();
    throw new NativeActionError("invalid_input", "The file exceeds the attachment size limit.");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await nativeAbortable(reader.read(), signal);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes)
        throw new NativeActionError("invalid_input", "The file exceeds the attachment size limit.");
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
