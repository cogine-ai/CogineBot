import { DEPLOYMENT_TRANSFER_MAX_WIRE_BYTES, encodeDeploymentTransferJson } from "@rakazo/adapters";
import { DeploymentTransferIdSchema } from "@rakazo/contracts";
import type { Hono } from "hono";
import type { createDeploymentTransferService } from "./deployment-transfer.js";

/** Peer endpoints carry credentials only inside a signed server-to-server item. */
export function mountDeploymentTransferHttp(
  app: Hono,
  service: ReturnType<typeof createDeploymentTransferService>,
) {
  const base = "/api/deployment-transfer/v1";
  app.get(`${base}/identity`, async (c) => {
    try {
      return c.body(encodeDeploymentTransferJson(await service.publicIdentity()), 200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
    } catch {
      return c.json({ error: "Credential transfer unavailable." }, 400);
    }
  });
  for (const operation of ["challenge", "proposal", "grant", "item", "status", "cancel"] as const) {
    app.post(`${base}/${operation}`, async (c) => {
      try {
        const request = c.req.raw;
        if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
          throw new Error();
        if (!request.body) throw new Error();
        const reader = request.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let size = 0;
        let text = "";
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > DEPLOYMENT_TRANSFER_MAX_WIRE_BYTES) {
              void reader.cancel().catch(() => undefined);
              throw new Error();
            }
            text += decoder.decode(next.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          reader.releaseLock();
        }
        const body: unknown = JSON.parse(text);
        let result: unknown;
        switch (operation) {
          case "challenge": {
            if (
              !body ||
              typeof body !== "object" ||
              Object.keys(body).length !== 1 ||
              !("locator" in body)
            )
              throw new Error();
            result = await service.challenge(DeploymentTransferIdSchema.parse(body.locator));
            break;
          }
          case "proposal":
            result = await service.receiveProposal(body, request.signal);
            break;
          case "grant":
            result = await service.receiveGrant(body, request.signal);
            break;
          case "item": {
            const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
              request.headers.get("authorization") ?? "",
            )?.[1];
            if (!token) throw new Error();
            result = await service.receiveItem(token, body, request.signal);
            break;
          }
          case "status":
            result = await service.receiveStatus(body);
            break;
          case "cancel":
            result = await service.receiveCancel(body, request.signal);
            break;
        }
        return c.body(encodeDeploymentTransferJson(result), 200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
      } catch {
        // No parser/credential/provider error, cause, body or bearer is reflected to the peer.
        return c.json({ error: "Credential transfer unavailable." }, 400, {
          "cache-control": "no-store",
        });
      }
    });
  }
}
