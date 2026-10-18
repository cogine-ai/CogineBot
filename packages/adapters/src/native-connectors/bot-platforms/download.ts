import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { combineSignals } from "../../connector-safety.js";
import type { RemoteTransportDependencies } from "../../remote-mcp.js";
import { NativeActionError } from "../action.js";
import { readNativeBytes } from "../binary.js";
import { createNativeFetch } from "../network.js";

/** Only message-proven Discord CDN URLs; no bot credential is sent to the CDN. */
export class DiscordAttachmentDownloads {
  private readonly fetch;
  constructor(
    private readonly revalidate: () => Promise<unknown>,
    private readonly signal: AbortSignal,
    network: RemoteTransportDependencies = {},
  ) {
    this.fetch = createNativeFetch(network);
  }
  close(): Promise<void> {
    return this.fetch.close();
  }
  async download(input: {
    url: string;
    maxBytes: number;
  }): Promise<{ bytes: Uint8Array; mimeType: string }> {
    if (
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 1 ||
      input.maxBytes > ATTACHMENT_MAX_BYTES
    )
      throw new NativeActionError("invalid_input", "Invalid file size limit.");
    let url: URL;
    let decoded: string;
    try {
      url = new URL(input.url);
      decoded = decodeURIComponent(url.pathname);
    } catch {
      throw new NativeActionError("invalid_input", "Invalid Discord attachment URL.");
    }
    if (
      url.origin !== "https://cdn.discordapp.com" ||
      url.username ||
      url.password ||
      url.hash ||
      !/^\/attachments\/[1-9][0-9]{5,20}\/[1-9][0-9]{5,20}\/.+/.test(url.pathname) ||
      decoded.split("/").some((p) => p === ".." || p === ".")
    )
      throw new NativeActionError(
        "invalid_input",
        "The attachment is outside the Discord CDN boundary.",
      );
    await this.revalidate();
    const signal = combineSignals(this.signal, AbortSignal.timeout(30_000));
    let response: Response;
    try {
      response = await this.fetch(url, { signal, redirect: "manual" });
    } catch {
      throw new NativeActionError(
        "temporarily_unavailable",
        "The attachment could not be downloaded.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new NativeActionError("resource_unavailable", "The attachment is unavailable.");
    }
    return {
      bytes: await readNativeBytes(response, signal, input.maxBytes),
      mimeType:
        response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
    };
  }
}
