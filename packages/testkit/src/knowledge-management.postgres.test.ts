import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import type {
  AgentSkill,
  AgentSkillCatalogEntry,
  Me,
  MemoryDocument,
  Space,
} from "@rakazo/contracts";
import { memoryDocumentsMarkdown } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.js";
import { sessionCookieHeader } from "./index.js";

type AppHandles = Awaited<ReturnType<typeof createApp>>;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const postgres = enabled ? describe.sequential : describe.skip;

postgres("memory documents and shared agentSkills via authenticated API", () => {
  let handles: AppHandles;
  let dataDir: string;
  let owner: string;
  let member: string;
  let outsider: string;
  let spaceA: string;
  let spaceB: string;
  let botA: string;
  let botB: string;
  let documentA: string;
  let documentB: string;
  let sharedA: string;
  let sharedB: string;
  let savedSkill: AgentSkill;

  async function raw(
    session: string,
    spaceId: string | undefined,
    procedure: string,
    input: unknown = {},
  ) {
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
    session: string,
    spaceId: string | undefined,
    procedure: string,
    input: unknown = {},
  ): Promise<T> {
    const response = await raw(session, spaceId, procedure, input);
    if (!response.ok) throw new Error(`${procedure}: ${response.status}`);
    return ((await response.json()) as { json: T }).json;
  }
  async function signup() {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({
        email: `knowledge-${randomUUID()}@example.test`,
        password: "synthetic-password12",
        name: "Synthetic account",
      }),
    });
    expect(response.ok).toBe(true);
    return sessionCookieHeader(response);
  }
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !/^integration_\d+$/.test(url.pathname.slice(1)) ||
      url.pathname.slice(1) !== process.env.VERIFY_ISOLATED_DATABASE
    )
      throw new Error("An explicitly isolated local database is required");
    const { createApp } = await import("../../../apps/api/src/app.js");
    dataDir = mkdtempSync(path.join(tmpdir(), "knowledge-test-"));
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      composio: new ComposioEmulator(),
      signupsEnabled: "true",
    });
    owner = await signup();
    member = await signup();
    outsider = await signup();
    const own = await rpc<Me>(owner, undefined, "me");
    const other = await rpc<Me>(member, undefined, "me");
    spaceA = own.spaceId;
    spaceB = (await rpc<Space>(owner, spaceA, "spaces/create", { name: "Second synthetic space" }))
      .id;
    const space = await handles.prisma.space.findUniqueOrThrow({ where: { id: spaceA } });
    await handles.prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId: other.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await handles.prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: spaceA, userId: other.userId } },
      update: { role: "member" },
      create: {
        id: randomUUID(),
        spaceId: spaceA,
        organizationId: space.organizationId,
        userId: other.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    // Synthetic fixtures avoid starting an agent or calling any model.
    botA = (
      await handles.prisma.bot.create({
        data: { spaceId: spaceA, userId: own.userId, name: "First", color: "blue" },
      })
    ).id;
    botB = (
      await handles.prisma.bot.create({
        data: { spaceId: spaceA, userId: own.userId, name: "Second", color: "blue" },
      })
    ).id;
    const doc = async (spaceId: string, botId: string | null, content: string) =>
      (
        await handles.prisma.memoryDocument.create({
          data: {
            spaceId,
            userId: own.userId,
            botId,
            scope: botId ? "bot" : "user",
            path: "KNOWLEDGE.md",
            content,
          },
        })
      ).id;
    documentA = await doc(spaceA, botA, "First bot private");
    documentB = await doc(spaceA, botB, "Second bot private");
    sharedA = await doc(spaceA, null, "Shared only by my bots in A");
    sharedB = await doc(spaceB, null, "Shared only by my bots in B");
  }, 60_000);
  afterAll(async () => {
    await handles?.stop();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps Bot documents separate and reads saved Markdown through fresh API requests", async () => {
    const first = await rpc<MemoryDocument[]>(owner, spaceA, "memory/list", {
      botId: botA,
      scope: "bot",
    });
    const second = await rpc<MemoryDocument[]>(owner, spaceA, "memory/list", {
      botId: botB,
      scope: "bot",
    });
    expect(first.map((d) => d.id)).toEqual([documentA]);
    expect(second.map((d) => d.id)).toEqual([documentB]);
    const content = "# Saved 中文\n\nExact UTF-8 🐦\n";
    const saved = await rpc<MemoryDocument>(owner, spaceA, "memory/update", {
      documentId: documentA,
      content,
    });
    expect(saved).toMatchObject({ content, revision: 2 });
    const fresh = await rpc<MemoryDocument[]>(owner, spaceA, "memory/list", {
      botId: botA,
      scope: "bot",
    });
    expect(fresh[0]?.content).toBe(content);
    expect(memoryDocumentsMarkdown(fresh)).toBe(`# KNOWLEDGE.md\n\n${content}`);
    expect(
      (await rpc<MemoryDocument[]>(owner, spaceA, "memory/list", { botId: botB, scope: "bot" }))[0]
        ?.content,
    ).toBe("Second bot private");
  });
  it("isolates user documents from other members and Spaces, including direct-ID writes", async () => {
    const shared = await rpc<MemoryDocument[]>(owner, spaceA, "memory/list", { scope: "user" });
    expect(shared.some((d) => d.id === sharedA)).toBe(true);
    expect(shared.some((d) => d.id === sharedB || d.botId)).toBe(false);
    await rpc(owner, spaceA, "memory/update", {
      documentId: sharedA,
      content: "Saved shared document",
    });
    expect(
      (await rpc<MemoryDocument[]>(owner, spaceA, "memory/list", { scope: "user" })).find(
        (d) => d.id === sharedA,
      )?.content,
    ).toBe("Saved shared document");
    expect(
      (await rpc<MemoryDocument[]>(owner, spaceB, "memory/list", { scope: "user" })).some(
        (d) => d.id === sharedA,
      ),
    ).toBe(false);
    expect(
      (await rpc<MemoryDocument[]>(member, spaceA, "memory/list", {})).some((d) =>
        [documentA, documentB, sharedA].includes(d.id),
      ),
    ).toBe(false);
    for (const [session, spaceId] of [
      [member, spaceA],
      [owner, spaceB],
      [outsider, spaceA],
    ]) {
      expect(
        (
          await raw(session!, spaceId!, "memory/update", {
            documentId: sharedA,
            content: "Forbidden",
          })
        ).ok,
      ).toBe(false);
    }
    expect((await raw(outsider, spaceA, "memory/list", {})).ok).toBe(false);
  });
  it("manages writable skills while denying builtins, other members and other Spaces", async () => {
    const content =
      "---\nname: synthetic-recipe\ndescription: Synthetic instructions\n---\n\nFirst steps.\n";
    savedSkill = await rpc<AgentSkill>(owner, spaceA, "agentSkills/create", { content });
    expect(
      (await rpc<AgentSkill[]>(owner, spaceA, "agentSkills/list")).some(
        (s) => s.id === savedSkill.id,
      ),
    ).toBe(true);
    const updated = content.replace("First steps.", "Updated steps.");
    await rpc(owner, spaceA, "agentSkills/update", { skillId: savedSkill.id, content: updated });
    expect(
      (await rpc<AgentSkill>(owner, spaceA, "agentSkills/get", { skillId: savedSkill.id })).content,
    ).toBe(updated);
    for (const [session, spaceId] of [
      [member, spaceA],
      [owner, spaceB],
    ]) {
      expect(
        (await rpc<AgentSkillCatalogEntry[]>(session!, spaceId!, "agentSkills/list")).some(
          (s) => s.id === savedSkill.id,
        ),
      ).toBe(false);
      for (const operation of ["get", "update", "remove"])
        expect(
          (
            await raw(session!, spaceId!, `agentSkills/${operation}`, {
              skillId: savedSkill.id,
              ...(operation === "update" ? { content } : {}),
            })
          ).ok,
        ).toBe(false);
    }
    const builtin = (await rpc<AgentSkillCatalogEntry[]>(owner, spaceA, "agentSkills/list")).find(
      (s) => s.source === "builtin",
    )!;
    expect(
      (await rpc<AgentSkill>(owner, spaceA, "agentSkills/get", { skillId: builtin.id })).readOnly,
    ).toBe(true);
    expect(
      (await raw(owner, spaceA, "agentSkills/update", { skillId: builtin.id, content })).ok,
    ).toBe(false);
    expect((await raw(owner, spaceA, "agentSkills/remove", { skillId: builtin.id })).ok).toBe(
      false,
    );
    await rpc(owner, spaceA, "agentSkills/remove", { skillId: savedSkill.id });
    expect(
      (await rpc<AgentSkillCatalogEntry[]>(owner, spaceA, "agentSkills/list")).some(
        (s) => s.id === savedSkill.id,
      ),
    ).toBe(false);
  });
});
