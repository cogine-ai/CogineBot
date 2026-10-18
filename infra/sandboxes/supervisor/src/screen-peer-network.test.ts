import type * as NodeHttp from "node:http";
import { Readable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  version: vi.fn(),
  getContainer: vi.fn(),
  listContainers: vi.fn(),
  getNetwork: vi.fn(),
}));
vi.mock("dockerode", () => ({
  default: class {
    version = mocks.version;
    getContainer = mocks.getContainer;
    listContainers = mocks.listContainers;
    getNetwork = mocks.getNetwork;
  },
}));
vi.mock("node:http", async (original) => {
  const http = await original<typeof NodeHttp>();
  return {
    ...http,
    default: {
      ...http,
      get: vi.fn((_options, callback) => {
        callback({ statusCode: 200, resume() {} });
        return {
          once() {
            return this;
          },
          destroy() {},
        };
      }),
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.version.mockReset();
  vi.stubEnv("HOSTNAME", "supervisor-host");
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function fixture(control = false) {
  const members = new Set<string>();
  const connect = vi.fn(async (options: { Container: string }) => {
    members.add(options.Container);
  });
  const container = {
    inspect: vi.fn().mockResolvedValue({
      Id: "computer",
      Config: {
        Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        ...(control ? { Env: ["RAKAZO_COMPUTER_CONTROL_TOKEN=fixture-control-token"] } : {}),
      },
      HostConfig: { NetworkMode: "bot-network" },
      State: { Running: true },
      NetworkSettings: { Networks: { "bot-network": { IPAddress: "172.28.0.2" } } },
    }),
    exec: vi.fn(async (options: { Cmd: string[] }) => ({
      start: async () => Readable.from(options.Cmd[1] === "-lc" ? ["GEOM 1 1\nIMAGE AQID\n"] : []),
      inspect: async () => ({ ExitCode: 0 }),
    })),
  };
  const supervisor = {
    inspect: vi.fn().mockResolvedValue({
      Id: "supervisor-peer",
      Config: { Labels: { "com.docker.compose.project": "example" } },
    }),
  };
  mocks.getContainer.mockImplementation((id: string) =>
    id === "supervisor-host" ? supervisor : container,
  );
  mocks.listContainers.mockResolvedValue([{ Id: "web-peer" }]);
  mocks.getNetwork.mockReturnValue({
    inspect: vi.fn(async () => ({
      Containers: Object.fromEntries([...members].map((id) => [id, {}])),
    })),
    connect,
  });
  return { connect, members, exec: container.exec };
}

async function observe() {
  const { supervisorApp } = await import("./index.js");
  return supervisorApp.request("/computers/computer/observe", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "writer",
    },
  });
}

async function openScreen() {
  const { supervisorApp } = await import("./index.js");
  return supervisorApp.request("/computers/computer/screen-mode", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "writer",
    },
    body: JSON.stringify({ interactive: false }),
  });
}

describe("isolated screen peer gateway priority through the supervisor route", () => {
  it.each([
    ["1.45", false],
    ["1.47", false],
    ["invalid", false],
    ["1.48", true],
    ["1.55", true],
    ["2.0", true],
  ] as const)(
    "network.connect for Docker API %s includes GwPriority -1 only when supported (%s)",
    async (version, supportsPriority) => {
      const { connect } = fixture();
      mocks.version.mockResolvedValue({ ApiVersion: version });
      const response = await openScreen();
      expect(response.status).toBe(200);
      const payload = (containerId: string) =>
        supportsPriority
          ? { Container: containerId, EndpointConfig: { GwPriority: -1 } }
          : { Container: containerId };
      expect(connect).toHaveBeenCalledTimes(2);
      expect(connect).toHaveBeenCalledWith(payload("supervisor-peer"));
      expect(connect).toHaveBeenCalledWith(payload("web-peer"));
    },
  );

  it("rejoins the computer network on use after the supervisor container is recreated", async () => {
    const { connect, members } = fixture();
    mocks.version.mockResolvedValue({ ApiVersion: "1.45" });
    expect((await openScreen()).status).toBe(200);
    members.clear();
    vi.resetModules();
    connect.mockClear();

    expect((await observe()).status).toBe(200);
    expect(connect).toHaveBeenCalledWith({ Container: "supervisor-peer" });
    expect(connect).toHaveBeenCalledWith({ Container: "web-peer" });
  });

  it("does not reconnect peers already attached to the computer network", async () => {
    const { connect } = fixture();
    mocks.version.mockResolvedValue({ ApiVersion: "1.45" });
    expect((await observe()).status).toBe(200);
    expect(connect).toHaveBeenCalledTimes(2);
    connect.mockClear();

    expect((await observe()).status).toBe(200);
    expect(connect).not.toHaveBeenCalled();
  });

  it("keeps observing when a missing screen peer cannot rejoin", async () => {
    const { connect, members } = fixture();
    members.add("supervisor-peer");
    connect.mockRejectedValueOnce(new Error("peer disappeared before connect"));

    const response = await observe();

    expect(connect).toHaveBeenCalledWith({ Container: "web-peer" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ image: "AQID", width: 1, height: 1 });
  });

  it.each(["internal", "published"])("does not join screen peers in %s mode", async (mode) => {
    vi.stubEnv("SANDBOX_SCREEN_NETWORK", mode);
    const { connect } = fixture();

    expect((await observe()).status).toBe(200);
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects a different Space before connecting its screen peers", async () => {
    const { connect, exec } = fixture();
    const { supervisorApp } = await import("./index.js");
    const response = await supervisorApp.request("/computers/computer/observe", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "different-space",
        "x-rakazo-screen-id": "writer",
      },
    });

    expect(response.status).not.toBe(200);
    expect(connect).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("keeps opening screens after a failed version lookup and retries discovery later", async () => {
    const { connect, members } = fixture();
    mocks.version
      .mockRejectedValueOnce(new Error("version temporarily unavailable"))
      .mockResolvedValue({ ApiVersion: "1.48" });
    expect((await openScreen()).status).toBe(200);
    expect(connect).toHaveBeenCalledWith({ Container: "web-peer" });
    expect(connect).toHaveBeenCalledWith({ Container: "supervisor-peer" });
    connect.mockClear();
    members.clear();
    expect((await openScreen()).status).toBe(200);
    expect(mocks.version).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledWith({
      Container: "web-peer",
      EndpointConfig: { GwPriority: -1 },
    });
    expect(connect).toHaveBeenCalledWith({
      Container: "supervisor-peer",
      EndpointConfig: { GwPriority: -1 },
    });
  });
});

