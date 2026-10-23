import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import type { Bot, Me, Routine, Space } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";

type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describePostgres = hasDb ? describe.sequential : describe.skip;

describePostgres("account timezone and profile through the real API", () => {
  let handles: AppHandles;
  let cookie: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let dataDir: string | undefined;

  async function raw(procedure: string, input: unknown, session = cookie, spaceId?: string) {
    return handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: session,
        origin: "http://127.0.0.1:5173",
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
  }

  async function rpc<T>(
    procedure: string,
    input: unknown = {},
    session = cookie,
    spaceId?: string,
  ) {
    const response = await raw(procedure, input, session, spaceId);
    const result = (await response.json()) as { json?: T };
    if (!response.ok) throw new Error(`${procedure} failed (${response.status})`);
    return result.json as T;
  }

  async function signup(label: string) {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({
        email: `account-${label}-${stamp}@example.test`,
        password: "password12",
        name: "Account test user",
      }),
    });
    if (!response.ok) throw new Error(`Signup failed (${response.status})`);
    return sessionCookieHeader(response);
  }

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-account-profile-"));
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      composio: new ComposioEmulator(),
      signupsEnabled: "true",
    });
    cookie = await signup("owner");
  });

  afterAll(async () => {
    await handles?.stop();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("reports unset timezone and adopts the first valid device zone only once", async () => {
    expect((await rpc<Me>("me")).timezone).toBeNull();
    const adopted = await rpc<Me>("preferences/adoptTimezone", { timezone: "Asia/Taipei" });
    expect(adopted.timezone).toBe("Asia/Taipei");
    expect(
      (await rpc<Me>("preferences/adoptTimezone", { timezone: "America/New_York" })).timezone,
    ).toBe("Asia/Taipei");
    expect((await rpc<Me>("me")).timezone).toBe("Asia/Taipei");
  });

  it("keeps an explicit setting when device adoption races it", async () => {
    await rpc("preferences/update", { timezone: null });
    await Promise.all([
      rpc("preferences/adoptTimezone", { timezone: "Asia/Taipei" }),
      rpc("preferences/update", { timezone: "UTC" }),
    ]);
    expect((await rpc<Me>("me")).timezone).toBe("UTC");
    expect(
      (await rpc<Me>("preferences/adoptTimezone", { timezone: "Asia/Kolkata" })).timezone,
    ).toBe("UTC");
    expect((await rpc<Me>("preferences/update", { avatarStyle: "organic" })).timezone).toBe("UTC");
  });

  it("chooses one device under concurrent first-use and keeps other accounts isolated", async () => {
    await rpc("preferences/update", { timezone: null });
    const zones = ["Asia/Taipei", "America/New_York", "Asia/Kolkata"];
    await Promise.all(zones.map((timezone) => rpc("preferences/adoptTimezone", { timezone })));
    const saved = (await rpc<Me>("me")).timezone;
    expect(zones).toContain(saved);
    const other = await signup("other");
    expect((await rpc<Me>("me", {}, other)).timezone).toBeNull();
    await rpc("preferences/update", { timezone: "Pacific/Auckland" }, other);
    expect((await rpc<Me>("me")).timezone).toBe(saved);
  });

  it("rejects invalid zones and empty writes without changing saved preferences", async () => {
    const before = await rpc<Me>("me");
    for (const timezone of ["", "+08:00", "Not/AZone", "X".repeat(65)]) {
      expect((await raw("preferences/update", { timezone })).status).toBe(400);
      expect((await raw("preferences/adoptTimezone", { timezone })).status).toBe(400);
    }
    expect((await raw("preferences/update", {})).status).toBe(400);
    expect((await rpc<Me>("me")).timezone).toBe(before.timezone);
  });

  it("scopes timezone to the account while switching Spaces and leaves saved routines unchanged", async () => {
    const bot = await rpc<Bot>("bots/create", { name: "Schedule keeper" });
    await discardBotIntroFromCreate(handles, cookie, "bots/create", bot);
    const routine = await rpc<Routine>("routines/create", {
      botId: bot.id,
      name: "Saved clock",
      prompt: "Keep this schedule",
      crons: ["0 9 * * *"],
      timezone: "Asia/Tokyo",
      active: true,
      notify: false,
    });
    await rpc("preferences/update", { timezone: "Asia/Taipei" });
    const space = await rpc<Space>("spaces/create", { name: "Timezone Space" });
    expect((await rpc<Me>("me", {}, cookie, space.id)).timezone).toBe("Asia/Taipei");
    await rpc("preferences/update", { timezone: "UTC" }, cookie, space.id);
    expect((await rpc<Me>("me")).timezone).toBe("UTC");
    const saved = (await rpc<Routine[]>("routines/list", { botId: bot.id })).find(
      (item) => item.id === routine.id,
    );
    expect(saved).toMatchObject({
      timezone: routine.timezone,
      crons: routine.crons,
      nextRunAt: routine.nextRunAt,
    });
  });

  it("normalizes public profile fields and keeps explicit rules, including blanks, lossless", async () => {
    const rules = "  # Private rules\n\nKeep this spacing.\n\n";
    for (const instructions of [rules, "", "  "]) {
      const bot = await rpc<Bot>("bots/create", {
        name: "  Role  ",
        title: "  Public title  ",
        description: "  Public division  ",
        instructions,
      });
      await discardBotIntroFromCreate(handles, cookie, "bots/create", bot);
      expect(bot).toMatchObject({
        name: "Role",
        title: "Public title",
        description: "Public division",
        instructions,
      });
      const loaded = await rpc<Bot>("bots/get", { botId: bot.id });
      expect(loaded.instructions).toBe(instructions);
    }
    const legacy = await rpc<Bot>("bots/create", { name: "Legacy", description: "  Old role  " });
    await discardBotIntroFromCreate(handles, cookie, "bots/create", legacy);
    expect(legacy.instructions).toBe("Old role");
    expect(
      (await raw("bots/create", { name: "Too long", instructions: "X".repeat(20_001) })).status,
    ).toBe(400);
  });
});
