import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo, Socket } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadinessProbe } from "./readiness.js";
import { createReadinessProbe } from "./readiness.js";

const probes: ReadinessProbe[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(probes.splice(0).map((probe) => probe.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function probe(url: string) {
  const result = createReadinessProbe(url);
  probes.push(result);
  return result;
}

function message(type: string, body: Buffer) {
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type), length, body]);
}

function success(socket: Socket) {
  socket.write(
    Buffer.concat([message("C", Buffer.from("SELECT 1\0")), message("Z", Buffer.from("I"))]),
  );
}

// A loopback-only PostgreSQL wire peer exercises the installed pg and pg-pool,
// including their real TCP sockets and timeout/release paths.
async function wireServer(socketPath?: string) {
  const connections: Array<{
    socket: Socket;
    startup: Record<string, string>;
    queries: string[];
    closed: boolean;
  }> = [];
  let startupMode: "ready" | "stall" | "capacity" = "ready";
  let queryMode: "complete" | "stall" | "disconnect" | "error" = "complete";
  let maximumOpen = 0;
  let sslRequests = 0;
  const server = createServer((socket) => {
    const connection = { socket, startup: {}, queries: [] as string[], closed: false };
    connections.push(connection);
    maximumOpen = Math.max(maximumOpen, connections.filter((item) => !item.closed).length);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      connection.closed = true;
    });
    let bytes = Buffer.alloc(0);
    let started = false;
    socket.on("data", (data) => {
      bytes = Buffer.concat([bytes, data]);
      while (bytes.length >= (started ? 5 : 8)) {
        const length = bytes.readInt32BE(started ? 1 : 0);
        const total = length + (started ? 1 : 0);
        if (bytes.length < total) return;
        const packet = bytes.subarray(0, total);
        bytes = bytes.subarray(total);
        if (!started) {
          if (packet.readInt32BE(4) === 80877103) {
            sslRequests += 1;
            socket.write("N");
            continue;
          }
          const fields = packet.subarray(8).toString().split("\0");
          connection.startup = Object.fromEntries(
            fields
              .slice(0, -2)
              .flatMap((value, index) => (index % 2 === 0 ? [[value, fields[index + 1]]] : [])),
          );
          started = true;
          if (startupMode === "capacity") {
            socket.end(
              message("E", Buffer.from("SFATAL\0C53300\0Msynthetic capacity rejection\0\0")),
            );
          } else if (startupMode === "ready") {
            socket.write(
              Buffer.concat([message("R", Buffer.alloc(4)), message("Z", Buffer.from("I"))]),
            );
          }
        } else if (packet[0] === "Q".charCodeAt(0)) {
          connection.queries.push(packet.subarray(5, -1).toString());
          if (queryMode === "complete") success(socket);
          else if (queryMode === "disconnect") socket.destroy();
          else if (queryMode === "error") {
            socket.write(
              Buffer.concat([
                message("E", Buffer.from("SERROR\0C57014\0Msynthetic query timeout\0\0")),
                message("Z", Buffer.from("I")),
              ]),
            );
          }
        } else if (packet[0] === "X".charCodeAt(0)) {
          socket.end();
        }
      }
    });
  });
  const listening = once(server, "listening");
  if (socketPath) server.listen(socketPath);
  else server.listen(0, "127.0.0.1");
  await listening;
  const port = socketPath ? 5432 : (server.address() as AddressInfo).port;
  const result = {
    url: `postgres://probe:synthetic@127.0.0.1:${port}/probe?sslmode=disable`,
    connections,
    setStartupMode(mode: typeof startupMode) {
      startupMode = mode;
    },
    setQueryMode(mode: typeof queryMode) {
      queryMode = mode;
    },
    get maximumOpen() {
      return maximumOpen;
    },
    get sslRequests() {
      return sslRequests;
    },
    async close() {
      for (const connection of connections) connection.socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  servers.push(result);
  return result;
}

describe("database readiness resource bounds", () => {
  it("reuses one connection and preserves startup options while fixing the statement timeout", async () => {
    const server = await wireServer();
    const options = "-c search_path=public -c statement_timeout=60000";
    const check = probe(
      `${server.url}&application_name=readiness-test&options=${encodeURIComponent(options)}&statement_timeout=0&statement_timeout=60000&query_timeout=60000`,
    );
    await check.check();
    await check.check();
    expect(server.connections).toHaveLength(1);
    expect(server.connections[0]!.startup).toEqual({
      user: "probe",
      database: "probe",
      application_name: "readiness-test",
      options,
      statement_timeout: "1500",
      client_encoding: "UTF8",
    });
    expect(server.connections[0]!.queries).toEqual(["SELECT 1", "SELECT 1"]);
    expect(server.maximumOpen).toBe(1);
    const closing = check.close();
    expect(check.close()).toBe(closing);
    await closing;
    await vi.waitFor(() => expect(server.connections[0]!.closed).toBe(true));
    await expect(check.check()).rejects.toThrow("Readiness probe is closed");
  });

  it("does not silently disable required SSL", async () => {
    const server = await wireServer();
    const check = probe(server.url.replace("sslmode=disable", "sslmode=verify-full"));
    await expect(check.check()).rejects.toThrow("The server does not support SSL connections");
    expect(server.sslRequests).toBe(1);
    expect(server.connections[0]!.queries).toEqual([]);
    await vi.waitFor(() => expect(server.connections[0]!.closed).toBe(true));
  });

  it("preserves Unix socket host and encoded database options", async () => {
    const directory = await mkdtemp(join(tmpdir(), "readiness-"));
    directories.push(directory);
    const server = await wireServer(join(directory, ".s.PGSQL.5432"));
    const check = probe(
      `postgres://probe:synthetic@ignored/socket%20database?host=${encodeURIComponent(directory)}&port=5432&sslmode=disable&statement_timeout=0`,
    );
    await check.check();
    expect(server.connections[0]!.startup).toMatchObject({
      user: "probe",
      database: "socket database",
      statement_timeout: "1500",
    });
  });

  it.each(["path", "socket"] as const)("preserves the %s Unix socket DSN form", async (form) => {
    vi.stubEnv("PGSSLMODE", "disable");
    vi.stubEnv("PGPORT", "5432");
    const directory = await mkdtemp(join(tmpdir(), "readiness-"));
    directories.push(directory);
    const server = await wireServer(join(directory, ".s.PGSQL.5432"));
    const url =
      form === "path"
        ? `${directory} probe`
        : `socket:${directory}?db=probe&encoding=UTF8&statement_timeout=0`;
    await probe(url).check();
    expect(server.connections[0]!.startup).toMatchObject({
      database: "probe",
      statement_timeout: "1500",
    });
  });

  it("places the timeout before the URL fragment", async () => {
    const server = await wireServer();
    await probe(`${server.url}&statement_timeout=0#ignored-fragment`).check();
    expect(server.connections[0]!.startup.statement_timeout).toBe("1500");
  });

  it("sets the timeout on a URL without query parameters", async () => {
    vi.stubEnv("PGSSLMODE", "disable");
    const server = await wireServer();
    await probe(server.url.split("?")[0]!).check();
    expect(server.connections[0]!.startup.statement_timeout).toBe("1500");
  });

  it("rejects a refused loopback connection without business connection retries", async () => {
    const reservation = createServer();
    const listening = once(reservation, "listening");
    reservation.listen(0, "127.0.0.1");
    await listening;
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const started = performance.now();
    await expect(
      probe(`postgres://probe:synthetic@127.0.0.1:${port}/probe?sslmode=disable`).check(),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("destroys a socket whose PostgreSQL startup never completes, then recovers", async () => {
    const server = await wireServer();
    server.setStartupMode("stall");
    const check = probe(server.url);
    const started = performance.now();
    await expect(check.check()).rejects.toThrow(/connection timeout|timeout expired/i);
    expect(performance.now() - started).toBeLessThan(2500);
    await vi.waitFor(() => expect(server.connections[0]!.closed).toBe(true));
    expect(server.connections).toHaveLength(1);
    server.setStartupMode("ready");
    await check.check();
    expect(server.connections).toHaveLength(2);
  });

  it("destroys an active query socket despite a DSN query timeout override", async () => {
    const server = await wireServer();
    server.setQueryMode("stall");
    const check = probe(`${server.url}&query_timeout=60000`);
    const started = performance.now();
    await expect(check.check()).rejects.toThrow("Query read timeout");
    expect(performance.now() - started).toBeLessThan(2500);
    await vi.waitFor(() => expect(server.connections[0]!.closed).toBe(true));
    server.setQueryMode("complete");
    await check.check();
    expect(server.connections).toHaveLength(2);
  });

  it("removes a timed out pending checkout without opening a second connection", async () => {
    const server = await wireServer();
    server.setStartupMode("stall");
    const check = probe(server.url);
    const outcomes = await Promise.allSettled([check.check(), check.check(), check.check()]);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    await vi.waitFor(() =>
      expect(server.connections.every((connection) => connection.closed)).toBe(true),
    );
    expect(server.connections).toHaveLength(1);
    expect(server.maximumOpen).toBe(1);
    server.setStartupMode("ready");
    await check.check();
    expect(server.connections).toHaveLength(2);
    expect(server.connections[1]!.queries).toEqual(["SELECT 1"]);
  });

  it("does not retry a PostgreSQL capacity rejection", async () => {
    const server = await wireServer();
    server.setStartupMode("capacity");
    const check = probe(server.url);
    await expect(check.check()).rejects.toMatchObject({ code: "53300" });
    expect(server.connections).toHaveLength(1);
    server.setStartupMode("ready");
    await check.check();
    expect(server.connections).toHaveLength(2);
  });

  it("removes a client after a server query error without retrying that check", async () => {
    const server = await wireServer();
    server.setQueryMode("error");
    const check = probe(server.url);
    await expect(check.check()).rejects.toMatchObject({ code: "57014" });
    await vi.waitFor(() => expect(server.connections[0]!.closed).toBe(true));
    expect(server.connections).toHaveLength(1);
    expect(server.connections[0]!.queries).toEqual(["SELECT 1"]);
    server.setQueryMode("complete");
    await check.check();
    expect(server.connections).toHaveLength(2);
  });

  it("handles disconnects during a query and while idle without leaking or crashing", async () => {
    const server = await wireServer();
    const check = probe(server.url);
    server.setQueryMode("disconnect");
    await expect(check.check()).rejects.toThrow(/Connection terminated/);
    await vi.waitFor(() => expect(server.connections[0]!.closed).toBe(true));
    server.setQueryMode("complete");
    await check.check();
    server.connections[1]!.socket.destroy();
    await vi.waitFor(() => expect(server.connections[1]!.closed).toBe(true));
    await check.check();
    expect(server.connections).toHaveLength(3);
  });

  it("evicts an idle connection after ten seconds", async () => {
    const server = await wireServer();
    const check = probe(server.url);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await check.check();
    expect(server.connections[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(9999);
    expect(server.connections[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(server.connections[0]!.closed).toBe(true));
    await check.check();
    expect(server.connections).toHaveLength(2);
  });

  it.each(["startup", "query"] as const)("drains close racing with a stalled %s", async (phase) => {
    const server = await wireServer();
    if (phase === "startup") server.setStartupMode("stall");
    else server.setQueryMode("stall");
    const check = probe(server.url);
    const outcome = check.check().then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(server.connections).toHaveLength(1));
    if (phase === "query") {
      await vi.waitFor(() => expect(server.connections[0]!.queries).toHaveLength(1));
    }
    const closing = check.close();
    expect(check.close()).toBe(closing);
    await expect(check.check()).rejects.toThrow("Readiness probe is closed");
    expect(await outcome).toBeInstanceOf(Error);
    await closing;
    await vi.waitFor(() => expect(server.connections[0]!.closed).toBe(true));
    expect(server.connections).toHaveLength(1);
  });
});
