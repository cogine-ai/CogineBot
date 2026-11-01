import { sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:https";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT,
  manifest,
  NOW,
  signed,
  TEST_KEY,
  TEST_PUBLIC_KEY,
} from "../test-fixtures/update-revocations.js";
import { createUpdateRevocationPoc } from "./update-revocations.js";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// Public localhost certificate for the RFC 8032 test-vector key, valid 2026-2036.
const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBWTCCAQugAwIBAgIUciwAnNnlASiHT7D2jKnLk5zhm84wBQYDK2VwMBQxEjAQ
BgNVBAMMCWxvY2FsaG9zdDAeFw0yNjExMDExMDI5MjRaFw0zNjEwMjkxMDI5MjRa
MBQxEjAQBgNVBAMMCWxvY2FsaG9zdDAqMAUGAytlcAMhANdamAGCsQq31Uv+08lk
BzoO4XLz2qYjJa8CGmj3B1Eao28wbTAdBgNVHQ4EFgQUWyeqVYkXl3DkdXWxYqHe
2XuL/G0wHwYDVR0jBBgwFoAUWyeqVYkXl3DkdXWxYqHe2XuL/G0wDwYDVR0TAQH/
BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwBQYDK2VwA0EAatjK
AiyUkPHu2OVloYg9j0awEsMKoVo5zbmqfNK2qOwYANbODhh9EBUYEH051r3CN2Ut
WJC0W2zIUH5PtBUcDA==
-----END CERTIFICATE-----`;

async function options(readFeed: () => Promise<ReturnType<typeof signed>>) {
  const directory = await mkdtemp(path.join(tmpdir(), "update-revocations-test-"));
  directories.push(directory);
  return {
    feedOrigin: "https://updates.example.test",
    publicKeyPem: TEST_PUBLIC_KEY,
    serialFile: path.join(directory, "serial.json"),
    now: () => NOW,
    readFeed,
  };
}

async function httpsOptions(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(
    { key: TEST_KEY.export({ type: "pkcs8", format: "pem" }), cert: TEST_CERTIFICATE },
    handle,
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected a local TCP server");
  return {
    ...(await options(async () => signed(manifest()))),
    feedOrigin: `https://127.0.0.1:${address.port}`,
    certificateAuthorityPem: TEST_CERTIFICATE,
    readFeed: undefined,
  };
}

