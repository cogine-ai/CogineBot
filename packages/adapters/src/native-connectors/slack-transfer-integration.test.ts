import assert from "node:assert/strict";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { afterEach, it as test } from "vitest";
import { NativeActionError } from "./action.js";
import { context } from "./collaboration-conformance.js";
import { NativeSlackFileTransfers } from "./file-transfers.js";
import { NativeHttpClient } from "./http.js";
import { slackActions } from "./slack.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(close.splice(0).map((done) => done()));
});
const action = (id: string) => slackActions.find((action) => action.id === id)!;
function setup(size = 1024, actualBytes = new Uint8Array(size)) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const artifacts: Uint8Array[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input),
      authorization = new Headers(init?.headers).get("authorization");
    calls.push({ url, authorization });
    if (url.startsWith("https://slack.com/api/")) {
      assert.equal(authorization, "Bearer fixture-transfer-token");
      if (url.includes("files.info"))
        return new Response(
          JSON.stringify({
            ok: true,
            file: {
              id: "F123FIXTURE",
              name: "fixture.bin",
              size,
              mimetype: "application/octet-stream",
              url_private_download:
                "https://files.slack.com/files-pri/T123FIXTURE-F123FIXTURE/fixture.bin",
            },
          }),
        );
      if (url.endsWith("files.getUploadURLExternal"))
        return new Response(
          JSON.stringify({
            ok: true,
            file_id: "F123FIXTURE",
            upload_url: "https://files.slack.com/upload/v1/FIXTURE",
          }),
        );
      if (url.endsWith("files.completeUploadExternal"))
        return new Response(
          JSON.stringify({ ok: true, files: [{ id: "F123FIXTURE", title: "Fixture" }] }),
        );
    }
    if (url.startsWith("https://files.slack.com/files-pri/")) {
      assert.equal(authorization, "Bearer fixture-transfer-token");
      return new Response(actualBytes);
    }
    if (url.startsWith("https://files.slack.com/upload/v1/")) {
      assert.equal(authorization, null);
      assert.deepEqual(init!.body, actualBytes);
      return new Response("ok");
    }
    throw Error("Unexpected file transport authority");
  };
  const signal = new AbortController().signal,
    network = { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] };
  const http = new NativeHttpClient(
    "https://slack.com/api",
    async () => ({ kind: "bearer", value: "fixture-transfer-token" }),
    { network, signal, readOnly: false },
  );
  const files = new NativeSlackFileTransfers(async () => "fixture-transfer-token", signal, network);
  close.push(
    () => http.close(),
    () => files.close(),
  );
  const ctx = context("slack", (request) => http.request(request), {
    downloadResource: (input) => files.download(input),
    uploadResource: (input) => files.upload(input),
    readArtifact: async () => ({
      bytes: actualBytes,
      name: "fixture.bin",
      mimeType: "application/octet-stream",
    }),
    writeArtifact: async ({ bytes, name, mimeType }) => {
      artifacts.push(bytes);
      return { id: "fixture-result", name, mimeType, size: bytes.length };
    },
  });
  return { ctx, calls, artifacts };
}
test("Slack default small-file download composes actual transfer and bounded byte reader", async () => {
  assert.equal(ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024);
  const f = setup();
  const result = await action("slack.files.download").execute({ file: "F123FIXTURE" }, f.ctx);
  assert.equal(f.artifacts.length, 1);
  assert.equal(f.artifacts[0]!.byteLength, 1024);
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.stringify(result).includes("files-pri"), false);
  assert.equal(JSON.stringify(result).includes("fixture-transfer-token"), false);
});
test("Slack oversized metadata/default/custom limit is rejected before binary transport", async () => {
  const f = setup(ATTACHMENT_MAX_BYTES + 1, new Uint8Array(1));
  await assert.rejects(
    action("slack.files.download").execute({ file: "F123FIXTURE" }, f.ctx),
    (e) => e instanceof NativeActionError && e.kind === "invalid_input",
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.artifacts.length, 0);
  await assert.rejects(
    action("slack.files.download").execute(
      { file: "F123FIXTURE", maxBytes: ATTACHMENT_MAX_BYTES + 1 },
      f.ctx,
    ),
    (e) => e instanceof NativeActionError && e.kind === "invalid_input",
  );
  assert.equal(f.calls.length, 1);
});
test("Slack oversized actual stream is rejected by shared reader without creating an artifact", async () => {
  const f = setup(1024, new Uint8Array(ATTACHMENT_MAX_BYTES + 1));
  await assert.rejects(
    action("slack.files.download").execute({ file: "F123FIXTURE" }, f.ctx),
    (e) => e instanceof NativeActionError && e.kind === "invalid_input",
  );
  assert.equal(f.calls.length, 2);
  assert.equal(f.artifacts.length, 0);
});
test("Slack complete external upload sends no bearer to signed upload URL", async () => {
  const f = setup(7, new TextEncoder().encode("fixture"));
  await action("slack.files.upload").execute(
    { artifactId: "fixture-artifact", filename: "fixture.bin", channel_id: "C123FIXTURE" },
    f.ctx,
  );
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1]!.authorization, null);
});
test("Slack oversized artifact is rejected before allocating an external upload", async () => {
  const f = setup(ATTACHMENT_MAX_BYTES + 1);
  await assert.rejects(
    action("slack.files.upload").execute(
      { artifactId: "fixture-artifact", filename: "fixture.bin", channel_id: "C123FIXTURE" },
      f.ctx,
    ),
    (e) => e instanceof NativeActionError && e.kind === "invalid_input",
  );
  assert.equal(f.calls.length, 0);
});
