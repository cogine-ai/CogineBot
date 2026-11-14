import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor, Bot, NativeRoutineTrigger, Routine } from "@rakazo/contracts";
import { nativeEventApp, nativeEventResource } from "@rakazo/contracts";
import { draftFromNativeRoutineTrigger } from "@rakazo/core/routine-native-events";
import type { RoutineSaveState } from "@rakazo/core/routine-save";
import { saveRoutineDraft } from "@rakazo/core/routine-save";
import { routineTriggerDraft, routineTriggerPatch } from "@rakazo/core/routine-trigger-patch";
import { createDb } from "@rakazo/db";
import { isolatedDatabaseUrl } from "@rakazo/db/testing/row-security-expectations";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NativeEventResourceVerifier } from "../../../packages/adapters/src/native-connectors/events/resource-verifier.js";
import { discardBotIntroFromCreate } from "../../../packages/testkit/src/discard-bot-intro.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const origin = "http://127.0.0.1:5173";

describePostgres("routine save transaction regressions", () => {
  let database: ReturnType<typeof createDb>;
  let handles: Awaited<ReturnType<typeof createApp>>;
  let dataDir: string;
  let beforePrepare: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "routine-history-acceptance-"));
    database = createDb(isolatedDatabaseUrl());
    expect((await database.pool.query("SELECT current_database() AS name")).rows[0].name).toBe(
      process.env.VERIFY_ISOLATED_DATABASE,
    );
    handles = await createApp({
      prisma: database.prisma,
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      encryptionKey: "offline-routine-history-test-key",
      webOrigin: origin,
      authUrl: origin,
    });
    vi.spyOn(handles.jobs, "enqueue").mockResolvedValue(undefined as never);
    vi.spyOn(NativeEventResourceVerifier.prototype, "prepare").mockImplementation(
      async (scope, input) => {
        await beforePrepare?.();
        const c = await database.prisma.connection.findUniqueOrThrow({
          where: { id: input.connectionId },
          include: { oauthGrant: true, nativeConfig: true },
        });
        const g = c.oauthGrant!;
        return {
          input,
          proof: {
            ...scope,
            connectionId: c.id,
            authorizationRevision: `${g.id}:${g.authGeneration}`,
            grantId: g.id,
            authGeneration: g.authGeneration,
            configId: c.nativeConfig!.id,
            configRevision: c.nativeConfig!.revision,
            appId: nativeEventApp(input.spec),
            resource: nativeEventResource(input.spec),
            spec: input.spec,
          },
        };
      },
    );
  });
  afterAll(async () => {
    await handles?.stop();
    await database?.prisma.$disconnect();
    await database?.pool.end();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  function raw(cookie: string, procedure: string, input: unknown = {}, spaceId?: string) {
    return handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        ...(cookie ? { cookie } : {}),
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
  }
  async function rpc<T>(cookie: string, procedure: string, input: unknown = {}, spaceId?: string) {
    const response = await raw(cookie, procedure, input, spaceId);
    const text = await response.text();
    if (!response.ok) throw new Error(`${procedure}: ${response.status} ${text}`);
    const result = (JSON.parse(text) as { json: T }).json;
    return discardBotIntroFromCreate(handles, cookie, procedure, result);
  }
  async function account() {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `routine-history-${randomUUID()}@example.test`,
        password: "password12",
        name: "Routine history tester",
      }),
    });
    expect(response.ok).toBe(true);
    const cookie = sessionCookieHeader(response);
    const actor = await rpc<Actor>(cookie, "me");
    return { cookie, actor };
  }
  async function fixture() {
    const owner = await account();
    const bot = await rpc<Bot>(owner.cookie, "bots/create", { name: "History bot" });
    const routine = await rpc<Routine>(owner.cookie, "routines/create", {
      botId: bot.id,
      name: "History routine",
      prompt: "Record a synthetic observation",
      crons: ["0 9 * * *"],
    });
    const thread = await database.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    return { ...owner, bot, routine, thread };
  }

  async function connected(
    owner: Awaited<ReturnType<typeof fixture>>,
    provider = "google-calendar",
  ) {
    const scope = { userId: owner.actor.userId, spaceId: owner.actor.spaceId };
    const config = await database.prisma.nativeAppConfig.create({
      data: {
        appId: provider,
        label: "Synthetic acceptance",
        ownership: "byo",
        credentialKind: "oauth",
        callbackUri: "https://example.test/callback",
        config: {},
      },
    });
    const secret = await database.prisma.secret.create({
      data: { ...scope, kind: "native_grant", ciphertext: "synthetic-never-used" },
    });
    const grant = await database.prisma.nativeOAuthGrant.create({
      data: {
        ...scope,
        id: randomUUID(),
        configId: config.id,
        configRevision: config.revision,
        authority: "https://example.test",
        subject: "synthetic",
        secretId: secret.id,
        scopes: [],
      },
    });
    const c = await database.prisma.connection.create({
      data: {
        ...scope,
        connectorId: "native",
        provider,
        providerRef: grant.id,
        displayName: "Synthetic",
        status: "connected",
        oauthGrantId: grant.id,
        nativeConfigId: config.id,
        nativeConfigRevision: config.revision,
        metadata: { authRevision: `${grant.id}:${grant.authGeneration}` },
      },
    });
    return (id: string) => ({
      connectionId: c.id,
      spec: {
        kind: "calendar.event_changed" as const,
        calendarId: id,
        target: { kind: "calendar" as const },
      },
    });
  }
  const inputOf = (t: NativeRoutineTrigger) => ({
    id: t.id,
    expectedVersion: t.version,
    connectionId: t.connectionId,
    spec: t.spec,
  });
  async function update(o: Awaited<ReturnType<typeof fixture>>, input: Record<string, unknown>) {
    return rpc<Routine>(o.cookie, "routines/update", { routineId: o.routine.id, ...input });
  }
  it.each(["create", "update"] as const)(
    "recovers %s then saves changed drafts without resetting event state",
    async (operation) => {
      const o = await fixture(),
        make = await connected(o);
      const state: RoutineSaveState = {};
      const input = {
        mutationId: randomUUID(),
        name: "First",
        prompt: "First prompt",
        nativeTriggers: [make("recovery-calendar")],
        ...(operation === "create"
          ? { botId: o.bot.id, crons: ["0 9 * * *"], timezone: "UTC", active: false, notify: true }
          : { routineId: o.routine.id, nativeTriggerBaseline: [] }),
      };
      let committed: Routine | undefined;
      const send = async (request: Parameters<typeof saveRoutineDraft>[1]) => {
        const saved = await rpc<Routine>(o.cookie, `routines/${request.operation}`, request.input);
        if (!committed) {
          committed = saved;
          throw new Error("Response lost after commit");
        }
        return saved;
      };
      const baseline = operation === "create" ? null : o.routine;
      await expect(
        saveRoutineDraft(state, { operation, input }, baseline, send, () => true),
      ).rejects.toThrow("Response lost");
      const triggerId = committed!.nativeTriggers![0]!.id;
      await database.prisma.nativeRoutineTrigger.update({
        where: { id: triggerId },
        data: { state: { cursor: "keep-cursor" }, leaseId: "synthetic-lease" },
      });
      const before = await database.prisma.nativeRoutineTrigger.findUniqueOrThrow({
        where: { id: triggerId },
      });
      const saved = await saveRoutineDraft(
        state,
        { operation, input: { ...input, name: "Later", prompt: "Later prompt" } },
        baseline,
        send,
        () => true,
      );
      expect(saved).toMatchObject({ id: committed!.id, name: "Later", prompt: "Later prompt" });
      expect(
        await database.prisma.nativeRoutineTrigger.findUniqueOrThrow({ where: { id: triggerId } }),
      ).toEqual(before);
      expect(await database.prisma.routine.count({ where: { botId: o.bot.id } })).toBe(
        operation === "create" ? 2 : 1,
      );
    },
  );

  it.each(["create", "update"] as const)(
    "preserves uncertain %s identity across revoked and restored membership",
    async (operation) => {
      const o = await fixture(),
        state: RoutineSaveState = {};
      const input = {
        mutationId: randomUUID(),
        name: "First",
        prompt: "First prompt",
        ...(operation === "create"
          ? { botId: o.bot.id, crons: ["0 9 * * *"] }
          : { routineId: o.routine.id }),
      };
      const request = { operation, input };
      let committed: Routine | undefined;
      const send = async (attempt: Parameters<typeof saveRoutineDraft>[1]) => {
        const response = await raw(
          o.cookie,
          `routines/${attempt.operation}`,
          attempt.input,
          o.actor.spaceId,
        );
        const body = await response.json();
        if (!response.ok) throw { code: body.json?.code ?? body.code, status: response.status };
        if (!committed) {
          committed = body.json;
          throw new Error("Lost response");
        }
        return body.json as Routine;
      };
      const baseline = operation === "create" ? null : o.routine;
      await expect(saveRoutineDraft(state, request, baseline, send, () => true)).rejects.toThrow(
        "Lost response",
      );
      const membership = await database.prisma.spaceMember.findUniqueOrThrow({
        where: { spaceId_userId: { spaceId: o.actor.spaceId, userId: o.actor.userId } },
      });
      await database.prisma.spaceMember.delete({ where: { id: membership.id } });
      try {
        await expect(
          saveRoutineDraft(state, request, baseline, send, () => true),
        ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      } finally {
        await database.prisma.spaceMember.create({ data: membership });
      }
      // A new follow-up is different from a refused recovery: this first dispatch
      // is actually rejected by schema validation and may be corrected safely.
      await expect(
        saveRoutineDraft(
          state,
          { operation, input: { ...input, mutationId: randomUUID(), name: "Later", crons: [""] } },
          baseline,
          send,
          () => true,
        ),
      ).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
      const saved = await saveRoutineDraft(
        state,
        {
          operation,
          input: { ...input, mutationId: randomUUID(), name: "Later", prompt: "Later prompt" },
        },
        baseline,
        send,
        () => true,
      );
      expect
        .soft(saved)
        .toMatchObject({ id: committed!.id, name: "Later", prompt: "Later prompt" });
      expect(await database.prisma.routine.count({ where: { botId: o.bot.id } })).toBe(
        operation === "create" ? 2 : 1,
      );
    },
  );

  it("recovers two lost submissions while successive trigger drafts reorder stable keys", async () => {
    const o = await fixture(),
      make = await connected(o),
      state: RoutineSaveState = {};
    const calls: Array<Parameters<typeof saveRoutineDraft>[1]> = [];
    const receipts = new Set<string>();
    let committed: Routine | undefined;
    const send = async (request: Parameters<typeof saveRoutineDraft>[1]) => {
      calls.push(structuredClone(request));
      const saved = await rpc<Routine>(o.cookie, `routines/${request.operation}`, request.input);
      if (!receipts.has(String(request.input.mutationId))) {
        receipts.add(String(request.input.mutationId));
        committed = saved;
        if (receipts.size <= 2) throw new Error("Lost committed response");
      }
      return saved;
    };
    const draft = (a: string, reverse = false) => ({
      operation: "create" as const,
      input: {
        botId: o.bot.id,
        name: "Trigger recovery",
        prompt: "Synthetic",
        crons: ["0 9 * * *"],
        mutationId: randomUUID(),
        nativeTriggers: reverse ? [make("stable-b"), make(a)] : [make(a), make("stable-b")],
      },
      triggerKeys: reverse ? ["key-b", "key-a"] : ["key-a", "key-b"],
    });
    await expect(saveRoutineDraft(state, draft("a-one"), null, send, () => true)).rejects.toThrow(
      "Lost committed response",
    );
    const first = committed!;
    const idA = first.nativeTriggers![0]!.id,
      idB = first.nativeTriggers![1]!.id;
    await expect(
      saveRoutineDraft(state, draft("a-two", true), null, send, () => true),
    ).rejects.toThrow("Lost committed response");
    await database.prisma.nativeRoutineTrigger.update({
      where: { id: idB },
      data: { state: { cursor: "keep" }, leaseId: "synthetic-lease" },
    });
    const beforeB = await database.prisma.nativeRoutineTrigger.findUniqueOrThrow({
      where: { id: idB },
    });
    const saved = await saveRoutineDraft(state, draft("a-three"), null, send, () => true);
    expect(saved?.id).toBe(first.id);
    expect(saved?.nativeTriggers?.find((t) => t.id === idA)).toMatchObject({
      version: 3,
      spec: make("a-three").spec,
    });
    expect(
      await database.prisma.nativeRoutineTrigger.findUniqueOrThrow({ where: { id: idB } }),
    ).toEqual(beforeB);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[3]).toEqual(calls[2]);
    expect(calls[4]!.input.nativeTriggers).toMatchObject([
      { id: idA, expectedVersion: 2 },
      { id: idB, expectedVersion: 1 },
    ]);
    expect(await database.prisma.routine.count({ where: { botId: o.bot.id } })).toBe(2);
  });

  it.each(["distinct", "same spec across accounts", "concurrent version"])(
    "keeps three draft identities through an omitted trigger patch and reordered recovery: %s",
    async (mode) => {
      const o = await fixture(),
        make = await connected(o),
        state: RoutineSaveState = {};
      const other = await connected(o);
      const makeB = () => (mode === "same spec across accounts" ? other("a") : make("b"));
      const calls: Array<Parameters<typeof saveRoutineDraft>[1]> = [];
      const receipts = new Set<string>();
      let first: Routine | undefined;
      const send = async (request: Parameters<typeof saveRoutineDraft>[1]) => {
        calls.push(structuredClone(request));
        const saved = await rpc<Routine>(o.cookie, `routines/${request.operation}`, request.input);
        if (!receipts.has(String(request.input.mutationId))) {
          receipts.add(String(request.input.mutationId));
          if (!first) {
            first = saved;
            // Force a different canonical read order, independently of random IDs.
            for (const [index, row] of saved.nativeTriggers!.entries()) {
              await database.prisma.nativeRoutineTrigger.update({
                where: { id: row.id },
                data: {
                  createdAt: new Date(Date.UTC(2020, 0, index === 0 ? 3 : index)),
                },
              });
            }
          }
          if (receipts.size <= 2) throw new Error("Lost committed response");
        }
        return saved;
      };
      const draft = (name: string, reorder = false) => ({
        operation: "create" as const,
        input: {
          botId: o.bot.id,
          name,
          prompt: "Synthetic",
          crons: ["0 9 * * *"],
          mutationId: randomUUID(),
          nativeTriggers: reorder
            ? [makeB(), make("c"), make("a-edited")]
            : [make("a"), makeB(), make("c")],
        },
        triggerKeys: reorder ? ["key-b", "key-c", "key-a"] : ["key-a", "key-b", "key-c"],
      });
      await expect(saveRoutineDraft(state, draft("First"), null, send, () => true)).rejects.toThrow(
        "Lost committed response",
      );
      const [a, b, c] = first!.nativeTriggers!;
      await expect(
        saveRoutineDraft(state, draft("Second"), null, send, () => true),
      ).rejects.toThrow("Lost committed response");
      expect(state.pending!.input).not.toHaveProperty("nativeTriggers");
      expect(state.baseline!.nativeTriggers!.map((t) => t.id)).toEqual([b!.id, c!.id, a!.id]);
      for (const row of [b!, c!])
        await database.prisma.nativeRoutineTrigger.update({
          where: { id: row.id },
          data: {
            state: { cursor: row.id },
            leaseId: `lease-${row.id}`,
            leaseUntil: new Date("2030-01-01"),
          },
        });
      const untouched = await database.prisma.nativeRoutineTrigger.findMany({
        where: { id: { in: [b!.id, c!.id] } },
        orderBy: { id: "asc" },
      });
      if (mode === "concurrent version") {
        await rpc(o.cookie, "routines/update", {
          routineId: first!.id,
          nativeTriggerBaseline: first!.nativeTriggers!.map(({ id, version }) => ({ id, version })),
          nativeTriggers: [
            inputOf(a!),
            { ...inputOf(b!), spec: make("b-concurrent").spec },
            inputOf(c!),
          ],
        });
        const before = await database.prisma.nativeRoutineTrigger.findMany({
          where: { routineId: first!.id },
          orderBy: { id: "asc" },
        });
        await expect(
          saveRoutineDraft(state, draft("Third", true), null, send, () => true),
        ).rejects.toThrow("This native trigger changed");
        expect(calls).toHaveLength(4);
        expect(
          await database.prisma.nativeRoutineTrigger.findMany({
            where: { routineId: first!.id },
            orderBy: { id: "asc" },
          }),
        ).toEqual(before);
        return;
      }
      const saved = await saveRoutineDraft(state, draft("Third", true), null, send, () => true);
      expect(saved!.id).toBe(first!.id);
      expect(saved!.nativeTriggers!.find((t) => t.id === a!.id)).toMatchObject({
        version: 2,
        spec: make("a-edited").spec,
      });
      expect(
        await database.prisma.nativeRoutineTrigger.findMany({
          where: { id: { in: [b!.id, c!.id] } },
          orderBy: { id: "asc" },
        }),
      ).toEqual(untouched);
      expect(calls[4]!.input.nativeTriggers).toMatchObject([
        { id: b!.id, expectedVersion: 1 },
        { id: c!.id, expectedVersion: 1 },
        { id: a!.id, expectedVersion: 1 },
      ]);
      expect(calls[1]).toEqual(calls[0]);
      expect(calls[3]).toEqual(calls[2]);
    },
  );

  it("rejects duplicate configurations before creating a routine or receipt", async () => {
    const o = await fixture(),
      make = await connected(o),
      mutationId = randomUUID();
    const before = await database.prisma.routine.count({ where: { botId: o.bot.id } });
    const receiptsBefore = await database.prisma.routineMutation.count({
      where: { userId: o.actor.userId, spaceId: o.actor.spaceId },
    });
    const response = await raw(o.cookie, "routines/create", {
      botId: o.bot.id,
      name: "Duplicate",
      prompt: "Synthetic",
      mutationId,
      nativeTriggers: [make("same"), make("same")],
    });
    expect(response.status).toBe(400);
    expect(await database.prisma.routine.count({ where: { botId: o.bot.id } })).toBe(before);
    expect(
      await database.prisma.routineMutation.count({
        where: { userId: o.actor.userId, spaceId: o.actor.spaceId },
      }),
    ).toBe(receiptsBefore);
  });

  it.each([false, true])(
    "advances confirmed trigger recovery before a rejected follow-up (metadata=%s)",
    async (metadata) => {
      const o = await fixture(),
        make = await connected(o),
        state: RoutineSaveState = {};
      const calls: Array<Parameters<typeof saveRoutineDraft>[1]> = [];
      const receipts = new Set<string>();
      let first: Routine | undefined;
      const send = async (request: Parameters<typeof saveRoutineDraft>[1]) => {
        calls.push(structuredClone(request));
        const response = await raw(o.cookie, `routines/${request.operation}`, request.input);
        const body = await response.json();
        if (!response.ok) throw { code: body.json?.code ?? body.code, status: response.status };
        const saved = body.json as Routine;
        first ??= saved;
        if (!receipts.has(String(request.input.mutationId))) {
          receipts.add(String(request.input.mutationId));
          throw new Error("Lost committed response");
        }
        return saved;
      };
      const draft = (a: string, name: string, invalid = false) => ({
        operation: "create" as const,
        input: {
          botId: o.bot.id,
          name,
          prompt: "Synthetic",
          crons: [invalid ? "" : "0 9 * * *"],
          nativeTriggers: [make("b"), make(a), make("c")],
        },
        triggerKeys: ["b", "a", "c"],
      });
      await expect(
        saveRoutineDraft(state, draft("a1", "First"), null, send, () => true),
      ).rejects.toThrow("Lost committed response");
      const [b, a, c] = first!.nativeTriggers!;
      for (const row of [b!, c!])
        await database.prisma.nativeRoutineTrigger.update({
          where: { id: row.id },
          data: {
            state: { cursor: row.id },
            leaseId: `lease-${row.id}`,
            leaseUntil: new Date("2030-01-01"),
          },
        });
      const untouched = await database.prisma.nativeRoutineTrigger.findMany({
        where: { id: { in: [b!.id, c!.id] } },
        orderBy: { id: "asc" },
      });
      await expect(
        saveRoutineDraft(state, draft("a2", "Second"), null, send, () => true),
      ).rejects.toThrow("Lost committed response");
      if (metadata) {
        await expect(
          saveRoutineDraft(state, draft("a2", "Metadata"), null, send, () => true),
        ).rejects.toThrow("Lost committed response");
        expect(state.pending!.input).not.toHaveProperty("nativeTriggers");
      }
      const confirmedRequest = structuredClone(state.pending);
      await expect(
        saveRoutineDraft(state, draft("a3", "Third", true), null, send, () => true),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
      // Correcting the first rejected intent must replay the latest acknowledged
      // submission, not create/A1. Lose the corrected write too, then recover it.
      await expect(
        saveRoutineDraft(state, draft("a3", "Third"), null, send, () => true),
      ).rejects.toThrow("Lost committed response");
      expect(calls.at(-2)).toEqual(confirmedRequest);
      const saved = await saveRoutineDraft(state, draft("a3", "Third"), null, send, () => true);
      expect(saved!.id).toBe(first!.id);
      expect(saved!.nativeTriggers!.find((t) => t.id === a!.id)).toMatchObject({
        version: 3,
        spec: make("a3").spec,
      });
      expect(
        await database.prisma.nativeRoutineTrigger.findMany({
          where: { id: { in: [b!.id, c!.id] } },
          orderBy: { id: "asc" },
        }),
      ).toEqual(untouched);
      expect(
        await database.prisma.nativeRoutineTrigger.count({ where: { routineId: first!.id } }),
      ).toBe(3);
      expect(await database.prisma.routine.count({ where: { botId: o.bot.id } })).toBe(2);
      expect(
        await database.prisma.routineMutation.count({
          where: { userId: o.actor.userId, spaceId: o.actor.spaceId },
        }),
      ).toBe(metadata ? 4 : 3);
      expect(state.pending).toBeUndefined();
    },
  );

  it.each(
    ["none", "change", "add", "remove"].flatMap((concurrent) =>
      ["lost", "first rejection", "recovery refusal"].map((transition) => ({
        concurrent,
        transition,
      })),
    ),
  )(
    "keeps the editor trigger baseline across metadata replay: $concurrent / $transition",
    async ({ concurrent, transition }) => {
      const o = await fixture(),
        make = await connected(o),
        state: RoutineSaveState = {};
      const calls: Array<Parameters<typeof saveRoutineDraft>[1]> = [];
      const receipts = new Set<string>();
      let first: Routine | undefined;
      const send = async (request: Parameters<typeof saveRoutineDraft>[1]) => {
        calls.push(structuredClone(request));
        const response = await raw(o.cookie, `routines/${request.operation}`, request.input);
        const body = await response.json();
        if (!response.ok) throw { code: body.json?.code ?? body.code, status: response.status };
        const saved = body.json as Routine;
        first ??= saved;
        if (!receipts.has(String(request.input.mutationId))) {
          receipts.add(String(request.input.mutationId));
          throw new Error("Lost committed response");
        }
        return saved;
      };
      const draft = (name: string, a = "a1", invalid = false) => ({
        operation: "create" as const,
        triggerKeys: ["a", "b", "c"],
        input: {
          botId: o.bot.id,
          name,
          prompt: "Synthetic",
          crons: [invalid ? "" : "0 9 * * *"],
          nativeTriggers: [make(a), make("b-original"), make("c")],
        },
      });
      const attempt = (name: string, a = "a1", invalid = false) =>
        saveRoutineDraft(state, draft(name, a, invalid), null, send, () => true);
      await expect(attempt("First")).rejects.toThrow("Lost committed response");
      await expect(attempt("Metadata one")).rejects.toThrow("Lost committed response");
      expect(state.pending!.input).not.toHaveProperty("nativeTriggers");
      const [a, b, c] = first!.nativeTriggers!;
      if (concurrent !== "none") {
        const inputs = first!.nativeTriggers!.map(inputOf);
        if (concurrent === "change")
          inputs[1] = { ...inputOf(b!), spec: make("b-concurrent").spec };
        if (concurrent === "remove") inputs.splice(1, 1);
        await rpc(o.cookie, "routines/update", {
          routineId: first!.id,
          nativeTriggerBaseline: first!.nativeTriggers!.map(({ id, version }) => ({ id, version })),
          nativeTriggers: concurrent === "add" ? [...inputs, make("d-concurrent")] : inputs,
        });
      }
      for (const row of concurrent === "remove" ? [c!] : [b!, c!])
        await database.prisma.nativeRoutineTrigger.update({
          where: { id: row.id },
          data: {
            state: { cursor: row.id },
            leaseId: `lease-${row.id}`,
            leaseUntil: new Date("2030-01-01"),
          },
        });
      const rows = () =>
        database.prisma.nativeRoutineTrigger.findMany({
          where: { routineId: first!.id },
          orderBy: { id: "asc" },
        });
      const before = await rows();
      if (transition === "recovery refusal") {
        const membership = await database.prisma.spaceMember.findUniqueOrThrow({
          where: { spaceId_userId: { spaceId: o.actor.spaceId, userId: o.actor.userId } },
        });
        const pending = structuredClone(state);
        await database.prisma.spaceMember.delete({ where: { id: membership.id } });
        try {
          await expect(attempt("Metadata two")).rejects.toMatchObject({
            code: "FORBIDDEN",
            status: 403,
          });
        } finally {
          await database.prisma.spaceMember.create({ data: membership });
        }
        expect(state).toEqual(pending);
      }
      if (transition === "first rejection") {
        await expect(attempt("Metadata two", "a1", true)).rejects.toMatchObject({
          code: "BAD_REQUEST",
          status: 400,
        });
      }
      // Metadata is allowed to save despite concurrent trigger changes. It must
      // not upgrade the stale trigger draft's write preconditions as a side effect.
      await expect(attempt("Metadata two")).rejects.toThrow("Lost committed response");
      expect(state.pending!.input).not.toHaveProperty("nativeTriggers");
      if (transition !== "lost") {
        await expect(attempt("Metadata three")).rejects.toThrow("Lost committed response");
        expect(state.pending!.input).not.toHaveProperty("nativeTriggers");
      }
      expect(await rows()).toEqual(before);
      const count = calls.length;
      if (concurrent !== "none") {
        await expect.soft(attempt("Edit A", "a2")).rejects.toThrow("This native trigger changed");
        expect.soft(calls).toHaveLength(count + 1); // Receipt read only; no follow-up write.
        expect.soft(await rows()).toEqual(before);
        expect
          .soft(
            (await database.prisma.routine.findUniqueOrThrow({ where: { id: first!.id } })).name,
          )
          .toBe(transition === "lost" ? "Metadata two" : "Metadata three");
      } else {
        await expect(attempt("Edit A", "a2")).rejects.toThrow("Lost committed response");
        await expect(attempt("Metadata four", "a2")).rejects.toThrow("Lost committed response");
        await expect(attempt("Edit A again", "a3")).rejects.toThrow("Lost committed response");
        const saved = await attempt("Edit A again", "a3");
        expect(saved!.id).toBe(first!.id);
        expect((await rows()).find((row) => row.id === a!.id)).toMatchObject({
          version: 3,
          spec: make("a3").spec,
        });
        expect((await rows()).filter((row) => row.id !== a!.id)).toEqual(
          before.filter((row) => row.id !== a!.id),
        );
      }
      expect(await database.prisma.routine.count({ where: { botId: o.bot.id } })).toBe(2);
      expect((await rows()).length).toBe(
        concurrent === "add" ? 4 : concurrent === "remove" ? 2 : 3,
      );
    },
  );

  it.each(["metadata", "lost then forbidden", "scope cancellation", "edit trigger"])(
    "retains cancellation after a rejected metadata follow-up: %s",
    async (mode) => {
      const o = await fixture(),
        make = await connected(o),
        state: RoutineSaveState = {};
      const initial = await update(o, { nativeTriggers: [make("a1"), make("b")] });
      const [a, b] = initial.nativeTriggers!;
      const calls: Array<Parameters<typeof saveRoutineDraft>[1]> = [];
      const receipts = new Set<string>();
      const send = async (request: Parameters<typeof saveRoutineDraft>[1]) => {
        calls.push(structuredClone(request));
        const response = await raw(o.cookie, `routines/${request.operation}`, request.input);
        const body = await response.json();
        if (!response.ok) throw { code: body.json?.code ?? body.code, status: response.status };
        if (!receipts.has(String(request.input.mutationId))) {
          receipts.add(String(request.input.mutationId));
          if (receipts.size === 1 || mode === "lost then forbidden")
            throw new Error("Lost committed response");
        }
        return body.json as Routine;
      };
      const triggers = (calendarId: string) => ({
        nativeTriggers: [{ ...inputOf(a!), spec: make(calendarId).spec }, inputOf(b!)],
        nativeTriggerBaseline: initial.nativeTriggers!.map(({ id, version }) => ({ id, version })),
      });
      const request = (input: Record<string, unknown>) => ({
        operation: "update" as const,
        triggerKeys: ["a", "b"],
        input: { routineId: initial.id, ...input },
      });
      await expect(
        saveRoutineDraft(state, request(triggers("a2")), initial, send, () => true),
      ).rejects.toThrow("Lost committed response");
      state.discarded = true; // Actual mobile Cancel retains the unresolved request.
      for (const row of [a!, b!])
        await database.prisma.nativeRoutineTrigger.update({
          where: { id: row.id },
          data: {
            state: { cursor: row.id },
            leaseId: `lease-${row.id}`,
            leaseUntil: new Date("2030-01-01"),
          },
        });
      const rows = () =>
        database.prisma.nativeRoutineTrigger.findMany({
          where: { routineId: initial.id },
          orderBy: { id: "asc" },
        });
      const committed = await rows();
      await expect(
        saveRoutineDraft(
          state,
          request({ name: "Rejected", crons: [""] }),
          initial,
          send,
          () => true,
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
      expect(calls[2]!.input).not.toHaveProperty("nativeTriggers");
      if (mode === "scope cancellation") {
        const before = structuredClone(state),
          count = calls.length;
        expect(
          await saveRoutineDraft(state, request({ name: "Corrected" }), initial, send, () => false),
        ).toBeUndefined();
        expect(state).toEqual(before);
        expect(calls).toHaveLength(count + 1);
      }
      const corrected = request({
        name: "Corrected",
        ...(mode === "edit trigger" ? triggers("a3") : {}),
      });
      if (mode === "lost then forbidden") {
        await expect(saveRoutineDraft(state, corrected, initial, send, () => true)).rejects.toThrow(
          "Lost committed response",
        );
        const before = structuredClone(state);
        const membership = await database.prisma.spaceMember.findUniqueOrThrow({
          where: { spaceId_userId: { spaceId: o.actor.spaceId, userId: o.actor.userId } },
        });
        await database.prisma.spaceMember.delete({ where: { id: membership.id } });
        try {
          await expect(
            saveRoutineDraft(state, corrected, initial, send, () => true),
          ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
        } finally {
          await database.prisma.spaceMember.create({ data: membership });
        }
        expect(state).toEqual(before);
      }
      const saved = await saveRoutineDraft(state, corrected, initial, send, () => true);
      expect(saved!.id).toBe(initial.id);
      expect(saved!.name).toBe("Corrected");
      if (mode === "edit trigger") {
        expect((await rows()).find((row) => row.id === a!.id)).toMatchObject({
          version: 3,
          spec: make("a3").spec,
        });
        expect((await rows()).find((row) => row.id === b!.id)).toEqual(
          committed.find((row) => row.id === b!.id),
        );
      } else {
        expect
          .soft(
            calls
              .slice(3)
              .filter((call) => call.input.name === "Corrected")
              .every((call) => !("nativeTriggers" in call.input)),
          )
          .toBe(true);
        expect.soft(await rows()).toEqual(committed);
      }
      expect(await database.prisma.routine.count({ where: { botId: o.bot.id } })).toBe(1);
      expect(
        await database.prisma.nativeRoutineTrigger.count({ where: { routineId: initial.id } }),
      ).toBe(2);
      expect(state.pending).toBeUndefined();
    },
  );

  it("receipt-only update replay returns current activation after pause and resume", async () => {
    const o = await fixture();
    await update(o, { active: true });
    const input = { mutationId: randomUUID(), name: "Edited", routineId: o.routine.id };
    await rpc(o.cookie, "routines/update", input); // Simulate losing this result.
    await update(o, { active: false });
    expect(await rpc(o.cookie, "routines/update", input)).toMatchObject({
      id: o.routine.id,
      active: false,
    });
    await update(o, { active: true });
    expect(await rpc(o.cookie, "routines/update", input)).toMatchObject({
      id: o.routine.id,
      active: true,
    });
    expect((await rpc<Routine[]>(o.cookie, "routines/list", { botId: o.bot.id }))[0]!.active).toBe(
      true,
    );
  });

  it("sparse update preserves concurrent schedule, model, pause and external flags", async () => {
    const o = await fixture();
    await database.prisma.routine.update({
      where: { id: o.routine.id },
      data: {
        active: false,
        modelProvider: "synthetic",
        modelId: "synthetic-model",
        crons: ["30 6 * * *"],
        githubEnabled: true,
      },
    });
    const v = await update(o, { webhookEnabled: true });
    expect(v).toMatchObject({
      active: false,
      modelProvider: "synthetic",
      modelId: "synthetic-model",
      crons: ["30 6 * * *"],
      githubEnabled: true,
      webhookEnabled: true,
    });
    const stranger = await account();
    expect(
      (
        await raw(stranger.cookie, "routines/update", {
          routineId: o.routine.id,
          webhookEnabled: false,
        })
      ).status,
    ).toBe(404);
    expect(
      (await raw("", "routines/update", { routineId: o.routine.id, webhookEnabled: false })).status,
    ).toBe(401);
  });
  it("stale event edit must preserve a concurrently added second trigger", async () => {
    const o = await fixture(),
      make = await connected(o);
    const initial = await update(o, { active: false, nativeTriggers: [make("calendar-a")] });
    const draft = routineTriggerDraft(initial);
    draft.nativeTriggers![0]!.calendarId = "calendar-a-edited";
    await update(o, { nativeTriggers: [inputOf(initial.nativeTriggers![0]!), make("calendar-b")] });
    const response = await raw(o.cookie, "routines/update", {
      routineId: o.routine.id,
      ...routineTriggerPatch(initial, draft),
    });
    const read = (await rpc<Routine[]>(o.cookie, "routines/list", { botId: o.bot.id }))[0]!;
    expect(
      response.status === 409 && read.nativeTriggers!.length === 2,
      "must conflict or retain unseen trigger B",
    ).toBe(true);
  });
  it("stale remove-all must not erase a concurrently edited trigger", async () => {
    const o = await fixture(),
      make = await connected(o);
    const initial = await update(o, { active: false, nativeTriggers: [make("calendar-a")] });
    await update(o, {
      nativeTriggers: [
        { ...inputOf(initial.nativeTriggers![0]!), spec: make("calendar-new").spec },
      ],
    });
    const draft = routineTriggerDraft(initial);
    draft.nativeTriggers = [];
    const response = await raw(o.cookie, "routines/update", {
      routineId: o.routine.id,
      ...routineTriggerPatch(initial, draft),
    });
    const read = (await rpc<Routine[]>(o.cookie, "routines/list", { botId: o.bot.id }))[0]!;
    expect(
      response.status === 409 && read.nativeTriggers!.length === 1,
      "must conflict or retain concurrently updated trigger",
    ).toBe(true);
  });
  it("lost create response and retry should retain one routine identity", async () => {
    const o = await fixture();
    const input = {
      mutationId: randomUUID(),
      botId: o.bot.id,
      name: "lost-response",
      prompt: "Synthetic",
      crons: [],
      webhookEnabled: true,
      active: false,
    };
    const first = await raw(o.cookie, "routines/create", input);
    expect(first.ok).toBe(true);
    // Response deliberately discarded, as when transport drops after commit.
    const retried = await rpc<Routine>(o.cookie, "routines/create", input);
    const all = await rpc<Routine[]>(o.cookie, "routines/list", { botId: o.bot.id });
    expect(all.filter((r) => r.name === "lost-response").map((r) => r.id)).toEqual([retried.id]);
  });
  it("stale included version conflicts atomically and disconnected account is rejected", async () => {
    const o = await fixture(),
      make = await connected(o);
    const initial = await update(o, { active: false, nativeTriggers: [make("calendar-a")] });
    const item = inputOf(initial.nativeTriggers![0]!);
    await update(o, { nativeTriggers: [{ ...item, spec: make("calendar-b").spec }] });
    expect(
      (
        await raw(o.cookie, "routines/update", {
          routineId: o.routine.id,
          name: "must-not-save",
          nativeTriggers: [item],
        })
      ).status,
    ).toBe(409);
    const read = (await rpc<Routine[]>(o.cookie, "routines/list", { botId: o.bot.id }))[0]!;
    expect(read.name).not.toBe("must-not-save");
    await database.prisma.connection.update({
      where: { id: item.connectionId },
      data: { status: "disconnected" },
    });
    expect(
      (
        await raw(o.cookie, "routines/update", {
          routineId: o.routine.id,
          nativeTriggers: [inputOf(read.nativeTriggers![0]!)],
        })
      ).status,
    ).toBe(400);
  });

  it("lost update response: added trigger identity must survive identical retry", async () => {
    const o = await fixture(),
      make = await connected(o);
    const initial = await update(o, { active: false, nativeTriggers: [make("calendar-a")] });
    const draft = routineTriggerDraft(initial);
    const added = draftFromNativeRoutineTrigger({
      ...initial.nativeTriggers![0],
      id: "temporary",
      spec: make("calendar-b").spec,
    });
    delete added.id;
    delete added.expectedVersion;
    draft.nativeTriggers.push(added);
    const patch = { ...routineTriggerPatch(initial, draft), mutationId: randomUUID() };
    const first = await update(o, patch);
    const addedId = first.nativeTriggers!.find(
      (t) => t.spec.kind === "calendar.event_changed" && t.spec.calendarId === "calendar-b",
    )!.id;
    await database.prisma.nativeRoutineTrigger.update({
      where: { id: addedId },
      data: { state: { cursor: "retained" }, leaseId: "synthetic-lease" },
    });
    const before = await database.prisma.nativeRoutineTrigger.findUniqueOrThrow({
      where: { id: addedId },
    });
    const second = await update(o, patch);
    expect(
      await database.prisma.nativeRoutineTrigger.findUniqueOrThrow({ where: { id: addedId } }),
    ).toEqual(before);
    expect(
      second.nativeTriggers!.map((t) => t.id).sort(),
      "retry must not delete/recreate the just-added trigger",
    ).toEqual(first.nativeTriggers!.map((t) => t.id).sort());
  });
  it("simultaneous identical creates commit one identity; changed, foreign, and deleted replays are safe", async () => {
    const o = await fixture();
    const input = {
      mutationId: randomUUID(),
      botId: o.bot.id,
      name: "Concurrent",
      prompt: "Synthetic",
      crons: ["0 9 * * *"],
    };
    const saved = await Promise.all([
      rpc<Routine>(o.cookie, "routines/create", input),
      rpc<Routine>(o.cookie, "routines/create", input),
    ]);
    expect(saved[0]!.id).toBe(saved[1]!.id);
    expect((await raw(o.cookie, "routines/create", { ...input, prompt: "Changed" })).status).toBe(
      409,
    );
    const other = await account();
    expect((await raw(other.cookie, "routines/create", input)).status).toBe(404);
    const space = await rpc<{ id: string }>(o.cookie, "spaces/create", { name: "Other scope" });
    expect((await raw(o.cookie, "routines/create", input, space.id)).status).toBe(404);
    await rpc(o.cookie, "routines/remove", { routineId: saved[0]!.id });
    expect((await raw(o.cookie, "routines/create", input)).status).toBe(404);
    expect(await database.prisma.routine.count({ where: { id: saved[0]!.id } })).toBe(0);
  });
  it("racing distinct event writes under real transactions cannot lose an addition", async () => {
    const o = await fixture(),
      make = await connected(o);
    const initial = await update(o, { nativeTriggers: [make("calendar-a")] });
    const a = routineTriggerDraft(initial),
      b = routineTriggerDraft(initial);
    a.nativeTriggers[0]!.calendarId = "edited-a";
    const added = draftFromNativeRoutineTrigger({
      ...initial.nativeTriggers![0]!,
      id: "temporary",
      spec: make("calendar-b").spec,
    });
    delete added.id;
    delete added.expectedVersion;
    b.nativeTriggers.push(added);
    const responses = await Promise.all(
      [a, b].map((d) =>
        raw(o.cookie, "routines/update", {
          routineId: o.routine.id,
          ...routineTriggerPatch(initial, d),
          mutationId: randomUUID(),
        }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const read = (await rpc<Routine[]>(o.cookie, "routines/list", { botId: o.bot.id }))[0]!;
    expect(read.nativeTriggers!.length).toBe(responses[1]!.ok ? 2 : 1);
  });
  it("rejects legacy blind removals and rolls back its receipt and ordinary fields", async () => {
    const o = await fixture(),
      make = await connected(o);
    const initial = await update(o, { nativeTriggers: [make("calendar-a")] });
    const mutationId = randomUUID();
    expect(
      (
        await raw(o.cookie, "routines/update", {
          routineId: o.routine.id,
          mutationId,
          name: "must rollback",
          nativeTriggers: [],
        })
      ).status,
    ).toBe(409);
    const read = (await rpc<Routine[]>(o.cookie, "routines/list", { botId: o.bot.id }))[0]!;
    expect(read.name).toBe(initial.name);
    // A failed transaction leaves no receipt; corrected request can use the intent.
    const removed = await update(o, {
      mutationId,
      nativeTriggers: [],
      nativeTriggerBaseline: initial.nativeTriggers!.map(({ id, version }) => ({ id, version })),
    });
    expect(removed.nativeTriggers).toEqual([]);
  });

  it("rechecks the entire baseline after resource verification pauses across another commit", async () => {
    const o = await fixture(),
      make = await connected(o);
    const initial = await update(o, { nativeTriggers: [make("calendar-a")] });
    const draft = routineTriggerDraft(initial);
    draft.nativeTriggers[0]!.calendarId = "edited-a";
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    beforePrepare = async () => {
      beforePrepare = undefined;
      entered();
      await gate;
    };
    const stale = raw(o.cookie, "routines/update", {
      routineId: o.routine.id,
      name: "must rollback",
      ...routineTriggerPatch(initial, draft),
    });
    await waiting;
    try {
      await update(o, {
        nativeTriggers: [inputOf(initial.nativeTriggers![0]!), make("calendar-b")],
      });
    } finally {
      release();
      beforePrepare = undefined;
    }
    expect((await stale).status).toBe(409);
    const read = (await rpc<Routine[]>(o.cookie, "routines/list", { botId: o.bot.id }))[0]!;
    expect(read.nativeTriggers).toHaveLength(2);
    expect(read.name).toBe(initial.name);
  });
});
