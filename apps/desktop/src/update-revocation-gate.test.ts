import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UpdateArtifactIdentity, UpdateRevocationClient } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadedUpdateRevocationGate } from "./update-revocation-gate.js";

const NOW = Date.parse("2026-11-01T10:00:00.000Z");
const folders: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function artifact(content = "synthetic installer", version = "0.3.0") {
  const dir = await mkdtemp(path.join(tmpdir(), "update-gate-test-"));
  folders.push(dir);
  const downloadedFile = path.join(dir, "installer.bin");
  await writeFile(downloadedFile, content);
  const sha512 = createHash("sha512").update(content).digest("base64");
  return { version, downloadedFile, files: [{ sha512 }], sha512 };
}

function verifier(status: "unknown" | "clear" | "revoked"): UpdateRevocationClient {
  return {
    check: vi.fn(async (identity: UpdateArtifactIdentity) => ({
      status,
      artifact: identity,
      checkedAt: NOW,
      expiresAt: status === "unknown" ? null : NOW + 60_000,
      reason: status === "revoked" ? "Synthetic withdrawal" : null,
    })),
  };
}

function gate(client: UpdateRevocationClient, now = () => NOW) {
  return new DownloadedUpdateRevocationGate({
    client,
    platform: "darwin",
    arch: "arm64",
    channel: "stable",
    now,
  });
}

