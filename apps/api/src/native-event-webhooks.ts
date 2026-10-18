import type { NativeRoutineEventService } from "@rakazo/adapters";
import { InvalidNativeEventSignal } from "@rakazo/adapters";
import type { Hono } from "hono";

/** Signature verification must receive these exact bounded bytes, not JSON decoded and reserialized. */
export async function readNativeEventBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const length = request.headers.get("content-length");
  if (
    length !== null &&
    (!Number.isSafeInteger(Number(length)) || Number(length) < 0 || Number(length) > maxBytes)
  ) {
    await request.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(item.value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    reader.releaseLock();
  }
}
/** Public routes authenticate provider signals only. They do not create general Bot webhook messages. */
export function registerNativeEventWebhooks(
  app: Hono,
  events: Pick<NativeRoutineEventService, "ingestNotion" | "ingestCalendar">,
): void {
  app.post("/api/connectors/events/calendar", async (c) => {
    try {
      const raw = await readNativeEventBytes(c.req.raw, 0);
      if (!raw) return c.body(null, 413);
      await events.ingestCalendar(c.req.raw.headers);
      return c.body(null, 204);
    } catch (error) {
      return c.body(null, error instanceof InvalidNativeEventSignal ? 401 : 503);
    }
  });
  app.post("/api/connectors/events/notion/:hookId", async (c) => {
    try {
      const hookId = c.req.param("hookId");
      if (hookId.length > 256) return c.body(null, 404);
      const raw = await readNativeEventBytes(c.req.raw, 262144);
      if (!raw) return c.body(null, 413);
      // Unsigned challenge can fill only an app-bound expiring pending slot; owner confirmation is separate.
      await events.ingestNotion(hookId, raw, c.req.header("x-notion-signature") ?? null);
      return c.body(null, 204);
    } catch (error) {
      return c.body(null, error instanceof InvalidNativeEventSignal ? 401 : 503);
    }
  });
}
