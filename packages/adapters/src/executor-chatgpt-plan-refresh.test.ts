import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type * as ChatGPTPlanAuth from "./chatgpt-plan-auth.js";
import { createRunExecutor } from "./executor.js";
import { PiRuntimeCredentialStore, toOAuthCredential } from "./pi-credentials.js";
import { parseModelSecret, serializeModelSecret } from "./pi-oauth.js";

const rotation = vi.hoisted(() => ({
  error: new Error("rotation verification pending"),
  checkpoint: undefined as unknown,
}));
vi.mock("./chatgpt-plan-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ChatGPTPlanAuth>();
  const isRotation = (error: unknown) =>
    error === rotation.error || (error instanceof Error && error.cause === rotation.error);
  return {
    ...actual,
    chatGPTPlanRotationCheckpoint: (error: unknown) =>
      isRotation(error) ? rotation.checkpoint : actual.chatGPTPlanRotationCheckpoint(error),
    isChatGPTPlanRotationPendingError: (error: unknown) =>
      isRotation(error) || actual.isChatGPTPlanRotationPendingError(error),
  };
});

const scope = { userId: "user-fixture", spaceId: "space-fixture" };
function fixture(input: Array<"text" | "image"> = ["text"]) {
  const initial = {
    type: "oauth" as const,
    access: "fake-before",
    refresh: "fake-refresh-before",
    expires: Date.now() + 3600_000,
    clientId: "oaiapp_fixture",
    issuer: "https://auth.openai.com",
    subject: "fixture-subject",
    hostId: "urn:uuid:8d497bea-75d5-4b56-9bed-401ec51007a3",
    idToken: "fake-id-token",
    scopes: ["chatgpt.tokens.use.direct"],
    chatgptPlanModels: [{ id: "account-model", name: "Account model", input }],
  };
  const account = {
    id: "credential-fixture",
    userId: scope.userId,
    provider: "chatgpt-plan",
    label: "Fixture",
    secretId: "secret-fixture",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const secret = {
    id: account.secretId,
    userId: scope.userId,
    spaceId: null,
    ciphertext: "cipher-0",
  };
  const plaintexts = new Map([
    [secret.ciphertext, serializeModelSecret({ kind: "oauth", credential: initial })],
  ]);
  const order: string[] = [];
  let connected = true;
  const secretTable = {
    findFirst: vi.fn(async () => ({ ...secret })),
    update: vi.fn(async (input: { data: { ciphertext: string } }) => {
      secret.ciphertext = input.data.ciphertext;
      order.push("persist");
      return secret;
    }),
  };
  const transaction = {
    secret: secretTable,
    userModelCredential: { findFirst: vi.fn(async () => (connected ? account : null)) },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => {
      order.push("lock");
      return [];
    }),
  };
  const prisma = {
    secret: secretTable,
    userModelCredential: {
      findMany: vi.fn(async () => [account]),
      findFirst: vi.fn(async () => account),
    },
    spaceModelPreference: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => {
      const previous = secret.ciphertext;
      try {
        const value = await operation(transaction);
        order.push("commit");
        return value;
      } catch (error) {
        secret.ciphertext = previous;
        order.push("rollback");
        throw error;
      }
    }),
  } as unknown as PrismaClient;
  const secretStore = {
    load: vi.fn(async (ciphertext: string) => plaintexts.get(ciphertext)!),
    put: vi.fn(async (plaintext: string) => {
      const ciphertext = `cipher-${plaintexts.size}`;
      plaintexts.set(ciphertext, plaintext);
      return { ciphertext };
    }),
  };
  const executor = createRunExecutor({ prisma, secretStore } as unknown as Parameters<
    typeof createRunExecutor
  >[0]);
  return {
    initial,
    executor,
    order,
    secretStore,
    read: () => parseModelSecret(plaintexts.get(secret.ciphertext)!),
    replace: (credential: typeof initial) => {
      const ciphertext = `cipher-${plaintexts.size}`;
      plaintexts.set(ciphertext, serializeModelSecret({ kind: "oauth", credential }));
      secret.ciphertext = ciphertext;
    },
    disconnect: () => {
      connected = false;
    },
  };
}

