import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { encodeLoginSecret } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

// Offline boundary: a fake Prisma client and secret store drive the real router handlers,
// the real repos.getBot ownership check, and the real storeBotSecret validation.

type Row = Record<string, unknown>;

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;

const FAKE_VALUE = "fake-value-SENTINEL-1";

function matches(row: Row, where: Row = {}) {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function pick(row: Row, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
}

function botSecretDeps(seed: Row[] = []) {
  const now = new Date("2026-09-01T00:00:00.000Z");
  const bots: Row[] = [
    { id: "bot-1", name: "Primary bot", userId: "user-1", spaceId: "space-1", archivedAt: null },
    { id: "bot-other", name: "Peer bot", userId: "user-2", spaceId: "space-1", archivedAt: null },
    { id: "bot-2", name: "Second bot", userId: "user-1", spaceId: "space-1", archivedAt: null },
    {
      id: "bot-remote",
      name: "Remote bot",
      userId: "user-1",
      spaceId: "space-2",
      archivedAt: null,
    },
    {
      id: "bot-archived",
      name: "Archived bot",
      userId: "user-1",
      spaceId: "space-1",
      archivedAt: now,
    },
  ];
  let nextRevision = 0;
  const revision = () => `revision-${++nextRevision}`;
  const rows: Row[] = seed.map((row) => ({ revision: revision(), ...row }));
  const botSecret = {
    findMany: vi.fn(async (args: { where: Row; select?: Record<string, boolean> }) =>
      rows
        .filter((row) => matches(row, args.where))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map((row) => pick(row, args.select)),
    ),
    findFirst: vi.fn(async (args: { where: Row; select?: Record<string, boolean> }) => {
      const { bot, ...where } = args.where;
      const row = rows.find(
        (entry) =>
          matches(entry, where) &&
          (!bot ||
            bots.some(
              (candidate) => candidate.id === entry.botId && matches(candidate, bot as Row),
            )),
      );
      return row ? pick(row, args.select) : null;
    }),
    count: vi.fn(
      async (args: { where: Row }) => rows.filter((row) => matches(row, args.where)).length,
    ),
    create: vi.fn(async (args: { data: Row }) => {
      rows.push({ ...args.data, createdAt: now, updatedAt: now, revision: revision() });
      return {};
    }),
    updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
      const row = rows.find((entry) => matches(entry, args.where));
      if (!row) return { count: 0 };
      Object.assign(row, args.data, { updatedAt: now, revision: revision() });
      return { count: 1 };
    }),
    deleteMany: vi.fn(async (args: { where: Row }) => {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matches(rows[index] ?? {}, args.where)) rows.splice(index, 1);
      }
      return { count: before - rows.length };
    }),
  };
  const prisma = {
    bot: {
      findMany: vi.fn(
        async (args: {
          where: Row;
          select: { botSecrets: { where: Row; select: Record<string, boolean> } };
        }) =>
          bots
            .filter((bot) => matches(bot, args.where))
            .map((bot) => ({
              id: bot.id,
              name: bot.name,
              botSecrets: rows
                .filter((row) => row.botId === bot.id && matches(row, args.select.botSecrets.where))
                .map((row) => pick(row, args.select.botSecrets.select)),
            })),
      ),
      findFirst: vi.fn(async (args: { where: Row }) => {
        const bot = bots.find((entry) => matches(entry, args.where));
        return bot ? { ...bot, thread: null, computer: null } : null;
      }),
    },
    botSecret,
    $queryRaw: vi.fn(
      async (
        _sql: TemplateStringsArray,
        botId: string,
        spaceId: string,
        owner: boolean,
        userId: string,
      ) =>
        bots.filter(
          (bot) =>
            bot.id === botId &&
            bot.spaceId === spaceId &&
            bot.archivedAt === null &&
            (!owner || bot.userId === userId),
        ),
    ),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const plaintexts = new Map<string, string>();
  const secrets = {
    put: vi.fn(async (plaintext: string, _context: unknown, options: { recordId: string }) => {
      const ciphertext = `enc:${options.recordId}:${plaintexts.size}`;
      plaintexts.set(ciphertext, plaintext);
      return { id: options.recordId, ref: ciphertext, ciphertext };
    }),
    load: vi.fn(async (ciphertext: string) => plaintexts.get(ciphertext)),
  };
  const auth = { hasRecentIdentityConfirmation: vi.fn(async () => false) };
  const deps = {
    auth,
    prisma: prisma as unknown as PrismaClient,
    secrets,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function call(
    path:
      | "list"
      | "listForEdit"
      | "put"
      | "putForEdit"
      | "remove"
      | "removeForEdit"
      | "listForSpace"
      | "reveal"
      | "loginFieldsForEdit",
    input: unknown,
    context?: { sessionId?: string; stillAuthorized?: () => Promise<boolean> },
  ) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/botSecrets/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor, ...context } },
    );
    if (!response) throw new Error("Procedure did not match");
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as { json: unknown } };
  }
  return { prisma, secrets, auth, rows, call };
}

