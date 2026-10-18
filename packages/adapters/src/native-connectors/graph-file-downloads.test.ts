import assert from "node:assert/strict";
import { it as test } from "vitest";
import { NativeGraphFileDownloads } from "./graph-file-downloads.js";

test("Graph preauthenticated download revalidates its account and never sends credentials", async () => {
  let calls = 0,
    validated = false;
  const downloads = new NativeGraphFileDownloads(
    async () => {
      validated = true;
    },
    new AbortController().signal,
    {
      resolveHostname: async () => [{ address: "203.0.113.8", family: 4 }],
      fetch: async (url, init) => {
        calls++;
        assert.equal(validated, true);
        assert.equal(String(url), "https://fixture.sharepoint.com/file?token=fixture-signed");
        assert.equal(new Headers(init?.headers).has("authorization"), false);
        assert.equal(init?.redirect, "manual");
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "application/pdf" },
        });
      },
    },
  );
  try {
    assert.deepEqual(
      await downloads.download({
        url: "https://fixture.sharepoint.com/file?token=fixture-signed",
        maxBytes: 3,
      }),
      { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" },
    );
    for (const url of [
      "https://attacker.example.test/file",
      "https://fixture.sharepoint.com.attacker.example.test/file",
      "https://fixture:secret@fixture.sharepoint.com/file",
      "http://fixture.sharepoint.com/file",
      "https://fixture.sharepoint.com/file#fragment",
    ]) {
      await assert.rejects(downloads.download({ url, maxBytes: 3 }));
    }
    assert.equal(calls, 1);
  } finally {
    await downloads.close();
  }
});

test("Graph download refuses redirects, private DNS, oversized bytes and a revoked grant", async () => {
  for (const kind of ["redirect", "private", "oversize", "revoked"]) {
    let calls = 0;
    const downloads = new NativeGraphFileDownloads(
      async () => {
        if (kind === "revoked") throw new Error("Fixture revoked");
      },
      new AbortController().signal,
      {
        resolveHostname: async () => [
          { address: kind === "private" ? "10.0.0.1" : "203.0.113.8", family: 4 },
        ],
        fetch: async () => {
          calls++;
          return kind === "redirect"
            ? new Response(null, {
                status: 302,
                headers: { location: "https://attacker.example.test" },
              })
            : new Response(new Uint8Array(4));
        },
      },
    );
    try {
      await assert.rejects(
        downloads.download({ url: "https://fixture.files.1drv.com/file", maxBytes: 3 }),
      );
      assert.equal(calls, kind === "private" || kind === "revoked" ? 0 : 1);
    } finally {
      await downloads.close();
    }
  }
});
