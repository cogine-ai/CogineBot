import type { NativeConnectorProvider } from "@rakazo/adapters";
import { NativeActionError } from "@rakazo/adapters";
import type { Hono } from "hono";
import { readNativeEventBytes } from "./native-event-webhooks.js";

/** Enterprise configuration callbacks never create a user grant or a chat task. */
export function registerNativeEnterpriseWebhooks(
  app: Hono,
  hooks: Pick<NativeConnectorProvider["enterpriseHooks"], "accept">,
): void {
  app.on(["GET", "POST"], "/api/connectors/enterprise/:configId", async (c) => {
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    try {
      const id = c.req.param("configId");
      if (!id || id.length > 256) return c.body(null, 404);
      const raw = await readNativeEventBytes(c.req.raw, 262144);
      if (!raw) return c.body(null, 413);
      const result = await hooks.accept(
        id,
        {
          rawBody: raw,
          headers: Object.fromEntries(c.req.raw.headers),
          query: {
            msg_signature: c.req.query("msg_signature"),
            timestamp: c.req.query("timestamp"),
            nonce: c.req.query("nonce"),
            echostr: c.req.query("echostr"),
          },
        },
        c.req.raw.signal,
      );
      if (result.type === "challenge")
        return c.req.query("echostr") !== undefined
          ? c.text(result.challenge)
          : c.json({ challenge: result.challenge });
      return c.text("success");
    } catch (error) {
      return c.body(
        null,
        error instanceof NativeActionError && error.kind === "authorization_required" ? 401 : 503,
      );
    }
  });
}
