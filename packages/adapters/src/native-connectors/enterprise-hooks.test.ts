import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import type { NativeAppConfig, PrismaClient } from "@rakazo/db";
import { describe, it } from "vitest";
import type { NativeConfigStore } from "./config.js";
import { NativeEnterpriseHookStore } from "./enterprise-hooks.js";

const key = Buffer.alloc(32, 11),
  clientId = "suite-fixture",
  verificationToken = "fixture-verify",
  encryptionKey = key.toString("base64").slice(0, -1),
  issuedAt = Math.floor(Date.now() / 1000),
  stamp = String(issuedAt),
  ownerSecret = JSON.stringify({
    version: 1,
    clientSecret: "fixture-secret",
    verificationToken,
    encryptionKey,
  });
function payload(kind: string, extra = "", receiver = clientId) {
  const body = `<xml><SuiteId>${receiver}</SuiteId><InfoType>${kind}</InfoType><TimeStamp>${stamp}</TimeStamp>${extra}</xml>`,
    raw = Buffer.from(body),
    size = Buffer.alloc(4);
  size.writeUInt32BE(raw.length);
  let plain = Buffer.concat([Buffer.alloc(16, 8), size, raw, Buffer.from(receiver)]);
  const n = 32 - (plain.length % 32);
  plain = Buffer.concat([plain, Buffer.alloc(n, n)]);
  const c = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  c.setAutoPadding(false);
  const encrypted = Buffer.concat([c.update(plain), c.final()]).toString("base64"),
    nonce = "fixture-nonce";
  return {
    rawBody: `<xml><Encrypt>${encrypted}</Encrypt></xml>`,
    query: {
      timestamp: stamp,
      nonce,
      msg_signature: createHash("sha1")
        .update([verificationToken, stamp, nonce, encrypted].sort().join(""))
        .digest("hex"),
    },
  };
}
interface Grant {
  id: string;
  configId: string;
  configRevision: number;
  tenant: string;
  createdAt: Date;
  revokedAt: Date | null;
  secretId: string | null;
  userId: string;
  spaceId: string;
  authGeneration: number;
  refreshLeaseId: string | null;
}
function setup() {
  const cfg = {
    id: "config-fixture",
    appId: "wecom",
    credentialKind: "oauth",
    enabled: true,
    revision: 3,
    config: {
      clientId,
      actor: "app",
      scopes: [],
      capabilities: [],
      knowledgeBaseIds: [],
      agentId: "1000001",
    },
  } as unknown as NativeAppConfig;
  const grants: Grant[] = [];
  const removed: string[] = [],
    changed: string[] = [],
    tickets: unknown[] = [],
    filters: Record<string, unknown>[] = [];
  let currentRevision = 3,
    txCalls = 0;
  const tx = {
    $queryRaw: async () => [],
    nativeAppConfig: {
      findFirst: async ({ where }: { where: { revision: number } }) =>
        where.revision === currentRevision ? cfg : null,
    },
    nativeOAuthGrant: {
      findMany: async ({
        where,
      }: {
        where: {
          configId: string;
          configRevision: number;
          tenant: string;
          createdAt: { lt: Date };
        };
      }) => {
        filters.push(where);
        return grants
          .filter(
            (g) =>
              g.configId === where.configId &&
              g.configRevision === where.configRevision &&
              g.tenant === where.tenant &&
              !g.revokedAt &&
              g.createdAt < where.createdAt.lt,
          )
          .map((g) => structuredClone(g));
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { revokedAt: Date; authGeneration: { increment: number } };
      }) => {
        const grant = grants.find((g) => g.id === where.id && !g.revokedAt);
        if (!grant) return { count: 0 };
        assert.equal(data.authGeneration.increment, 1);
        Object.assign(grant, data, { authGeneration: grant.authGeneration + 1 });
        return { count: 1 };
      },
    },
    connection: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { oauthGrantId: string; status: string };
        data: { status: string };
      }) => {
        assert.equal(where.status, "connected");
        assert.equal(data.status, "error");
        changed.push(where.oauthGrantId);
        return { count: 1 };
      },
    },
    secret: {
      deleteMany: async ({ where }: { where: { id: string; userId: string; spaceId: string } }) => {
        const grant = grants.find((g) => g.id === where.id.replace("secret-", ""));
        assert.equal(where.userId, grant?.userId);
        assert.equal(where.spaceId, grant?.spaceId);
        removed.push(where.id);
        return { count: 1 };
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (v: typeof tx) => Promise<unknown>) => {
      txCalls++;
      return fn(tx);
    },
  } as unknown as PrismaClient;
  const configs = {
    forEnterpriseCallback: async () => cfg,
    credential: async () => ownerSecret,
    recordEnterpriseTicket: async (...args: unknown[]) => {
      assert.equal(args[2], 3);
      if (currentRevision !== 3) throw Error("configuration changed");
      tickets.push(args);
    },
  } as unknown as NativeConfigStore;
  const hook = new NativeEnterpriseHookStore(prisma, configs);
  function grant(id: string, extra: Partial<Grant> = {}) {
    const g: Grant = {
      id,
      configId: cfg.id,
      configRevision: 3,
      tenant: "corp-fixture",
      createdAt: new Date((issuedAt - 10) * 1000),
      revokedAt: null,
      secretId: `secret-${id}`,
      userId: `user-${id}`,
      spaceId: `space-${id}`,
      authGeneration: 1,
      refreshLeaseId: "fixture-lease",
      ...extra,
    };
    grants.push(g);
    return g;
  }
  return {
    hook,
    cfg,
    grant,
    grants,
    removed,
    changed,
    tickets,
    filters,
    setRevision: (v: number) => {
      currentRevision = v;
    },
    get txCalls() {
      return txCalls;
    },
  };
}
describe("Native enterprise hooks with actual synthetic supplier crypto", () => {
  it("verified suite ticket forwards exact application and captured config revision to CAS", async () => {
    const s = setup();
    const result = await s.hook.accept(
      s.cfg.id,
      payload("suite_ticket", "<SuiteTicket>fixture-ticket</SuiteTicket>"),
      AbortSignal.timeout(1000),
    );
    assert.equal(result.type, "ticket");
    assert.equal(s.tickets.length, 1);
    const args = s.tickets[0] as unknown[];
    assert.equal(args[0], s.cfg.id);
    assert.equal(args[1], clientId);
    assert.deepEqual(args[3], { platform: "wecom", value: "fixture-ticket", issuedAt });
    assert.equal(s.txCalls, 0);
  });
  it("ticket authenticated under an old revision cannot update a new config", async () => {
    const s = setup();
    s.setRevision(4);
    await assert.rejects(
      s.hook.accept(
        s.cfg.id,
        payload("suite_ticket", "<SuiteTicket>fixture-ticket</SuiteTicket>"),
        AbortSignal.timeout(1000),
      ),
    );
    assert.equal(s.tickets.length, 0);
  });
  it("invalid signature never reaches DB grant mutation or ticket persistence", async () => {
    const s = setup(),
      input = payload("cancel_auth", "<AuthCorpId>corp-fixture</AuthCorpId>");
    input.query.msg_signature = "0".repeat(40);
    await assert.rejects(s.hook.accept(s.cfg.id, input, AbortSignal.timeout(1000)));
    assert.equal(s.txCalls, 0);
    assert.equal(s.tickets.length, 0);
  });
  it("signed create_auth is acknowledged as facts without manufacturing a member grant", async () => {
    const s = setup();
    const result = await s.hook.accept(
      s.cfg.id,
      payload("create_auth", "<AuthCode>fixture-code</AuthCode>"),
      AbortSignal.timeout(1000),
    );
    assert.equal(result.type, "installation");
    assert.equal(s.txCalls, 0);
    assert.equal(s.tickets.length, 0);
  });
  for (const kind of ["cancel_auth", "change_auth"])
    it(`${kind} retires exact corp/config revision and preserves a newer reconnect or another corp`, async () => {
      const s = setup(),
        old = s.grant("old"),
        newer = s.grant("newer", { createdAt: new Date((issuedAt + 1) * 1000) }),
        other = s.grant("other", { tenant: "other-corp" }),
        oldRevision = s.grant("oldRevision", { configRevision: 2 });
      const result = await s.hook.accept(
        s.cfg.id,
        payload(kind, "<AuthCorpId>corp-fixture</AuthCorpId>"),
        AbortSignal.timeout(1000),
      );
      assert.equal(result.type, "installation");
      assert.ok(old.revokedAt);
      assert.equal(old.secretId, null);
      assert.equal(old.refreshLeaseId, null);
      assert.equal(old.authGeneration, 2);
      assert.equal(newer.revokedAt, null);
      assert.equal(other.revokedAt, null);
      assert.equal(oldRevision.revokedAt, null);
      assert.deepEqual(s.removed, ["secret-old"]);
      assert.deepEqual(s.changed, ["old"]);
      assert.equal(s.filters[0]?.configRevision, 3);
    });
  it("provider second includes a grant created at +500ms and preserves next-second reauthorization", async () => {
    const s = setup(),
      same = s.grant("same-second", { createdAt: new Date(issuedAt * 1000 + 500) }),
      later = s.grant("next-second", { createdAt: new Date((issuedAt + 1) * 1000) });
    await s.hook.accept(
      s.cfg.id,
      payload("cancel_auth", "<AuthCorpId>corp-fixture</AuthCorpId>"),
      AbortSignal.timeout(1000),
    );
    assert.ok(same.revokedAt);
    assert.equal(later.revokedAt, null);
    assert.deepEqual(s.removed, ["secret-same-second"]);
  });
  it("replayed cancel cannot increment retired generations or delete a reconnect secret", async () => {
    const s = setup(),
      old = s.grant("old"),
      input = payload("cancel_auth", "<AuthCorpId>corp-fixture</AuthCorpId>");
    await s.hook.accept(s.cfg.id, input, AbortSignal.timeout(1000));
    s.grant("reconnect", { createdAt: new Date((issuedAt + 1) * 1000) });
    await s.hook.accept(s.cfg.id, input, AbortSignal.timeout(1000));
    assert.equal(old.authGeneration, 2);
    assert.deepEqual(s.removed, ["secret-old"]);
    assert.deepEqual(s.changed, ["old"]);
  });
  it("config revision changes between signature verification and transaction fence abort mutation", async () => {
    const s = setup(),
      g = s.grant("old");
    s.setRevision(4);
    await assert.rejects(
      s.hook.accept(
        s.cfg.id,
        payload("cancel_auth", "<AuthCorpId>corp-fixture</AuthCorpId>"),
        AbortSignal.timeout(1000),
      ),
    );
    assert.equal(g.revokedAt, null);
    assert.equal(s.removed.length, 0);
  });
  it("cancel without exact authenticated corp is rejected", async () => {
    const s = setup();
    await assert.rejects(
      s.hook.accept(s.cfg.id, payload("cancel_auth"), AbortSignal.timeout(1000)),
    );
    assert.equal(s.txCalls, 0);
  });
});
