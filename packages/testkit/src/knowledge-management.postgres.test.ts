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
import type { KnowledgeState } from "@rakazo/core";
import {
  createKnowledgeEditor,
  initialKnowledgeState,
  memoryDocumentsMarkdown,
} from "@rakazo/core";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  it.each([false, true])(
    "recovers the same committed Skill after losing create response (rename: %s)",
    async (rename) => {
      const name = `lost-response-${randomUUID()}`;
      const content = `---\nname: ${name}\ndescription: Synthetic recovery\n---\n\nInitial steps.\n`;
      let state: KnowledgeState = initialKnowledgeState;
      let committedId = "";
      let loseResponse = true;
      const editor = createKnowledgeEditor({
        botId: botA,
        section: "skills",
        changed: (next) => {
          state = next;
        },
        deliver: async () => {},
        client: {
          isCurrent: () => true,
          async request<T>(procedure: string, input: unknown): Promise<T> {
            const result = await rpc<T>(owner, spaceA, procedure, input);
            if (procedure === "agentSkills/create" && loseResponse) {
              loseResponse = false;
              committedId = (result as AgentSkill).id;
              throw new Error("Injected response loss after commit");
            }
            return result;
          },
        },
      });
      editor.createSkill(content);
      await editor.save();
      expect(committedId).not.toBe("");
      expect(state.editor).toMatchObject({ skill: null });
      const edited = rename ? content.replace(name, `${name}-renamed`) : content;
      editor.edit(edited);
      await editor.save();
      expect(state.error).toBeNull();
      const rows = await handles.prisma.agentSkill.findMany({
        where: {
          spaceId: spaceA,
          userId: (await rpc<Me>(owner, spaceA, "me")).userId,
          name: { startsWith: name },
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(committedId);
      expect(rows[0]?.content).toBe(edited);
      editor.dispose();
    },
  );
  it("deduplicates only the same authenticated user/Space creation nonce, never a matching name", async () => {
    const nonce = randomUUID();
    const content = `---\nname: scoped-${randomUUID()}\ndescription: Synthetic\n---\n\nSteps.\n`;
    const input = { clientNonce: nonce, content };
    const first = await rpc<AgentSkill>(owner, spaceA, "agentSkills/create", input);
    const again = await rpc<AgentSkill>(owner, spaceA, "agentSkills/create", input);
    expect(again.id).toBe(first.id);
    for (const [session, spaceId] of [
      [member, spaceA],
      [owner, spaceB],
    ]) {
      const other = await rpc<AgentSkill>(session!, spaceId!, "agentSkills/create", input);
      expect(other.id).not.toBe(first.id);
      expect(
        (await raw(session!, spaceId!, "agentSkills/update", { skillId: first.id, content })).ok,
      ).toBe(false);
    }
    expect((await raw(outsider, spaceA, "agentSkills/create", input)).ok).toBe(false);
    expect(
      (await raw(owner, spaceA, "agentSkills/create", { content, clientNonce: randomUUID() })).ok,
    ).toBe(false);
    const concurrentInput = {
      clientNonce: randomUUID(),
      content: content.replace("scoped-", "race-"),
    };
    const concurrent = await Promise.all([
      rpc<AgentSkill>(owner, spaceA, "agentSkills/create", concurrentInput),
      rpc<AgentSkill>(owner, spaceA, "agentSkills/create", concurrentInput),
    ]);
    expect(concurrent[0]!.id).toBe(concurrent[1]!.id);
  });

  it("reopens committed memory after the authenticated update response is lost", async () => {
    let state: KnowledgeState = initialKnowledgeState;
    let loseResponse = true;
    const editor = createKnowledgeEditor({
      botId: botA,
      section: "bot",
      changed: (next) => {
        state = next;
      },
      deliver: async () => {},
      client: {
        isCurrent: () => true,
        async request<T>(procedure: string, input: unknown): Promise<T> {
          const result = await rpc<T>(owner, spaceA, procedure, input);
          if (procedure === "memory/update" && loseResponse) {
            loseResponse = false;
            throw new Error("Injected response loss after memory commit");
          }
          return result;
        },
      },
    });
    await editor.refresh();
    const old = state.documents.find((d) => d.id === documentA)!;
    await editor.openDocument(old);
    editor.edit("Actually committed memory");
    await editor.save();
    expect(state.error).toBe("save");
    editor.cancel();
    await editor.openDocument(old);
    expect(state.draft).toBe("Actually committed memory");
    expect(state.documents.find((d) => d.id === documentA)?.content).toBe(
      "Actually committed memory",
    );
    editor.dispose();
  });
  it.each([false, true])(
    "does not promote an early snapshot to final after a PG-blocked write times out (read failure: %s)",
    async (readFailure) => {
      const db = createDb(process.env.DATABASE_URL!, { poolMax: 2 });
      const lock = await db.pool.connect();
      let actualWrite: Promise<MemoryDocument> | undefined;
      let state: KnowledgeState = initialKnowledgeState;
      let failRead = false;
      let locked = false;
      const content = `Late commit ${randomUUID()}`;
      const editor = createKnowledgeEditor({
        botId: botA,
        section: "bot",
        changed: (next) => {
          state = next;
        },
        deliver: async () => {},
        client: {
          isCurrent: () => true,
          async request<T>(procedure: string, input: unknown): Promise<T> {
            if (procedure === "memory/list" && failRead)
              throw new Error("Injected readback failure");
            if (procedure !== "memory/update") return rpc<T>(owner, spaceA, procedure, input);
            actualWrite = rpc<MemoryDocument>(owner, spaceA, procedure, input);
            void actualWrite.catch(() => undefined);
            const holder = await lock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            // Timeout is injected only after the authenticated update reaches PostgreSQL.
            await vi.waitFor(
              async () => {
                const waiting = await db.pool.query(
                  `SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))
             AND datname=current_database() AND wait_event_type='Lock'
             AND query ILIKE '%memory_documents%'`,
                  [holder.rows[0]!.pid],
                );
                expect(waiting.rowCount).toBeGreaterThan(0);
              },
              { timeout: 5000, interval: 10 },
            );
            throw new Error("Injected transport timeout while server is blocked");
          },
        },
      });
      try {
        await editor.refresh();
        const old = state.documents.find((d) => d.id === documentA)!;
        await editor.openDocument(old);
        editor.edit(content);
        await lock.query("BEGIN");
        locked = true;
        await lock.query("SELECT id FROM memory_documents WHERE id=$1 FOR UPDATE", [documentA]);
        await editor.save();
        expect(state.saveError).toBe(true);
        // Successful reads before the blocked write finishes are snapshots, not completion receipts.
        await editor.exportMarkdown();
        await editor.refresh();
        expect(state.saveError).toBe(true);
        expect(state.draft).toBe(content);
        editor.cancel();
        await editor.openDocument(old);
        expect(state.draft).toBe(old.content);
        await lock.query("ROLLBACK");
        locked = false;
        expect((await actualWrite)!.content).toBe(content);
        expect(
          (
            await rpc<MemoryDocument[]>(owner, spaceA, "memory/list", { botId: botA, scope: "bot" })
          ).find((d) => d.id === documentA)?.content,
        ).toBe(content);
        editor.cancel();
        if (readFailure) {
          failRead = true;
          await editor.openDocument(old);
          expect(state.editor).toBeNull();
          expect(state.error).toBe("load");
          failRead = false;
        }
        await editor.openDocument(old);
        expect(state.draft).toBe(content);
      } finally {
        editor.dispose();
        if (locked) await lock.query("ROLLBACK");
        lock.release();
        await actualWrite?.catch(() => undefined);
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    },
  );
});
