import type { AdapterContext, SecretResourceIdentity } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { InfisicalSecretStore } from "./infisical-secret-store.js";
import { ComposedSecretStore } from "./secret-store-factory.js";
import { infisicalFake } from "./secret-store-fake.js";
import { EncryptedSecretStore } from "./secrets.js";

const context: AdapterContext = {
  userId: "fake-owner",
  spaceId: "fake-space",
  operationId: "identity",
  traceId: "identity",
  signal: new AbortController().signal,
};
function external(value: SecretResourceIdentity) {
  if (value.kind !== "external") throw new Error("Expected an external resource identity");
  return value;
}
function alias(ref: string, key: string) {
  return `${ref.slice(0, ref.lastIndexOf(":") + 1)}${key}`;
}

describe("backend secret resource identity", () => {
  it("recognizes only an AAD-matching inline reservation as having no external resource", () => {
    const encrypted = new EncryptedSecretStore("fake-key");
    const reservation = encrypted.prepareWrite("row");
    expect(encrypted.resourceIdentity(reservation, "row")).toEqual({ kind: "inline" });
    expect(encrypted.resourceIdentity(reservation, "other-row")).toEqual({ kind: "unknown" });
    expect(encrypted.resourceIdentity("inline:v1:invalid", "row")).toEqual({ kind: "unknown" });
  });
  it("classifies inline values without a resource and never misroutes remote refs into inline", async () => {
    const encrypted = new EncryptedSecretStore("fake-key");
    const value = await encrypted.put("fake-protected-value", context, { recordId: "row" });
    expect(encrypted.resourceIdentity(value.ref, "row")).toEqual({ kind: "inline" });
    expect(encrypted.resourceIdentity("infisical:v1:missing", "row")).toEqual({ kind: "unknown" });
    const composite = new ComposedSecretStore(encrypted);
    expect(composite.resourceIdentity(value.ref, "row")).toEqual({ kind: "inline" });
    expect(composite.resourceIdentity("infisical:v1:missing", "row")).toEqual({ kind: "unknown" });
    expect(composite.resourceIdentity("unsupported-provider:v1:opaque", "row")).toEqual({
      kind: "unknown",
    });
    await composite.close();
  });
  it("recognizes v1/v2 and client-id aliases of one actual shared provider key without reading its value", async () => {
    const sourceFake = infisicalFake(),
      targetFake = infisicalFake({ clientId: "second-fake-client", values: sourceFake.values });
    const source = new InfisicalSecretStore(sourceFake.options),
      target = new InfisicalSecretStore(targetFake.options);
    try {
      const written = await source.put("fake-shared-value", context, { recordId: "cloned-row" });
      const key = written.ref.split(":").at(-1)!;
      const targetRef = alias(target.prepareWrite("cloned-row"), key);
      expect(targetRef).not.toBe(written.ref);
      const callsBefore = sourceFake.fetcher.mock.calls.length;
      const a = external(source.resourceIdentity(written.ref, "cloned-row"));
      const b = external(target.resourceIdentity(targetRef, "cloned-row"));
      expect(a).toEqual(b);
      expect(sourceFake.fetcher).toHaveBeenCalledTimes(callsBefore);
      expect(targetFake.fetcher).not.toHaveBeenCalled();
      // The fake has one physical namespace: both locator versions really load the same key.
      await expect(target.load(targetRef, "cloned-row")).resolves.toBe("fake-shared-value");
      expect(sourceFake.values.size).toBe(1);
      const encoded = JSON.stringify(a);
      for (const privatePart of [
        key,
        sourceFake.options.baseUrl,
        sourceFake.options.clientId,
        "fake-shared-value",
        "fake-project",
      ])
        expect(encoded).not.toContain(privatePart);
    } finally {
      await source.close();
      await target.close();
    }
  });
  it("normalizes equivalent provider URL spellings and excludes authentication secrets", () => {
    const fake = infisicalFake(),
      source = new InfisicalSecretStore(fake.options);
    const ref = source.prepareWrite("row");
    const other = new InfisicalSecretStore({
      ...fake.options,
      baseUrl: "https://SECRETS.example.test:443/",
      clientSecret: "rotated-fake-secret",
    });
    expect(other.resourceIdentity(ref, "row")).toEqual(source.resourceIdentity(ref, "row"));
    expect(fake.fetcher).not.toHaveBeenCalled();
  });
  it.each(["baseUrl", "projectId", "environment", "folder"] as const)(
    "keeps a conservative deletion collision across a changed %s namespace",
    (field) => {
      const fake = infisicalFake(),
        source = new InfisicalSecretStore(fake.options);
      const ref = source.prepareWrite("row"),
        key = ref.split(":").at(-1)!;
      const other = new InfisicalSecretStore({
        ...fake.options,
        [field]:
          field === "baseUrl"
            ? "https://proxy.example.test"
            : field === "folder"
              ? "/different"
              : "different",
      });
      const otherRef = alias(other.prepareWrite("row"), key);
      const a = external(source.resourceIdentity(ref, "row")),
        b = external(other.resourceIdentity(otherRef, "row"));
      expect(b.fingerprint).not.toBe(a.fingerprint);
      expect(b.deletionKeyFingerprint).toBe(a.deletionKeyFingerprint);
      expect(fake.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(["/rakazo/", "/rakazo//nested", "/rakazo/../other"])(
    "treats ambiguous folder %s as unknown",
    (folder) => {
      const fake = infisicalFake({ folder }),
        remote = new InfisicalSecretStore(fake.options);
      expect(remote.resourceIdentity(remote.prepareWrite("row"), "row")).toEqual({
        kind: "unknown",
      });
      expect(fake.fetcher).not.toHaveBeenCalled();
    },
  );
  it("does not confuse a different key with the protected source resource", () => {
    const fake = infisicalFake(),
      remote = new InfisicalSecretStore(fake.options);
    const a = external(remote.resourceIdentity(remote.prepareWrite("row"), "row"));
    const b = external(remote.resourceIdentity(remote.prepareWrite("row"), "row"));
    expect(b.fingerprint).not.toBe(a.fingerprint);
    expect(b.deletionKeyFingerprint).not.toBe(a.deletionKeyFingerprint);
  });
  it("does not equate malformed, foreign-scope or wrong-AAD refs with a harmless inline value", () => {
    const fake = infisicalFake(),
      remote = new InfisicalSecretStore(fake.options);
    const composite = new ComposedSecretStore(new EncryptedSecretStore("fake-key"), remote);
    const ref = remote.prepareWrite("row");
    for (const value of [
      "infisical:v2:malformed",
      "infisical:v1:invalid",
      ref.replace(":v2:", ":v2:foreign:"),
    ])
      expect(composite.resourceIdentity(value, "row")).toEqual({ kind: "unknown" });
    expect(composite.resourceIdentity(ref, "different-aad")).toEqual({ kind: "unknown" });
    expect(fake.fetcher).not.toHaveBeenCalled();
  });
  it("routes metadata using the ref rather than the current write provider", () => {
    const fake = infisicalFake(),
      remote = new InfisicalSecretStore(fake.options),
      encrypted = new EncryptedSecretStore("fake-key");
    const composite = new ComposedSecretStore(encrypted, remote);
    expect(composite.resourceIdentity(remote.prepareWrite("row"), "row").kind).toBe("external");
    const method = vi.spyOn(encrypted, "resourceIdentity");
    expect(composite.resourceIdentity("v2:inline-opaque-ref", "row")).toEqual({ kind: "inline" });
    expect(method).toHaveBeenCalledOnce();
  });
});
