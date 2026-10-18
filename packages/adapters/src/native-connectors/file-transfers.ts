import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { combineSignals } from "../connector-safety.js";
import type { RemoteTransportDependencies } from "../remote-mcp.js";
import { NativeActionError } from "./action.js";
import { readNativeBytes } from "./binary.js";
import { createNativeFetch } from "./network.js";

function resourceUrl(value: string, upload: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NativeActionError("invalid_input", "Invalid file resource.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "files.slack.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !(upload
      ? url.pathname.startsWith("/upload/v1/")
      : /^\/files-(pri|tmb)\//.test(url.pathname)) ||
    /(?:^|\/)\.\.(?:\/|$)/.test(decodeURIComponent(url.pathname))
  )
    throw new NativeActionError("invalid_input", "Unsupported private file authority.");
  return url;
}

/** One fixed provider boundary; signed upload URLs never receive the account bearer token. */
export class NativeSlackFileTransfers {
  private readonly fetch;
  constructor(
    private readonly token: () => Promise<string>,
    private readonly signal: AbortSignal,
    network: RemoteTransportDependencies = {},
  ) {
    this.fetch = createNativeFetch(network);
  }
  close(): Promise<void> {
    return this.fetch.close();
  }

  async upload(input: {
    url: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<{ status: number }> {
    const url = resourceUrl(input.url, true);
    if (
      input.bytes.byteLength > ATTACHMENT_MAX_BYTES ||
      !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(input.contentType)
    )
      throw new NativeActionError("invalid_input", "Unsupported attachment size or media type.");
    // Revalidate the exact grant even though this signed upload must not receive its bearer.
    await this.token();
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: { "content-type": input.contentType },
        body: input.bytes as BodyInit,
        signal: combineSignals(this.signal, AbortSignal.timeout(30_000)),
      });
    } catch {
      throw new NativeActionError("result_unknown", "File upload acknowledgement unavailable.", {
        uncertain: true,
      });
    }
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400)
      throw new NativeActionError("invalid_input", "Private file redirects are not supported.");
    if (!response.ok)
      throw new NativeActionError(
        response.status >= 500 ? "result_unknown" : "resource_unavailable",
        "File upload was not acknowledged.",
        { uncertain: response.status >= 500 },
      );
    return { status: response.status };
  }

  async download(input: {
    url: string;
    maxBytes: number;
  }): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const url = resourceUrl(input.url, false);
    const token = await this.token();
    const signal = combineSignals(this.signal, AbortSignal.timeout(30_000));
    const response = await this.fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new NativeActionError(
        response.status === 401 ? "authorization_expired" : "resource_unavailable",
        "Private file is unavailable.",
      );
    }
    return {
      bytes: await readNativeBytes(response, signal, input.maxBytes),
      mimeType:
        response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
    };
  }
}