describe("downloaded update installation gate", () => {
  it("retains an unconfirmed download but refuses any install effect", async () => {
    const download = await artifact();
    const control = gate(verifier("unknown"));
    await control.downloaded(download);
    const install = vi.fn();

    expect(await control.install(install)).toBe(false);
    expect(install).not.toHaveBeenCalled();
    expect(control.state()).toMatchObject({
      status: "unknown",
      artifact: { sha512: download.sha512 },
    });
    expect(await readFile(download.downloadedFile, "utf8")).toBe("synthetic installer");
  });

  it("binds approval to the selected file's digest rather than the first metadata item", async () => {
    const download = await artifact();
    const control = gate(verifier("clear"));
    await control.downloaded({
      ...download,
      files: [{ sha512: "another artifact" }, ...download.files],
    });
    const install = vi.fn();
    expect(await control.install(install)).toBe(true);
    expect(install).toHaveBeenCalledTimes(1);
    expect(control.state()).toMatchObject({ artifact: { arch: "arm64", sha512: download.sha512 } });
  });

  it("requires a matching authenticated download digest before checking withdrawal", async () => {
    const download = await artifact();
    const client = verifier("clear");
    const control = gate(client);
    await control.downloaded({ ...download, files: [{ sha512: "incorrect" }] });
    expect(await control.install(vi.fn())).toBe(false);
    expect(client.check).not.toHaveBeenCalled();
  });

  it("refuses an artifact replaced after a clear receipt and retains the changed file", async () => {
    const download = await artifact();
    const control = gate(verifier("clear"));
    await control.downloaded(download);
    await writeFile(download.downloadedFile, "changed installer");
    const install = vi.fn();
    expect(await control.install(install)).toBe(false);
    expect(install).not.toHaveBeenCalled();
    expect(control.state()?.status).toBe("unknown");
    expect(await readFile(download.downloadedFile, "utf8")).toBe("changed installer");
  });

  it("does not accept a symlink as the synthetic installer", async () => {
    const download = await artifact();
    const link = path.join(path.dirname(download.downloadedFile), "linked.bin");
    await symlink(download.downloadedFile, link);
    const control = gate(verifier("clear"));
    await control.downloaded({ ...download, downloadedFile: link });
    expect(await control.install(vi.fn())).toBe(false);
  });

  it("checks expiry at the install boundary even when no timer has fired", async () => {
    let now = NOW;
    const control = gate(verifier("clear"), () => now);
    await control.downloaded(await artifact());
    now += 60_000;
    expect(control.state()?.status).toBe("unknown");
    expect(await control.install(vi.fn(), false)).toBe(false);
    expect(await control.install(vi.fn())).toBe(false);
  });

  it("does not use a cached clear receipt after the local clock moves before its check", async () => {
    let now = NOW;
    const control = gate(verifier("clear"), () => now);
    await control.downloaded(await artifact());
    now -= 1;
    expect(await control.install(vi.fn(), false)).toBe(false);
    expect(control.state()?.status).toBe("unknown");
  });

  it("serializes simultaneous install requests to one effect and permits failure recovery", async () => {
    const control = gate(verifier("clear"));
    await control.downloaded(await artifact());
    const install = vi.fn();
    expect(await Promise.all([control.install(install), control.install(install)])).toEqual([
      true,
      false,
    ]);
    expect(install).toHaveBeenCalledTimes(1);
    control.installationFailed();
    const failing = vi.fn(() => {
      throw new Error("synthetic installer failure");
    });
    await expect(control.install(failing)).rejects.toThrow("synthetic installer failure");
    expect(await control.install(install)).toBe(true);
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("never lets a caller mutate a returned receipt into authorization", async () => {
    const control = gate(verifier("revoked"));
    await control.downloaded(await artifact());
    const state = control.state();
    if (!state) throw new Error("Expected a receipt");
    state.status = "clear";
    state.artifact.sha512 = "different";
    expect(control.state()?.status).toBe("revoked");
    expect(await control.install(vi.fn(), false)).toBe(false);
  });

  it("discards a late clear result across A to B to A download generations", async () => {
    const a = await artifact("installer A");
    const b = await artifact("installer B");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const client = verifier("revoked");
    const normalCheck = client.check;
    client.check = vi.fn(async (identity) => {
      if (!first) return normalCheck(identity);
      first = false;
      await blocked;
      return {
        status: "clear",
        artifact: identity,
        checkedAt: NOW,
        expiresAt: NOW + 60_000,
        reason: null,
      };
    });
    const control = gate(client);
    const old = control.downloaded(a);
    await vi.waitFor(() => expect(client.check).toHaveBeenCalledTimes(1));
    const middle = control.downloaded(b);
    const current = control.downloaded(a);
    expect(control.state()).toBeNull();
    expect(await control.install(vi.fn(), false)).toBe(false);
    release();
    await Promise.all([old, middle, current]);
    expect(control.state()).toMatchObject({ status: "revoked", artifact: { sha512: a.sha512 } });
    expect(client.check).toHaveBeenCalledTimes(2);
  });

  it("rejects a clear result for another artifact and treats a failed recheck as unknown", async () => {
    const client = verifier("clear");
    const check = client.check;
    client.check = vi.fn(async (identity) => ({
      ...(await check(identity)),
      artifact: { ...identity, arch: "x64" },
    }));
    const control = gate(client);
    await control.downloaded(await artifact());
    expect(control.state()?.status).toBe("unknown");
    client.check = async () => {
      throw new Error("offline");
    };
    expect(await control.install(vi.fn())).toBe(false);
  });

  it("fences an installation when a replacement arrives during its final feed check", async () => {
    const client = verifier("clear");
    const control = gate(client);
    await control.downloaded(await artifact("installer A"));
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const normalCheck = client.check;
    client.check = vi.fn(async (identity) => {
      await wait;
      return normalCheck(identity);
    });
    const install = vi.fn();
    const pendingInstall = control.install(install);
    await vi.waitFor(() => expect(client.check).toHaveBeenCalledTimes(1));
    const next = await artifact("installer B", "0.4.0");
    const pendingDownload = control.downloaded(next);
    release();
    expect(await pendingInstall).toBe(false);
    await pendingDownload;
    expect(install).not.toHaveBeenCalled();
    expect(control.state()).toMatchObject({ artifact: { version: "0.4.0", sha512: next.sha512 } });
  });

  it("cannot be enabled in a production process", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => gate(verifier("clear"))).toThrow("test-only");
  });

  it("keeps the selected build tuple fixed when its caller changes the options during hashing", async () => {
    const client = verifier("revoked");
    const check = client.check;
    client.check = async (identity) => ({
      ...(await check(identity)),
      status: identity.arch === "arm64" ? "revoked" : "clear",
    });
    const options = {
      client,
      platform: "darwin",
      arch: "arm64",
      channel: "stable",
      now: () => NOW,
    };
    const control = new DownloadedUpdateRevocationGate(options);
    const pending = control.downloaded(await artifact());
    options.arch = "x64";
    await pending;
    expect(control.state()).toMatchObject({ status: "revoked", artifact: { arch: "arm64" } });
    expect(await control.install(vi.fn())).toBe(false);
  });

  it("permanently closes a disposed prototype even if a download callback arrives late", async () => {
    const control = gate(verifier("clear"));
    control.dispose();
    await control.downloaded(await artifact());
    expect(await control.install(vi.fn())).toBe(false);
  });

  it("immediately declines quit while a manual install is awaiting its network review", async () => {
    const client = verifier("clear");
    const control = gate(client);
    await control.downloaded(await artifact());
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const check = client.check;
    client.check = vi.fn(async (identity) => {
      await wait;
      return check(identity);
    });
    const manual = control.install(vi.fn());
    await vi.waitFor(() => expect(client.check).toHaveBeenCalledTimes(1));
    let settled = false;
    const quit = control.install(vi.fn(), false).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const declinedWithoutNetworkWait = settled;
    release();
    await manual;
    expect(await quit).toBe(false);
    expect(declinedWithoutNetworkWait).toBe(true);
  });
});
