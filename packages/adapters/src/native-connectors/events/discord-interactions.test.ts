import { generateKeyPairSync, sign } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, expect, it, vi } from "vitest";
import { ingestDiscordRoutine } from "./discord-interactions.js";

const APP = "223456789012345678",
  GUILD = "323456789012345678",
  CHANNEL = "423456789012345678",
  COMMAND = "523456789012345678",
  USER = "623456789012345678";
function fixture(type = 2) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"),
    key = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const id = (((BigInt(Date.now()) - 1420070400000n) << 22n) + 1n).toString();
  const body = {
    type,
    id,
    application_id: APP,
    guild_id: GUILD,
    channel_id: CHANNEL,
    token: "fixture-interaction-token-never-retained",
    member: { user: { id: USER } },
    data: {
      id: COMMAND,
      type: 1,
      name: "review",
      options: [{ name: "topic", type: 3, value: "fixture untrusted argument" }],
    },
  };
  const raw = new TextEncoder().encode(` \n${JSON.stringify(body)}\n`),
    timestamp = String(Math.floor(Date.now() / 1000)),
    signature = sign(
      null,
      Buffer.concat([Buffer.from(timestamp), Buffer.from(raw)]),
      privateKey,
    ).toString("hex"),
    headers = new Headers({ "x-signature-ed25519": signature, "x-signature-timestamp": timestamp });
  const authority = {
    connectionId: "connection",
    userId: "owner",
    spaceId: "space",
    configRevision: 2,
    grantId: "grant",
    authGeneration: 3,
    authorizationRevision: "authorization",
    principal: {
      actorType: "bot",
      credentialType: "bot_token",
      scopeAuthority: "provider_enforced",
      applicationId: APP,
      interactionPublicKey: key,
      boundSpaceId: "space",
    },
    config: {
      actor: "bot",
      scopes: [],
      capabilities: ["commands"],
      knowledgeBaseIds: [],
      boundSpaceId: "space",
      tenantId: GUILD,
      targetIds: [CHANNEL],
    },
  };
  const target = {
    ...authority,
    id: "trigger",
    version: 4,
    spec: {
      kind: "discord.command.invoked",
      guildId: GUILD,
      channelId: CHANNEL,
      commandId: COMMAND,
      commandName: "review",
    },
  };
  const query = vi.fn().mockResolvedValueOnce([authority]).mockResolvedValueOnce([target]);
  const prisma = { $queryRaw: query } as unknown as PrismaClient,
    enqueue = vi.fn(async (_job: unknown) => {});
  return { prisma, enqueue, query, authority, target, body, raw, headers };
}
afterEach(() => vi.unstubAllGlobals());
it("actual Ed25519 PING authenticates against a verified active grant without enqueuing or provider HTTP", async () => {
  const f = fixture(1),
    fetch = vi.fn(() => {
      throw new Error("Provider HTTP must not run before ACK");
    });
  vi.stubGlobal("fetch", fetch);
  await expect(
    ingestDiscordRoutine(f.prisma, { enqueue: f.enqueue }, "config", f.raw, f.headers),
  ).resolves.toEqual({ type: 1 });
  expect(fetch).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.query).toHaveBeenCalledTimes(1);
});
it("signed command ACK is queued within three seconds using only DB + existing durable queue, with no interaction token", async () => {
  const f = fixture(),
    fetch = vi.fn(() => {
      throw new Error("No provider HTTP in the acknowledgement path");
    });
  vi.stubGlobal("fetch", fetch);
  const start = performance.now();
  const result = await ingestDiscordRoutine(
    f.prisma,
    { enqueue: f.enqueue },
    "config",
    f.raw,
    f.headers,
  );
  expect(result).toEqual({ type: 4, data: { content: "Routine queued.", flags: 64 } });
  expect(performance.now() - start).toBeLessThan(3000);
  expect(fetch).not.toHaveBeenCalled();
  const job = f.enqueue.mock.calls[0]![0];
  expect(job).toMatchObject({
    name: "native.discord.signal",
    payload: {
      triggerId: "trigger",
      triggerVersion: 4,
      configId: "config",
      configRevision: 2,
      userId: "owner",
      spaceId: "space",
      grantId: "grant",
      authGeneration: 3,
      interaction: { applicationId: APP, commandId: COMMAND, commandName: "review" },
    },
  });
  expect(JSON.stringify(job)).not.toContain("fixture-interaction-token-never-retained");
  expect(JSON.stringify(job)).not.toContain("x-signature");
  expect(JSON.stringify(job)).not.toContain("interactionPublicKey");
});
it("a queued acknowledgement waits until durable enqueue actually succeeds", async () => {
  const f = fixture();
  let resolve!: () => void;
  f.enqueue.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  let settled = false;
  const result = ingestDiscordRoutine(
    f.prisma,
    { enqueue: f.enqueue },
    "config",
    f.raw,
    f.headers,
  ).then((value) => {
    settled = true;
    return value;
  });
  await vi.waitFor(() => expect(f.enqueue).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false);
  resolve();
  await expect(result).resolves.toMatchObject({ type: 4, data: { content: "Routine queued." } });
});
it("queue rejection never returns a successful queued receipt", async () => {
  const f = fixture();
  f.enqueue.mockRejectedValue(new Error("queue unavailable"));
  await expect(
    ingestDiscordRoutine(f.prisma, { enqueue: f.enqueue }, "config", f.raw, f.headers),
  ).rejects.toThrow("queue unavailable");
});
it.each(["wrong signature", "missing signature", "raw byte edit", "expired timestamp"])(
  "rejects %s before any command job",
  async (mode) => {
    const f = fixture();
    if (mode === "wrong signature") f.headers.set("x-signature-ed25519", "0".repeat(128));
    if (mode === "missing signature") f.headers.delete("x-signature-ed25519");
    if (mode === "expired timestamp") f.headers.set("x-signature-timestamp", "1");
    const raw = mode === "raw byte edit" ? new Uint8Array([...f.raw, 32]) : f.raw;
    await expect(
      ingestDiscordRoutine(f.prisma, { enqueue: f.enqueue }, "config", raw, f.headers),
    ).rejects.toMatchObject({ kind: "authorization_required" });
    expect(f.enqueue).not.toHaveBeenCalled();
  },
);
it.each(["guild", "channel", "capability", "bound space"])(
  "an active verified application still refuses an unconfigured %s",
  async (mode) => {
    const f = fixture();
    if (mode === "guild") f.authority.config.tenantId = "999999";
    if (mode === "channel") f.authority.config.targetIds = [];
    if (mode === "capability") f.authority.config.capabilities = [];
    if (mode === "bound space") f.authority.principal.boundSpaceId = "other";
    await expect(
      ingestDiscordRoutine(f.prisma, { enqueue: f.enqueue }, "config", f.raw, f.headers),
    ).rejects.toMatchObject({ kind: "authorization_required" });
    expect(f.enqueue).not.toHaveBeenCalled();
  },
);
it("only explicitly configured targets fan out; unmatched or another Space/account/application is never run", async () => {
  const f = fixture();
  f.query
    .mockReset()
    .mockResolvedValueOnce([f.authority])
    .mockResolvedValueOnce([
      { ...f.target, spaceId: "other-space" },
      { ...f.target, spec: { ...f.target.spec, commandId: "999999" } },
      { ...f.target, principal: { ...f.target.principal, applicationId: "999999" } },
    ]);
  await expect(
    ingestDiscordRoutine(f.prisma, { enqueue: f.enqueue }, "config", f.raw, f.headers),
  ).resolves.toMatchObject({
    type: 4,
    data: { content: "No Routine is enabled for this command here." },
  });
  expect(f.enqueue).not.toHaveBeenCalled();
});
it("permanent source keys distinguish exact explicit Routines while retrying one interaction keeps its stable identity", async () => {
  const f = fixture();
  f.query.mockReset().mockResolvedValue([f.authority]);
  f.query
    .mockResolvedValueOnce([f.authority])
    .mockResolvedValueOnce([f.target, { ...f.target, id: "trigger-2" }]);
  await ingestDiscordRoutine(f.prisma, { enqueue: f.enqueue }, "config", f.raw, f.headers);
  expect(f.enqueue).toHaveBeenCalledTimes(2);
  const keys = f.enqueue.mock.calls.map(([job]) => (job as { replaceKey: string }).replaceKey);
  expect(keys[0]).not.toBe(keys[1]);
});