function putInput(origin: string, botId = "bot-1") {
  return {
    botId,
    destination: { name: "router", origin, auth: { type: "bearer" } },
    value: FAKE_VALUE,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("botSecrets router", () => {
  it("requires a revision to save named fields and keeps older forms from replacing them", async () => {
    const { call, rows, secrets } = botSecretDeps();
    const login = {
      botId: "bot-1",
      destination: {
        name: "portal",
        origin: "https://login.example.test",
        auth: { type: "login" },
      },
    };
    const value = encodeLoginSecret({
      fields: [
        { label: "Account ID", value: "account-fixture", hidden: false },
        { label: "Access phrase", value: FAKE_VALUE, hidden: true },
      ],
    });
    expect((await call("put", { ...login, value })).status).toBe(409);
    const created = await call("putForEdit", { ...login, value, expectedRevision: null });
    expect(created.status).toBe(200);
    expect(created.body.json).toMatchObject({ namedLogin: true });
    expect(created.text).not.toContain(FAKE_VALUE);
    expect(created.text).not.toContain("Access phrase");
    const first = { ...rows[0] };
    const listed = await call("listForEdit", { botId: login.botId });
    expect(listed.body.json).toEqual([
      expect.objectContaining({
        namedLogin: true,
        revision: first.revision,
        auth: { type: "login" },
      }),
    ]);
    expect(listed.text).not.toContain("Access phrase");
    expect((await call("list", { botId: login.botId })).body.json).toEqual([
      expect.objectContaining({ namedLogin: true, auth: null }),
    ]);
    const legacyValue = encodeLoginSecret({ username: "old-form", password: "old-form-fixture" });
    for (const expectedRevision of [undefined, first.revision]) {
      const rejected = await call("put", { ...login, value: legacyValue, expectedRevision });
      expect(rejected.status).toBe(409);
      expect(rejected.text).toContain("This login uses named fields");
    }
    expect(secrets.put).toHaveBeenCalledOnce();
    expect(secrets.load).not.toHaveBeenCalled();
    expect(rows[0]).toEqual(first);
    expect((await call("remove", { botId: login.botId, name: "portal" })).status).toBe(409);
    expect(
      (
        await call("removeForEdit", {
          botId: login.botId,
          name: "portal",
          expectedRevision: "stale",
        })
      ).status,
    ).toBe(409);
    expect(rows[0]).toEqual(first);
    expect(
      (
        await call("removeForEdit", {
          botId: login.botId,
          name: "portal",
          expectedRevision: first.revision,
        })
      ).status,
    ).toBe(200);
    expect(rows).toHaveLength(0);
  });

  it("rejects a revision that changed while the encrypted replacement was prepared", async () => {
    const { call, rows, secrets, prisma } = botSecretDeps();
    const input = putInput("https://api.example.test");
    expect((await call("put", input)).status).toBe(200);
    const preparedAt = rows[0]?.revision;
    const put = secrets.put.getMockImplementation()!;
    secrets.put.mockImplementationOnce(async (...args) => {
      Object.assign(rows[0]!, { revision: "another-write", ciphertext: "enc:another-write" });
      return put(...args);
    });
    expect((await call("put", { ...input, expectedRevision: preparedAt })).status).toBe(409);
    expect(prisma.botSecret.updateMany).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ revision: "another-write", ciphertext: "enc:another-write" });
  });

  it("reports a conflict if a competing save retired the old login reference", async () => {
    const { call, rows, secrets } = botSecretDeps();
    const input = {
      botId: "bot-1",
      destination: {
        name: "portal",
        origin: "https://login.example.test",
        auth: { type: "login" },
      },
      value: encodeLoginSecret({ username: "fixture", password: "legacy-fixture" }),
    };
    expect((await call("put", input)).status).toBe(200);
    secrets.load.mockImplementationOnce(async () => {
      Object.assign(rows[0]!, { revision: "newer", ciphertext: "enc:newer" });
      throw new Error("Synthetic provider reference retired");
    });
    const refused = await call("put", { ...input, expectedRevision: rows[0]?.revision });
    expect(refused.status).toBe(409);
    expect(refused.text).not.toContain("Synthetic provider");
    expect(secrets.put).toHaveBeenCalledOnce();
  });

  it("prepares a slow credential before opening the five-second transaction", async () => {
    const { prisma, secrets, call } = botSecretDeps();
    let clock = 0;
    let active = false;
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
      const start = clock;
      active = true;
      try {
        const result = await fn(prisma);
        if (clock - start > 5000) throw new Error("Transaction expired");
        return result;
      } finally {
        active = false;
      }
    });
    const put = secrets.put.getMockImplementation()!;
    secrets.put.mockImplementation(async (...args) => {
      expect(active).toBe(false);
      clock += 15000;
      return put(...args);
    });
    expect((await call("put", putInput("https://api.example.test"))).status).toBe(200);
    expect(secrets.put).toHaveBeenCalledOnce();
    expect(prisma.botSecret.create).toHaveBeenCalledOnce();
  });

  it("rejects another user's bot and a missing bot before any secret access", async () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const { prisma, secrets, call } = botSecretDeps();
    for (const botId of ["bot-other", "missing-bot"]) {
      const results = [
        await call("list", { botId }),
        await call("put", putInput("https://api.example.com", botId)),
        await call("remove", { botId, name: "router" }),
      ];
      for (const result of results) {
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(result.text).not.toContain(FAKE_VALUE);
      }
    }
    expect(prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1", spaceId: "space-1", archivedAt: null }),
      }),
    );
    expect(secrets.put).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.botSecret.findMany).not.toHaveBeenCalled();
    expect(prisma.botSecret.create).not.toHaveBeenCalled();
    expect(prisma.botSecret.updateMany).not.toHaveBeenCalled();
    expect(prisma.botSecret.deleteMany).not.toHaveBeenCalled();
  });

  it("lists metadata only, selecting neither the ciphertext nor the row id", async () => {
    const created = new Date("2026-08-01T00:00:00.000Z");
    const { prisma, call } = botSecretDeps([
      {
        id: "row-1",
        userId: "user-1",
        spaceId: "space-1",
        botId: "bot-1",
        name: "github",
        origin: "https://api.github.com",
        auth: { type: "basic", username: "octocat" },
        ciphertext: "enc:row-1",
        createdAt: created,
        updatedAt: created,
      },
    ]);
    const result = await call("list", { botId: "bot-1" });
    expect(result.status).toBe(200);
    const select = prisma.botSecret.findMany.mock.calls[0]?.[0].select ?? {};
    expect(Object.keys(select).sort()).toEqual([
      "auth",
      "createdAt",
      "name",
      "origin",
      "revision",
      "updatedAt",
    ]);
    expect(result.body.json).toEqual([
      {
        name: "github",
        origin: "https://api.github.com",
        auth: { type: "basic", username: "octocat" },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        revision: "revision-1",
      },
    ]);
    expect(result.text).not.toContain("enc:");
    expect(result.text).not.toContain("ciphertext");
  });

  it("stores a LAN http origin only with the private-HTTP opt-in", async () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const allowed = botSecretDeps();
    const saved = await allowed.call("put", putInput("http://192.168.1.20:8080"));
    expect(saved.status).toBe(200);
    expect(saved.body.json).toEqual({
      name: "router",
      origin: "http://192.168.1.20:8080",
      auth: { type: "bearer" },
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      revision: "revision-1",
    });
    expect(saved.text).not.toContain(FAKE_VALUE);
    expect(allowed.secrets.put).toHaveBeenCalledWith(
      FAKE_VALUE,
      expect.anything(),
      expect.objectContaining({ recordId: expect.any(String) }),
    );
    expect(allowed.rows).toHaveLength(1);
    expect(allowed.rows[0]).toMatchObject({ userId: "user-1", spaceId: "space-1", botId: "bot-1" });

    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "");
    const denied = botSecretDeps();
    const rejected = await denied.call("put", putInput("http://192.168.1.20:8080"));
    expect(rejected.status).toBe(400);
    expect(rejected.text).toContain("Invalid credential destination");
    expect(rejected.text).not.toContain(FAKE_VALUE);
    expect(denied.secrets.put).not.toHaveBeenCalled();
    expect(denied.rows).toHaveLength(0);
  });

  it("rejects public plain http and cloud-metadata hosts in both modes", async () => {
    for (const flag of ["1", ""]) {
      vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", flag);
      for (const origin of [
        "http://example.com",
        "http://100.100.100.200",
        "https://169.254.169.254",
        "https://metadata.google.internal",
      ]) {
        const { secrets, rows, call } = botSecretDeps();
        const result = await call("put", putInput(origin));
        expect({ flag, origin, status: result.status }).toEqual({ flag, origin, status: 400 });
        expect(result.text).not.toContain(FAKE_VALUE);
        expect(secrets.put).not.toHaveBeenCalled();
        expect(rows).toHaveLength(0);
      }
    }
  });

  it("maps malformed website login values to a bad request without echoing them", async () => {
    for (const value of [`not-json-${FAKE_VALUE}`, JSON.stringify({ password: FAKE_VALUE })]) {
      const { secrets, call } = botSecretDeps();
      const result = await call("put", {
        botId: "bot-1",
        destination: {
          name: "portal",
          origin: "https://portal.example.com",
          auth: { type: "login" },
        },
        value,
      });
      expect(result.status).toBe(400);
      expect(result.text).toContain("Enter valid website login fields");
      expect(result.text).not.toContain(FAKE_VALUE);
      expect(secrets.put).not.toHaveBeenCalled();
    }
  });

  it("lists every row when one name and one auth no longer pass the schema", async () => {
    const created = new Date("2026-08-01T00:00:00.000Z");
    const row = (name: string, auth: unknown) => ({
      id: `row-${name}`,
      userId: "user-1",
      spaceId: "space-1",
      botId: "bot-1",
      name,
      origin: "https://api.example.com",
      auth,
      ciphertext: `enc:${name}`,
      createdAt: created,
      updatedAt: created,
    });
    const { call } = botSecretDeps([
      row("alpha", { type: "bearer" }),
      row("Bad Name", { type: "bearer" }),
      row("middle", { type: "cookie" }),
      row("omega", { type: "header", name: "X-Api-Key" }),
    ]);
    const result = await call("list", { botId: "bot-1" });
    expect(result.status).toBe(200);
    const byName = new Map(
      (result.body.json as { name: string; auth: unknown }[]).map((entry) => [entry.name, entry]),
    );
    expect([...byName.keys()].sort()).toEqual(["Bad Name", "alpha", "middle", "omega"]);
    expect(byName.get("alpha")?.auth).toEqual({ type: "bearer" });
    // Invalid stored names stay listable/removable but are not replaceable.
    expect(byName.get("Bad Name")?.auth).toBeNull();
    expect(byName.get("middle")?.auth).toBeNull();
    expect(byName.get("omega")?.auth).toEqual({ type: "header", name: "X-Api-Key" });
    expect(result.text).not.toContain("cookie");
    expect(result.text).not.toContain("ciphertext");
  });

  it("lists a private-HTTP origin as remove-only when the opt-in is off", async () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "");
    const created = new Date("2026-08-01T00:00:00.000Z");
    const { call } = botSecretDeps([
      {
        id: "row-lan",
        userId: "user-1",
        spaceId: "space-1",
        botId: "bot-1",
        name: "router",
        origin: "http://192.168.1.20:8080",
        auth: { type: "bearer" },
        ciphertext: "enc:lan",
        createdAt: created,
        updatedAt: created,
      },
    ]);
    const result = await call("list", { botId: "bot-1" });
    expect(result.status).toBe(200);
    expect(result.body.json).toEqual([
      {
        name: "router",
        origin: "http://192.168.1.20:8080",
        auth: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        revision: "revision-1",
      },
    ]);
  });

  it("removes a non-regex stored name for the owned bot and rejects another user's bot", async () => {
    const owned = botSecretDeps([
      { id: "row-1", userId: "user-1", spaceId: "space-1", botId: "bot-1", name: "Legacy Name" },
    ]);
    const removed = await owned.call("remove", { botId: "bot-1", name: "Legacy Name" });
    expect(removed.status).toBe(200);
    expect(removed.body.json).toEqual({ ok: true });
    expect(owned.prisma.botSecret.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "row-1",
        revision: "revision-1",
        userId: "user-1",
        spaceId: "space-1",
        botId: "bot-1",
        name: "Legacy Name",
      },
    });

    const foreign = botSecretDeps();
    const denied = await foreign.call("remove", { botId: "bot-other", name: "Legacy Name" });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(foreign.prisma.botSecret.deleteMany).not.toHaveBeenCalled();
  });

  it("removes a credential by name within the owner's bot scope", async () => {
    const { prisma, call } = botSecretDeps([
      { id: "row-1", userId: "user-1", spaceId: "space-1", botId: "bot-1", name: "router" },
    ]);
    const result = await call("remove", { botId: "bot-1", name: "router" });
    expect(result.status).toBe(200);
    expect(result.body.json).toEqual({ ok: true });
    expect(prisma.botSecret.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "row-1",
        revision: "revision-1",
        userId: "user-1",
        spaceId: "space-1",
        botId: "bot-1",
        name: "router",
      },
    });
  });
  it("stores a command variable with no origin and lists it with its type", async () => {
    const { secrets, rows, call } = botSecretDeps();
    const result = await call("put", {
      botId: "bot-1",
      destination: { name: "netbird-setup-key", auth: { type: "command" } },
      value: FAKE_VALUE,
    });
    expect(result.status).toBe(200);
    expect(result.body.json).toMatchObject({
      name: "netbird-setup-key",
      origin: "",
      auth: { type: "command" },
    });
    expect(result.text).not.toContain(FAKE_VALUE);
    expect(secrets.put).toHaveBeenCalledOnce();
    expect(rows[0]).toMatchObject({ origin: "", auth: { type: "command" } });
    const listed = await call("list", { botId: "bot-1" });
    expect(listed.body.json).toEqual([expect.objectContaining({ auth: { type: "command" } })]);
  });

  it("rejects a reserved command variable name with a clear bad request", async () => {
    const { secrets, rows, call } = botSecretDeps();
    const result = await call("put", {
      botId: "bot-1",
      destination: { name: "ld_preload", auth: { type: "command" } },
      value: FAKE_VALUE,
    });
    expect(result.status).toBe(400);
    expect(result.text).toContain("$LD_PRELOAD is reserved");
    expect(result.text).not.toContain(FAKE_VALUE);
    expect(secrets.put).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("still requires a site for every other credential type", async () => {
    const { secrets, call } = botSecretDeps();
    const result = await call("put", {
      botId: "bot-1",
      destination: { name: "api", auth: { type: "bearer" } },
      value: FAKE_VALUE,
    });
    expect(result.status).toBe(400);
    expect(secrets.put).not.toHaveBeenCalled();
  });
});

