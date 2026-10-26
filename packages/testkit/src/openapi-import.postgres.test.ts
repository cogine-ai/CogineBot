import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  SecretContext,
  SecretPutOptions,
  SecretRecord,
} from "@rakazo/adapter-kit";
import { ComposioEmulator, EncryptedSecretStore } from "@rakazo/adapters";
import type {
  Actor,
  OpenApiImportConfirmation,
  OpenApiImportInput,
  OpenApiImportPreview,
  Space,
} from "@rakazo/contracts";
import { OpenApiImportConfirmationSchema, OpenApiImportPreviewSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { parametersFor } from "../../adapters/src/pi-runtime.js";
import { sessionCookieHeader } from "./index.js";

type AppHandles = Awaited<ReturnType<typeof createApp>>;
type Reply = () => Promise<Response>;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
const target = "https://service.example.test/v1";
const credential = "synthetic-import-credential";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Distinct opaque refs model a vault boundary; database persistence stays real. */
class ImportSecretStore extends EncryptedSecretStore {
  readonly values = new Map<string, string>();
  readonly puts: SecretRecord[] = [];
  readonly deleted: string[] = [];
  failPut = false;
  failDelete = false;
  beforePut?: () => void | Promise<void>;
  afterPut?: () => void | Promise<void>;

  override async put(value: string, context: AdapterContext, options: SecretPutOptions = {}) {
    context.signal.throwIfAborted();
    await this.beforePut?.();
    if (this.failPut) throw new Error("Synthetic vault put failure");
    const id = options.recordId ?? randomUUID();
    const ref = `synthetic-vault:${randomUUID()}`;
    const record = { id, ref, ciphertext: ref };
    this.values.set(ref, value);
    this.puts.push(record);
    await this.afterPut?.();
    return record;
  }

  override async load(ref: string, _context: SecretContext) {
    const value = this.values.get(ref);
    if (value === undefined) throw new Error("Synthetic vault ref missing");
    return value;
  }

  override async delete(ref: string, _context: SecretContext) {
    this.deleted.push(ref);
    if (this.failDelete) throw new Error("Synthetic vault cleanup failure");
    this.values.delete(ref);
  }
}

function documentFor(baseUrl = target) {
  return {
    openapi: "3.0.3",
    servers: [{ url: baseUrl }],
    paths: {
      "/items/{itemId}": {
        post: {
          operationId: "update_item",
          description: "Update the selected item",
          parameters: [
            {
              name: "itemId",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 2 },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 10, default: 5 },
            },
            { name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } },
            { name: "X-Trace", in: "header", schema: { type: "string", minLength: 2 } },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: ["object", "null"],
                  properties: { title: { type: "string", minLength: 2 } },
                  additionalProperties: false,
                },
              },
            },
          },
        },
      },
    },
  };
}

