/** Exact downloaded artifact identity; a version alone does not identify an installer. */
export interface UpdateArtifactIdentity {
  version: string;
  platform: string;
  arch: string;
  sha512: string;
  channel: string;
}

/** Prototype protocol only. Production publishers and trust roots are not configured. */
export interface UpdateRevocationManifest {
  schemaVersion: 1;
  serial: number;
  issuedAt: string;
  expiresAt: string;
  channel: string;
  revoked: Array<Omit<UpdateArtifactIdentity, "channel"> & { reason: string }>;
}

export interface UpdateRevocationStatus {
  status: "unknown" | "clear" | "revoked";
  artifact: UpdateArtifactIdentity;
  checkedAt: number;
  expiresAt: number | null;
  reason: string | null;
}

export interface UpdateRevocationClient {
  check: (artifact: UpdateArtifactIdentity) => Promise<UpdateRevocationStatus>;
}
