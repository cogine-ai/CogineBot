import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createDeploymentTransferKeyPair,
  DEPLOYMENT_TRANSFER_MAX_WIRE_BYTES,
  deploymentTransferDigest,
  deploymentTransferFingerprint,
  deploymentTransferPublicKeyFromPrivate,
  encodeDeploymentTransferJson,
  signDeploymentTransferMessage,
  verifyDeploymentTransferMessage,
} from "./deployment-transfer-crypto.js";

const identity = createDeploymentTransferKeyPair();
const other = createDeploymentTransferKeyPair();

describe("fixed deployment transfer signatures", () => {
  it("matches independent Node Ed25519 encoding and operation separation", () => {
    const value = { target: "https://target.example.test", revision: 2, source: "source" };
    const bytes = Buffer.from(
      'coginebot.transfer/1:proposal\n{"revision":2,"source":"source","target":"https://target.example.test"}',
    );
    const privateKey = createPrivateKey({
      key: Buffer.from(identity.privateKey, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey(privateKey);
    const signature = signDeploymentTransferMessage(identity.privateKey, "proposal", value);
    expect(signature).toBe(sign(null, bytes, privateKey).toString("base64url"));
    expect(verify(null, bytes, publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    expect(verifyDeploymentTransferMessage(identity.publicKey, "proposal", value, signature)).toBe(
      true,
    );
    expect(verifyDeploymentTransferMessage(identity.publicKey, "grant", value, signature)).toBe(
      false,
    );
    expect(deploymentTransferDigest("proposal", value)).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });
  it("derives the public identity from the private key and fingerprints exact public bytes", () => {
    expect(deploymentTransferPublicKeyFromPrivate(identity.privateKey)).toBe(identity.publicKey);
    expect(deploymentTransferFingerprint(identity.publicKey)).toBe(
      createHash("sha256").update(Buffer.from(identity.publicKey, "base64url")).digest("hex"),
    );
    expect(other.fingerprint).not.toBe(identity.fingerprint);
  });
  it("binds the entire item value, owner mapping, intent and counterpart", () => {
    const value = {
      itemKey: "fixture-item",
      value: "synthetic-only",
      owner: "fixture-owner",
      nonce: "fixture-nonce",
      target: "https://target.example.test",
      revision: 1,
    };
    const signature = signDeploymentTransferMessage(identity.privateKey, "item", value);
    for (const patch of [
      { value: "changed" },
      { owner: "another" },
      { nonce: "another" },
      { target: "https://another.example.test" },
      { revision: 2 },
    ])
      expect(
        verifyDeploymentTransferMessage(
          identity.publicKey,
          "item",
          { ...value, ...patch },
          signature,
        ),
      ).toBe(false);
    expect(verifyDeploymentTransferMessage(other.publicKey, "item", value, signature)).toBe(false);
  });
  it.each([
    "",
    "not-a-key",
    `${identity.publicKey}=`,
    identity.privateKey,
    identity.publicKey.repeat(100),
  ])("rejects noncanonical or wrong-kind public keys without exposing input (%#)", (key) => {
    expect(() => deploymentTransferFingerprint(key)).toThrow(
      "Invalid deployment transfer identity",
    );
    expect(verifyDeploymentTransferMessage(key, "item", {}, "bad")).toBe(false);
  });
  it("rejects malformed signatures and private keys", () => {
    const signature = signDeploymentTransferMessage(identity.privateKey, "item", {});
    for (const value of [
      "",
      "bad",
      `${signature}=`,
      signature.slice(1),
      `${signature.slice(0, -1)}!`,
    ])
      expect(verifyDeploymentTransferMessage(identity.publicKey, "item", {}, value)).toBe(false);
    expect(() => signDeploymentTransferMessage("synthetic-private-input", "item", {})).toThrow(
      "Invalid deployment transfer identity",
    );
  });
});

describe("bounded canonical transfer JSON", () => {
  it("sorts nested object keys while retaining array order, Unicode and literal values", () => {
    const value = { z: ["中\n", { b: false, a: null }], a: 3, absent: undefined };
    expect(encodeDeploymentTransferJson(value)).toBe('{"a":3,"z":["中\\n",{"a":null,"b":false}]}');
    expect(deploymentTransferDigest("plan", { b: 2, a: 1 })).toBe(
      deploymentTransferDigest("plan", { a: 1, b: 2 }),
    );
    expect(deploymentTransferDigest("plan", [1, 2])).not.toBe(
      deploymentTransferDigest("plan", [2, 1]),
    );
  });
  it.each([NaN, Infinity, 1.5, new Date(), undefined, [undefined], new Array(2), () => 1])(
    "rejects values outside the protocol JSON model (%#)",
    (value) => {
      expect(() => encodeDeploymentTransferJson(value)).toThrow(
        "Invalid deployment transfer message",
      );
    },
  );
  it("bounds depth, node count and actual UTF-8 bytes before signing", () => {
    let nested: unknown = {};
    for (let i = 0; i < 22; i++) nested = { nested };
    for (const value of [
      nested,
      Array.from({ length: 10_001 }, () => null),
      "中".repeat(DEPLOYMENT_TRANSFER_MAX_WIRE_BYTES / 2),
    ]) {
      expect(() => signDeploymentTransferMessage(identity.privateKey, "item", value)).toThrow(
        "Invalid deployment transfer message",
      );
      expect(verifyDeploymentTransferMessage(identity.publicKey, "item", value, "bad")).toBe(false);
    }
  });
});