describe("signed update revocation prototype", () => {
  it("cannot be enabled outside the test environment", async () => {
    const config = await options(async () => signed(manifest()));
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => createUpdateRevocationPoc(config)).toThrow("test-only");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    "http://updates.example.test",
    "https://person:secret@updates.example.test",
    "https://updates.example.test/other",
    "https://updates.example.test?redirect=other",
    "https://updates.example.test#other",
  ])("rejects a non-fixed HTTPS origin %s before making a request", async (feedOrigin) => {
    const readFeed = vi.fn(async () => signed(manifest()));
    const config = await options(readFeed);
    expect(() => createUpdateRevocationPoc({ ...config, feedOrigin })).toThrow("HTTPS feed origin");
    expect(readFeed).not.toHaveBeenCalled();
  });

  it("matches the entire artifact identity and sanitizes a bounded plaintext reason", async () => {
    const revoked = { ...ARTIFACT, reason: `<b>Withdrawn</b>\u0000\u202e ${"x".repeat(400)}` };
    const feed = signed(manifest({ revoked: [revoked] }));
    const config = await options(async () => feed);
    const client = createUpdateRevocationPoc(config);
    const result = await client.check(ARTIFACT);
    expect(result.status).toBe("revoked");
    expect(result.reason).toBe(`Withdrawn ${"x".repeat(230)}`);
    expect(result.reason).toHaveLength(240);
    for (const artifact of [
      { ...ARTIFACT, version: "0.3.1" },
      { ...ARTIFACT, platform: "win32" },
      { ...ARTIFACT, arch: "x64" },
      { ...ARTIFACT, sha512: Buffer.alloc(64, 8).toString("base64") },
    ]) {
      expect(await client.check(artifact)).toMatchObject({ status: "clear", reason: null });
    }
  });

  it("allows a signed restoration only at a newer serial", async () => {
    let feed = signed(manifest({ revoked: [{ ...ARTIFACT, reason: "Withdrawn" }] }));
    const config = await options(async () => feed);
    const client = createUpdateRevocationPoc(config);
    expect((await client.check(ARTIFACT)).status).toBe("revoked");
    feed = signed(manifest());
    expect((await client.check(ARTIFACT)).status).toBe("unknown");
    feed = signed(manifest({ serial: 2 }));
    expect((await client.check(ARTIFACT)).status).toBe("clear");
  });

  it.each([
    ["wrong schema", { schemaVersion: 2 }],
    ["fractional serial", { serial: 1.5 }],
    ["unsafe serial", { serial: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative serial", { serial: -1 }],
    ["future issue", { issuedAt: "2026-11-01T10:00:00.001Z" }],
    ["expired", { expiresAt: "2026-11-01T10:00:00.000Z" }],
    ["overlong lifetime", { expiresAt: "2026-11-02T09:00:00.001Z" }],
    ["backward lifetime", { expiresAt: "2026-11-01T08:00:00.000Z" }],
    ["ambiguous time", { issuedAt: "2026-11-01T09:00:00Z" }],
    ["wrong channel", { channel: "preview" }],
    ["invalid entry", { revoked: [{ ...ARTIFACT, sha512: "invalid", reason: "Withdrawn" }] }],
    ["coerced platform", { revoked: [{ ...ARTIFACT, platform: ["darwin"], reason: "Withdrawn" }] }],
    ["overlong reason", { revoked: [{ ...ARTIFACT, reason: "x".repeat(2049) }] }],
  ])("treats signed %s metadata as unknown", async (_name, change) => {
    const feed = signed({ ...manifest(), ...change });
    const config = await options(async () => feed);
    expect(await createUpdateRevocationPoc(config).check(ARTIFACT)).toMatchObject({
      status: "unknown",
      expiresAt: null,
      reason: null,
    });
    await expect(readFile(config.serialFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["tampered", "bad signature", "short signature", "oversized", "invalid UTF-8"])(
    "does not trust %s bytes",
    async (kind) => {
      let feed = signed(manifest());
      if (kind === "tampered") feed.manifest = Buffer.from(JSON.stringify(manifest({ serial: 3 })));
      if (kind === "bad signature") feed.signature = Buffer.alloc(64);
      if (kind === "short signature") feed.signature = feed.signature.subarray(0, 63);
      if (kind === "oversized") {
        const bytes = Buffer.alloc(256 * 1024 + 1, 32);
        feed = { manifest: bytes, signature: sign(null, bytes, TEST_KEY) };
      }
      if (kind === "invalid UTF-8") {
        const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
        feed = { manifest: bytes, signature: sign(null, bytes, TEST_KEY) };
      }
      const config = await options(async () => feed);
      expect((await createUpdateRevocationPoc(config).check(ARTIFACT)).status).toBe("unknown");
    },
  );

  it("keeps the serial namespace bound to the configured feed and key", async () => {
    const config = await options(async () => signed(manifest()));
    expect((await createUpdateRevocationPoc(config).check(ARTIFACT)).status).toBe("clear");
    expect(
      (
        await createUpdateRevocationPoc({
          ...config,
          feedOrigin: "https://other.example.test",
        }).check(ARTIFACT)
      ).status,
    ).toBe("unknown");
  });

  it.each(["corrupt", "locked", "unwritable"])(
    "fails closed with a %s serial store",
    async (kind) => {
      const config = await options(async () => signed(manifest()));
      if (kind === "corrupt") await writeFile(config.serialFile, "broken JSON");
      if (kind === "locked") await writeFile(`${config.serialFile}.lock`, "test lock");
      if (kind === "unwritable") config.serialFile = path.dirname(config.serialFile);
      expect((await createUpdateRevocationPoc(config).check(ARTIFACT)).status).toBe("unknown");
    },
  );

  it("never interprets an unavailable feed as a withdrawal or deletes the downloaded artifact", async () => {
    const config = await options(async () => {
      throw new Error("Offline");
    });
    const retained = path.join(path.dirname(config.serialFile), "download.zip");
    await writeFile(retained, "verified test download");
    expect((await createUpdateRevocationPoc(config).check(ARTIFACT)).status).toBe("unknown");
    expect(await readFile(retained, "utf8")).toBe("verified test download");
  });

  it.each([
    "404",
    "redirect",
    "declared oversize",
    "stream oversize",
    "oversized signature",
    "interrupted",
  ])("treats an HTTPS %s response as unknown without following redirects", async (kind) => {
    const paths: string[] = [];
    const feed = signed(manifest());
    const config = await httpsOptions((request, response) => {
      paths.push(request.url ?? "");
      if (kind === "404") {
        response.writeHead(404);
        response.end();
      } else if (kind === "redirect") {
        response.writeHead(302, { Location: "/outside" });
        response.end();
      } else if (kind === "declared oversize") {
        response.writeHead(200, { "Content-Length": 256 * 1024 + 1 });
        response.end();
      } else if (kind === "stream oversize") {
        response.end(Buffer.alloc(256 * 1024 + 1));
      } else if (kind === "oversized signature")
        response.end(request.url?.endsWith(".sig") ? Buffer.alloc(65) : feed.manifest);
      else {
        response.writeHead(200, { "Content-Length": 50 });
        response.write("short");
        response.destroy();
      }
    });
    expect((await createUpdateRevocationPoc(config).check(ARTIFACT)).status).toBe("unknown");
    expect(paths).not.toContain("/outside");
    await expect(readFile(config.serialFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires TLS trust even for an otherwise valid signed feed", async () => {
    const feed = signed(manifest());
    const config = await httpsOptions((request, response) =>
      response.end(request.url?.endsWith(".sig") ? feed.signature : feed.manifest),
    );
    expect(
      (
        await createUpdateRevocationPoc({ ...config, certificateAuthorityPem: undefined }).check(
          ARTIFACT,
        )
      ).status,
    ).toBe("unknown");
  });

  it("uses an absolute deadline even while a stalled HTTPS body keeps arriving", async () => {
    const config = await httpsOptions((_request, response) => {
      response.writeHead(200);
      response.write(" ");
      const timer = setInterval(() => response.write(" "), 50);
      response.once("close", () => clearInterval(timer));
    });
    expect((await createUpdateRevocationPoc(config).check(ARTIFACT)).status).toBe("unknown");
  });

  it("serializes concurrent clients without lowering the persisted serial", async () => {
    const feed = signed(manifest({ serial: 2 }));
    const config = await options(async () => feed);
    const results = await Promise.all([
      createUpdateRevocationPoc(config).check(ARTIFACT),
      createUpdateRevocationPoc(config).check(ARTIFACT),
      createUpdateRevocationPoc(config).check(ARTIFACT),
    ]);
    expect(results.map((result) => result.status)).toEqual(["clear", "clear", "clear"]);
    expect(JSON.parse(await readFile(config.serialFile, "utf8"))).toMatchObject({ serial: 2 });
    expect(
      (
        await createUpdateRevocationPoc({
          ...config,
          readFeed: async () => signed(manifest()),
        }).check(ARTIFACT)
      ).status,
    ).toBe("unknown");
  });

  it("rejects a lower serial arriving through another client while a higher result persists", async () => {
    const config = await options(async () => signed(manifest({ serial: 2 })));
    const results = await Promise.all([
      createUpdateRevocationPoc(config).check(ARTIFACT),
      createUpdateRevocationPoc({ ...config, readFeed: async () => signed(manifest()) }).check(
        ARTIFACT,
      ),
    ]);
    expect(results.map((result) => result.status)).toEqual(["clear", "unknown"]);
    expect(JSON.parse(await readFile(config.serialFile, "utf8"))).toMatchObject({ serial: 2 });
  });

  it("binds an in-flight check to the original artifact even when the caller mutates its object", async () => {
    let finish!: (feed: ReturnType<typeof signed>) => void;
    const config = await options(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const artifact = { ...ARTIFACT };
    const pending = createUpdateRevocationPoc(config).check(artifact);
    artifact.sha512 = Buffer.alloc(64, 8).toString("base64");
    finish(signed(manifest({ revoked: [{ ...ARTIFACT, reason: "Withdrawn" }] })));
    expect(await pending).toMatchObject({ status: "revoked", artifact: ARTIFACT });
  });

  it("bounds local serial reads and never resets an oversized record", async () => {
    const config = await options(async () => signed(manifest()));
    const contents = " ".repeat(4097);
    await writeFile(config.serialFile, contents);
    expect((await createUpdateRevocationPoc(config).check(ARTIFACT)).status).toBe("unknown");
    expect(await readFile(config.serialFile, "utf8")).toBe(contents);
  });

  it("reads the signed metadata from only the two pinned HTTPS feed paths", async () => {
    const feed = signed(manifest());
    const paths: string[] = [];
    const server = createServer(
      { key: TEST_KEY.export({ type: "pkcs8", format: "pem" }), cert: TEST_CERTIFICATE },
      (request, response) => {
        paths.push(request.url ?? "");
        response.end(request.url === "/revocations/v1.json" ? feed.manifest : feed.signature);
      },
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected a local TCP server");
    const config = await options(async () => feed);
    expect(
      await createUpdateRevocationPoc({
        ...config,
        feedOrigin: `https://127.0.0.1:${address.port}`,
        readFeed: undefined,
        certificateAuthorityPem: TEST_CERTIFICATE,
      }).check(ARTIFACT),
    ).toMatchObject({ status: "clear" });
    expect(paths).toEqual(["/revocations/v1.json", "/revocations/v1.json.sig"]);
  });
  it("accepts an authenticated fresh clear result and retains its serial after reopening", async () => {
    let feed = signed(manifest({ serial: 2 }));
    const config = await options(async () => feed);
    expect(await createUpdateRevocationPoc(config).check(ARTIFACT)).toMatchObject({
      status: "clear",
      artifact: ARTIFACT,
      checkedAt: NOW,
      expiresAt: Date.parse("2026-11-02T09:00:00.000Z"),
    });
    feed = signed(manifest({ serial: 1 }));
    expect(await createUpdateRevocationPoc(config).check(ARTIFACT)).toMatchObject({
      status: "unknown",
    });
  });
});
