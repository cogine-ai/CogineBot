import { resolveComposerSendPlan } from "@rakazo/core";
import { beforeEach, expect, it, vi } from "vitest";
import { OUTBOX_MAX_BYTES, outboxDisk } from "./outbox-disk";
import type { SendAttempt } from "./thread-feedback";
import { deliverSend, OUTBOX_MAX_ENTRIES } from "./thread-feedback";

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    get exists() {
      return [...files.keys()].some((p) => p.startsWith(this.uri));
    }
    create() {}
    delete() {
      for (const path of files.keys()) if (path.startsWith(`${this.uri}/`)) files.delete(path);
    }
    list() {
      const names = new Set(
        [...files.keys()]
          .filter((path) => path.startsWith(`${this.uri}/`))
          .map((path) => path.slice(this.uri.length + 1).split("/")[0]!),
      );
      return [...names].map((name) =>
        files.has(`${this.uri}/${name}`) ? new File(this, name) : new Directory(this, name),
      );
    }
  }
  class File extends Directory {
    override get exists() {
      return files.has(this.uri);
    }
    get size() {
      return Buffer.byteLength(files.get(this.uri) ?? "");
    }
    async base64() {
      return files.get(this.uri) ?? "";
    }
    textSync() {
      return files.get(this.uri);
    }
    write(text: string) {
      files.set(this.uri, text);
    }
  }
  return { Directory, File, Paths: { cache: "cache" } };
});
const scope = {
  apiBase: "https://api.example.test",
  userId: "user-a",
  cacheSession: "namespace-a",
  spaceId: "space-a",
};
function attempt(nonce = "nonce-a"): SendAttempt {
  return {
    ...scope,
    state: "pending",
    session: 1,
    clientNonce: nonce,
    artifactIds: new Map([["attachment-a", "artifact-a"]]),
    payload: {
      originThreadKey: "bot-a",
      displayText: "Hello",
      replyPreview: null,
      botTarget: "bot-a",
      reroutedToGroup: false,
      plan: resolveComposerSendPlan({ text: "Hello", mentions: [], hasAttachments: true }),
      replyQuote: null,
      attachments: [
        {
          id: "attachment-a",
          name: "photo.png",
          mimeType: "image/png",
          contentBase64: "aGVsbG8=",
          previewUri: "file:///fake-preview",
        },
      ],
    },
  };
}
beforeEach(() => files.clear());
it("restores payload, uploaded ids and nonce for an idempotent retry", async () => {
  const original = attempt();
  expect(outboxDisk.admit(original)).toBe(true);
  outboxDisk.save([original]);
  files.set("cache/outbox/delivered/0", "orphan");
  const [restored] = outboxDisk.load(2, scope);
  expect(restored).toMatchObject({
    state: "queued",
    session: 2,
    clientNonce: original.clientNonce,
  });
  expect(files.has("cache/outbox/delivered/0")).toBe(false);
  expect(restored?.artifactIds).toEqual(original.artifactIds);
  expect(restored?.payload.attachments[0]?.contentBase64).toBe("");
  restored!.artifactIds.clear();
  await outboxDisk.hydrate(restored!);
  expect(restored?.payload.attachments[0]?.contentBase64).toBe("aGVsbG8=");
  const metadata = files.get("cache/outbox/sends-v4.json");
  expect(metadata).not.toContain("aGVsbG8=");
  expect(metadata).not.toContain("file:");
});
it.each([
  { userId: "user-b" },
  { apiBase: "https://other.example.test" },
  { cacheSession: "namespace-b" },
])("rejects a different owner or session %j", (change) => {
  outboxDisk.save([attempt()]);
  expect(outboxDisk.load(2, { ...scope, ...change })).toEqual([]);
});
it("caps the persisted count and wipes every entry", () => {
  outboxDisk.save(Array.from({ length: OUTBOX_MAX_ENTRIES + 5 }, (_, i) => attempt(`nonce-${i}`)));
  expect(outboxDisk.load(2, scope)).toHaveLength(OUTBOX_MAX_ENTRIES);
  outboxDisk.clear();
  expect(files.size).toBe(0);
});
it("treats corrupt storage as an empty outbox", () => {
  files.set("cache/outbox/sends-v4.json", "{");
  expect(outboxDisk.load(2, scope)).toEqual([]);
});

it("rejects a full attachment budget without rewriting existing bytes", () => {
  files.set("cache/outbox/old/0", "x");
  const large = attempt();
  large.payload.attachments[0]!.contentBase64 = "x".repeat(Math.ceil((OUTBOX_MAX_BYTES * 4) / 3));
  expect(outboxDisk.admit(large)).toBe(false);
  expect(files.get("cache/outbox/old/0")).toBe("x");
});

