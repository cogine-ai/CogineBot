import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type {
  UpdateArtifactIdentity,
  UpdateRevocationClient,
  UpdateRevocationStatus,
} from "@rakazo/contracts";

interface DownloadedArtifact {
  identity: UpdateArtifactIdentity;
  file: string;
}

interface GateOptions {
  client: UpdateRevocationClient;
  /** The selected test-build tuple, including Rosetta selection, rather than process.arch. */
  platform: string;
  arch: string;
  channel: string;
  now?: () => number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha512(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Not an update file");
    const hash = createHash("sha512");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("Update changed while reading");
    }
    return hash.digest("base64");
  } finally {
    await handle.close();
  }
}

function sameArtifact(a: UpdateArtifactIdentity, b: UpdateArtifactIdentity) {
  return (
    a.version === b.version &&
    a.platform === b.platform &&
    a.arch === b.arch &&
    a.sha512 === b.sha512 &&
    a.channel === b.channel
  );
}

/** Test-only install boundary. No production composition supplies this PoC or a trust root. */
export class DownloadedUpdateRevocationGate {
  private generation = 0;
  private candidate: Promise<DownloadedArtifact | null> | null = null;
  private current: UpdateRevocationStatus | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private refreshInFlight: {
    generation: number;
    promise: Promise<UpdateRevocationStatus | null>;
  } | null = null;
  private installStarted = false;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly options: GateOptions) {
    if (process.env.NODE_ENV !== "test") throw new Error("Update revocation PoC is test-only");
    this.now = options.now ?? Date.now;
  }

  state(): UpdateRevocationStatus | null {
    const value = this.current;
    if (value === null) return null;
    const copy = { ...value, artifact: { ...value.artifact } };
    const now = this.now();
    if (
      !Number.isFinite(now) ||
      copy.checkedAt > now ||
      copy.expiresAt === null ||
      copy.expiresAt <= now
    ) {
      return { ...copy, status: "unknown", reason: null };
    }
    return copy;
  }

  /** Invalidate synchronously, before any asynchronous digest or network operation. */
  downloaded(payload: unknown): Promise<UpdateRevocationStatus | null> {
    if (this.disposed) return Promise.resolve(null);
    this.generation += 1;
    this.current = null;
    this.candidate = this.identify(payload).catch(() => null);
    return this.refresh();
  }

  private async identify(payload: unknown): Promise<DownloadedArtifact> {
    if (
      !record(payload) ||
      typeof payload.version !== "string" ||
      typeof payload.downloadedFile !== "string" ||
      !path.isAbsolute(payload.downloadedFile) ||
      !Array.isArray(payload.files)
    ) {
      throw new Error("Missing downloaded artifact identity");
    }
    // Copy the authenticated metadata before yielding; files[0] need not be the selected artifact.
    const { version, downloadedFile } = payload;
    const digests = payload.files.flatMap((file: unknown) =>
      record(file) && typeof file.sha512 === "string" ? [file.sha512] : [],
    );
    const digest = await sha512(downloadedFile);
    if (!digests.includes(digest)) throw new Error("Downloaded artifact digest mismatch");
    return {
      file: downloadedFile,
      identity: {
        version,
        sha512: digest,
        platform: this.options.platform,
        arch: this.options.arch,
        channel: this.options.channel,
      },
    };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  refresh(): Promise<UpdateRevocationStatus | null> {
    if (this.disposed) return Promise.resolve(null);
    const generation = this.generation;
    if (this.refreshInFlight?.generation === generation) return this.refreshInFlight.promise;
    const candidate = this.candidate;
    const promise = this.serialize(async () => {
      const artifact = await candidate;
      if (artifact && generation === this.generation) await this.review(artifact, generation);
      return this.state();
    });
    const flight = { generation, promise };
    this.refreshInFlight = flight;
    void promise.finally(() => {
      if (this.refreshInFlight === flight) this.refreshInFlight = null;
    });
    return promise;
  }

  private unknown(identity: UpdateArtifactIdentity): UpdateRevocationStatus {
    return {
      status: "unknown",
      artifact: { ...identity },
      checkedAt: this.now(),
      expiresAt: null,
      reason: null,
    };
  }

  private async review(artifact: DownloadedArtifact, generation: number) {
    let result = this.unknown(artifact.identity);
    try {
      const value = await this.options.client.check({ ...artifact.identity });
      if (
        sameArtifact(value.artifact, artifact.identity) &&
        value.checkedAt <= this.now() &&
        value.expiresAt !== null &&
        value.expiresAt > this.now()
      ) {
        result = { ...value, artifact: { ...value.artifact } };
      }
    } catch {
      // Availability failures keep the downloaded file but never authorize installation.
    }
    if (generation === this.generation) this.current = result;
  }

  /** Manual installs recheck the feed; a quit simulation uses only already-fresh evidence. */
  install(effect: () => void, manual = true): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (!manual && (this.refreshInFlight !== null || this.state()?.status !== "clear")) {
      return Promise.resolve(false);
    }
    const generation = this.generation;
    const candidate = this.candidate;
    return this.serialize(async () => {
      if (this.installStarted || generation !== this.generation) return false;
      const artifact = await candidate;
      if (!artifact || generation !== this.generation) return false;
      if (manual) await this.review(artifact, generation);
      const current = this.state();
      if (
        generation !== this.generation ||
        current?.status !== "clear" ||
        !sameArtifact(current.artifact, artifact.identity)
      ) {
        return false;
      }
      try {
        if ((await sha512(artifact.file)) !== artifact.identity.sha512) {
          if (generation === this.generation) this.current = this.unknown(artifact.identity);
          return false;
        }
      } catch {
        if (generation === this.generation) this.current = this.unknown(artifact.identity);
        return false;
      }
      if (generation !== this.generation || this.state()?.status !== "clear") return false;
      this.installStarted = true;
      try {
        effect();
      } catch (error) {
        this.installStarted = false;
        throw error;
      }
      return true;
    });
  }

  installationFailed() {
    this.installStarted = false;
  }

  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.candidate = null;
    this.current = null;
  }
}