describe("computer actions through the supervisor route", () => {
  it.each([
    { name: "HTTP success", accepted: 1, failure: "none", status: 200, execCount: 0 },
    { name: "connection refused", accepted: 0, failure: "refused", status: 200, execCount: 1 },
    { name: "connect timeout", accepted: 0, failure: "connect-timeout", status: 200, execCount: 1 },
    {
      name: "Undici timeout code without matching text",
      accepted: 0,
      failure: "connect-timeout-code",
      status: 200,
      execCount: 1,
    },
    { name: "bare timeout text", accepted: 0, failure: "bare-text", status: 500, execCount: 0 },
    {
      name: "lost receipt after accepting the action",
      accepted: 1,
      failure: "reset",
      status: 500,
      execCount: 0,
    },
    {
      name: "HTTP error after accepting the action",
      accepted: 1,
      failure: "http-error",
      status: 500,
      execCount: 0,
    },
    { name: "generic request timeout", accepted: 0, failure: "timeout", status: 500, execCount: 0 },
    { name: "explicit cancellation", accepted: 0, failure: "abort", status: 500, execCount: 0 },
  ])("executes at most once on $name", async ({ accepted, failure, status, execCount }) => {
    const { exec } = fixture(true);
    let acceptedHttpActions = 0;
    const fetchControl = vi.fn(async () => {
      acceptedHttpActions += accepted;
      if (failure === "refused") {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: new Error("connect ECONNREFUSED"),
        });
      }
      if (failure === "connect-timeout") {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("Connect Timeout Error (timeout: 10000ms)"), {
            name: "ConnectTimeoutError",
            code: "UND_ERR_CONNECT_TIMEOUT",
          }),
        });
      }
      if (failure === "connect-timeout-code") {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connection unavailable"), {
            code: "UND_ERR_CONNECT_TIMEOUT",
          }),
        });
      }
      if (failure === "bare-text") throw new Error("connect timeout");
      if (failure === "reset") {
        throw Object.assign(new TypeError("fetch failed"), { cause: new Error("read ECONNRESET") });
      }
      if (failure === "http-error") {
        return Response.json({ error: "connect timeout after applying action" }, { status: 500 });
      }
      if (failure === "timeout" || failure === "abort") {
        throw Object.assign(new Error("operation interrupted"), {
          name: failure === "timeout" ? "TimeoutError" : "AbortError",
        });
      }
      return Response.json({ completed: 1 });
    });
    vi.stubGlobal("fetch", fetchControl);
    const { supervisorApp } = await import("./index.js");
    const response = await supervisorApp.request("/computers/computer/actions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
        "x-rakazo-screen-id": "writer",
      },
      body: JSON.stringify({ actions: [{ kind: "key", key: "F8" }], observe: false }),
    });

    expect(response.status).toBe(status);
    expect(fetchControl).toHaveBeenCalledTimes(1);
    const execActionCalls = exec.mock.calls.filter(([options]) => options.Cmd[0] === "python3");
    expect(execActionCalls).toHaveLength(execCount);
    expect(acceptedHttpActions).toBe(accepted);
    expect(acceptedHttpActions + execActionCalls.length).toBeLessThanOrEqual(1);
  });
});
