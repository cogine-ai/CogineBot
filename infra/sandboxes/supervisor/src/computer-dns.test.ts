import type * as NodeFsPromises from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostComputerUser } from "./computer-spec.js";

const mocks = vi.hoisted(() => ({
  getImage: vi.fn(),
  getContainer: vi.fn(),
  listContainers: vi.fn(),
  createContainer: vi.fn(),
  createNetwork: vi.fn(),
  created: { id: "new-computer", start: vi.fn(), remove: vi.fn() },
}));

vi.mock("dockerode", () => ({
  default: class {
    getImage = mocks.getImage;
    getContainer = mocks.getContainer;
    listContainers = mocks.listContainers;
    createContainer = mocks.createContainer;
    createNetwork = mocks.createNetwork;
  },
}));
vi.mock("./home-ownership.js", () => ({ assertComputerHomeWritable: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  mkdir: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("HOSTNAME", "");
  vi.stubEnv("DATA_DIR", "/tmp/example-computer-dns");
  vi.stubEnv("SANDBOX_SUPERVISOR_TOKEN", "test-supervisor-token");
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "internal");
  vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "open");
  vi.stubEnv("SANDBOX_CONTROL_VIA_LOOPBACK", "false");
  vi.stubEnv("SANDBOX_COMPUTER_DNS", "192.0.2.53,2001:db8::53");
  mocks.getImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({ Id: "image" }) });
  mocks.listContainers.mockResolvedValue([]);
  mocks.created.start.mockResolvedValue(undefined);
  mocks.created.remove.mockResolvedValue(undefined);
  mocks.createContainer.mockResolvedValue(mocks.created);
});

afterEach(() => vi.unstubAllEnvs());

async function provision() {
  const { supervisorApp } = await import("./index.js");
  return supervisorApp.request("/computers", {
    method: "POST",
    headers: {
      authorization: "Bearer test-supervisor-token",
      "content-type": "application/json",
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
    },
    body: JSON.stringify({
      botId: "bot",
      spaceId: "space",
      homePath: "/tmp/example-computer-dns/homes/bot",
    }),
  });
}

function existingComputer(running: boolean, dns: string[] | null | undefined) {
  const info = {
    Image: "image",
    Config: {
      User: hostComputerUser(),
      Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
    },
    HostConfig: { NetworkMode: "bridge", PortBindings: {}, Dns: dns },
    State: { Running: running },
    NetworkSettings: { Networks: {} },
  };
  const existing = {
    id: "existing",
    inspect: vi.fn().mockResolvedValue(info),
    start: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  mocks.listContainers.mockResolvedValue([{ Id: existing.id }]);
  mocks.getContainer.mockReturnValue(existing);
  return { existing, info };
}

describe("computer DNS provisioning", () => {
  it("rejects invalid startup DNS before making Docker calls", async () => {
    vi.stubEnv("SANDBOX_COMPUTER_DNS", "not-an-ip");
    await expect(provision()).rejects.toThrow(/SANDBOX_COMPUTER_DNS/);
    expect(mocks.getImage).not.toHaveBeenCalled();
    expect(mocks.listContainers).not.toHaveBeenCalled();
    expect(mocks.createContainer).not.toHaveBeenCalled();
    expect(mocks.createNetwork).not.toHaveBeenCalled();
  });

  it.each([undefined, "", " , "])(
    "leaves a new computer on Docker's resolver for %j",
    async (value) => {
      vi.stubEnv("SANDBOX_COMPUTER_DNS", value);
      expect((await provision()).status).toBe(200);
      expect(mocks.createContainer.mock.calls[0]?.[0].HostConfig.Dns).toBeUndefined();
    },
  );

  it("creates a computer with the operator's ordered DNS servers", async () => {
    const response = await provision();
    expect(response.status).toBe(200);
    expect(mocks.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        HostConfig: expect.objectContaining({ Dns: ["192.0.2.53", "2001:db8::53"] }),
      }),
    );
  });

  it("keeps a running compatible computer on its current DNS", async () => {
    const { existing } = existingComputer(true, ["198.51.100.53"]);
    const response = await provision();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "existing", resumed: true, started: false });
    expect(existing.remove).not.toHaveBeenCalled();
    expect(existing.start).not.toHaveBeenCalled();
    expect(mocks.createContainer).not.toHaveBeenCalled();
  });

  it("recreates a stopped computer with changed DNS and the same saved home", async () => {
    const { existing } = existingComputer(false, ["198.51.100.53"]);
    const response = await provision();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "new-computer", resumed: false });
    expect(existing.remove).toHaveBeenCalledExactlyOnceWith();
    expect(existing.start).not.toHaveBeenCalled();
    expect(mocks.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        HostConfig: expect.objectContaining({
          Dns: ["192.0.2.53", "2001:db8::53"],
          Binds: ["/tmp/example-computer-dns/homes/bot:/home/rakazo"],
        }),
      }),
    );
  });

  it("preserves a computer that starts after inspection instead of forcing DNS replacement", async () => {
    const { existing } = existingComputer(false, ["198.51.100.53"]);
    existing.remove.mockRejectedValue(
      Object.assign(new Error("computer is running"), { statusCode: 409 }),
    );
    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "computer is running" });
    expect(existing.remove).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.createContainer).not.toHaveBeenCalled();
  });

  it("refuses incompatible running computers with changed DNS before allocating replacements", async () => {
    const { existing, info } = existingComputer(true, ["198.51.100.53"]);
    info.Image = "previous-image";
    const response = await provision();
    expect(response.status).toBe(409);
    expect(existing.remove).not.toHaveBeenCalled();
    expect(mocks.createContainer).not.toHaveBeenCalled();
    expect(mocks.createNetwork).not.toHaveBeenCalled();
  });

  it.each([
    {
      current: ["192.0.2.53", "2001:db8::53"],
      configured: "2001:db8::53,192.0.2.53",
      desired: ["2001:db8::53", "192.0.2.53"],
    },
    { current: ["192.0.2.53"], configured: "", desired: undefined },
    { current: undefined, configured: "192.0.2.53", desired: ["192.0.2.53"] },
  ])(
    "defers DNS order, clearing and first configuration until stopped: %j",
    async ({ current, configured, desired }) => {
      vi.stubEnv("SANDBOX_COMPUTER_DNS", configured);
      const { existing, info } = existingComputer(true, current);
      expect(await (await provision()).json()).toMatchObject({ id: "existing", resumed: true });
      expect(existing.remove).not.toHaveBeenCalled();
      expect(mocks.createContainer).not.toHaveBeenCalled();
      info.State.Running = false;
      expect(await (await provision()).json()).toMatchObject({
        id: "new-computer",
        resumed: false,
      });
      expect(existing.remove).toHaveBeenCalledExactlyOnceWith();
      expect(mocks.createContainer.mock.calls[0]?.[0].HostConfig.Dns).toEqual(desired);
    },
  );

  it.each([
    { current: ["192.0.2.53", "2001:db8::53"], configured: "192.0.2.53,2001:db8::53" },
    { current: null, configured: "" },
    { current: undefined, configured: "" },
    { current: [], configured: "" },
  ])(
    "starts stopped computers without replacing matching DNS: %j",
    async ({ current, configured }) => {
      vi.stubEnv("SANDBOX_COMPUTER_DNS", configured);
      const { existing } = existingComputer(false, current);
      const response = await provision();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: "existing", resumed: true, started: true });
      expect(existing.start).toHaveBeenCalledOnce();
      expect(existing.remove).not.toHaveBeenCalled();
      expect(mocks.createContainer).not.toHaveBeenCalled();
    },
  );
});
