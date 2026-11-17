import type { OAuthCredential } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  AgentModelOAuthCredential,
  AgentRunModel,
  ModelCredentialFailedState,
  ModelCredentialRetireReason,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { PiRuntimeCredentialStore } from "./pi-credentials.js";
import {
  matchesFailedOAuthSecret,
  OAUTH_ACCOUNT_CHANGED_ERROR,
  RetiredModelCredentialError,
  serializeModelSecret,
} from "./pi-oauth.js";

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60 * 60_000,
    ...overrides,
  };
}

describe("PiRuntimeCredentialStore", () => {
  it("keeps rotation ownership until a started callback settles after its deadline", async () => {
    const stopped = new AbortController();
    const held = credential();
    const successor = credential({ access: "successor", refresh: "successor-refresh" });
    let finish!: (value: OAuthCredential) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let saved = held;
    const store = new PiRuntimeCredentialStore(
      "anthropic",
      held,
      undefined,
      undefined,
      undefined,
      async (_, operation) => {
        const next = await operation(held, stopped.signal);
        if (next) saved = { ...next, type: "oauth" };
        return saved;
      },
    );
    let settled = false;
    const result = store.modify("anthropic", async () => {
      started();
      return new Promise<OAuthCredential>((resolve) => {
        finish = resolve;
      });
    });
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await entered;
    stopped.abort();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    finish(successor);
    await expect(result).resolves.toEqual(successor);
    expect(saved).toEqual(successor);
    expect(store.accessToken).toBe("successor");
  });
  it("runs provider refresh against the locked stored token and publishes only the committed result", async () => {
    const held = credential({ access: "stale", expires: 1 });
    const stored = credential({ access: "latest", refresh: "latest-refresh", expires: 2 });
    const successor = credential({ access: "successor" });
    const persist = vi.fn();
    const refresh = vi.fn<NonNullable<NonNullable<AgentRunModel["oauth"]>["refresh"]>>(
      async (seen, operation) => {
        expect(seen).toEqual(held);
        const result = await operation(stored, new AbortController().signal);
        expect(store.accessToken).toBe("stale");
        expect(result).toEqual(successor);
        return successor;
      },
    );
    const store = new PiRuntimeCredentialStore(
      "anthropic",
      held,
      persist,
      undefined,
      undefined,
      refresh,
    );
    const provider = vi.fn<Parameters<PiRuntimeCredentialStore["modify"]>[1]>(async (current) => {
      expect(current).toEqual(stored);
      return successor;
    });
    await expect(store.modify("anthropic", provider)).resolves.toEqual(successor);
    expect(provider).toHaveBeenCalledOnce();
    expect(store.accessToken).toBe("successor");
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps the held token when the coordinated refresh fails to commit", async () => {
    const held = credential();
    const store = new PiRuntimeCredentialStore(
      "anthropic",
      held,
      undefined,
      undefined,
      undefined,
      async (_, operation) => {
        await operation(held, new AbortController().signal);
        throw new Error("commit failed");
      },
    );
    await expect(
      store.modify("anthropic", async () => credential({ access: "uncommitted" })),
    ).rejects.toThrow("commit failed");
    expect(store.accessToken).toBe(held.access);
  });

  it("clears the request-local token only after confirmed retirement", async () => {
    const store = new PiRuntimeCredentialStore(
      "anthropic",
      credential(),
      undefined,
      undefined,
      undefined,
      async () => {
        throw new RetiredModelCredentialError("Reconnect");
      },
    );
    await expect(store.modify("anthropic", vi.fn())).rejects.toThrow("Reconnect");
    expect(await store.list()).toEqual([]);
  });

  it("does not start a provider operation after the coordinated refresh deadline", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const held = credential();
    const store = new PiRuntimeCredentialStore(
      "anthropic",
      held,
      undefined,
      undefined,
      undefined,
      async (_, operation) => {
        await operation(held, stopped.signal);
        return held;
      },
    );
    await expect(
      store.modify("anthropic", async () => new Promise(() => {})),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(store.accessToken).toBe(held.access);
  });

  it("reloads current ChatGPT credentials under a shared lock before each request-local refresh", async () => {
    let saved = credential({ access: "old-access", expires: 0 });
    let chain = Promise.resolve();
    let rotations = 0;
    let publications = 0;
    const synchronize = async (
      operation: (
        current: AgentModelOAuthCredential,
      ) => Promise<AgentModelOAuthCredential | undefined>,
    ) => {
      const previous = chain;
      let release!: () => void;
      chain = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        const next = await operation(saved);
        if (next && JSON.stringify(next) !== JSON.stringify(saved)) {
          saved = { ...next };
          publications++;
        }
        return saved;
      } finally {
        release();
      }
    };
    const stores = [
      new PiRuntimeCredentialStore("chatgpt-plan", saved, undefined, undefined, synchronize),
      new PiRuntimeCredentialStore("chatgpt-plan", saved, undefined, undefined, synchronize),
    ];
    await Promise.all(
      stores.map((store) =>
        store.modify("chatgpt-plan", async (current) => {
          if (current?.type !== "oauth" || current.expires > Date.now()) return undefined;
          rotations++;
          return credential({ access: "new-access", refresh: "rotated-refresh" });
        }),
      ),
    );
    expect(rotations).toBe(1);
    expect(publications).toBe(1);
    expect(stores.map((store) => store.accessToken)).toEqual(["new-access", "new-access"]);
  });

  it("commits a ChatGPT successor before reporting cancellation after refresh", async () => {
    const controller = new AbortController();
    let saved = credential({ access: "old-access", expires: 0 });
    const persist = vi.fn();
    const store = new PiRuntimeCredentialStore(
      "chatgpt-plan",
      saved,
      persist,
      undefined,
      async (operation) => {
        const next = await operation(saved);
        saved = next ? { ...next } : saved;
        return saved;
      },
    );
    await expect(
      store.modify(
        "chatgpt-plan",
        async () => {
          controller.abort();
          return credential({ access: "successor-access", refresh: "successor-refresh" });
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(saved).toMatchObject({ access: "successor-access", refresh: "successor-refresh" });
    expect(store.accessToken).toBe("successor-access");
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not publish a synchronized ChatGPT credential before its transaction commits", async () => {
    const before = credential({ access: "before" });
    const store = new PiRuntimeCredentialStore(
      "chatgpt-plan",
      before,
      undefined,
      undefined,
      async (operation) => {
        await operation(before);
        throw new Error("commit failed");
      },
    );
    await expect(
      store.modify("chatgpt-plan", async () => credential({ access: "uncommitted" })),
    ).rejects.toThrow("commit failed");
    expect(store.accessToken).toBe("before");
  });

  it("does not configure openai-codex without a stored OAuth credential", async () => {
    expect(await builtinModels().getAuth("openai-codex")).toBeUndefined();
  });

  it("uses the actual SDK provider deadline inside coordinated runtime refresh", async () => {
    const held = credential({ expires: 1 });
    const deadline = new AbortController();
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => (ms === 15_000 ? deadline.signal : originalTimeout(ms)));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let providerSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      providerSignal = init?.signal ?? undefined;
      entered();
      return new Promise<Response>((_resolve, reject) => {
        providerSignal!.addEventListener("abort", () => reject(providerSignal!.reason), {
          once: true,
        });
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const save = vi.fn();
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      held,
      undefined,
      undefined,
      undefined,
      async (_, operation) => {
        const next = await operation(held, new AbortController().signal);
        if (next) save(next);
        return next ?? held;
      },
    );
    try {
      const auth = builtinModels({ credentials: store }).getAuth("openai-codex");
      const rejected = expect(auth).rejects.toThrow();
      await started;
      expect(timeout).toHaveBeenCalledWith(15_000);
      expect(providerSignal).toBe(deadline.signal);
      deadline.abort(new Error("provider deadline"));
      await rejected;
      expect(fetcher).toHaveBeenCalledOnce();
      expect(save).not.toHaveBeenCalled();
      expect(store.accessToken).toBe(held.access);
    } finally {
      deadline.abort();
      timeout.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("bridges an encrypted OAuth credential into the OAuth-only Codex provider", async () => {
    const store = new PiRuntimeCredentialStore("openai-codex", credential());
    const models = builtinModels({ credentials: store });

    const auth = await models.getAuth("openai-codex");

    expect(auth?.auth.apiKey).toBe("access-token");
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });

  it("serializes refresh publication without exposing credential values in metadata", async () => {
    let persisted: OAuthCredential | undefined;
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ access: "old-access" }),
      async (next) => {
        persisted = next;
      },
    );

    await store.modify("openai-codex", async () => credential({ access: "new-access" }));

    expect(persisted?.access).toBe("new-access");
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });

  it("retires once when a mid-run refresh is terminally rejected", async () => {
    const retire = vi.fn(async () => undefined);
    const store = new PiRuntimeCredentialStore("openai-codex", credential(), undefined, retire);
    const failure = new Error("OAuth refresh failed for openai-codex", {
      cause: new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'),
    });

    await expect(
      store.modify("openai-codex", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(retire).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith(
      "terminal-refresh-failure",
      "invalid_grant",
      // The credential state the failed refresh was attempted on.
      expect.objectContaining({
        access: "access-token",
        refresh: "refresh-token",
      }),
    );
    // The failed refresh must not clear the in-memory credential itself.
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });

  it("settles retirement before the refresh error surfaces", async () => {
    let releaseRetire!: () => void;
    const retireGate = new Promise<undefined>((resolve) => {
      releaseRetire = () => resolve(undefined);
    });
    const retire = vi.fn(() => retireGate);
    const store = new PiRuntimeCredentialStore("openai-codex", credential(), undefined, retire);
    const failure = new Error("OAuth refresh failed for openai-codex", {
      cause: new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'),
    });

    let settled = false;
    const modification = store
      .modify("openai-codex", async () => {
        throw failure;
      })
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    // The delete must commit before the failure can be observed.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseRetire();
    await modification;
    expect(settled).toBe(true);
  });

  it("does not retire on transient mid-run refresh failures", async () => {
    const retire = vi.fn(async () => undefined);
    const store = new PiRuntimeCredentialStore("openai-codex", credential(), undefined, retire);

    for (const failure of [
      new Error("OAuth refresh failed for openai-codex", {
        cause: new Error('OpenAI Codex token refresh failed (500): {"error":"invalid_grant"}'),
      }),
      new Error("OpenAI Codex token refresh error: socket hang up"),
    ]) {
      await expect(
        store.modify("openai-codex", async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
    }
    expect(retire).not.toHaveBeenCalled();
  });

  it("surfaces the refresh error when the awaited retirement fails", async () => {
    const retire = vi.fn(async () => {
      throw new Error("database gone");
    });
    const store = new PiRuntimeCredentialStore("openai-codex", credential(), undefined, retire);
    const failure = new Error('refresh failed (400): {"error":"refresh_token_reused"}');

    await expect(
      store.modify("openai-codex", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(retire).toHaveBeenCalledWith(
      "terminal-refresh-failure",
      "refresh_token_reused",
      expect.objectContaining({
        access: "access-token",
        refresh: "refresh-token",
      }),
    );
  });

  it("persists a mid-run refresh that returns the same account", async () => {
    const retire = vi.fn(async () => undefined);
    let persisted: OAuthCredential | undefined;
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ access: "old-access", accountId: "acct-a" }),
      async (next) => {
        persisted = next;
      },
      retire,
    );

    await store.modify("openai-codex", async () =>
      credential({ access: "new-access", accountId: "acct-a" }),
    );

    expect(persisted?.access).toBe("new-access");
    expect(retire).not.toHaveBeenCalled();
  });

  it("retires and fails a mid-run refresh that returns a different account", async () => {
    const retire = vi.fn(async () => true);
    const persist = vi.fn(async () => {});
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ accountId: "acct-a" }),
      persist,
      retire,
    );

    await expect(
      store.modify("openai-codex", async () =>
        credential({ access: "new-access", accountId: "acct-b" }),
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RetiredModelCredentialError &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );

    expect(retire).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith(
      "account-changed",
      "stored account acct-a, refreshed account acct-b",
      // The stored credential state whose refresh produced the foreign account.
      expect.objectContaining({ access: "access-token", refresh: "refresh-token" }),
    );
    // The account-B token is never persisted or adopted in memory.
    expect(persist).not.toHaveBeenCalled();
    expect(await store.read("openai-codex")).toMatchObject({ access: "access-token" });
  });

  it("settles account-change retirement before the error surfaces", async () => {
    let releaseRetire!: () => void;
    const retireGate = new Promise<undefined>((resolve) => {
      releaseRetire = () => resolve(undefined);
    });
    const retire = vi.fn(() => retireGate);
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ accountId: "acct-a" }),
      undefined,
      retire,
    );

    let settled = false;
    const modification = store
      .modify("openai-codex", async () => credential({ accountId: "acct-b" }))
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    // The delete must commit before the account-change failure can be observed.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseRetire();
    await modification;
    expect(settled).toBe(true);
  });

  it("still fails the refresh when the awaited account-change retirement fails", async () => {
    const retire = vi.fn(async () => {
      throw new Error("database gone");
    });
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ accountId: "acct-a" }),
      undefined,
      retire,
    );

    await expect(
      store.modify("openai-codex", async () => credential({ accountId: "acct-b" })),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RetiredModelCredentialError) &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );
    expect(retire).toHaveBeenCalledWith(
      "account-changed",
      "stored account acct-a, refreshed account acct-b",
      expect.objectContaining({ access: "access-token", refresh: "refresh-token" }),
    );
  });

  it("passes the stored credential state so a stale account-change retire skips a rotated row", async () => {
    // The caller wires the failed state into a matchesFailedSecret predicate
    // over the secret row's current ciphertext. The row was rewritten by a
    // concurrent successful refresh, so the stale account-change failure must
    // not delete the newer credential — and without the failed state the
    // fence is absent and the delete would proceed.
    const stored = credential({ refresh: "refresh-token", expires: 1, accountId: "acct-a" });
    const rotated = serializeModelSecret({
      kind: "oauth",
      credential: credential({
        refresh: "rotated-refresh",
        expires: 50_000,
        accountId: "acct-a",
      }),
    });
    const deleteCredential = vi.fn();
    const retire = async (
      _reason: ModelCredentialRetireReason,
      _detail?: string,
      failed?: ModelCredentialFailedState,
    ) => {
      const matches = failed ? matchesFailedOAuthSecret(() => rotated, failed) : undefined;
      if (matches && !(await matches({ id: "secret-codex", ciphertext: "cipher-codex" })))
        return false;
      deleteCredential();
      return true;
    };
    const store = new PiRuntimeCredentialStore("openai-codex", stored, undefined, retire);

    await expect(
      store.modify("openai-codex", async () => credential({ accountId: "acct-b" })),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RetiredModelCredentialError) &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );

    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("skips an account-change delete when another worker rotated only the access token", async () => {
    const stored = credential({
      access: "old-access",
      refresh: "same-refresh",
      expires: 1,
      accountId: "acct-a",
    });
    const rotated = serializeModelSecret({
      kind: "oauth",
      credential: credential({
        access: "rotated-access",
        refresh: "same-refresh",
        expires: 1,
        accountId: "acct-a",
      }),
    });
    const deleteCredential = vi.fn();
    const retire = async (
      _reason: ModelCredentialRetireReason,
      _detail?: string,
      failed?: ModelCredentialFailedState,
    ) => {
      const matches = failed ? matchesFailedOAuthSecret(() => rotated, failed) : undefined;
      if (matches && !(await matches({ id: "secret-codex", ciphertext: "cipher-codex" })))
        return false;
      deleteCredential();
      return true;
    };
    const store = new PiRuntimeCredentialStore("openai-codex", stored, undefined, retire);

    await expect(
      store.modify("openai-codex", async () => credential({ accountId: "acct-b" })),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RetiredModelCredentialError) &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );

    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("tolerates a missing account id on either side of a mid-run refresh", async () => {
    const retire = vi.fn(async () => undefined);
    const persisted: OAuthCredential[] = [];
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ access: "old-access" }),
      async (next) => {
        persisted.push(next);
      },
      retire,
    );

    // Stored side has no account id: no comparison, no retirement.
    await store.modify("openai-codex", async () =>
      credential({ access: "new-access", accountId: "acct-b" }),
    );
    // Refreshed side has no account id either.
    await store.modify("openai-codex", async () => credential({ access: "newer-access" }));

    expect(persisted.map((entry) => entry.access)).toEqual(["new-access", "newer-access"]);
    expect(retire).not.toHaveBeenCalled();
  });
});