describe("ChatGPT plan executor refresh publication", () => {
  it.each([false, true])(
    "propagates validated account-specific vision capability %s",
    async (vision) => {
      const f = fixture(vision ? ["text", "image"] : ["text"]);
      const config = await f.executor.resolveConnectedModel(scope, "chatgpt-plan", "account-model");
      expect(config.acceptsImages).toBe(vision);
      await expect(
        f.executor.resolveConnectedModel(scope, "chatgpt-plan", "unknown-model"),
      ).rejects.toThrow(/not available/);
    },
  );
  it("reloads the encrypted successor instead of rotating a stale second run snapshot", async () => {
    const f = fixture();
    const first = await f.executor.resolveConnectedModel(scope, "chatgpt-plan", "account-model");
    const second = await f.executor.resolveConnectedModel(scope, "chatgpt-plan", "account-model");
    const configs = [first, second];
    let rotations = 0;
    const stores = configs.map(
      (config) =>
        new PiRuntimeCredentialStore(
          "chatgpt-plan",
          toOAuthCredential(config.oauth!.credential),
          config.oauth?.persist,
          config.oauth?.retire,
          config.oauth?.synchronize,
        ),
    );
    await Promise.all(
      stores.map((store) =>
        store.modify("chatgpt-plan", async (current) => {
          if (current?.type !== "oauth" || current.access !== "fake-before") return undefined;
          rotations++;
          return {
            ...current,
            access: "fake-successor",
            refresh: "fake-successor-refresh",
            expires: Date.now() + 7200_000,
          };
        }),
      ),
    );
    expect(rotations).toBe(1);
    expect(f.secretStore.put).toHaveBeenCalledTimes(1);
    expect(stores.map((store) => store.accessToken)).toEqual(["fake-successor", "fake-successor"]);
    expect(f.order.filter((entry) => entry === "lock")).toHaveLength(4);
    expect(f.read()).toMatchObject({
      kind: "oauth",
      credential: { access: "fake-successor", refresh: "fake-successor-refresh" },
    });
  });

  it("commits an encrypted pending rotation and rethrows its safe error", async () => {
    const f = fixture();
    const config = await f.executor.resolveConnectedModel(scope, "chatgpt-plan", "account-model");
    rotation.checkpoint = {
      ...f.initial,
      pendingRotation: {
        response: {
          access_token: "fake-pending-access",
          refresh_token: "fake-pending-refresh",
          id_token: "fake-pending-id",
          expires_in: 3600,
          scope: "chatgpt.tokens.use.direct",
        },
        receivedAt: Date.now(),
      },
    };
    f.order.length = 0;
    await expect(
      config.oauth!.synchronize!(async () => {
        throw rotation.error;
      }),
    ).rejects.toBe(rotation.error);
    expect(f.order).toEqual(["lock", "persist", "commit"]);
    expect(f.read()).toMatchObject({
      kind: "oauth",
      credential: { pendingRotation: { response: { refresh_token: "fake-pending-refresh" } } },
    });
    rotation.checkpoint = undefined;
  });

  it("retains the checkpoint when Pi wraps the refresh failure in an OAuth error cause", async () => {
    const f = fixture();
    const registerSecrets = vi.fn();
    const config = await f.executor.resolveConnectedModel(
      scope,
      "chatgpt-plan",
      "account-model",
      registerSecrets,
    );
    const store = new PiRuntimeCredentialStore(
      "chatgpt-plan",
      toOAuthCredential(config.oauth!.credential),
      config.oauth?.persist,
      config.oauth?.retire,
      config.oauth?.synchronize,
    );
    rotation.checkpoint = {
      ...f.initial,
      pendingRotation: {
        response: {
          access_token: "fake-pending-access",
          refresh_token: "fake-pending-refresh",
          id_token: "fake-pending-id",
          expires_in: 3600,
          scope: "chatgpt.tokens.use.direct",
        },
        receivedAt: Date.now(),
      },
    };
    f.order.length = 0;
    const wrapped = new Error("OAuth refresh failed for chatgpt-plan", { cause: rotation.error });
    try {
      await expect(
        store.modify("chatgpt-plan", async () => {
          throw wrapped;
        }),
      ).rejects.toBe(wrapped);
      expect(f.order).toEqual(["lock", "persist", "commit"]);
      expect(f.read()).toMatchObject({
        kind: "oauth",
        credential: { pendingRotation: { response: { refresh_token: "fake-pending-refresh" } } },
      });
      expect(store.accessToken).toBe("fake-before");
      expect(registerSecrets).toHaveBeenCalledWith(
        expect.arrayContaining(["fake-pending-access", "fake-pending-refresh", "fake-pending-id"]),
      );
    } finally {
      rotation.checkpoint = undefined;
    }
  });

  it("rejects a model removed from the current catalog before invoking a stale run's refresh", async () => {
    const f = fixture();
    const config = await f.executor.resolveConnectedModel(scope, "chatgpt-plan", "account-model");
    f.replace({ ...f.initial, chatgptPlanModels: [] });
    const operation = vi.fn(async () => f.initial);
    await expect(config.oauth!.synchronize!(operation)).rejects.toThrow(/not available/);
    expect(operation).not.toHaveBeenCalled();
    expect(f.secretStore.put).not.toHaveBeenCalled();
  });

  it("clears a stale request-local credential after another process disconnected it", async () => {
    const f = fixture();
    const config = await f.executor.resolveConnectedModel(scope, "chatgpt-plan", "account-model");
    const store = new PiRuntimeCredentialStore(
      "chatgpt-plan",
      toOAuthCredential(config.oauth!.credential),
      config.oauth?.persist,
      config.oauth?.retire,
      config.oauth?.synchronize,
    );
    f.disconnect();
    const refresh = vi.fn(async () => f.initial);
    await expect(store.modify("chatgpt-plan", refresh)).resolves.toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    expect(store.accessToken).toBeUndefined();
    expect(f.secretStore.put).not.toHaveBeenCalled();
  });

  it("publishes a rotating successor before cancellation stops the request", async () => {
    const f = fixture();
    const config = await f.executor.resolveConnectedModel(scope, "chatgpt-plan", "account-model");
    const store = new PiRuntimeCredentialStore(
      "chatgpt-plan",
      toOAuthCredential(config.oauth!.credential),
      config.oauth?.persist,
      config.oauth?.retire,
      config.oauth?.synchronize,
    );
    const controller = new AbortController();
    f.order.length = 0;
    await expect(
      store.modify(
        "chatgpt-plan",
        async () => {
          controller.abort();
          return { ...f.initial, access: "fake-after-cancel", refresh: "fake-rotated" };
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.order).toEqual(["lock", "persist", "commit"]);
    expect(f.read()).toMatchObject({
      kind: "oauth",
      credential: { access: "fake-after-cancel", refresh: "fake-rotated" },
    });
    expect(store.accessToken).toBe("fake-after-cancel");
  });
});
