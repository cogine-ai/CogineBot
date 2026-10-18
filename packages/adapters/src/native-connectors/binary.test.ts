import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { readNativeBytes } from "./binary.js";
import { NativeSlackFileTransfers } from "./file-transfers.js";
import { NativeHttpClient } from "./http.js";
import { nativeServiceBase } from "./service-bases.js";

const signal = () => new AbortController().signal;
const network = (fetch: typeof globalThis.fetch) => ({
  fetch,
  resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
});
describe("bounded native binary transport", () => {
  it("preserves non-text bytes exactly", async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10]);
    expect(await readNativeBytes(new Response(bytes), signal())).toEqual(bytes);
  });
  it("rejects chunked oversize and cancels the stream", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(5));
      },
      cancel,
    });
    await expect(readNativeBytes(new Response(body), signal(), 8)).rejects.toMatchObject({
      kind: "invalid_input",
    });
    expect(cancel).toHaveBeenCalled();
  });
  it("rejects claimed oversize before allocation", async () => {
    await expect(
      readNativeBytes(
        new Response("", { headers: { "content-length": String(ATTACHMENT_MAX_BYTES + 1) } }),
        signal(),
      ),
    ).rejects.toMatchObject({ kind: "invalid_input" });
  });
  it("cancels a stalled body when the operation is aborted", async () => {
    const control = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const read = readNativeBytes(response, control.signal);
    control.abort();
    await expect(read).rejects.toBeDefined();
    expect(cancel).toHaveBeenCalled();
  });
  it("pins each app to its API and rejects cross-app secondary APIs", () => {
    expect(nativeServiceBase("gmail")).toBe("https://gmail.googleapis.com/gmail/v1");
    expect(nativeServiceBase("google-docs", undefined, "drive")).toBe(
      "https://www.googleapis.com/drive/v3",
    );
    expect(nativeServiceBase("google-drive", undefined, "drive-upload")).toBe(
      "https://www.googleapis.com/upload/drive/v3",
    );
    expect(() => nativeServiceBase("gmail", undefined, "drive-upload")).toThrow();
    expect(() => nativeServiceBase("notion", undefined, "drive")).toThrow();
    expect(() => nativeServiceBase("unknown")).toThrow();
  });
  it("keeps repeated Gmail query fields and binary responses", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      expect(new URL(String(url)).searchParams.getAll("labelIds")).toEqual(["INBOX", "UNREAD"]);
      return new Response(new Uint8Array([255, 0, 128]));
    });
    const http = new NativeHttpClient(
      "https://gmail.googleapis.com/gmail/v1",
      async () => ({ kind: "bearer", value: "fixture-token" }),
      { network: network(fetch), signal: signal(), readOnly: true },
    );
    try {
      expect(
        (
          await http.request({
            method: "GET",
            path: "/users/me/messages",
            query: { labelIds: ["INBOX", "UNREAD"] },
            responseType: "bytes",
          })
        ).body,
      ).toEqual(new Uint8Array([255, 0, 128]));
    } finally {
      await http.close();
    }
  });
  it("returns resumable 308 without following Location", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 308,
          headers: { range: "bytes=0-255", location: "https://unexpected.example.test/" },
        }),
    );
    const http = new NativeHttpClient(
      "https://www.googleapis.com/upload/drive/v3",
      async () => ({ kind: "bearer", value: "fixture-token" }),
      { network: network(fetch), signal: signal(), readOnly: false, resumableUpload: true },
    );
    try {
      expect(
        (await http.request({ method: "PUT", path: "/files", body: new Uint8Array([1]) })).status,
      ).toBe(308);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await http.close();
    }
  });
  it("uploads only to the fixed Slack file boundary without bearer", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response("ok");
    });
    const files = new NativeSlackFileTransfers(
      async () => "fixture-private-token",
      signal(),
      network(fetch),
    );
    try {
      await files.upload({
        url: "https://files.slack.com/upload/v1/fixture",
        bytes: new Uint8Array([1]),
        contentType: "text/plain",
      });
    } finally {
      await files.close();
    }
  });
  it("never forwards private file credentials to another authority or follows redirects", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://unexpected.example.test/file" },
        }),
    );
    const files = new NativeSlackFileTransfers(
      async () => "fixture-private-token",
      signal(),
      network(fetch),
    );
    try {
      await expect(
        files.download({
          url: "https://files.slack.com.attacker.example/files-pri/fixture",
          maxBytes: 100,
        }),
      ).rejects.toMatchObject({ kind: "invalid_input" });
      expect(fetch).not.toHaveBeenCalled();
      await expect(
        files.download({ url: "https://files.slack.com/files-pri/fixture", maxBytes: 100 }),
      ).rejects.toThrow("redirects");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await files.close();
    }
  });
});
