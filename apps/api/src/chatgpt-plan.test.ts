import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets.js";
import {
  applyChatGPTPlanCatalog,
  chatGPTPlanHostId,
  createChatGPTPlanLogin,
  createChatGPTPlanLoopback,
  disconnectChatGPTPlan,
  isLocalChatGPTPlanOrigin,
  listChatGPTPlanProfiles,
} from "./chatgpt-plan.js";

const auth = vi.hoisted(() => ({
  failAfterRegistration: false,
  revokeConfirmed: true,
  revokeCalls: 0,
  contexts: [] as Array<{
    registration?: { clientId: string };
    idTokenHint?: string;
    hostId: string;
    redirectUri: string;
  }>,
  callbacks: [] as string[],
}));
vi.mock("@rakazo/adapters", async (original) => {
  const actual = await original<typeof import("@rakazo/adapters")>();
  return {
    ...actual,
    createChatGPTPlanOAuthAuth: (options: {
      getLoginContext?: () => Promise<{
        hostId: string;
        redirectUri: string;
        registration?: { clientId: string; subject?: string };
        idTokenHint?: string;
        onRegistration?: (registration: { clientId: string; issuer: string }) => Promise<void>;
      }>;
    }) => ({
      async login(interaction: {
        signal?: AbortSignal;
        notify(event: { type: "auth_url"; url: string }): void;
        prompt(prompt: { type: "manual_code"; message: string }): Promise<string>;
      }) {
        const context = await options.getLoginContext!();
        auth.contexts.push(context);
        const authorization = new URL("https://auth.openai.com/api/accounts/authorize");
        authorization.search = new URLSearchParams({
          state: "fixture-state",
          redirect_uri: context.redirectUri,
        }).toString();
        interaction.notify({ type: "auth_url", url: authorization.href });
        auth.callbacks.push(await interaction.prompt({ type: "manual_code", message: "Callback" }));
        interaction.signal?.throwIfAborted();
        const clientId = context.registration?.clientId ?? `oaiapp_${auth.contexts.length}`;
        if (!context.registration)
          await context.onRegistration?.({ clientId, issuer: "https://auth.openai.com" });
        if (auth.failAfterRegistration) throw new Error("Code exchange failed");
        return {
          type: "oauth",
          access: `access-${clientId}`,
          refresh: `refresh-${clientId}`,
          expires: Date.now() + 3_600_000,
          clientId,
          hostId: context.hostId,
          issuer: "https://auth.openai.com",
          subject: `subject-${clientId}`,
          email: "shared@example.test",
          idToken: `id-token-${clientId}`,
          scopes: ["openid", "resource.invoke", "chatgpt.tokens.use.direct"],
        };
      },
      toAuth: async (credential: { access: string }) => ({ apiKey: credential.access }),
    }),
    revokeChatGPTPlanCredential: async () => {
      auth.revokeCalls += 1;
      return { confirmed: auth.revokeConfirmed };
    },
  };
});

type Row = {
  id: string;
  userId: string;
  spaceId: null;
  kind: string;
  ciphertext: string;
  createdAt: number;
};
type ModelRow = { id: string; userId: string; provider: string; secretId: string };
type Where = Partial<Row>;
const actor = { userId: "user-one", spaceId: "space-one" };
const dirs: string[] = [];
const controllers: AbortController[] = [];
const placeholder = {
  provider: "chatgpt-plan",
  providerName: "ChatGPT",
  id: "connect",
  label: "ChatGPT",
  billing: "ChatGPT plan",
  auth: "oauth" as const,
  placeholder: true,
};