describe.skipIf(!enabled).sequential("OpenAPI review through the real API and PostgreSQL", () => {
  let handles: AppHandles;
  let pool: ReturnType<typeof createDb>["pool"];
  let cookie: string;
  let otherCookie: string;
  let actor: Actor;
  let otherActor: Actor;
  let space: Space;
  let dataDir: string;
  let now = Date.now();
  const secrets = new ImportSecretStore("synthetic-import-encryption-key");
  const documents = new Map<string, unknown>();
  const replies = new Map<string, Reply[]>();
  const sourceRequests: string[] = [];
  const outbound: Array<{ url: string; method: string; headers: Headers; body?: BodyInit | null }> =
    [];
  let transactionFailure: "start" | "rollback" | undefined;

  // Only the transaction boundary faults; every model/query uses real Prisma/PG.
  function faultablePrisma(prisma: PrismaClient): PrismaClient {
    return new Proxy(prisma, {
      get(client, property, receiver) {
        if (property === "$extends")
          return (...args: unknown[]) =>
            faultablePrisma(Reflect.apply(client.$extends, client, args) as PrismaClient);
        if (property !== "$transaction") return Reflect.get(client, property, receiver);
        return async (...args: unknown[]) => {
          const failure = transactionFailure;
          transactionFailure = undefined;
          if (failure === "start") throw new Error("Synthetic transaction start failure");
          if (failure === "rollback" && typeof args[0] === "function") {
            const callback = args[0] as (tx: unknown) => Promise<unknown>;
            args[0] = async (tx: unknown) => {
              await callback(tx);
              throw new Error("Synthetic transaction rollback");
            };
          }
          return Reflect.apply(client.$transaction, client, args);
        };
      },
    });
  }

  async function raw(
    procedure: string,
    input: unknown,
    options: { cookie?: string; spaceId?: string; signal?: AbortSignal } = {},
  ) {
    return handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: options.cookie ?? cookie,
        origin,
        "x-rakazo-space-id": options.spaceId ?? space.id,
      },
      body: JSON.stringify({ json: input }),
      signal: options.signal,
    });
  }

  async function rpc<T>(
    procedure: string,
    input: unknown,
    options: Parameters<typeof raw>[2] = {},
  ): Promise<T> {
    const response = await raw(procedure, input, options);
    const body = (await response.json()) as { json?: T };
    if (!response.ok) throw new Error(`${procedure} failed (${response.status})`);
    return body.json as T;
  }

  async function signup() {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `openapi-${randomUUID()}@example.test`,
        password: "password12",
        name: "Import fixture",
      }),
    });
    expect(response.ok).toBe(true);
    return sessionCookieHeader(response);
  }

  function input(document: unknown = documentFor()): OpenApiImportInput {
    const source = `https://import.example.test/${randomUUID()}.yaml`;
    documents.set(source, document);
    return { name: "Reviewed API", source, config: { auth: { type: "bearer" } }, credential };
  }

  async function preview(request: OpenApiImportInput) {
    return OpenApiImportPreviewSchema.parse(
      await rpc<OpenApiImportPreview>("capabilities/previewOpenApi", request),
    );
  }

  async function ready(request: OpenApiImportInput) {
    const result = await preview(request);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected a valid review");
    return { ...request, reviewToken: result.reviewToken };
  }

  async function confirm(request: Awaited<ReturnType<typeof ready>>) {
    return OpenApiImportConfirmationSchema.parse(
      await rpc<OpenApiImportConfirmation>("capabilities/confirmOpenApi", request),
    );
  }

  async function receipt(reviewToken: string) {
    return OpenApiImportConfirmationSchema.parse(
      await rpc<OpenApiImportConfirmation>("capabilities/openApiReceipt", { reviewToken }),
    );
  }

  async function counts() {
    const where = { spaceId: space.id, userId: actor.userId };
    const [installs, secretRows, receipts] = await Promise.all([
      handles.prisma.capabilityInstall.count({ where }),
      handles.prisma.secret.count({ where }),
      handles.prisma.openApiImportReceipt.count({ where }),
    ]);
    return { installs, secretRows, receipts, puts: secrets.puts.length };
  }

  function pauseNext(source: string, reply?: Reply) {
    const entered = deferred();
    const release = deferred();
    replies.set(source, [
      async () => {
        entered.resolve();
        await release.promise;
        return reply ? reply() : Response.json(documents.get(source));
      },
    ]);
    return { entered: entered.promise, release: release.resolve };
  }

  async function expireLease() {
    const row = await handles.prisma.openApiImportReceipt.findFirstOrThrow({
      where: { spaceId: space.id },
    });
    expect(row.state).toBe("pending");
    await handles.prisma.openApiImportReceipt.update({
      where: { id: row.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    return row;
  }

  beforeAll(async () => {
    const sessionUrl = new URL(process.env.DATABASE_URL!);
    sessionUrl.searchParams.set("options", "-c TimeZone=Pacific/Honolulu");
    const db = createDb(sessionUrl.toString(), { applicationName: "openapi-product-fixture" });
    pool = db.pool;
    const { createApp } = await import("../../../apps/api/src/app.ts");
    dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-openapi-import-"));
    handles = await createApp({
      prisma: faultablePrisma(db.prisma),
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      authUrl: origin,
      webOrigin: origin,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      composio: new ComposioEmulator(),
      signupsEnabled: "true",
      secretStore: secrets,
      openApiNow: () => now,
      remoteConnectors: {
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        fetch: async (request, init) => {
          const url = new URL(request instanceof Request ? request.url : String(request));
          if (url.hostname === "import.example.test") {
            sourceRequests.push(url.href);
            const queued = replies.get(url.href)?.shift();
            return queued
              ? queued()
              : typeof documents.get(url.href) === "string"
                ? new Response(documents.get(url.href) as string)
                : Response.json(documents.get(url.href));
          }
          if (url.hostname === "service.example.test") {
            outbound.push({
              url: url.href,
              method: init?.method ?? "GET",
              headers: new Headers(init?.headers),
              body: init?.body,
            });
            return Response.json({ accepted: true, itemId: url.pathname.split("/").at(-1) });
          }
          throw new Error("Unexpected synthetic HTTP target");
        },
      },
    });
    cookie = await signup();
    otherCookie = await signup();
    const response = await handles.app.request("/rpc/me", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ json: {} }),
    });
    actor = ((await response.json()) as { json: Actor }).json;
    const otherResponse = await handles.app.request("/rpc/me", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: otherCookie, origin },
      body: JSON.stringify({ json: {} }),
    });
    otherActor = ((await otherResponse.json()) as { json: Actor }).json;
    expect(actor.isDeploymentOwner).toBe(true);
  });

  beforeEach(async () => {
    now = Date.now();
    secrets.puts.length = 0;
    secrets.deleted.length = 0;
    secrets.failPut = false;
    secrets.failDelete = false;
    secrets.beforePut = undefined;
    secrets.afterPut = undefined;
    transactionFailure = undefined;
    sourceRequests.length = 0;
    outbound.length = 0;
    replies.clear();
    const response = await handles.app.request("/rpc/spaces/create", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ json: { name: `Import ${randomUUID()}` } }),
    });
    expect(response.ok).toBe(true);
    space = ((await response.json()) as { json: Space }).json;
  });

  afterAll(async () => {
    await handles?.stop();
    await pool?.end();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("previews partial YAML imports without creating an intent, install, or secret", async () => {
    const request = input(
      `openapi: 3.0.3\nservers:\n  - url: ${target}\npaths:\n  /items:\n    get:\n      operationId: list_items\n    trace:\n      operationId: rejected_trace\n`,
    );
    const result = await preview(request);
    expect(result).toMatchObject({
      status: "ready",
      target,
      operations: [{ id: "list_items", method: "GET", path: "/items", readOnly: true }],
      counts: { accepted: 1 },
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "unsupported_method" }),
    );
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(result.reviewToken!.length).toBeLessThanOrEqual(4096);
    expect(await counts()).toEqual({ installs: 0, secretRows: 0, receipts: 0, puts: 0 });
  });

  it("retains typed all-invalid diagnostics and never issues a review token", async () => {
    const request = input({
      openapi: "3.0.3",
      servers: [{ url: target }],
      paths: {
        "/items": {
          get: {
            operationId: "unsafe_ref",
            parameters: [{ $ref: "https://schemas.example.test/remote" }],
          },
        },
      },
    });
    expect(await preview(request)).toMatchObject({
      status: "invalid",
      reviewToken: null,
      expiresAt: null,
      operations: [],
      diagnostics: [{ code: "external_reference" }],
      counts: { accepted: 0, rejected: 1 },
    });
    expect(await counts()).toEqual({ installs: 0, secretRows: 0, receipts: 0, puts: 0 });
  });

  it("uses read-only pending recovery while the valid review has no receipt row", async () => {
    const request = await ready(input());
    const fetched = sourceRequests.length;
    expect(await receipt(request.reviewToken)).toMatchObject({ status: "pending" });
    expect(sourceRequests).toHaveLength(fetched);
    expect(await counts()).toEqual({ installs: 0, secretRows: 0, receipts: 0, puts: 0 });
    expect(await confirm(request)).toMatchObject({ status: "installed", replayed: false });
    expect(await counts()).toMatchObject({ installs: 1, receipts: 1, puts: 1 });
  });

  it("re-fetches the reviewed plan and executes unchanged strict arguments through the composed provider", async () => {
    const request = await ready(input());
    const confirmed = await confirm(request);
    expect(confirmed.status).toBe("installed");
    if (confirmed.status !== "installed") throw new Error("Expected an install");
    expect(sourceRequests).toHaveLength(2);
    const stored = await handles.prisma.capabilityInstall.findUniqueOrThrow({
      where: { id: confirmed.install.id },
    });
    const operation = (
      stored.config as { operations: Array<{ importPolicy: string; inputSchema: unknown }> }
    ).operations[0]!;
    expect(operation.importPolicy).toBe("openapi-v1");
    expect(operation.inputSchema).toMatchObject({
      required: ["itemId"],
      properties: { limit: { minimum: 1, maximum: 10, default: 5 } },
    });
    const secret = await handles.prisma.secret.findUniqueOrThrow({
      where: { id: stored.secretId! },
    });
    expect(secret.ciphertext).not.toContain(credential);
    expect(secrets.values.get(secret.ciphertext)).toBe(credential);
    const provider = handles.connectors;
    const context = {
      userId: actor.userId,
      spaceId: space.id,
      operationId: "openapi-acceptance",
      traceId: "openapi-acceptance",
      signal: new AbortController().signal,
    };
    const tools = await provider.discoverTools(context);
    const tool = tools.find((candidate) => candidate.route?.resourceId === stored.id)!;
    expect(tool).toMatchObject({ readOnly: false, route: { connectorId: "installed" } });
    expect(JSON.parse(JSON.stringify(parametersFor(tool)))).toHaveProperty("properties.body");
    const args = { itemId: "item-1", limit: 3, tags: ["a", "b"], "X-Trace": "trace-1", body: null };
    const run = async (arguments_: Record<string, unknown>) => {
      const events = [];
      for await (const event of provider.execute(
        { tool: tool.name, route: tool.route, args: arguments_, executionId: randomUUID() },
        context,
      ))
        events.push(event);
      return events;
    };
    expect(await run(args)).toContainEqual(expect.objectContaining({ type: "result" }));
    expect(outbound).toHaveLength(1);
    const sent = outbound[0]!;
    expect(sent.url).toBe(`${target}/items/item-1?limit=3&tags=a&tags=b`);
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${credential}`);
    expect(sent.headers.get("x-trace")).toBe("trace-1");
    expect(sent.body).toBe("null");
    expect(args).toEqual({
      itemId: "item-1",
      limit: 3,
      tags: ["a", "b"],
      "X-Trace": "trace-1",
      body: null,
    });
    expect(await run({ itemId: "item-2" })).toContainEqual(
      expect.objectContaining({ type: "result" }),
    );
    expect(outbound[1]!.url).toBe(`${target}/items/item-2`);
    expect(outbound[1]!.body).toBeUndefined();
    for (const invalid of [
      { ...args, limit: 0 },
      { ...args, limit: "3" },
      { ...args, extra: true },
      { ...args, body: { title: "x" } },
    ]) {
      expect(await run(invalid)).toEqual([
        { type: "error", message: expect.stringContaining("schema") },
      ]);
    }
    expect(outbound).toHaveLength(2);
    expect(await counts()).toEqual({ installs: 1, secretRows: 1, receipts: 1, puts: 1 });
  });

  it("rejects document changes after review before storing any credential", async () => {
    const request = await ready(input());
    const changed = documentFor();
    changed.paths["/items/{itemId}"].post.description = "Changed after review";
    documents.set(request.source, changed);
    expect(await confirm(request)).toMatchObject({ status: "stale" });
    expect(await counts()).toEqual({ installs: 0, secretRows: 0, receipts: 1, puts: 0 });
    documents.set(request.source, documentFor());
    expect(await confirm(request)).toMatchObject({ status: "stale" });
    expect(await counts()).toMatchObject({ installs: 0, puts: 0 });
  });

  it("rejects changed snapshots, actor, and Space before network or writes", async () => {
    const request = await ready(input());
    for (const changed of [
      { ...request, name: "Other name" },
      { ...request, source: `${request.source}?changed=1` },
      { ...request, config: { auth: { type: "none" } } },
      { ...request, credential: "other-synthetic-credential" },
    ]) {
      expect(await confirm(changed)).toMatchObject({ status: "stale" });
    }
    expect(
      await confirm({ ...request, reviewToken: `${request.reviewToken.slice(0, -4)}AAAA` }),
    ).toMatchObject({ status: "invalid" });
    for (const malformed of [
      { ...request, name: "" },
      { ...request, reviewToken: "" },
    ]) {
      expect((await raw("capabilities/confirmOpenApi", malformed)).status).toBe(400);
    }
    const anotherSpace = await rpc<Space>("spaces/create", { name: "Other import space" });
    expect(
      await rpc<OpenApiImportConfirmation>("capabilities/confirmOpenApi", request, {
        spaceId: anotherSpace.id,
      }),
    ).toMatchObject({ status: "invalid" });
    expect(
      await rpc<OpenApiImportConfirmation>("capabilities/confirmOpenApi", request, {
        cookie: otherCookie,
        spaceId: otherActor.spaceId,
      }),
    ).toMatchObject({ status: "invalid" });
    expect(sourceRequests).toHaveLength(1);
    expect(await counts()).toEqual({ installs: 0, secretRows: 0, receipts: 0, puts: 0 });
  });

  it("does not allow old install flags to bypass review", async () => {
    const request = input();
    expect(
      (
        await raw("capabilities/install", {
          ...request,
          kind: "api",
          config: { ...request.config, openApi: true },
        })
      ).status,
    ).toBe(400);
    expect(await counts()).toEqual({ installs: 0, secretRows: 0, receipts: 0, puts: 0 });
  });

  it("does not create a receipt or fetch for an unrecorded expired review", async () => {
    const request = await ready(input());
    now += 16 * 60_000;
    expect(await receipt(request.reviewToken)).toMatchObject({ status: "expired" });
    expect(await confirm(request)).toMatchObject({ status: "expired" });
    expect(sourceRequests).toHaveLength(1);
    expect(await counts()).toEqual({ installs: 0, secretRows: 0, receipts: 0, puts: 0 });
  });

  it("recovers a lost committed response after expiry and never resurrects a removed install", async () => {
    const request = await ready(input());
    const installed = await confirm(request);
    if (installed.status !== "installed") throw new Error("Expected an install");
    now += 16 * 60_000;
    expect(await receipt(request.reviewToken)).toMatchObject({
      status: "installed",
      replayed: true,
      install: { id: installed.install.id },
    });
    expect(await confirm(request)).toMatchObject({
      status: "installed",
      replayed: true,
      install: { id: installed.install.id },
    });
    expect(sourceRequests).toHaveLength(2);
    await rpc("capabilities/remove", { id: installed.install.id });
    const tombstone = await handles.prisma.openApiImportReceipt.findFirstOrThrow({
      where: { spaceId: space.id },
    });
    expect(tombstone.installId).toBeNull();
    expect(await receipt(request.reviewToken)).toMatchObject({ status: "removed" });
    expect(await confirm(request)).toMatchObject({ status: "removed" });
    expect(sourceRequests).toHaveLength(2);
    expect(await counts()).toEqual({ installs: 0, secretRows: 0, receipts: 1, puts: 1 });
  });

  it("shares a single pending identity between simultaneous confirms and recovers the winner", async () => {
    const request = await ready(input());
    const paused = pauseNext(request.source);
    const first = confirm(request);
    try {
      await paused.entered;
      expect(await confirm(request)).toMatchObject({ status: "pending" });
      expect(await receipt(request.reviewToken)).toMatchObject({ status: "pending" });
      expect(await counts()).toEqual({ installs: 0, secretRows: 0, receipts: 1, puts: 0 });
    } finally {
      paused.release();
    }
    expect(await first).toMatchObject({ status: "installed", replayed: false });
    expect(await confirm(request)).toMatchObject({ status: "installed", replayed: true });
    expect(await counts()).toEqual({ installs: 1, secretRows: 1, receipts: 1, puts: 1 });
    expect(sourceRequests).toHaveLength(2);
  });

  it("keeps lease and signed review timestamps in UTC under a non-UTC database session", async () => {
    const clocks = await handles.prisma.$queryRaw<
      Array<{ timezone: string }>
    >`SELECT current_setting('TimeZone') AS timezone`;
    expect(clocks[0]?.timezone).toBe("Pacific/Honolulu");
    const request = await ready(input());
    const paused = pauseNext(request.source);
    const first = confirm(request);
    try {
      await paused.entered;
      const row = await handles.prisma.openApiImportReceipt.findFirstOrThrow({
        where: { spaceId: space.id },
      });
      expect(row.reviewExpiresAt.getTime()).toBe(now + 15 * 60_000);
      expect(Math.abs(row.leaseExpiresAt!.getTime() - Date.now() - 60_000)).toBeLessThan(5_000);
      expect(await confirm(request)).toMatchObject({ status: "pending" });
    } finally {
      paused.release();
    }
    expect(await first).toMatchObject({ status: "installed" });
    expect(await receipt(request.reviewToken)).toMatchObject({
      status: "installed",
      replayed: true,
    });
    expect(await counts()).toEqual({ installs: 1, secretRows: 1, receipts: 1, puts: 1 });
  });

  it.each(["success", "stale", "fetch-failure", "put-failure"] as const)(
    "fences a late %s owner after a lease takeover",
    async (late) => {
      const request = await ready(input());
      const paused = pauseNext(request.source, async () => {
        if (late === "fetch-failure") throw new Error("Synthetic late source failure");
        if (late === "put-failure") secrets.failPut = true;
        const document = documentFor();
        if (late === "stale")
          document.paths["/items/{itemId}"].post.description = "Late stale result";
        return Response.json(document);
      });
      const first = confirm(request);
      let winner: OpenApiImportConfirmation;
      try {
        await paused.entered;
        const original = await expireLease();
        winner = await confirm(request);
        expect(winner).toMatchObject({ status: "installed", replayed: false });
        const fenced = await handles.prisma.openApiImportReceipt.findUniqueOrThrow({
          where: { id: original.id },
        });
        expect(fenced.generation).toBeGreaterThan(original.generation);
        expect(fenced.state).toBe("installed");
      } finally {
        paused.release();
      }
      expect(await first).toMatchObject({ status: "installed", replayed: true });
      secrets.failPut = false;
      const current = await receipt(request.reviewToken);
      expect(current).toMatchObject({
        status: "installed",
        install: { id: winner!.status === "installed" ? winner!.install.id : "missing" },
      });
      const install = await handles.prisma.capabilityInstall.findFirstOrThrow({
        where: { spaceId: space.id },
      });
      const secret = await handles.prisma.secret.findUniqueOrThrow({
        where: { id: install.secretId! },
      });
      expect(secrets.values.get(secret.ciphertext)).toBe(credential);
      expect(secrets.deleted).not.toContain(secret.ciphertext);
      expect(await counts()).toMatchObject({ installs: 1, secretRows: 1, receipts: 1 });
      for (const prepared of secrets.puts)
        if (prepared.ciphertext !== secret.ciphertext)
          expect(secrets.values.has(prepared.ciphertext)).toBe(false);
    },
  );

  it("explicitly resumes a recorded pending intent after review expiry", async () => {
    const request = await ready(input());
    const paused = pauseNext(request.source, async () => {
      throw new Error("Synthetic old fetch failure");
    });
    const first = confirm(request);
    try {
      await paused.entered;
      await expireLease();
      now += 16 * 60_000;
      expect(await receipt(request.reviewToken)).toMatchObject({ status: "pending" });
      expect(await confirm(request)).toMatchObject({ status: "installed" });
    } finally {
      paused.release();
    }
    expect(await first).toMatchObject({ status: "installed" });
    expect(await counts()).toEqual({ installs: 1, secretRows: 1, receipts: 1, puts: 1 });
  });

  it("cleans a prepared late-owner ref without deleting the takeover winner's ref", async () => {
    const request = await ready(input());
    const entered = deferred();
    const release = deferred();
    secrets.afterPut = async () => {
      secrets.afterPut = undefined;
      entered.resolve();
      await release.promise;
    };
    const first = confirm(request);
    try {
      await entered.promise;
      await expireLease();
      expect(await confirm(request)).toMatchObject({ status: "installed" });
    } finally {
      release.resolve();
    }
    expect(await first).toMatchObject({ status: "installed", replayed: true });
    expect(secrets.puts).toHaveLength(2);
    const install = await handles.prisma.capabilityInstall.findFirstOrThrow({
      where: { spaceId: space.id },
    });
    const secret = await handles.prisma.secret.findUniqueOrThrow({
      where: { id: install.secretId! },
    });
    expect(secret.ciphertext).toBe(secrets.puts[1]!.ciphertext);
    expect(secrets.deleted).toContain(secrets.puts[0]!.ciphertext);
    expect(secrets.values.has(secrets.puts[0]!.ciphertext)).toBe(false);
    expect(secrets.deleted).not.toContain(secret.ciphertext);
    expect(secrets.values.get(secret.ciphertext)).toBe(credential);
    expect(await counts()).toEqual({ installs: 1, secretRows: 1, receipts: 1, puts: 2 });
  });

  it("preserves a takeover winner when the old owner's in-flight vault put fails", async () => {
    const request = await ready(input());
    const entered = deferred();
    const release = deferred();
    secrets.beforePut = async () => {
      secrets.beforePut = undefined;
      entered.resolve();
      await release.promise;
      throw new Error("Synthetic late vault put failure");
    };
    const first = confirm(request);
    try {
      await entered.promise;
      await expireLease();
      expect(await confirm(request)).toMatchObject({ status: "installed" });
    } finally {
      release.resolve();
    }
    expect(await first).toMatchObject({ status: "installed", replayed: true });
    const install = await handles.prisma.capabilityInstall.findFirstOrThrow({
      where: { spaceId: space.id },
    });
    const secret = await handles.prisma.secret.findUniqueOrThrow({
      where: { id: install.secretId! },
    });
    expect(secrets.values.get(secret.ciphertext)).toBe(credential);
    expect(secrets.deleted).not.toContain(secret.ciphertext);
    expect(await receipt(request.reviewToken)).toMatchObject({
      status: "installed",
      install: { id: install.id },
    });
    expect(await counts()).toEqual({ installs: 1, secretRows: 1, receipts: 1, puts: 1 });
  });

  it.each(["membership", "space-deletion", "private-owner"] as const)(
    "rechecks %s after source fetch before put and commit",
    async (change) => {
      const request = await ready(
        input(documentFor(change === "private-owner" ? "http://127.0.0.1:9123/v1" : target)),
      );
      const paused = pauseNext(request.source);
      const first = raw("capabilities/confirmOpenApi", request);
      const membership = await handles.prisma.spaceMember.findUniqueOrThrow({
        where: { spaceId_userId: { spaceId: space.id, userId: actor.userId } },
      });
      try {
        await paused.entered;
        if (change === "membership")
          await handles.prisma.spaceMember.delete({ where: { id: membership.id } });
        if (change === "space-deletion")
          await handles.prisma.space.update({
            where: { id: space.id },
            data: { deletingAt: new Date(), deletionClaimId: randomUUID() },
          });
        if (change === "private-owner")
          await handles.prisma.deploymentSettings.update({
            where: { id: "default" },
            data: { ownerUserId: null },
          });
      } finally {
        paused.release();
      }
      try {
        const response = await first;
        if (response.ok)
          expect(
            ((await response.json()) as { json: OpenApiImportConfirmation }).json.status,
          ).not.toBe("installed");
        expect(await counts()).toMatchObject({ installs: 0, secretRows: 0, puts: 0 });
      } finally {
        if (change === "membership") await handles.prisma.spaceMember.create({ data: membership });
        if (change === "space-deletion")
          await handles.prisma.space.update({
            where: { id: space.id },
            data: { deletingAt: null, deletionClaimId: null },
          });
        if (change === "private-owner")
          await handles.prisma.deploymentSettings.update({
            where: { id: "default" },
            data: { ownerUserId: actor.userId },
          });
      }
    },
  );

  it.each(["start", "rollback", "cleanup"] as const)(
    "compensates prepared secret references after %s failure through composition wrappers",
    async (failure) => {
      const request = await ready(input());
      secrets.failDelete = failure === "cleanup";
      secrets.afterPut = () => {
        transactionFailure = failure === "start" ? "start" : "rollback";
      };
      const response = await raw("capabilities/confirmOpenApi", request);
      if (response.ok)
        expect(
          ((await response.json()) as { json: OpenApiImportConfirmation }).json.status,
        ).not.toBe("installed");
      secrets.afterPut = undefined;
      expect(secrets.puts).toHaveLength(1);
      expect(await counts()).toMatchObject({ installs: 0, secretRows: 0, receipts: 1 });
      expect(secrets.deleted).toContain(secrets.puts[0]!.ciphertext);
      if (failure !== "cleanup")
        expect(secrets.values.has(secrets.puts[0]!.ciphertext)).toBe(false);
      // A failed remote cleanup remains a boundary limitation, never a DB install.
      if (failure === "cleanup") expect(secrets.values.has(secrets.puts[0]!.ciphertext)).toBe(true);
      secrets.failDelete = false;
      expect(await confirm(request)).toMatchObject({ status: "installed" });
      expect(await counts()).toEqual({ installs: 1, secretRows: 1, receipts: 1, puts: 2 });
    },
  );

  it("does not persist an install or secret when vault put fails", async () => {
    const request = await ready(input());
    secrets.failPut = true;
    const response = await raw("capabilities/confirmOpenApi", request);
    if (response.ok)
      expect(((await response.json()) as { json: OpenApiImportConfirmation }).json.status).not.toBe(
        "installed",
      );
    expect(await counts()).toEqual({ installs: 0, secretRows: 0, receipts: 1, puts: 0 });
    secrets.failPut = false;
    expect(await confirm(request)).toMatchObject({ status: "installed" });
    expect(await counts()).toEqual({ installs: 1, secretRows: 1, receipts: 1, puts: 1 });
  });

  it("compensates a prepared credential when membership changes during secret put", async () => {
    const request = await ready(input());
    const membership = await handles.prisma.spaceMember.findUniqueOrThrow({
      where: { spaceId_userId: { spaceId: space.id, userId: actor.userId } },
    });
    secrets.afterPut = async () => {
      secrets.afterPut = undefined;
      await handles.prisma.spaceMember.delete({ where: { id: membership.id } });
    };
    try {
      const response = await raw("capabilities/confirmOpenApi", request);
      if (response.ok)
        expect(
          ((await response.json()) as { json: OpenApiImportConfirmation }).json.status,
        ).not.toBe("installed");
      expect(await counts()).toEqual({ installs: 0, secretRows: 0, receipts: 1, puts: 1 });
      expect(secrets.deleted).toContain(secrets.puts[0]!.ciphertext);
      expect(secrets.values.has(secrets.puts[0]!.ciphertext)).toBe(false);
    } finally {
      await handles.prisma.spaceMember.create({ data: membership });
    }
  });

  it("enforces receipt state, generation, and lease constraints in PostgreSQL", async () => {
    const request = await ready(input());
    expect(await confirm(request)).toMatchObject({ status: "installed" });
    const row = await handles.prisma.openApiImportReceipt.findFirstOrThrow({
      where: { spaceId: space.id },
    });
    for (const data of [
      { generation: 0 },
      { state: "unrecognized" },
      { leaseOwner: "synthetic-owner", leaseExpiresAt: null },
      { leaseOwner: "synthetic-owner", leaseExpiresAt: new Date() },
      { state: "stale" },
    ]) {
      await expect(
        handles.prisma.openApiImportReceipt.update({ where: { id: row.id }, data }),
      ).rejects.toThrow();
    }
    expect(
      await handles.prisma.openApiImportReceipt.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({
      state: "installed",
      generation: row.generation,
      installId: row.installId,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  it("honors an already-aborted confirmation without a credential or install write", async () => {
    const request = await ready(input());
    const controller = new AbortController();
    controller.abort();
    const result = await raw("capabilities/confirmOpenApi", request, {
      signal: controller.signal,
    }).catch(() => undefined);
    if (result?.ok)
      expect(((await result.json()) as { json: OpenApiImportConfirmation }).json.status).not.toBe(
        "installed",
      );
    expect(await counts()).toMatchObject({ installs: 0, secretRows: 0, puts: 0 });
  });
});