it("does not reuse leftover bytes for a repeated nonce in another session", () => {
  files.set("cache/outbox/nonce-a/0", "old-private-placeholder");
  const next = { ...attempt(), userId: "user-b", cacheSession: "namespace-b" };
  expect(outboxDisk.admit(next)).toBe(false);
  expect(next.payload.attachments[0]?.contentBase64).toBe("aGVsbG8=");
});

it("rehydrates a failed fallback Page send with raw owner text, context, uploaded ids and the same retry nonce", async () => {
  const raw = "[https://owner.example/report](page:manual)\nPlease read this.";
  const original = attempt();
  original.artifactIds.clear();
  original.payload.displayText = `[Plan](page:page-a)\n${raw}`;
  original.payload.plan = resolveComposerSendPlan({
    text: raw,
    mentions: [],
    hasAttachments: true,
  });
  original.payload.pageContext = { pageId: "page-a" };
  expect(outboxDisk.admit(original)).toBe(true);
  await outboxDisk.hydrate(original);
  let sends = 0;
  const calls: Array<{ proc: string; body: unknown }> = [];
  const request = async <T>(proc: string, body: unknown): Promise<T> => {
    calls.push({ proc, body });
    if (proc === "artifacts/create") return { id: "uploaded-a" } as T;
    sends += 1;
    if (sends === 1) throw new Error("Connection lost before receipt");
    return { seq: 42 } as T;
  };
  await expect(deliverSend(original.payload, original, request)).rejects.toThrow("Connection lost");
  original.state = "failed";
  outboxDisk.save([original]);
  const stored = JSON.parse(files.get("cache/outbox/sends-v4.json")!);
  expect(stored[0].payload).toMatchObject({
    displayText: `[Plan](page:page-a)\n${raw}`,
    plan: { trimmed: raw },
    pageContext: { pageId: "page-a" },
  });
  const [restored] = outboxDisk.load(2, scope);
  expect(restored?.clientNonce).toBe(original.clientNonce);
  expect(restored?.state).toBe("failed");
  await outboxDisk.hydrate(restored!);
  expect(await deliverSend(restored!.payload, restored!, request)).toBe(42);
  expect(calls.filter(({ proc }) => proc === "artifacts/create")).toHaveLength(1);
  const requests = calls.filter(({ proc }) => proc === "threads/send");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[1]!.body).toMatchObject({
    clientNonce: original.clientNonce,
    text: raw,
    pageContext: { pageId: "page-a" },
    artifactIds: ["uploaded-a"],
  });
});

it.each([null, { pageId: "" }, { pageId: "page-a", title: "forged" }])(
  "does not restore malformed or client-supplied Page metadata %j",
  (pageContext) => {
    const original = attempt();
    expect(outboxDisk.admit(original)).toBe(true);
    outboxDisk.save([original]);
    const stored = JSON.parse(files.get("cache/outbox/sends-v4.json")!);
    stored[0].payload.pageContext = pageContext;
    files.set("cache/outbox/sends-v4.json", JSON.stringify(stored));
    expect(outboxDisk.load(2, scope)).toEqual([]);
  },
);

it("restores an ordinary hand-written leading Page link without inventing context", async () => {
  const original = attempt();
  const raw = "[https://owner.example/report](page:manual)\nPlease read this.";
  original.payload.displayText = raw;
  original.payload.plan = resolveComposerSendPlan({
    text: raw,
    mentions: [],
    hasAttachments: true,
  });
  expect(outboxDisk.admit(original)).toBe(true);
  original.state = "failed";
  outboxDisk.save([original]);
  const [restored] = outboxDisk.load(2, scope);
  expect(restored!.payload.pageContext).toBeUndefined();
  const sent: unknown[] = [];
  const request = async <T>(proc: string, body: unknown): Promise<T> => {
    if (proc === "threads/send") sent.push(body);
    return { seq: 43 } as T;
  };
  await deliverSend(restored!.payload, restored!, request);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ text: raw, pageContext: undefined });
});

it.each([{ trimmed: null }, { trimmed: 3 }, { shouldSend: "yes" }, { shouldRunRoutines: null }])(
  "rejects a malformed wire plan rather than replaying partial Page context %j",
  (plan) => {
    const original = attempt();
    original.payload.pageContext = { pageId: "page-a" };
    expect(outboxDisk.admit(original)).toBe(true);
    outboxDisk.save([original]);
    const stored = JSON.parse(files.get("cache/outbox/sends-v4.json")!);
    Object.assign(stored[0].payload.plan, plan);
    files.set("cache/outbox/sends-v4.json", JSON.stringify(stored));
    expect(outboxDisk.load(2, scope)).toEqual([]);
  },
);
