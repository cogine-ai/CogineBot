import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { combineSignals } from "../connector-safety.js";
import type { RemoteTransportDependencies } from "../remote-mcp.js";
import { NativeActionError } from "./action.js";
import { readNativeBytes } from "./binary.js";
import { createNativeFetch } from "./network.js";

/** Only the URL returned by the selected account's fixed Graph metadata request. */
export class NativeGraphFileDownloads {
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
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new NativeActionError("invalid_input", "Invalid Microsoft file resource.");
    }
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      ![".sharepoint.com", ".files.1drv.com"].some((suffix) => url.hostname.endsWith(suffix)) ||
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 1 ||
      input.maxBytes > ATTACHMENT_MAX_BYTES
    )
      throw new NativeActionError(
        "invalid_input",
        "This Microsoft download authority or file limit is unsupported.",
      );
    await this.revalidate();
    const signal = combineSignals(this.signal, AbortSignal.timeout(30_000));
    let response: Response;
    try {
      response = await this.fetch(url, { method: "GET", redirect: "manual", signal });
    } catch {
      throw new NativeActionError(
        "temporarily_unavailable",
        "The Microsoft file could not be downloaded.",
      );
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new NativeActionError(
        "resource_unavailable",
        "The Microsoft file is unavailable or its download link expired.",
      );
    }
    return {
      bytes: await readNativeBytes(response, signal, input.maxBytes),
      mimeType:
        response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
    };
  }
}