describe("Space credential management", () => {
  it("returns only active owned Bot metadata and keeps equal names independent", async () => {
    const { call, rows, secrets } = botSecretDeps();
    for (const botId of ["bot-1", "bot-2"])
      expect(
        (
          await call("putForEdit", {
            ...putInput("https://api.example.test", botId),
            expectedRevision: null,
          })
        ).status,
      ).toBe(200);
    const original = rows[0]!;
    rows.push(
      { ...original, botId: "bot-other", userId: "user-2" },
      { ...original, botId: "bot-remote", spaceId: "space-2" },
      { ...original, botId: "bot-archived" },
      { ...original, botId: "bot-1", userId: "user-2", name: "peer-credential" },
      { ...original, botId: "bot-1", spaceId: "space-2", name: "other-space" },
    );
    const listed = await call("listForSpace", {});
    expect(listed.status).toBe(200);
    expect(listed.body.json).toEqual(
      ["bot-1", "bot-2"].map((botId) =>
        expect.objectContaining({
          botId,
          credentials: [expect.objectContaining({ name: "router" })],
        }),
      ),
    );
    expect(listed.text).not.toContain(FAKE_VALUE);
    expect(listed.text).not.toContain("ciphertext");
    expect(secrets.load).not.toHaveBeenCalled();
  });

  it("reveals only the exact current revision after confirming the calling session", async () => {
    const { auth, call, rows, secrets } = botSecretDeps();
    await call("putForEdit", { ...putInput("https://api.example.test"), expectedRevision: null });
    const input = { botId: "bot-1", name: "router", expectedRevision: rows[0]!.revision };
    const context = { sessionId: "session-1" };
    const refused = await call("reveal", input, context);
    expect(refused.status).toBe(403);
    expect(refused.text).toContain("IDENTITY_CONFIRMATION_REQUIRED");
    expect(refused.text).not.toContain(FAKE_VALUE);
    expect(auth.hasRecentIdentityConfirmation).toHaveBeenCalledWith({
      sessionId: "session-1",
      userId: actor.userId,
    });
    expect(secrets.load).not.toHaveBeenCalled();
    auth.hasRecentIdentityConfirmation.mockResolvedValue(true);
    for (const botId of ["bot-2", "bot-other", "bot-archived", "bot-remote"]) {
      const attempt = await call("reveal", { ...input, botId }, context);
      expect(attempt.status).toBe(404);
      expect(attempt.text).not.toContain(FAKE_VALUE);
    }
    const stale = await call("reveal", { ...input, expectedRevision: "stale" }, context);
    expect(stale.status).toBe(404);
    expect(secrets.load).not.toHaveBeenCalled();
    const actual = await call("reveal", input, context);
    expect(actual.body.json).toEqual({ value: FAKE_VALUE });

    auth.hasRecentIdentityConfirmation.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const expiredDuringRead = await call("reveal", input, context);
    expect(expiredDuringRead.status).toBe(403);
    expect(expiredDuringRead.text).not.toContain(FAKE_VALUE);

    secrets.load.mockImplementationOnce(async () => {
      rows[0]!.revision = "updated-during-read";
      return FAKE_VALUE;
    });
    const raced = await call("reveal", input, context);
    expect(raced.status).toBe(404);
    expect(raced.text).not.toContain(FAKE_VALUE);

    secrets.load.mockRejectedValueOnce(new Error(FAKE_VALUE));
    const storageFailure = await call(
      "reveal",
      { ...input, expectedRevision: "updated-during-read" },
      context,
    );
    expect(storageFailure.status).toBe(503);
    expect(storageFailure.text).not.toContain(FAKE_VALUE);
    const revoked = await call(
      "reveal",
      { ...input, expectedRevision: "updated-during-read" },
      {
        ...context,
        stillAuthorized: async () => false,
      },
    );
    expect(revoked.status).toBe(404);
    expect(revoked.text).not.toContain(FAKE_VALUE);
  });

  it("loads only labels and visibility for editing a login", async () => {
    const { call, rows } = botSecretDeps();
    await call("putForEdit", {
      botId: "bot-1",
      destination: {
        name: "portal",
        origin: "https://login.example.test",
        auth: { type: "login" },
      },
      expectedRevision: null,
      value: encodeLoginSecret({
        fields: [
          { label: "Account", value: "identifier-fixture", hidden: false },
          { label: "Access phrase", value: FAKE_VALUE, hidden: true },
        ],
      }),
    });
    const result = await call("loginFieldsForEdit", {
      botId: "bot-1",
      name: "portal",
      expectedRevision: rows[0]!.revision,
    });
    expect(result.status).toBe(200);
    expect(result.body.json).toEqual([
      { label: "Account", hidden: false },
      { label: "Access phrase", hidden: true },
    ]);
    expect(result.text).not.toContain(FAKE_VALUE);
    expect(result.text).not.toContain("identifier-fixture");
  });
});
