import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const helper = vi.hoisted(() => ({
  login: vi.fn(),
  profiles: vi.fn(),
  disconnect: vi.fn(),
  loginFunction: vi.fn(),
}));
vi.mock("./chatgpt-plan.js", async (original) => ({
  ...(await original<typeof import("./chatgpt-plan.js")>()),
  createChatGPTPlanLogin: helper.login,
  listChatGPTPlanProfiles: helper.profiles,
  disconnectChatGPTPlan: helper.disconnect,
}));

const actor: Actor = {
  userId: "user-one",
  spaceId: "space-one",
  email: "user@example.test",
  isDeploymentOwner: true,
};

beforeEach(() => {
  helper.login.mockReset().mockReturnValue(helper.loginFunction);
  helper.profiles.mockReset().mockResolvedValue([]);
  helper.disconnect.mockReset();
});

function fixture(options: { webOrigin?: string; billed?: boolean; provider?: string } = {}) {
  const steps: string[] = [];
  let inRemovalHook = false;
  const provider = options.provider ?? "chatgpt-plan";
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "credential-one" }]),
    bot: { findMany: vi.fn(async () => []) },
    routine: { findMany: vi.fn(async () => []) },
    run: { findMany: vi.fn(async () => []) },
    steeringMessage: { findMany: vi.fn(async () => []) },
    spaceMember: { findMany: vi.fn(async () => [{ spaceId: actor.spaceId }]) },
    spaceBackupModel: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => {
        steps.push("backups");
        return { count: 1 };
      }),
    },
    spaceModelPreference: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => {
        steps.push("preferences");
        return { count: 1 };
      }),
    },
    userModelCredential: {
      findMany: vi.fn(async () => [
        { id: "credential-one", secretId: "secret-one", provider, connectionRevision: 1 },
      ]),
      deleteMany: vi.fn(async () => {
        steps.push("credential");
        return { count: 1 };
      }),
      count: vi.fn(async () => 0),
    },
    userVoiceCredential: { count: vi.fn(async () => 0) },
    secret: {
      deleteMany: vi.fn(async () => {
        steps.push("secret");
        return { count: 1 };
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<void>) => fn(tx)),
  };
  const oauthLogins = {
    begin: vi.fn(async (_input: unknown) => ({
      loginId: "login-one",
      provider,
      mode: "auth-url" as const,
      verificationUri: "https://auth.openai.com/api/accounts/authorize?state=fixture-state",
      expiresInSeconds: 600,
    })),
    cancelProvider: vi.fn(async () => {
      steps.push("cancel");
    }),
  };
  const secrets = { put: vi.fn(), load: vi.fn() };
  const deps = {
    prisma,
    oauthLogins,
    secrets,
    dataDir: "/tmp/offline-chatgpt-router-fixture",
    ...(options.billed ? { billing: {} } : {}),
    env: {
      webOrigin: options.webOrigin ?? "http://127.0.0.1:5180",
      defaultProvider: "scripted",
      defaultModel: "scripted-test-model",
      sandboxProvider: "fake",
      agentRuntime: "pi",
    },
  } as unknown as RouterDeps;
  const signal = new AbortController().signal;
  const client = createRouterClient(createRouter(deps), { context: { actor, signal } });
  helper.disconnect.mockImplementation(
    async (
      _deps: unknown,
      _actor: unknown,
      remove: (client: typeof tx) => Promise<void>,
      options?: { validateRemoval?: (client: typeof tx) => Promise<void> },
    ) => {
      await options?.validateRemoval?.(tx);
      steps.push("revoke");
      inRemovalHook = true;
      try {
        await remove(tx);
      } finally {
        inRemovalHook = false;
      }
      return { confirmed: false };
    },
  );
  return {
    client,
    deps,
    prisma,
    tx,
    secrets,
    oauthLogins,
    signal,
    steps,
    inRemovalHook: () => inRemovalHook,
  };
}

