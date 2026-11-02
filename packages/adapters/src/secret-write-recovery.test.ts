import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { InfisicalSecretStore } from "./infisical-secret-store.js";
import { ComposedSecretStore, reconcileSecretWrite } from "./secret-store-factory.js";
import { infisicalFake } from "./secret-store-fake.js";
import { EncryptedSecretStore } from "./secrets.js";

const context: AdapterContext = {
  operationId: "offline-recovery",
  traceId: "offline-recovery",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const secretPosts = (fake: ReturnType<typeof infisicalFake>) =>
  fake.fetcher.mock.calls.filter(
    ([input, init]) => init?.method === "POST" && String(input).includes("/secrets/"),
  );

describe("prepared credential write recovery", () => {
  it("finds the exact remote key after a lost acknowledgement and a fresh provider instance", async () => {
    const fake = infisicalFake();
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fake.fetcher(input, init);
      if (init?.method === "POST" && String(input).includes("/secrets/"))
        throw new Error("synthetic response loss after commit");
      return response;
    };
    const writer = new InfisicalSecretStore({ ...fake.options, fetch: fetcher });
    const recoveryRef = writer.prepareWrite("reserved-row");
    expect(fake.fetcher).not.toHaveBeenCalled();
    await expect(
      writer.put("private-value", context, { recordId: "reserved-row", recoveryRef }),
    ).rejects.toThrow();
    expect(fake.values.size).toBe(1);
    expect(secretPosts(fake)).toHaveLength(1);
    expect(fake.fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    await writer.close();
    const recovered = new InfisicalSecretStore(fake.options);
    try {
      expect(await recovered.reconcileWrite(recoveryRef, "reserved-row")).toEqual({
        state: "found",
        ref: recoveryRef,
      });
      await recovered.delete(recoveryRef, "reserved-row");
      expect(fake.values.size).toBe(0);
      // Remote absence is never promoted into proof that an old request cannot create later.
      expect(await recovered.reconcileWrite(recoveryRef, "reserved-row")).toEqual({
        state: "unknown",
      });
    } finally {
      await recovered.close();
    }
  });

  it("keeps an active write and another process's early 404 unknown before a late create", async () => {
    const fake = infisicalFake();
    let release!: () => void;
    let opened!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const fetcher: typeof fetch = async (input, init) => {
      if (init?.method === "POST" && String(input).includes("/secrets/")) {
        opened();
        await gate;
      }
      return fake.fetcher(input, init);
    };
    const writer = new InfisicalSecretStore({ ...fake.options, fetch: fetcher });
    const other = new InfisicalSecretStore(fake.options);
    const recoveryRef = writer.prepareWrite("row");
    const pending = writer.put("private-late-value", context, { recordId: "row", recoveryRef });
    try {
      await started;
      expect(await writer.reconcileWrite(recoveryRef, "row")).toEqual({ state: "unknown" });
      expect(await other.reconcileWrite(recoveryRef, "row")).toEqual({ state: "unknown" });
      expect(fake.values.size).toBe(0);
      release();
      expect(await pending).toMatchObject({ ref: recoveryRef });
      expect(await other.reconcileWrite(recoveryRef, "row")).toEqual({
        state: "found",
        ref: recoveryRef,
      });
      await other.delete(recoveryRef, "row");
      expect(fake.values.size).toBe(0);
    } finally {
      release();
      await pending.catch(() => undefined);
      await writer.close();
      await other.close();
    }
  });

  it.each([429, 503])("does not redispatch a prepared create after HTTP %s", async (status) => {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore(fake.options);
    const recoveryRef = store.prepareWrite("row");
    fake.statuses.push(status);
    try {
      await expect(
        store.put("private", context, { recordId: "row", recoveryRef }),
      ).rejects.toThrow();
      expect(secretPosts(fake)).toHaveLength(1);
      expect(fake.sleep).not.toHaveBeenCalled();
      expect(fake.fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    } finally {
      await store.close();
    }
  });

  it("allows explicit unauthorized reauthentication without retrying an uncertain write", async () => {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore(fake.options);
    const recoveryRef = store.prepareWrite("row");
    fake.statuses.push(401, 200);
    try {
      expect(await store.put("private", context, { recordId: "row", recoveryRef })).toMatchObject({
        ref: recoveryRef,
      });
      expect(secretPosts(fake)).toHaveLength(2);
      expect(fake.values.size).toBe(1);
    } finally {
      await store.close();
    }
  });

  it.each(["projectId", "environment", "folder", "clientId", "baseUrl"] as const)(
    "does not inspect or delete through a changed %s",
    async (field) => {
      const fake = infisicalFake();
      const original = new InfisicalSecretStore(fake.options);
      const recoveryRef = original.prepareWrite("row");
      const changed = new InfisicalSecretStore({
        ...fake.options,
        [field]: field === "baseUrl" ? "https://different.example.test" : "different",
      });
      try {
        expect(await changed.reconcileWrite(recoveryRef, "row")).toEqual({ state: "unknown" });
        await expect(changed.delete(recoveryRef, "row")).rejects.toThrow(/scope/);
        await expect(
          changed.put("private", context, { recordId: "row", recoveryRef }),
        ).rejects.toThrow(/scope/);
        expect(fake.fetcher).not.toHaveBeenCalled();
      } finally {
        await original.close();
        await changed.close();
      }
    },
  );

  it("never routes a remote reservation or ref into inline absence or deletion", async () => {
    const fake = infisicalFake();
    const remote = new InfisicalSecretStore(fake.options);
    const recoveryRef = remote.prepareWrite("row");
    const encrypted = new EncryptedSecretStore("key");
    const inline = new ComposedSecretStore(encrypted);
    try {
      expect(await inline.reconcileWrite(recoveryRef, "row")).toEqual({ state: "unknown" });
      expect(await encrypted.reconcileWrite(recoveryRef, "row")).toEqual({ state: "unknown" });
      await expect(
        inline.put("private", context, { recordId: "row", recoveryRef }),
      ).rejects.toThrow();
      await expect(inline.delete(recoveryRef, "row")).rejects.toThrow(/unavailable/);
      await expect(encrypted.delete(recoveryRef, "row")).rejects.toThrow(/unavailable/);
      expect(fake.fetcher).not.toHaveBeenCalled();
    } finally {
      await remote.close();
      await inline.close();
    }
  });

  it("recognizes only an explicit, matching inline reservation as authoritatively absent", async () => {
    const fake = infisicalFake();
    const encrypted = new EncryptedSecretStore("key");
    const store = new ComposedSecretStore(encrypted, new InfisicalSecretStore(fake.options));
    const recoveryRef = store.prepareWrite("row", { ephemeral: true });
    try {
      expect(await store.reconcileWrite(recoveryRef, "row")).toEqual({ state: "absent" });
      expect(await store.reconcileWrite(recoveryRef, "different-row")).toEqual({
        state: "unknown",
      });
      expect(await reconcileSecretWrite(store, undefined, "row")).toEqual({ state: "unknown" });
      expect(
        await store.put("private-inline", context, { recordId: "row", recoveryRef }),
      ).toMatchObject({ id: "row" });
      expect(fake.fetcher).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it("keeps malformed and old unprepared locators unknown without network access", async () => {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore(fake.options);
    try {
      for (const value of [
        "infisical:v1:old-key",
        "infisical:v2:invalid",
        "inline:v1:wrong",
        "arbitrary",
      ])
        expect(await store.reconcileWrite(value, "row")).toEqual({ state: "unknown" });
      expect(fake.fetcher).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });
});