afterEach(async () => {
  for (const controller of controllers) controller.abort();
  controllers.length = 0;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  auth.failAfterRegistration = false;
  auth.revokeConfirmed = true;
  auth.contexts.length = 0;
  auth.callbacks.length = 0;
  auth.revokeCalls = 0;
});

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "chatgpt-plan-api-"));
  dirs.push(dataDir);
  const rows = new Map<string, Row>();
  const modelRows: ModelRow[] = [];
  const secrets = new EncryptedSecretStore("offline-fixture-key");
  const matching = (where: Where) =>
    [...rows.values()].filter((row) =>
      Object.entries(where).every(([key, value]) => row[key as keyof Row] === value),
    );
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => []),
    secret: {
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        matching(where).sort((a, b) => b.createdAt - a.createdAt),
      ),
      findFirst: vi.fn(async ({ where }: { where: Where }) => matching(where)[0]),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { id: string };
          create: Omit<Row, "createdAt">;
          update: { ciphertext: string };
        }) => {
          const old = rows.get(where.id);
          const row = old ? { ...old, ...update } : { ...create, createdAt: rows.size };
          rows.set(row.id, row);
          return row;
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { ciphertext: string } }) => {
          const row = rows.get(where.id);
          if (!row) throw new Error("Missing fixture secret");
          Object.assign(row, data);
          return row;
        },
      ),
    },
    userModelCredential: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string; provider: string } }) =>
        modelRows.find((row) => row.userId === where.userId && row.provider === where.provider),
      ),
    },
  };
  const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const token =
      new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "missing";
    return Response.json({
      models: [
        {
          slug: `model-${token}`,
          display_name: `Model ${token}`,
          visibility: "list",
          context_window: 128_000,
        },
        { slug: "hidden", display_name: "Hidden", visibility: "hide" },
      ],
    });
  });
  const deps = {
    prisma: prisma as unknown as Parameters<typeof createChatGPTPlanLogin>[0]["prisma"],
    secrets,
    dataDir,
    chatgptPlanFetch: fetcher as typeof fetch,
  };
  async function activate(credential: unknown, owner = actor) {
    const stored = await secrets.put(JSON.stringify(credential), {
      ...owner,
      operationId: "fixture",
      traceId: "fixture",
      signal: new AbortController().signal,
    });
    rows.set(stored.id, {
      id: stored.id,
      userId: owner.userId,
      spaceId: null,
      kind: "model",
      ciphertext: stored.ciphertext,
      createdAt: rows.size,
    });
    const row = {
      id: randomUUID(),
      userId: owner.userId,
      provider: "chatgpt-plan",
      secretId: stored.id,
    };
    const existing = modelRows.findIndex((item) => item.userId === owner.userId);
    if (existing < 0) modelRows.push(row);
    else modelRows[existing] = row;
    return row;
  }
  async function login(input: Parameters<typeof createChatGPTPlanLogin>[2] = {}, owner = actor) {
    const controller = new AbortController();
    controllers.push(controller);
    return createChatGPTPlanLogin(deps, owner, { callbackTransport: "desktop", ...input })({
      signal: controller.signal,
      notify() {},
      prompt: async () =>
        "http://127.0.0.1:1455/auth/callback?code=fixture&state=fixture-state&client_id=oaiapp_fixture",
    });
  }
  return { deps, rows, modelRows, fetcher, secrets, activate, login, prisma };
}

