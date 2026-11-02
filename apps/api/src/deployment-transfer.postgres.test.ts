import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretStore } from "@rakazo/adapter-kit";
import { createDeploymentTransferPeer, EncryptedSecretStore } from "@rakazo/adapters";
import type { Actor, DeploymentTransferStatus } from "@rakazo/contracts";
import { createDb, type Prisma } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";
import { cleanupOrphanedTransfers } from "./deployment-transfer-cleanup.js";

const enabled =
  process.env.VERIFY_DATABASE === "1" &&
  process.env.DATABASE_URL &&
  process.env.DEPLOYMENT_TRANSFER_PEER_DATABASE_URL;
const postgres = enabled ? describe.sequential : describe.skip;
type Account = { cookie: string; actor: Actor; botId: string; email: string };
type Side = {
  origin: string;
  database: ReturnType<typeof createDb>;
  handles: Awaited<ReturnType<typeof createApp>>;
  secrets: SecretStore;
  dataDir: string;
};

postgres(
  "One-time transfer through real authenticated HTTP and two independent PostgreSQL databases",
  () => {
    let source: Side;
    let target: Side;
    let loseGrantAck = false;
    let loseItemAck = false;
    let loseCancelAck = false;
    let failPeerStatus = false;
    let failInlinePut = false;
    let remoteMode = false;
    let loseRemotePutAck = false;
    let remoteVisible = true;
    let loseDeleteAck = false;
    let beforeTargetPut: (() => Promise<void>) | undefined;
    let afterSourceLoad: (() => Promise<void>) | undefined;
    const remote = new Map<string, string>();
    const targetPuts = vi.fn();
    const sourceLoads = vi.fn();
    const targetDeletes = vi.fn();
    const users: Array<{ side: Side; userId: string; organizationId: string }> = [];
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (
        failPeerStatus &&
        request.url.startsWith(target.origin) &&
        request.url.endsWith("/status")
      )
        throw new Error("Synthetic peer status unavailable");
      const destination = request.url.startsWith(source.origin)
        ? source
        : request.url.startsWith(target.origin)
          ? target
          : undefined;
      if (!destination) throw new Error("Unexpected external endpoint");
      const response = await destination.handles.app.request(request);
      if (request.url.endsWith("/grant") && loseGrantAck) {
        loseGrantAck = false;
        throw new Error("Synthetic lost grant acknowledgement");
      }
      if (request.url.endsWith("/item") && loseItemAck) {
        loseItemAck = false;
        throw new Error("Synthetic lost item acknowledgement");
      }
      if (request.url.endsWith("/cancel") && loseCancelAck) {
        loseCancelAck = false;
        throw new Error("Synthetic cancel acknowledgement lost");
      }
      return response;
    });
    const remoteRef = (recordId: string) => `fixture-remote:${recordId}`;
    const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
    function fixtureStore(key: string, receiving: boolean): SecretStore {
      const inline = new EncryptedSecretStore(key);
      return {
        describe: () => inline.describe(),
        onChange: (listener) => inline.onChange(listener),
        start: () => inline.start(),
        close: () => inline.close(),
        redact: (value) => inline.redact(value),
        prepareWrite: (id, options) =>
          receiving && remoteMode && !options?.ephemeral ? remoteRef(id) : inline.prepareWrite(id),
        resourceIdentity: (ref, context) =>
          ref.startsWith("fixture-remote:")
            ? {
                kind: "external",
                fingerprint: fingerprint(ref),
                deletionKeyFingerprint: fingerprint(ref.split("?")[0]!),
              }
            : inline.resourceIdentity(ref, context),
        reconcileWrite: async (ref, context) =>
          ref.startsWith("fixture-remote:")
            ? remoteVisible && remote.has(ref)
              ? { state: "found", ref }
              : { state: "unknown" }
            : inline.reconcileWrite(ref, context),
        load: async (ref, context) => {
          const recordId = typeof context === "string" ? context : context.recordId;
          const credentialLoad =
            !receiving &&
            !recordId.startsWith("deployment-identity:") &&
            !recordId.startsWith("transfer-grant:");
          if (credentialLoad) sourceLoads(ref);
          if (ref.startsWith("fixture-remote:")) {
            const value = remote.get(ref);
            if (value === undefined) throw new Error("Not available");
            if (credentialLoad) await afterSourceLoad?.();
            return value;
          }
          const value = await inline.load(ref, context);
          if (credentialLoad) await afterSourceLoad?.();
          return value;
        },
        put: async (value, context, options) => {
          if (receiving && !options?.ephemeral) {
            targetPuts();
            await beforeTargetPut?.();
            if (failInlinePut) {
              failInlinePut = false;
              throw new Error("Synthetic pre-seal interruption");
            }
            if (remoteMode) {
              const ref = options?.recoveryRef ?? remoteRef(options?.recordId ?? "missing");
              remote.set(ref, value);
              if (loseRemotePutAck) {
                loseRemotePutAck = false;
                throw new Error("Synthetic remote acknowledgement lost");
              }
              return { id: options!.recordId!, ciphertext: ref, ref };
            }
          }
          return inline.put(value, context, options);
        },
        delete: async (ref, context) => {
          if (receiving) targetDeletes(ref);
          if (ref.startsWith("fixture-remote:")) remote.delete(ref);
          else await inline.delete(ref, context);
          if (receiving && loseDeleteAck) {
            loseDeleteAck = false;
            throw new Error("Synthetic delete acknowledgement lost");
          }
        },
      };
    }
    async function makeSide(
      origin: string,
      databaseUrl: string,
      receiving: boolean,
    ): Promise<Side> {
      const database = createDb(databaseUrl);
      const dataDir = await mkdtemp(join(tmpdir(), "transfer-http-"));
      const secrets = fixtureStore(`independent-offline-master-key-${receiving}`, receiving);
      const handles = await createApp({
        prisma: database.prisma,
        databaseUrl,
        dataDir,
        secretStore: secrets,
        encryptionKey: `independent-offline-auth-key-${receiving}`,
        webOrigin: origin,
        authUrl: origin,
        sandboxProvider: "fake",
        agentRuntime: "scripted",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        signupAllowlist: "",
        deploymentTransferPeer: createDeploymentTransferPeer({
          fetch: transport as typeof fetch,
          resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
        }),
        remoteConnectors: {
          fetch: async () => {
            throw new Error("Unrelated outbound request");
          },
          resolveHostname: async () => [],
        },
      });
      return { origin, database, handles, secrets, dataDir };
    }
    async function raw(
      side: Side,
      account: Account,
      method: string,
      input: unknown,
      spaceId = account.actor.spaceId,
    ) {
      return side.handles.app.request(`/rpc/transfer/${method}`, {
        method: "POST",
        headers: {
          origin: side.origin,
          "content-type": "application/json",
          cookie: account.cookie,
          ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
        },
        body: JSON.stringify({ json: input }),
      });
    }
    async function call<T = DeploymentTransferStatus>(
      side: Side,
      account: Account,
      method: string,
      input: unknown,
    ): Promise<T> {
      const response = await raw(side, account, method, input);
      const body = (await response.json()) as { json: T };
      expect(response.status, JSON.stringify(body)).toBe(200);
      return body.json;
    }
    async function account(side: Side): Promise<Account> {
      const email = `${randomUUID()}@example.test`;
      const response = await side.handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { origin: side.origin, "content-type": "application/json" },
        body: JSON.stringify({ email, password: "offline-password-123", name: "Transfer fixture" }),
      });
      expect(response.status).toBe(200);
      const cookie = sessionCookieHeader(response);
      const me = await side.handles.app.request("/rpc/me", {
        method: "POST",
        headers: { origin: side.origin, "content-type": "application/json", cookie },
        body: JSON.stringify({ json: {} }),
      });
      const actor = ((await me.json()) as { json: Actor }).json;
      const bot = await side.database.prisma.bot.create({
        data: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          name: "Transfer Bot",
          color: "blue",
        },
      });
      users.push({
        side,
        userId: actor.userId,
        organizationId: (
          await side.database.prisma.space.findUniqueOrThrow({ where: { id: actor.spaceId } })
        ).organizationId,
      });
      return { cookie, actor, botId: bot.id, email };
    }
    async function credential(
      side: Side,
      owner: Account,
      name: string,
      value: string,
      auth: Prisma.InputJsonValue = { type: "bearer" },
    ) {
      const id = randomUUID();
      const stored = await side.secrets.put(
        value,
        {
          userId: owner.actor.userId,
          spaceId: owner.actor.spaceId,
          operationId: "fixture",
          traceId: "fixture",
          signal: new AbortController().signal,
        },
        { recordId: id },
      );
      return side.database.prisma.botSecret.create({
        data: {
          id,
          userId: owner.actor.userId,
          spaceId: owner.actor.spaceId,
          botId: owner.botId,
          name,
          origin: "https://service.example",
          auth,
          ciphertext: stored.ciphertext,
        },
      });
    }
    async function pair(
      options: {
        names?: string[];
        sourceOwner?: Account;
        targetOwner?: Account;
        overwrite?: string[];
        login?: boolean;
        selectedNames?: string[];
      } = {},
    ) {
      const s = options.sourceOwner ?? (await account(source));
      const t = options.targetOwner ?? (await account(target));
      for (const name of options.names ?? ["api_key"])
        await credential(
          source,
          s,
          name,
          options.login
            ? JSON.stringify({
                username: "private-login-user",
                password: "private-login-password",
                totp: "excluded-totp",
                onePassword: "excluded-vault",
              })
            : `protected-value-${name}`,
          options.login ? { type: "login" } : { type: "bearer" },
        );
      let receiving = await call(target, t, "start", {
        targetBotId: t.botId,
        sourceOrigin: source.origin,
        clientNonce: randomUUID(),
      });
      let sending = await call(source, s, "preview", {
        mode: "source",
        targetOrigin: target.origin,
        locator: receiving.transferId,
        sourceBotId: s.botId,
        clientNonce: randomUUID(),
      });
      sending = await call(source, s, "propose", {
        transferId: sending.transferId,
        expectedRevision: sending.revision,
        selected: sending.candidates
          .filter((item) => !options.selectedNames || options.selectedNames.includes(item.name))
          .map(({ itemKey, revision }) => ({ itemKey, revision })),
      });
      receiving = await call(target, t, "status", { transferId: receiving.transferId });
      receiving = await call(target, t, "preview", {
        mode: "target",
        transferId: receiving.transferId,
        expectedRevision: receiving.revision,
        decisions: receiving.items
          .filter((item) => options.overwrite?.includes(item.name))
          .map(({ itemKey }) => ({ itemKey, action: "overwrite" })),
      });
      receiving = await call(target, t, "approve", {
        transferId: receiving.transferId,
        expectedRevision: receiving.revision,
        planDigest: receiving.planDigest,
        expectedSourceFingerprint: receiving.source!.fingerprint,
      });
      sending = await call(source, s, "status", { transferId: sending.transferId });
      return { s, t, sending, receiving, nonce: randomUUID() };
    }
    const commit = (p: Awaited<ReturnType<typeof pair>>) =>
      call(source, p.s, "commit", {
        transferId: p.sending.transferId,
        expectedRevision: p.sending.revision,
        planDigest: p.sending.planDigest,
        expectedTargetFingerprint: p.sending.target.fingerprint,
        clientNonce: p.nonce,
      });
    const targetRows = (p: Awaited<ReturnType<typeof pair>>) =>
      target.database.prisma.botSecret.findMany({ where: { botId: p.t.botId } });
    async function share(side: Side, owner: Account, member: Account) {
      const space = await side.database.prisma.space.findUniqueOrThrow({
        where: { id: owner.actor.spaceId },
      });
      await side.database.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: space.organizationId,
          userId: member.actor.userId,
          role: "member",
          createdAt: new Date(),
        },
      });
      await side.database.prisma.spaceMember.upsert({
        where: { spaceId_userId: { spaceId: space.id, userId: member.actor.userId } },
        update: { role: "member" },
        create: {
          id: randomUUID(),
          organizationId: space.organizationId,
          spaceId: space.id,
          userId: member.actor.userId,
          role: "member",
          createdAt: new Date(),
        },
      });
      const bot = await side.database.prisma.bot.create({
        data: { userId: member.actor.userId, spaceId: space.id, name: "Member Bot", color: "blue" },
      });
      return { ...member, botId: bot.id, actor: { ...member.actor, spaceId: space.id } };
    }
    beforeAll(async () => {
      expect(new URL(process.env.DATABASE_URL!).pathname).not.toBe(
        new URL(process.env.DEPLOYMENT_TRANSFER_PEER_DATABASE_URL!).pathname,
      );
      source = await makeSide("https://source.transfer.example", process.env.DATABASE_URL!, false);
      target = await makeSide(
        "https://target.transfer.example",
        process.env.DEPLOYMENT_TRANSFER_PEER_DATABASE_URL!,
        true,
      );
    });
    afterEach(() => {
      loseGrantAck = false;
      loseItemAck = false;
      loseCancelAck = false;
      failPeerStatus = false;
      failInlinePut = false;
      remoteMode = false;
      loseRemotePutAck = false;
      remoteVisible = true;
      beforeTargetPut = undefined;
      afterSourceLoad = undefined;
      targetPuts.mockClear();
      sourceLoads.mockClear();
      targetDeletes.mockClear();
      loseDeleteAck = false;
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      for (const side of [source, target].filter(Boolean)) {
        const own = users.filter((user) => user.side === side);
        await side.database.prisma.organization.deleteMany({
          where: { id: { in: own.map((user) => user.organizationId) } },
        });
        await side.database.prisma.user.deleteMany({
          where: { id: { in: own.map((user) => user.userId) } },
        });
        await side.handles.stop();
        await side.database.pool.end();
        await rm(side.dataDir, { recursive: true, force: true });
      }
    });
    it("copies through independent identities and keys while preserving every source row", async () => {
      const p = await pair();
      const before = await source.database.prisma.botSecret.findMany({
        where: { botId: p.s.botId },
      });
      const result = await commit(p);
      expect(result.phase).toBe("completed");
      expect(result.items[0]!.status).toBe("copied");
      const rows = await targetRows(p);
      expect(await target.secrets.load(rows[0]!.ciphertext, rows[0]!.id)).toBe(
        "protected-value-api_key",
      );
      expect(
        await source.database.prisma.botSecret.findMany({ where: { botId: p.s.botId } }),
      ).toEqual(before);
      expect(result.source!.fingerprint).not.toBe(result.target.fingerprint);
      expect(targetPuts).toHaveBeenCalledTimes(1);
    });
    it("projects legacy login JSON to username/password without metadata or excluded fields", async () => {
      const p = await pair({ login: true });
      expect(JSON.stringify(p.sending)).not.toMatch(/private-login|excluded-/);
      const result = await commit(p);
      expect(result.items[0]!.reason).toBe("login_password_only");
      const [row] = await targetRows(p);
      expect(JSON.parse(await target.secrets.load(row!.ciphertext, row!.id))).toEqual({
        username: "private-login-user",
        password: "private-login-password",
      });
      const original = await source.database.prisma.botSecret.findFirstOrThrow({
        where: { botId: p.s.botId },
      });
      expect(await source.secrets.load(original.ciphertext, original.id)).toContain(
        "excluded-totp",
      );
      expect(JSON.stringify(result)).not.toMatch(/private-login|excluded-/);
    });
    it("keeps a target conflict by default and copies an independent new item", async () => {
      const t = await account(target);
      const old = await credential(target, t, "keep", "old-target");
      targetPuts.mockClear();
      const p = await pair({ targetOwner: t, names: ["keep", "new"] });
      const result = await commit(p);
      expect(result.items.map((item) => item.status).sort()).toEqual(["copied", "kept"]);
      expect(
        (await target.database.prisma.botSecret.findUniqueOrThrow({ where: { id: old.id } }))
          .ciphertext,
      ).toBe(old.ciphertext);
      expect(targetPuts).toHaveBeenCalledTimes(1);
    });
    it("settles an entirely kept plan on both deployments without reading or writing credentials", async () => {
      const t = await account(target);
      const existing = await credential(target, t, "api_key", "keep-target-value");
      targetPuts.mockClear();
      sourceLoads.mockClear();
      const p = await pair({ targetOwner: t });
      const result = await commit(p);
      expect(result.phase).toBe("completed");
      expect(result.items[0]!.status).toBe("kept");
      expect((await call(target, t, "status", { transferId: p.receiving.transferId })).phase).toBe(
        "completed",
      );
      expect((await targetRows(p))[0]!.ciphertext).toBe(existing.ciphertext);
      expect(targetPuts).not.toHaveBeenCalled();
      expect(sourceLoads).not.toHaveBeenCalled();
    });
    it("overwrites only the exact approved target revision", async () => {
      const t = await account(target);
      const old = await credential(target, t, "replace", "old-target");
      targetPuts.mockClear();
      const p = await pair({ targetOwner: t, names: ["replace"], overwrite: ["replace"] });
      const result = await commit(p);
      expect(result.items[0]!.status).toBe("copied");
      const row = await target.database.prisma.botSecret.findUniqueOrThrow({
        where: { id: old.id },
      });
      expect(row.revision).not.toBe(old.revision);
      expect(await target.secrets.load(row.ciphertext, row.id)).toBe("protected-value-replace");
    });
    it.each(["same key", "provider URL alias", "unknown provider"])(
      "protects source resources from destructive target overwrite: %s",
      async (variant) => {
        const s = await account(source);
        const t = await account(target);
        const sourceRef =
          variant === "unknown provider"
            ? "unsupported-provider:reserved"
            : "fixture-remote:shared-key";
        const targetRef =
          variant === "provider URL alias"
            ? `${sourceRef}?provider=https://alias.example`
            : sourceRef;
        const sourceId = randomUUID();
        await source.database.prisma.botSecret.create({
          data: {
            id: sourceId,
            userId: s.actor.userId,
            spaceId: s.actor.spaceId,
            botId: s.botId,
            name: "protected",
            origin: "https://service.example",
            auth: { type: "bearer" },
            ciphertext: sourceRef,
          },
        });
        const old = await target.database.prisma.botSecret.create({
          data: {
            id: randomUUID(),
            userId: t.actor.userId,
            spaceId: t.actor.spaceId,
            botId: t.botId,
            name: "protected",
            origin: "https://service.example",
            auth: { type: "bearer" },
            ciphertext: targetRef,
          },
        });
        const p = await pair({
          sourceOwner: s,
          targetOwner: t,
          names: [],
          overwrite: ["protected"],
        });
        expect(p.receiving.plan!.items[0]!.action).toBe("keep");
        expect(p.receiving.plan!.items[0]!.reason).toBe(
          variant === "unknown provider" ? "resource_unknown" : "source_resource_shared",
        );
        expect(JSON.stringify(p.receiving)).not.toContain("fixture-remote");
        await commit(p);
        expect(targetPuts).not.toHaveBeenCalled();
        expect(
          (await target.database.prisma.botSecret.findUniqueOrThrow({ where: { id: old.id } }))
            .ciphertext,
        ).toBe(targetRef);
        expect(
          (await source.database.prisma.botSecret.findUniqueOrThrow({ where: { id: sourceId } }))
            .ciphertext,
        ).toBe(sourceRef);
      },
    );
    it("does not overwrite a target changed after approval", async () => {
      const t = await account(target);
      const old = await credential(target, t, "replace", "old-target");
      const p = await pair({ targetOwner: t, names: ["replace"], overwrite: ["replace"] });
      await target.database.prisma.botSecret.update({
        where: { id: old.id },
        data: { name: "replace" },
      });
      targetPuts.mockClear();
      const result = await commit(p);
      expect(result.items[0]!.status).toBe("conflict");
      expect(result.items[0]!.reason).toBe("target_changed");
      expect(targetPuts).not.toHaveBeenCalled();
      expect((await targetRows(p))[0]!.ciphertext).toBe(old.ciphertext);
    });
    it("protects an unselected source credential from a cross-item target overwrite", async () => {
      const s = await account(source);
      const t = await account(target);
      const protectedRef = "fixture-remote:unselected-shared-key";
      await source.database.prisma.botSecret.create({
        data: {
          id: randomUUID(),
          userId: s.actor.userId,
          spaceId: s.actor.spaceId,
          botId: s.botId,
          name: "unselected",
          origin: "https://service.example",
          auth: { type: "bearer" },
          ciphertext: protectedRef,
        },
      });
      const old = await target.database.prisma.botSecret.create({
        data: {
          id: randomUUID(),
          userId: t.actor.userId,
          spaceId: t.actor.spaceId,
          botId: t.botId,
          name: "selected",
          origin: "https://service.example",
          auth: { type: "bearer" },
          ciphertext: `${protectedRef}?provider=https://alias.example`,
        },
      });
      const p = await pair({
        sourceOwner: s,
        targetOwner: t,
        names: ["selected"],
        selectedNames: ["selected"],
        overwrite: ["selected"],
      });
      expect(p.receiving.plan!.items).toHaveLength(1);
      expect(p.receiving.plan!.items[0]!.reason).toBe("source_resource_shared");
      await commit(p);
      expect(targetPuts).not.toHaveBeenCalled();
      expect(
        (await target.database.prisma.botSecret.findUniqueOrThrow({ where: { id: old.id } }))
          .ciphertext,
      ).toBe(old.ciphertext);
    });
    it("rechecks provider resource admission immediately before dispatch", async () => {
      const t = await account(target);
      await credential(target, t, "replace", "old-target");
      const p = await pair({ targetOwner: t, names: ["replace"], overwrite: ["replace"] });
      const classifier = target.secrets.resourceIdentity!.bind(target.secrets);
      const old = (await targetRows(p))[0]!;
      vi.spyOn(target.secrets, "resourceIdentity").mockImplementation((ref, context) =>
        ref === old.ciphertext ? { kind: "unknown" } : classifier(ref, context),
      );
      targetPuts.mockClear();
      await commit(p);
      expect(targetPuts).not.toHaveBeenCalled();
    });
    it("recovers a lost item response from receipts without another put", async () => {
      const p = await pair();
      loseItemAck = true;
      await commit(p);
      const restored = await call(source, p.s, "status", { transferId: p.sending.transferId });
      expect(restored.items[0]!.status).toBe("copied");
      expect(restored.commitNonce).toBe(p.nonce);
      p.sending = restored;
      expect((await commit(p)).items[0]!.status).toBe("copied");
      expect(targetPuts).toHaveBeenCalledTimes(1);
    });
    it("uses the same durable grant after its delivery response is lost", async () => {
      loseGrantAck = true;
      const p = await pair();
      expect(p.receiving.grantDelivery).toBe("unknown");
      const original = await target.database.prisma.deploymentTransferSession.findUniqueOrThrow({
        where: { id: p.receiving.transferId },
      });
      expect((await commit(p)).items[0]!.status).toBe("copied");
      const current = await target.database.prisma.deploymentTransferSession.findUniqueOrThrow({
        where: { id: original.id },
      });
      expect(current.tokenHash).toBe(original.tokenHash);
      expect(current.grantDelivery).toBe("acknowledged");
      expect(current.ciphertext).toBeNull();
      expect(current.secretRecordId).toBeNull();
    });
    it("keeps an uncertain remote create unknown, then adopts the found ref without another put", async () => {
      const p = await pair();
      remoteMode = true;
      loseRemotePutAck = true;
      remoteVisible = false;
      const first = await commit(p);
      expect(first.items[0]!.status).toBe("unknown");
      p.sending = first;
      await commit(p);
      expect(targetPuts).toHaveBeenCalledTimes(1);
      expect(await targetRows(p)).toHaveLength(0);
      remoteVisible = true;
      const observation = await call(source, p.s, "status", { transferId: first.transferId });
      expect(await targetRows(p)).toHaveLength(0);
      p.sending = observation;
      expect((await commit(p)).items[0]!.status).toBe("copied");
      expect(targetPuts).toHaveBeenCalledTimes(1);
    });
    it("does not adopt a found remote write after its source revision changes", async () => {
      const p = await pair();
      remoteMode = true;
      loseRemotePutAck = true;
      remoteVisible = false;
      p.sending = await commit(p);
      const secret = await source.database.prisma.botSecret.findFirstOrThrow({
        where: { botId: p.s.botId },
      });
      await source.database.prisma.botSecret.update({
        where: { id: secret.id },
        data: { name: secret.name },
      });
      remoteVisible = true;
      sourceLoads.mockClear();
      const result = await commit(p);
      expect(result.items[0]!.reason).toBe("source_changed");
      expect(await targetRows(p)).toHaveLength(0);
      expect(targetPuts).toHaveBeenCalledTimes(1);
      expect(sourceLoads).not.toHaveBeenCalled();
    });
    it("only explicitly re-seals an authoritative inline absence on the same intent", async () => {
      const p = await pair();
      failInlinePut = true;
      p.sending = await commit(p);
      expect(p.sending.items[0]!.status).toBe("unknown");
      await call(source, p.s, "status", { transferId: p.sending.transferId });
      expect(targetPuts).toHaveBeenCalledTimes(1);
      expect((await commit(p)).items[0]!.status).toBe("copied");
      expect(targetPuts).toHaveBeenCalledTimes(2);
    });
    it("binds concurrent commits to one batch nonce and one target dispatch", async () => {
      const p = await pair();
      await Promise.all([commit(p), commit(p)]);
      expect(await targetRows(p)).toHaveLength(1);
      expect(targetPuts).toHaveBeenCalledTimes(1);
      p.nonce = randomUUID();
      expect(
        (
          await raw(source, p.s, "commit", {
            transferId: p.sending.transferId,
            expectedRevision: 1,
            planDigest: p.sending.planDigest,
            expectedTargetFingerprint: p.sending.target.fingerprint,
            clientNonce: p.nonce,
          })
        ).status,
      ).toBe(409);
    });
    it("rejects a changed or deleted-and-recreated source before loading its value", async () => {
      const p = await pair();
      const old = await source.database.prisma.botSecret.findFirstOrThrow({
        where: { botId: p.s.botId },
      });
      await source.database.prisma.botSecret.delete({ where: { id: old.id } });
      await source.database.prisma.botSecret.create({ data: { ...old, revision: undefined } });
      sourceLoads.mockClear();
      expect((await commit(p)).items[0]!.reason).toBe("source_changed");
      expect(sourceLoads).not.toHaveBeenCalled();
      expect(targetPuts).not.toHaveBeenCalled();
    });
    it("rechecks a source changed after loading at the final dispatch transaction", async () => {
      const p = await pair();
      const secret = await source.database.prisma.botSecret.findFirstOrThrow({
        where: { botId: p.s.botId },
      });
      afterSourceLoad = async () => {
        afterSourceLoad = undefined;
        const changed = await source.secrets.put(
          "changed-after-load",
          {
            userId: p.s.actor.userId,
            spaceId: p.s.actor.spaceId,
            operationId: "fixture-rewrite",
            traceId: "fixture-rewrite",
            signal: new AbortController().signal,
          },
          { recordId: secret.id },
        );
        await source.database.prisma.botSecret.update({
          where: { id: secret.id },
          data: { ciphertext: changed.ciphertext },
        });
      };
      const result = await commit(p);
      expect(result.items[0]!.reason).toBe("source_changed");
      expect(targetPuts).not.toHaveBeenCalled();
      expect(await targetRows(p)).toHaveLength(0);
      expect(sourceLoads).toHaveBeenCalledTimes(1);
    });
    it("allows expired receipt reads and local cancel without renewing write authority", async () => {
      const p = await pair();
      await source.database.prisma.deploymentTransferSession.update({
        where: { id: p.sending.transferId },
        data: { expiresAt: new Date(0) },
      });
      p.sending = await call(source, p.s, "status", { transferId: p.sending.transferId });
      expect(p.sending.canCommit).toBe(false);
      expect(
        (
          await raw(source, p.s, "commit", {
            transferId: p.sending.transferId,
            expectedRevision: p.sending.revision,
            planDigest: p.sending.planDigest,
            expectedTargetFingerprint: p.sending.target.fingerprint,
            clientNonce: p.nonce,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await call(source, p.s, "cancel", {
            transferId: p.sending.transferId,
            expectedRevision: p.sending.revision,
          })
        ).phase,
      ).toBe("cancelled");
      expect(targetPuts).not.toHaveBeenCalled();
    });
    it("cancels without removing already accepted credentials or downgrading receipts", async () => {
      const p = await pair();
      p.sending = await commit(p);
      targetDeletes.mockClear();
      const cancelled = await call(source, p.s, "cancel", {
        transferId: p.sending.transferId,
        expectedRevision: p.sending.revision,
      });
      expect(cancelled.items[0]!.status).toBe("copied");
      expect(await targetRows(p)).toHaveLength(1);
      expect(targetDeletes).not.toHaveBeenCalled();
    });
    it("rechecks target lifecycle after a provider write and retains an unsettled reference", async () => {
      const p = await pair();
      beforeTargetPut = async () => {
        await target.database.prisma.bot.update({
          where: { id: p.t.botId },
          data: { archivedAt: new Date() },
        });
      };
      const result = await commit(p);
      expect(result.items[0]!.status).toBe("unknown");
      expect(await targetRows(p)).toHaveLength(0);
      const pending = await target.database.prisma.deploymentTransferItem.findFirstOrThrow({
        where: { sessionId: p.receiving.transferId },
      });
      expect(pending.ciphertext).not.toBeNull();
      expect(pending.recoveryRef).not.toBeNull();
      expect(await source.database.prisma.botSecret.count({ where: { botId: p.s.botId } })).toBe(1);
    });
    it("restores a receipt using its persisted Space even when another Space is selected", async () => {
      const p = await pair();
      const response = await raw(
        source,
        p.s,
        "status",
        { transferId: p.sending.transferId },
        "unrelated-missing-space",
      );
      expect(response.status).toBe(200);
      expect(
        ((await response.json()) as { json: DeploymentTransferStatus }).json.localScope.spaceId,
      ).toBe(p.s.actor.spaceId);
    });
    it("denies somebody else's intent even to an unrelated deployment owner", async () => {
      const p = await pair();
      const other = await account(source);
      expect(
        (await raw(source, other, "status", { transferId: p.sending.transferId })).status,
      ).toBe(404);
      expect(
        (
          await raw(source, other, "preview", {
            mode: "source",
            sourceBotId: p.s.botId,
            targetOrigin: target.origin,
            locator: p.receiving.transferId,
            clientNonce: randomUUID(),
          })
        ).status,
      ).toBe(403);
    });
    it("recovers start by owner nonce and forbids rebinding that nonce to another Bot", async () => {
      const t = await account(target);
      const nonce = randomUUID();
      const first = await call(target, t, "start", {
        targetBotId: t.botId,
        sourceOrigin: source.origin,
        clientNonce: nonce,
      });
      const restored = await call(target, t, "status", { side: "target", clientNonce: nonce });
      expect(restored.transferId).toBe(first.transferId);
      expect(
        await call(target, t, "status", { side: "target", clientNonce: randomUUID() }),
      ).toBeNull();
      const other = await target.database.prisma.bot.create({
        data: { userId: t.actor.userId, spaceId: t.actor.spaceId, name: "Other", color: "blue" },
      });
      expect(
        (
          await raw(target, t, "start", {
            targetBotId: other.id,
            sourceOrigin: source.origin,
            clientNonce: nonce,
          })
        ).status,
      ).toBe(409);
    });
    it("rejects malformed, unsigned and over-limit peer bodies without echoing values", async () => {
      for (const body of [
        JSON.stringify({ value: "sensitive-marker" }),
        " ".repeat(512 * 1024 + 1),
      ]) {
        const response = await target.handles.app.request("/api/deployment-transfer/v1/item", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${"a".repeat(43)}`,
          },
          body,
        });
        expect(response.status).toBe(400);
        expect(await response.text()).not.toContain("sensitive-marker");
      }
    });
    it("retains durable receipts after Bot deletion without granting further writes", async () => {
      const p = await pair();
      p.sending = await commit(p);
      await source.database.prisma.bot.delete({ where: { id: p.s.botId } });
      const restored = await call(source, p.s, "status", { transferId: p.sending.transferId });
      expect(restored.items[0]!.status).toBe("copied");
      expect(
        (
          await raw(source, p.s, "commit", {
            transferId: restored.transferId,
            expectedRevision: restored.revision,
            planDigest: restored.planDigest,
            expectedTargetFingerprint: restored.target.fingerprint,
            clientNonce: p.nonce,
          })
        ).status,
      ).toBe(200);
    });
    it("allows an ordinary Space member's own Bot and denies the Space owner's access to it", async () => {
      const owner = await account(source);
      const member = await share(source, owner, await account(source));
      const p = await pair({ sourceOwner: member });
      expect((await commit(p)).items[0]!.status).toBe("copied");
      expect(
        (
          await raw(source, owner, "preview", {
            mode: "source",
            targetOrigin: target.origin,
            locator: p.receiving.transferId,
            sourceBotId: member.botId,
            clientNonce: randomUUID(),
          })
        ).status,
      ).toBe(403);
    });
    it("does not revoke a Bot owner's transfer for an ordinary Space role change", async () => {
      const p = await pair();
      await source.database.prisma.spaceMember.update({
        where: { spaceId_userId: { spaceId: p.s.actor.spaceId, userId: p.s.actor.userId } },
        data: { role: "member" },
      });
      expect((await commit(p)).items[0]!.status).toBe("copied");
    });
    it.each(["source", "target"] as const)(
      "fences an old %s intent after membership deletion and recreation",
      async (which) => {
        const p = await pair();
        const side = which === "source" ? source : target;
        const owner = which === "source" ? p.s : p.t;
        const membership = await side.database.prisma.spaceMember.findUniqueOrThrow({
          where: { spaceId_userId: { spaceId: owner.actor.spaceId, userId: owner.actor.userId } },
        });
        await side.database.prisma.spaceMember.delete({ where: { id: membership.id } });
        await side.database.prisma.spaceMember.create({
          data: { ...membership, id: randomUUID() },
        });
        if (which === "source")
          expect(
            (
              await raw(source, p.s, "commit", {
                transferId: p.sending.transferId,
                expectedRevision: p.sending.revision,
                planDigest: p.sending.planDigest,
                expectedTargetFingerprint: p.sending.target.fingerprint,
                clientNonce: p.nonce,
              })
            ).status,
          ).toBe(409);
        else await commit(p);
        expect(targetPuts).not.toHaveBeenCalled();
        expect(await targetRows(p)).toHaveLength(0);
      },
    );
    it("keeps a new item when all target credential slots are already occupied", async () => {
      const t = await account(target);
      for (let index = 0; index < 100; index++)
        await credential(target, t, `slot_${index}`, `fixture-${index}`);
      targetPuts.mockClear();
      const p = await pair({ targetOwner: t });
      expect(p.receiving.plan!.items[0]!.action).toBe("keep");
      expect(p.receiving.plan!.items[0]!.reason).toBe("credential_limit");
      expect((await commit(p)).items[0]!.status).toBe("kept");
      expect(targetPuts).not.toHaveBeenCalled();
    });
    it("rechecks the target slot limit before putting a newly approved item", async () => {
      const p = await pair();
      for (let index = 0; index < 100; index++)
        await credential(target, p.t, `slot_${index}`, `fixture-${index}`);
      targetPuts.mockClear();
      await commit(p);
      expect(targetPuts).not.toHaveBeenCalled();
      expect(await targetRows(p)).toHaveLength(100);
    });
    it("omits command credentials while preserving them at the source", async () => {
      const s = await account(source);
      const command = await credential(source, s, "shell_secret", "source-only-command", {
        type: "command",
      });
      await source.database.prisma.botSecret.update({
        where: { id: command.id },
        data: { origin: "" },
      });
      const p = await pair({ sourceOwner: s });
      expect(p.sending.leftOut).toContainEqual({
        name: "shell_secret",
        reason: "unsupported_kind",
      });
      expect((await commit(p)).items).toHaveLength(1);
      expect(
        await source.database.prisma.botSecret.findUnique({ where: { id: command.id } }),
      ).not.toBeNull();
      expect(
        (await targetRows(p)).some(
          (row) =>
            row.auth &&
            typeof row.auth === "object" &&
            "type" in row.auth &&
            row.auth.type === "command",
        ),
      ).toBe(false);
    });
    it("explicitly cleans a confirmed unadopted write after cancellation", async () => {
      const p = await pair();
      beforeTargetPut = async () => {
        await target.database.prisma.deploymentTransferSession.update({
          where: { id: p.receiving.transferId },
          data: { cancelRequestedAt: new Date(), status: "cancelled", revision: { increment: 1 } },
        });
      };
      p.sending = await commit(p);
      beforeTargetPut = undefined;
      const pending = await target.database.prisma.deploymentTransferItem.findFirstOrThrow({
        where: { sessionId: p.receiving.transferId },
      });
      expect(pending.ciphertext).not.toBeNull();
      await target.database.prisma.deploymentTransferItem.update({
        where: { id: pending.id },
        data: { cleanupState: "pending" },
      });
      let state = await call(target, p.t, "status", { transferId: p.receiving.transferId });
      targetDeletes.mockClear();
      state = await call(target, p.t, "cancel", {
        transferId: state.transferId,
        expectedRevision: state.revision,
      });
      expect(state.items[0]!.status).toBe("cancelled");
      const cleaned = await target.database.prisma.deploymentTransferItem.findUniqueOrThrow({
        where: { id: pending.id },
      });
      expect(cleaned.ciphertext).toBeNull();
      expect(cleaned.recoveryRef).toBeNull();
      expect(cleaned.cleanupState).toBe("done");
      expect(targetDeletes).toHaveBeenCalledTimes(1);
      expect(targetPuts).toHaveBeenCalledTimes(1);
    });
    it("retains a cleanup-unknown receipt after delete response loss and never puts again", async () => {
      const p = await pair();
      remoteMode = true;
      beforeTargetPut = async () => {
        await target.database.prisma.deploymentTransferSession.update({
          where: { id: p.receiving.transferId },
          data: { cancelRequestedAt: new Date(), status: "cancelled", revision: { increment: 1 } },
        });
      };
      await commit(p);
      beforeTargetPut = undefined;
      loseDeleteAck = true;
      let state = await call(target, p.t, "status", { transferId: p.receiving.transferId });
      state = await call(target, p.t, "cancel", {
        transferId: state.transferId,
        expectedRevision: state.revision,
      });
      const pending = await target.database.prisma.deploymentTransferItem.findFirstOrThrow({
        where: { sessionId: state.transferId },
      });
      expect(pending.cleanupState).toBe("unknown");
      expect(pending.ciphertext).not.toBeNull();
      const deletes = targetDeletes.mock.calls.length;
      await call(target, p.t, "status", { transferId: state.transferId });
      expect(targetDeletes).toHaveBeenCalledTimes(deletes);
      state = await call(target, p.t, "cancel", {
        transferId: state.transferId,
        expectedRevision: state.revision,
      });
      expect(state.items[0]!.status).toBe("cancelled");
      expect(targetPuts).toHaveBeenCalledTimes(1);
    });
    it("does not let signing out and signing back in silently renew an old target approval", async () => {
      const p = await pair();
      await target.database.prisma.session.deleteMany({ where: { userId: p.t.actor.userId } });
      const login = await target.handles.app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { origin: target.origin, "content-type": "application/json" },
        body: JSON.stringify({ email: p.t.email, password: "offline-password-123" }),
      });
      expect(login.status).toBe(200);
      p.t.cookie = sessionCookieHeader(login);
      await call(target, p.t, "status", { transferId: p.receiving.transferId });
      p.sending = await commit(p);
      expect(targetPuts).not.toHaveBeenCalled();
      let targetState = await call(target, p.t, "status", { transferId: p.receiving.transferId });
      targetState = await call(target, p.t, "approve", {
        transferId: targetState.transferId,
        expectedRevision: targetState.revision,
        planDigest: targetState.planDigest,
        expectedSourceFingerprint: targetState.source!.fingerprint,
      });
      expect(targetState.planDigest).toBe(p.receiving.planDigest);
      expect((await commit(p)).items[0]!.status).toBe("copied");
    });
    it("preserves copied and unknown evidence while the restore fence invalidates every write", async () => {
      const copied = await pair();
      copied.sending = await commit(copied);
      const pending = await pair();
      remoteMode = true;
      loseRemotePutAck = true;
      remoteVisible = false;
      pending.sending = await commit(pending);
      const before = await target.database.prisma.deploymentTransferItem.findMany({
        where: { sessionId: { in: [copied.receiving.transferId, pending.receiving.transferId] } },
        orderBy: { id: "asc" },
      });
      const old = await targetRows(copied);
      const fence = await readFile(
        new URL("../../../scripts/restore-transfer-fence.sql", import.meta.url),
        "utf8",
      );
      await target.database.prisma.$executeRawUnsafe(fence);
      const after = await target.database.prisma.deploymentTransferItem.findMany({
        where: { sessionId: { in: [copied.receiving.transferId, pending.receiving.transferId] } },
        orderBy: { id: "asc" },
      });
      expect(after).toEqual(before);
      expect((await targetRows(copied))[0]!.revision).not.toBe(old[0]!.revision);
      expect(
        await target.database.prisma.deploymentTransferSession.count({
          where: {
            id: { in: [copied.receiving.transferId, pending.receiving.transferId] },
            writeRevokedReason: "restore",
          },
        }),
      ).toBe(2);
      expect(
        (await call(target, copied.t, "status", { transferId: copied.receiving.transferId }))
          .items[0]!.status,
      ).toBe("copied");
      const pendingState = await call(source, pending.s, "status", {
        transferId: pending.sending.transferId,
      });
      expect(pendingState.phase).toBe("expired");
      expect(pendingState.canCommit).toBe(false);
      expect(pendingState.items[0]!.reason).toBe("restore");
      expect(pendingState.items[0]!.canRecover).toBe(false);
      const puts = targetPuts.mock.calls.length;
      pending.sending = pendingState;
      expect(
        (
          await raw(source, pending.s, "commit", {
            transferId: pendingState.transferId,
            expectedRevision: pendingState.revision,
            planDigest: pendingState.planDigest,
            expectedTargetFingerprint: pendingState.target.fingerprint,
            clientNonce: pending.nonce,
          })
        ).status,
      ).toBe(409);
      expect(targetPuts).toHaveBeenCalledTimes(puts);
      expect(await targetRows(pending)).toHaveLength(0);
    });
    it("rolls the restore fence back atomically if the enclosing restore transaction fails", async () => {
      const p = await pair();
      const before = await source.database.prisma.botSecret.findFirstOrThrow({
        where: { botId: p.s.botId },
      });
      const session = await source.database.prisma.deploymentTransferSession.findUniqueOrThrow({
        where: { id: p.sending.transferId },
      });
      const fence = await readFile(
        new URL("../../../scripts/restore-transfer-fence.sql", import.meta.url),
        "utf8",
      );
      await expect(
        source.database.prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(fence);
          throw new Error("Synthetic restore failure");
        }),
      ).rejects.toThrow("Synthetic restore failure");
      expect(
        (await source.database.prisma.botSecret.findUniqueOrThrow({ where: { id: before.id } }))
          .revision,
      ).toBe(before.revision);
      expect(
        await source.database.prisma.deploymentTransferSession.findUniqueOrThrow({
          where: { id: session.id },
        }),
      ).toEqual(session);
    });
    it("does not clean a confirmed pending reference after a restore revoked its writes", async () => {
      const p = await pair();
      beforeTargetPut = async () => {
        await target.database.prisma.bot.update({
          where: { id: p.t.botId },
          data: { archivedAt: new Date() },
        });
      };
      await commit(p);
      beforeTargetPut = undefined;
      const pending = await target.database.prisma.deploymentTransferItem.findFirstOrThrow({
        where: { sessionId: p.receiving.transferId },
      });
      expect(pending.ciphertext).not.toBeNull();
      const fence = await readFile(
        new URL("../../../scripts/restore-transfer-fence.sql", import.meta.url),
        "utf8",
      );
      await target.database.prisma.$executeRawUnsafe(fence);
      const state = await call(target, p.t, "status", { transferId: p.receiving.transferId });
      targetDeletes.mockClear();
      await call(target, p.t, "cancel", {
        transferId: state.transferId,
        expectedRevision: state.revision,
      });
      expect(targetDeletes).not.toHaveBeenCalled();
      const retained = await target.database.prisma.deploymentTransferItem.findUniqueOrThrow({
        where: { id: pending.id },
      });
      expect(retained.ciphertext).toBe(pending.ciphertext);
      expect(retained.recoveryRef).toBe(pending.recoveryRef);
    });
    it.each(["modified", "removed"] as const)(
      "observes a %s target while preserving the copied historical receipt",
      async (targetState) => {
        const p = await pair();
        p.sending = await commit(p);
        const [secret] = await targetRows(p);
        if (targetState === "removed")
          await target.database.prisma.botSecret.delete({ where: { id: secret!.id } });
        else
          await target.database.prisma.botSecret.update({
            where: { id: secret!.id },
            data: { name: secret!.name },
          });
        sourceLoads.mockClear();
        targetPuts.mockClear();
        targetDeletes.mockClear();
        const observedTarget = await call(target, p.t, "status", {
          transferId: p.receiving.transferId,
        });
        const observedSource = await call(source, p.s, "status", {
          transferId: p.sending.transferId,
        });
        expect(observedTarget.items[0]!.status).toBe("copied");
        expect(observedTarget.items[0]!.targetState).toBe(targetState);
        expect(observedSource.items[0]!.status).toBe("copied");
        expect(observedSource.items[0]!.targetState).toBe(targetState);
        expect(sourceLoads).not.toHaveBeenCalled();
        expect(targetPuts).not.toHaveBeenCalled();
        expect(targetDeletes).not.toHaveBeenCalled();
        const stored = await source.database.prisma.deploymentTransferSession.findUniqueOrThrow({
          where: { id: p.sending.transferId },
        });
        expect(stored.ciphertext).toBeNull();
        expect(stored.secretRecordId).toBeNull();
        p.sending = observedSource;
        expect((await commit(p)).items[0]!.status).toBe("copied");
        expect(targetPuts).not.toHaveBeenCalled();
      },
    );
    it("keeps a first-item source refusal when the second item is copied and later pending receipts arrive", async () => {
      const p = await pair({ names: ["first", "second"] });
      const first = p.sending.plan!.items[0]!.source;
      const original = await source.database.prisma.botSecret.findFirstOrThrow({
        where: { botId: p.s.botId, name: first.name },
      });
      await source.database.prisma.botSecret.update({
        where: { id: original.id },
        data: { name: original.name },
      });
      const result = await commit(p);
      expect(result.phase).toBe("partial");
      expect(result.items.find((item) => item.itemKey === first.itemKey)).toMatchObject({
        status: "conflict",
        reason: "source_changed",
      });
      expect(result.items.filter((item) => item.status === "copied")).toHaveLength(1);
      const reloaded = await call(source, p.s, "status", { transferId: result.transferId });
      expect(reloaded.items.find((item) => item.itemKey === first.itemKey)).toMatchObject({
        status: "conflict",
        reason: "source_changed",
      });
      expect(targetPuts).toHaveBeenCalledTimes(1);
      const durable = await source.database.prisma.deploymentTransferSession.findUniqueOrThrow({
        where: { id: result.transferId },
      });
      expect(durable.ciphertext).toBeNull();
      expect(durable.secretRecordId).toBeNull();
    });
    it("omits a cached target observation after restore when the peer cannot be checked", async () => {
      const p = await pair();
      p.sending = await commit(p);
      await source.database.prisma.deploymentTransferSession.update({
        where: { id: p.sending.transferId },
        data: {
          writeRevokedAt: new Date(),
          writeRevokedReason: "restore",
          revision: 1,
        },
      });
      failPeerStatus = true;
      sourceLoads.mockClear();
      targetPuts.mockClear();
      const restored = await call(source, p.s, "status", { transferId: p.sending.transferId });
      expect(restored.revision).toBe(1);
      expect(restored.writeRevokedReason).toBe("restore");
      expect(restored.phase).toBe("expired");
      expect(restored.canApprove || restored.canCommit || restored.canRecover).toBe(false);
      expect(restored.items[0]!.status).toBe("copied");
      expect(restored.items[0]).not.toHaveProperty("targetState");
      expect(sourceLoads).not.toHaveBeenCalled();
      expect(targetPuts).not.toHaveBeenCalled();
    });
    it("preserves an in-flight unknown when cancel delivery acknowledgement is lost", async () => {
      const p = await pair();
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      beforeTargetPut = async () => {
        entered();
        await gate;
      };
      const running = commit(p);
      await started;
      let current = await call(source, p.s, "status", { transferId: p.sending.transferId });
      loseCancelAck = true;
      current = await call(source, p.s, "cancel", {
        transferId: current.transferId,
        expectedRevision: current.revision,
      });
      expect(current.phase).toBe("cancelled");
      expect(current.items[0]!.status).toBe("unknown");
      const durable = await source.database.prisma.deploymentTransferSession.findUniqueOrThrow({
        where: { id: current.transferId },
        include: { items: true },
      });
      expect(durable.items[0]!.writeState).toBe("dispatched");
      expect(durable.ciphertext).toBeNull();
      expect(durable.secretRecordId).toBeNull();
      release();
      await running;
      beforeTargetPut = undefined;
      expect(targetPuts).toHaveBeenCalledTimes(1);
      expect(await targetRows(p)).toHaveLength(0);
      current = await call(source, p.s, "status", { transferId: current.transferId });
      current = await call(source, p.s, "cancel", {
        transferId: current.transferId,
        expectedRevision: current.revision,
      });
      expect(current.items[0]!.status).toBe("cancelled");
      expect(targetPuts).toHaveBeenCalledTimes(1);
    });
    it("retires an expired grant with DB-only CAS and no provider or item changes", async () => {
      loseGrantAck = true;
      const p = await pair();
      await target.database.prisma.deploymentTransferSession.update({
        where: { id: p.receiving.transferId },
        data: { expiresAt: new Date(0) },
      });
      const before = await target.database.prisma.deploymentTransferItem.findMany({
        where: { sessionId: p.receiving.transferId },
      });
      targetDeletes.mockClear();
      await call(target, p.t, "status", { transferId: p.receiving.transferId });
      const retired = await target.database.prisma.deploymentTransferSession.findUniqueOrThrow({
        where: { id: p.receiving.transferId },
      });
      expect(retired.ciphertext).toBeNull();
      expect(retired.secretRecordId).toBeNull();
      expect(
        await target.database.prisma.deploymentTransferItem.findMany({
          where: { sessionId: p.receiving.transferId },
        }),
      ).toEqual(before);
      expect(targetDeletes).not.toHaveBeenCalled();
    });
    it.each(["Bot", "Space", "User"] as const)(
      "cleans a confirmed orphan after %s deletion through trusted maintenance only",
      async (parent) => {
        const p = await pair();
        beforeTargetPut = async () => {
          beforeTargetPut = undefined;
          if (parent === "Bot")
            await target.database.prisma.bot.delete({ where: { id: p.t.botId } });
          else if (parent === "Space")
            await target.database.prisma.space.delete({ where: { id: p.t.actor.spaceId } });
          else await target.database.prisma.user.delete({ where: { id: p.t.actor.userId } });
        };
        await commit(p);
        const item = await target.database.prisma.deploymentTransferItem.findFirstOrThrow({
          where: { sessionId: p.receiving.transferId },
        });
        expect(item.ciphertext).not.toBeNull();
        targetDeletes.mockClear();
        const dry = await cleanupOrphanedTransfers({
          prisma: target.database.prisma,
          secrets: target.secrets,
          dryRun: true,
        });
        expect(dry.candidates).toBeGreaterThan(0);
        expect(targetDeletes).not.toHaveBeenCalled();
        const before = await target.database.prisma.deploymentTransferItem.findUniqueOrThrow({
          where: { id: item.id },
        });
        expect(before.ciphertext).toBe(item.ciphertext);
        await cleanupOrphanedTransfers({ prisma: target.database.prisma, secrets: target.secrets });
        const retired = await target.database.prisma.deploymentTransferItem.findUniqueOrThrow({
          where: { id: item.id },
        });
        expect(retired.cleanupState).toBe("done");
        expect(retired.ciphertext).toBeNull();
        expect(retired.recoveryRef).toBeNull();
        expect(await source.database.prisma.botSecret.count({ where: { botId: p.s.botId } })).toBe(
          1,
        );
      },
    );
    it("trusted orphan cleanup preserves reservations, accepted receipts and restore-revoked references", async () => {
      const unknown = await pair();
      remoteMode = true;
      loseRemotePutAck = true;
      remoteVisible = false;
      await commit(unknown);
      await target.database.prisma.bot.delete({ where: { id: unknown.t.botId } });
      remoteMode = false;
      remoteVisible = true;
      const accepted = await pair();
      await commit(accepted);
      await target.database.prisma.bot.delete({ where: { id: accepted.t.botId } });
      const restored = await pair();
      beforeTargetPut = async () => {
        beforeTargetPut = undefined;
        await target.database.prisma.bot.delete({ where: { id: restored.t.botId } });
      };
      await commit(restored);
      await target.database.prisma.deploymentTransferSession.update({
        where: { id: restored.receiving.transferId },
        data: { writeRevokedAt: new Date(), writeRevokedReason: "restore" },
      });
      const before = await target.database.prisma.deploymentTransferItem.findMany({
        where: {
          sessionId: {
            in: [
              unknown.receiving.transferId,
              accepted.receiving.transferId,
              restored.receiving.transferId,
            ],
          },
        },
        orderBy: { id: "asc" },
      });
      await cleanupOrphanedTransfers({ prisma: target.database.prisma, secrets: target.secrets });
      expect(
        await target.database.prisma.deploymentTransferItem.findMany({
          where: {
            sessionId: {
              in: [
                unknown.receiving.transferId,
                accepted.receiving.transferId,
                restored.receiving.transferId,
              ],
            },
          },
          orderBy: { id: "asc" },
        }),
      ).toEqual(before);
    });
    it("retains a confirmed write when the target changes during put and only permits cleanup", async () => {
      const t = await account(target);
      const original = await credential(target, t, "replace", "original-target-value");
      const p = await pair({ targetOwner: t, names: ["replace"], overwrite: ["replace"] });
      targetPuts.mockClear();
      beforeTargetPut = async () => {
        beforeTargetPut = undefined;
        const edit = await target.secrets.put(
          "user-edited-during-put",
          {
            userId: t.actor.userId,
            spaceId: t.actor.spaceId,
            operationId: "fixture-edit",
            traceId: "fixture-edit",
            signal: new AbortController().signal,
          },
          { recordId: original.id, ephemeral: true },
        );
        await target.database.prisma.botSecret.update({
          where: { id: original.id },
          data: { ciphertext: edit.ciphertext },
        });
      };
      p.sending = await commit(p);
      expect(p.sending.items[0]).toMatchObject({
        status: "unknown",
        reason: "target_changed",
        canRecover: false,
      });
      expect(p.sending.canCommit).toBe(false);
      let targetState = await call(target, t, "status", { transferId: p.receiving.transferId });
      expect(targetState.items[0]).toMatchObject({
        status: "unknown",
        reason: "target_changed",
        canRecover: false,
      });
      expect(targetState.canRecover).toBe(false);
      const pending = await target.database.prisma.deploymentTransferItem.findFirstOrThrow({
        where: { sessionId: targetState.transferId },
      });
      expect(pending.ciphertext).not.toBeNull();
      expect(pending.recoveryRef).not.toBeNull();
      expect(pending.targetSecretId).toBeNull();
      let actual = await target.database.prisma.botSecret.findUniqueOrThrow({
        where: { id: original.id },
      });
      expect(await target.secrets.load(actual.ciphertext, actual.id)).toBe(
        "user-edited-during-put",
      );
      await commit(p);
      expect(targetPuts).toHaveBeenCalledTimes(1);
      targetState = await call(target, t, "cancel", {
        transferId: targetState.transferId,
        expectedRevision: targetState.revision,
      });
      expect(targetState.items[0]!.status).toBe("cancelled");
      const cleaned = await target.database.prisma.deploymentTransferItem.findUniqueOrThrow({
        where: { id: pending.id },
      });
      expect(cleaned.ciphertext).toBeNull();
      expect(cleaned.recoveryRef).toBeNull();
      actual = await target.database.prisma.botSecret.findUniqueOrThrow({
        where: { id: original.id },
      });
      expect(await target.secrets.load(actual.ciphertext, actual.id)).toBe(
        "user-edited-during-put",
      );
    });
    it("allows explicit cleanup of a confirmed pending write after its transfer expires", async () => {
      const p = await pair();
      beforeTargetPut = async () => {
        beforeTargetPut = undefined;
        await target.database.prisma.deploymentTransferSession.update({
          where: { id: p.receiving.transferId },
          data: { expiresAt: new Date(0) },
        });
      };
      await commit(p);
      const expired = await call(target, p.t, "status", { transferId: p.receiving.transferId });
      expect(expired.phase).toBe("expired");
      expect(expired.items[0]!.status).toBe("unknown");
      const pending = await target.database.prisma.deploymentTransferItem.findFirstOrThrow({
        where: { sessionId: expired.transferId },
      });
      expect(pending.ciphertext).not.toBeNull();
      expect(pending.recoveryRef).not.toBeNull();
      const cancelled = await call(target, p.t, "cancel", {
        transferId: expired.transferId,
        expectedRevision: expired.revision,
      });
      expect(cancelled.items[0]!.status).toBe("cancelled");
      const cleaned = await target.database.prisma.deploymentTransferItem.findUniqueOrThrow({
        where: { id: pending.id },
      });
      expect(cleaned.ciphertext).toBeNull();
      expect(cleaned.recoveryRef).toBeNull();
      expect(targetPuts).toHaveBeenCalledTimes(1);
      expect(await targetRows(p)).toHaveLength(0);
    });
    it("accepts the restore fence for an older backup without transfer tables or revision", async () => {
      const fence = await readFile(
        new URL("../../../scripts/restore-transfer-fence.sql", import.meta.url),
        "utf8",
      );
      await expect(
        target.database.prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("DROP TABLE deployment_transfer_items");
          await tx.$executeRawUnsafe("DROP TABLE deployment_transfer_sessions");
          await tx.$executeRawUnsafe("ALTER TABLE bot_secrets DROP COLUMN revision CASCADE");
          await tx.$executeRawUnsafe(fence);
          throw new Error("Rollback temporary old-backup fixture");
        }),
      ).rejects.toThrow("Rollback temporary old-backup fixture");
      expect(await target.database.prisma.deploymentTransferSession.count()).toBeGreaterThan(0);
    });
  },
);
