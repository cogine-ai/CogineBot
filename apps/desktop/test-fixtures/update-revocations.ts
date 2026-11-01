import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import type { UpdateArtifactIdentity, UpdateRevocationManifest } from "@rakazo/contracts";

if (process.env.NODE_ENV !== "test") throw new Error("Update test fixtures are test-only");

// Public RFC 8032 test-vector seed. Never a production signing key or trust root.
export const TEST_KEY = createPrivateKey({
  key: Buffer.from(
    "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  ),
  format: "der",
  type: "pkcs8",
});
export const TEST_PUBLIC_KEY = createPublicKey(TEST_KEY)
  .export({ format: "pem", type: "spki" })
  .toString();
export const NOW = Date.parse("2026-11-01T10:00:00.000Z");
export const ARTIFACT: UpdateArtifactIdentity = {
  version: "0.3.0",
  platform: "darwin",
  arch: "arm64",
  sha512: Buffer.alloc(64, 7).toString("base64"),
  channel: "stable",
};
export function manifest(
  overrides: Partial<UpdateRevocationManifest> = {},
): UpdateRevocationManifest {
  return {
    schemaVersion: 1,
    serial: 1,
    issuedAt: "2026-11-01T09:00:00.000Z",
    expiresAt: "2026-11-02T09:00:00.000Z",
    channel: "stable",
    revoked: [],
    ...overrides,
  };
}

export function signed(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { manifest: bytes, signature: sign(null, bytes, TEST_KEY) };
}