describe("installation and loopback transport", () => {
  it("does not delete a first connection which appears after an empty disconnect snapshot", async () => {
    const f = await fixture();
    const credential = await f.login({ newRegistration: true });
    f.prisma.$transaction.mockImplementationOnce(async (fn) => {
      await f.activate(credential);
      return fn(f.prisma);
    });
    const remove = vi.fn(async () => undefined);
    await expect(disconnectChatGPTPlan(f.deps, actor, remove)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(remove).not.toHaveBeenCalled();
    expect(auth.revokeCalls).toBe(0);
    expect(f.modelRows).toHaveLength(1);
  });
  it("does not revoke a reconnected successor while holding the previous secret's lock", async () => {
    const f = await fixture();
    const original = await f.login({ newRegistration: true });
    await f.activate(original);
    let replacement: unknown;
    f.prisma.$transaction.mockImplementationOnce(async (fn) => {
      replacement = await f.login({ newRegistration: true });
      await f.activate(replacement);
      return fn(f.prisma);
    });
    const remove = vi.fn(async () => undefined);
    await expect(disconnectChatGPTPlan(f.deps, actor, remove)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(auth.revokeCalls).toBe(0);
    expect(remove).not.toHaveBeenCalled();
    expect(f.modelRows).toHaveLength(1);
    const current = f.modelRows[0]!;
    expect(
      JSON.parse(await f.secrets.load(f.rows.get(current.secretId)!.ciphertext, current.secretId)),
    ).toEqual(replacement);
  });
  it("retains one opaque host ID across restarts with owner-only permissions", async () => {
    const f = await fixture();
    const first = await chatGPTPlanHostId(f.deps.dataDir);
    expect(first).toMatch(/^urn:uuid:/);
    expect(await chatGPTPlanHostId(f.deps.dataDir)).toBe(first);
    expect((await stat(path.join(f.deps.dataDir, "chatgpt-plan-host-id"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("serializes simultaneous host-ID initialization", async () => {
    const f = await fixture();
    const ids = await Promise.all(
      Array.from({ length: 12 }, () => chatGPTPlanHostId(f.deps.dataDir)),
    );
    expect(new Set(ids).size).toBe(1);
  });

  it("validates the local callback before forwarding registration metadata", async () => {
    const controller = new AbortController();
    controllers.push(controller);
    const listener = await createChatGPTPlanLoopback(controller.signal);
    listener.setAuthorizationUrl("https://auth.openai.com/api/accounts/authorize?state=expected");
    expect(new URL(listener.redirectUri).hostname).toBe("127.0.0.1");
    for (const query of [
      "state=wrong&code=x",
      "state=expected&state=wrong&code=x",
      "state=expected&code=x&access_token=secret",
    ]) {
      expect((await fetch(`${listener.redirectUri}?${query}`)).status).toBe(400);
    }
    const callback = `${listener.redirectUri}?state=expected&code=x&client_id=oaiapp_fixture&scope=openid`;
    const response = await fetch(callback);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("oaiapp_fixture");
    await expect(listener.result).resolves.toBe(callback);
    await expect(fetch(callback)).rejects.toThrow();
  });

  it("aborts a pending listener and refuses hosted origins", async () => {
    const controller = new AbortController();
    controllers.push(controller);
    const listener = await createChatGPTPlanLoopback(controller.signal);
    const rejected = expect(listener.result).rejects.toThrow("cancelled");
    controller.abort();
    await rejected;
    await expect(fetch(listener.redirectUri)).rejects.toThrow();
    expect(isLocalChatGPTPlanOrigin("http://127.0.0.1:5180")).toBe(true);
    expect(isLocalChatGPTPlanOrigin("https://app.example.com")).toBe(false);
    expect(isLocalChatGPTPlanOrigin("http://localhost.example.com")).toBe(false);
  });
});

describe("encrypted account registrations", () => {
  it("skips an unreadable registration while preserving its ciphertext and allowing other accounts", async () => {
    const f = await fixture();
    await f.login({ newRegistration: true });
    const corruptId = (await listChatGPTPlanProfiles(f.deps, actor))[0]!.id;
    f.rows.get(corruptId)!.ciphertext = "unreadable-fixture-ciphertext";
    await f.login({ newRegistration: true });
    const profiles = await listChatGPTPlanProfiles(f.deps, actor);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.id).not.toBe(corruptId);
    const callsBeforeRejectedSelection = auth.contexts.length;
    await expect(f.login({ registrationId: corruptId })).rejects.toThrow("not found");
    expect(auth.contexts).toHaveLength(callsBeforeRejectedSelection);
    await f.login({ newRegistration: true });
    expect(await listChatGPTPlanProfiles(f.deps, actor)).toHaveLength(2);
    expect(f.rows.get(corruptId)!.ciphertext).toBe("unreadable-fixture-ciphertext");
  });

  it("reports a secret-store outage instead of treating saved registrations as absent", async () => {
    const f = await fixture();
    await f.login({ newRegistration: true });
    const load = vi.spyOn(f.secrets, "load").mockRejectedValue(new SecretStoreUnavailableError());
    try {
      await expect(listChatGPTPlanProfiles(f.deps, actor)).rejects.toBeInstanceOf(
        SecretStoreUnavailableError,
      );
      await expect(f.login({ newRegistration: true })).rejects.toBeInstanceOf(
        SecretStoreUnavailableError,
      );
      expect(auth.contexts).toHaveLength(1);
      expect(f.rows.size).toBe(1);
    } finally {
      load.mockRestore();
    }
  });

  it("keeps same-email registrations separate and gives each a distinct display label", async () => {
    const f = await fixture();
    await f.login({ newRegistration: true });
    await f.login({ newRegistration: true });
    const profiles = await listChatGPTPlanProfiles(f.deps, actor);
    expect(profiles).toHaveLength(2);
    expect(new Set(profiles.map((profile) => profile.id)).size).toBe(2);
    expect(new Set(profiles.map((profile) => profile.label)).size).toBe(2);
    expect(profiles.every((profile) => profile.status === "registered")).toBe(true);
  });
  it("routes a local-web callback through the backend listener without a manual code prompt", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controllers.push(controller);
    const prompt = vi.fn(async () => "should-not-be-used");
    let browserReturn: Promise<Response> | undefined;
    const credential = await createChatGPTPlanLogin(f.deps, actor, {
      callbackTransport: "loopback",
      newRegistration: true,
    })({
      signal: controller.signal,
      prompt,
      notify(event) {
        if (event.type !== "auth_url") return;
        const authorization = new URL(event.url);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.search = "state=fixture-state&code=fixture&client_id=oaiapp_local";
        browserReturn = fetch(callback);
      },
    });
    expect((await browserReturn)?.status).toBe(200);
    expect(prompt).not.toHaveBeenCalled();
    expect(auth.callbacks[0]).toContain("client_id=oaiapp_local");
    expect(new URL(auth.contexts[0]!.redirectUri).pathname).toBe("/auth/callback");
    expect(credential).toMatchObject({
      registrationId: expect.any(String),
      chatgptPlanModels: expect.any(Array),
    });
  });

  it("retains an issued registration after exchange failure without exposing it in profile DTOs", async () => {
    const f = await fixture();
    auth.failAfterRegistration = true;
    await expect(f.login({ newRegistration: true, label: "Personal" })).rejects.toThrow(
      "Code exchange failed",
    );
    const profiles = await listChatGPTPlanProfiles(f.deps, actor);
    expect(profiles).toEqual([
      { id: expect.any(String), label: expect.stringMatching(/^Personal/), status: "incomplete" },
    ]);
    expect(JSON.stringify([...f.rows.values()])).not.toContain("oaiapp_1");
    expect(JSON.stringify(profiles)).not.toMatch(/clientId|idToken|subject|access|refresh/);
    auth.failAfterRegistration = false;
    const result = await f.login({ registrationId: profiles[0]?.id });
    expect(auth.contexts[1]?.registration?.clientId).toBe("oaiapp_1");
    expect(result).toMatchObject({ clientId: "oaiapp_1", registrationId: profiles[0]?.id });
    expect(auth.callbacks[0]).toContain("client_id=oaiapp_fixture");
  });

  it("rejects another user's registration before requesting authorization", async () => {
    const f = await fixture();
    await f.login({ newRegistration: true });
    const profile = (await listChatGPTPlanProfiles(f.deps, actor))[0]!;
    const other = { userId: "user-two", spaceId: "space-two" };
    expect(await listChatGPTPlanProfiles(f.deps, other)).toEqual([]);
    await expect(f.login({ registrationId: profile.id }, other)).rejects.toThrow("not found");
    expect(auth.contexts).toHaveLength(1);
  });

  it("keeps the active connection when a replacement fails after registration", async () => {
    const f = await fixture();
    const credential = await f.login({ newRegistration: true });
    const active = await f.activate(credential);
    const ciphertext = f.rows.get(active.secretId)?.ciphertext;
    auth.failAfterRegistration = true;
    await expect(f.login({ newRegistration: true })).rejects.toThrow();
    expect(f.modelRows[0]).toEqual(active);
    expect(f.rows.get(active.secretId)?.ciphertext).toBe(ciphertext);
    expect(
      (await listChatGPTPlanProfiles(f.deps, actor)).filter(
        (profile) => profile.status === "connected",
      ),
    ).toHaveLength(1);
  });

  it("preserves the active model credential if the replacement model catalog fails", async () => {
    const f = await fixture();
    const credential = await f.login({ newRegistration: true });
    const active = await f.activate(credential);
    const ciphertext = f.rows.get(active.secretId)?.ciphertext;
    f.fetcher.mockResolvedValueOnce(Response.json({ error: "access_denied" }, { status: 403 }));
    await expect(f.login({ newRegistration: true })).rejects.toThrow("model discovery failed");
    expect(f.modelRows[0]).toEqual(active);
    expect(f.rows.get(active.secretId)?.ciphertext).toBe(ciphertext);
  });

  it.each(["unavailable", "empty"])(
    "keeps a non-executable placeholder and unrelated providers when discovery is %s",
    async (failure) => {
      const f = await fixture();
      await f.activate(await f.login({ newRegistration: true }));
      f.fetcher.mockResolvedValueOnce(
        failure === "empty"
          ? Response.json({ models: [] })
          : Response.json({ error: "unavailable" }, { status: 503 }),
      );
      const unrelated = {
        provider: "other",
        id: "other-model",
        label: "Other",
        billing: "API key",
        auth: "api-key" as const,
      };
      const catalog = await applyChatGPTPlanCatalog(f.deps, actor, [placeholder, unrelated]);
      expect(catalog).toContainEqual(unrelated);
      expect(catalog.filter((entry) => entry.provider === "chatgpt-plan")).toEqual([
        expect.objectContaining({ id: "connect", placeholder: true }),
      ]);
      expect(JSON.stringify(catalog)).not.toContain("model-access-oaiapp_1");
    },
  );

  it("allows reconnect and disconnect recovery when the stored active credential is corrupt", async () => {
    const f = await fixture();
    const credential = await f.login({ newRegistration: true });
    await f.activate({ type: "oauth", access: "broken" });
    const profiles = await listChatGPTPlanProfiles(f.deps, actor);
    expect(profiles).toEqual([expect.objectContaining({ status: "registered" })]);
    const repaired = await f.login({ registrationId: profiles[0]?.id });
    expect(repaired).toMatchObject({ clientId: "oaiapp_1" });
    expect(auth.contexts.at(-1)?.idTokenHint).toBeUndefined();
    await expect(disconnectChatGPTPlan(f.deps, actor)).resolves.toEqual({ confirmed: false });
    expect(credential).toHaveProperty("registrationId", profiles[0]?.id);
  });

  it("keeps separate account catalogs and bearer credentials when changing the active registration", async () => {
    const f = await fixture();
    const first = await f.login({ newRegistration: true });
    await f.activate(first);
    const firstCatalog = await applyChatGPTPlanCatalog(f.deps, actor, [placeholder]);
    const second = await f.login({ newRegistration: true });
    await f.activate(second);
    const secondCatalog = await applyChatGPTPlanCatalog(f.deps, actor, [placeholder]);
    expect(firstCatalog.map((model) => model.id)).toEqual(["model-access-oaiapp_1"]);
    expect(secondCatalog.map((model) => model.id)).toEqual(["model-access-oaiapp_2"]);
    expect(JSON.stringify(secondCatalog)).not.toContain("model-access-oaiapp_1");
    const lastRequest = f.fetcher.mock.calls.at(-1)!;
    expect(lastRequest[0]).toBe("https://api.openai.com/v1/models");
    expect(new Headers(lastRequest[1]?.headers).get("authorization")).toBe(
      "Bearer access-oaiapp_2",
    );
  });

  it("discards a model catalog returned after the active account changed", async () => {
    const f = await fixture();
    await f.activate(await f.login({ newRegistration: true }));
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    let finishDiscovery!: (response: Response) => void;
    const delayedResponse = new Promise<Response>((resolve) => {
      finishDiscovery = resolve;
    });
    f.fetcher.mockImplementationOnce(async () => {
      fetchStarted();
      return delayedResponse;
    });
    const staleCatalog = applyChatGPTPlanCatalog(f.deps, actor, [placeholder]);
    await started;
    await f.activate(await f.login({ newRegistration: true }));
    finishDiscovery(
      Response.json({
        models: [
          { slug: "old-account-model", display_name: "Old account model", visibility: "list" },
        ],
      }),
    );
    const catalog = await staleCatalog;
    expect(catalog.some((model) => model.id === "old-account-model")).toBe(false);
    expect(
      catalog
        .filter((model) => model.provider === "chatgpt-plan")
        .every((model) => model.placeholder),
    ).toBe(true);
  });

  it("retains registration IDs but removes retained login hints on unconfirmed revocation", async () => {
    const f = await fixture();
    const credential = await f.login({ newRegistration: true, label: "Work" });
    await f.activate(credential);
    auth.revokeConfirmed = false;
    await expect(disconnectChatGPTPlan(f.deps, actor)).resolves.toEqual({ confirmed: false });
    const registrationRows = [...f.rows.values()].filter(
      (row) => row.kind === "chatgpt-plan-registration",
    );
    expect(registrationRows).toHaveLength(1);
    const profile = JSON.parse(
      await f.secrets.load(registrationRows[0]!.ciphertext, registrationRows[0]!.id),
    );
    expect(profile).toMatchObject({ signedOut: true, registration: { clientId: "oaiapp_1" } });
    expect(profile.idTokenHint).toBeUndefined();
    expect(await readFile(path.join(f.deps.dataDir, "chatgpt-plan-host-id"), "utf8")).toBe(
      auth.contexts[0]?.hostId,
    );
  });
});