describe("optional ChatGPT model provider router", () => {
  it("rejects an API key before model credential persistence", async () => {
    const f = fixture();
    await expect(
      f.client.models.connect({ provider: "chatgpt-plan", apiKey: "fake-key-value" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Connect ChatGPT through Continue with ChatGPT.",
    });
    expect(f.secrets.put).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    { webOrigin: "https://app.example.test" },
    { webOrigin: "http://127.0.0.1:5180", billed: true },
  ])("rejects new authorization for a hosted or billed deployment: %o", async (options) => {
    const f = fixture(options);
    await expect(
      f.client.models.beginOAuth({ provider: "chatgpt-plan", callbackTransport: "desktop" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("local desktop or local web"),
    });
    expect(helper.login).not.toHaveBeenCalled();
    expect(f.oauthLogins.begin).not.toHaveBeenCalled();
  });

  it.each(["desktop", "loopback", undefined] as const)(
    "passes the actor-bound login and reports the %s callback transport",
    async (callbackTransport) => {
      const f = fixture();
      const input = {
        provider: "chatgpt-plan",
        registrationId: "profile-one",
        newRegistration: false,
        callbackTransport,
      };
      await expect(f.client.models.beginOAuth(input)).resolves.toMatchObject({
        provider: "chatgpt-plan",
        callbackTransport: callbackTransport ?? "loopback",
      });
      expect(helper.login).toHaveBeenCalledWith(f.deps, actor, expect.objectContaining(input));
      expect(f.oauthLogins.begin).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: actor.userId,
          spaceId: actor.spaceId,
          provider: "chatgpt-plan",
          signal: f.signal,
          login: helper.loginFunction,
        }),
      );
    },
  );

  it("keeps the existing provider login path unchanged", async () => {
    const f = fixture({ provider: "anthropic", webOrigin: "https://app.example.test" });
    const result = await f.client.models.beginOAuth({ provider: "anthropic" });
    expect(result).not.toHaveProperty("callbackTransport");
    expect(helper.login).not.toHaveBeenCalled();
    expect(f.oauthLogins.begin.mock.calls[0]?.[0]).not.toHaveProperty("login");
  });

  it("gets saved registration projections only for the authenticated actor", async () => {
    const f = fixture();
    const profiles = [{ id: "profile-one", label: "Personal", status: "registered" }];
    helper.profiles.mockResolvedValue(profiles);
    await expect(f.client.models.chatgptProfiles()).resolves.toEqual(profiles);
    expect(helper.profiles).toHaveBeenCalledWith(f.deps, actor);
  });

  it("passes credential removal into the revocation owner and reports unconfirmed remote logout", async () => {
    const f = fixture();
    f.tx.userModelCredential.deleteMany.mockImplementation(async () => {
      expect(f.inRemovalHook()).toBe(true);
      f.steps.push("credential");
      return { count: 1 };
    });
    await expect(f.client.models.disconnect({ provider: "chatgpt-plan" })).resolves.toEqual({
      ok: true,
      remoteRevocationConfirmed: false,
    });
    expect(f.oauthLogins.cancelProvider).toHaveBeenCalledWith({
      userId: actor.userId,
      provider: "chatgpt-plan",
    });
    expect(helper.disconnect).toHaveBeenCalledWith(
      f.deps,
      actor,
      expect.any(Function),
      expect.objectContaining({ validateRemoval: expect.any(Function) }),
    );
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.steps).toEqual(["cancel", "revoke", "preferences", "credential", "secret"]);
    expect(f.tx.spaceBackupModel.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.secret.deleteMany).toHaveBeenCalledWith({ where: { id: "secret-one" } });
  });

  it("keeps ordinary provider disconnect in the existing transaction without a remote status", async () => {
    const f = fixture({ provider: "anthropic" });
    await expect(f.client.models.disconnect({ provider: "anthropic" })).resolves.toEqual({
      ok: true,
    });
    expect(helper.disconnect).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
    expect(f.steps).toEqual(["cancel", "preferences", "credential", "secret"]);
  });
  it("checks the selected connection revision before remote revocation", async () => {
    const f = fixture();
    await expect(
      f.client.models.disconnect({
        provider: "chatgpt-plan",
        credentialId: "credential-one",
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.steps).toEqual(["cancel"]);
    expect(f.tx.userModelCredential.deleteMany).not.toHaveBeenCalled();
  });
});
