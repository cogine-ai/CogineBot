import type { Actor } from "@rakazo/contracts";
import { buildSkillMd, parseSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createAgentSkillsService, resolveSkillContent } from "./agent-skills.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

function savedSkill(name: string, source = "user") {
  return {
    id: "saved-1",
    spaceId: actor.spaceId,
    userId: actor.userId,
    name,
    description: "Saved review recipe",
    content: buildSkillMd({ name, description: "Saved review recipe", body: "Saved steps" }),
    source,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function setup(rows: ReturnType<typeof savedSkill>[] = []) {
  type Where = {
    id?: string;
    spaceId: string;
    userId: string;
    source?: string;
    name?: { equals: string; mode: "insensitive" };
    NOT?: { id: string };
  };
  const matches = (row: ReturnType<typeof savedSkill>, where: Where) =>
    Object.entries(where).every(([key, value]) => {
      if (key === "name") return row.name.toLowerCase() === where.name?.equals.toLowerCase();
      if (key === "NOT") return row.id !== where.NOT?.id;
      return row[key as keyof typeof row] === value;
    });
  const agentSkill = {
    findMany: vi.fn(async ({ where }: { where: Where }) =>
      rows.filter((row) => matches(row, where)),
    ),
    findFirst: vi.fn(async ({ where }: { where: Where }) =>
      rows.find((row) => matches(row, where)),
    ),
    create: vi.fn(
      async ({
        data,
      }: {
        data: Omit<ReturnType<typeof savedSkill>, "id" | "createdAt" | "updatedAt">;
      }) => {
        const row = {
          ...data,
          id: `saved-${rows.length + 1}`,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
        rows.push(row);
        return row;
      },
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: object }) => {
      const row = rows.find((row) => matches(row, where));
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const index = rows.findIndex((row) => matches(row, where));
      if (index < 0) return { count: 0 };
      rows.splice(index, 1);
      return { count: 1 };
    }),
  };
  return {
    agentSkill,
    service: createAgentSkillsService({ agentSkill } as unknown as PrismaClient),
  };
}

describe("built-in skill precedence in the API", () => {
  it.each(["interrogate", " Interrogate "])(
    "keeps %j listed, readable and mutable",
    async (name) => {
      const { service } = setup([savedSkill(name)]);
      await expect(service.list(actor)).resolves.toEqual([
        expect.objectContaining({ id: "saved-1", name, readOnly: false }),
      ]);
      await expect(service.listWithContent(actor)).resolves.toEqual([
        expect.objectContaining({ id: "saved-1", content: expect.stringContaining("Saved steps") }),
      ]);
      await expect(service.get(actor, { name: " INTERROGATE " })).resolves.toMatchObject({
        id: "saved-1",
        source: "user",
      });
      await expect(service.get(actor, { skillId: "saved-1" })).resolves.toMatchObject({ name });
      await expect(
        service.update(actor, { skillId: "saved-1", description: "Updated recipe" }),
      ).resolves.toMatchObject({ name: name.trim(), description: "Updated recipe" });
      await expect(service.remove(actor, "saved-1")).resolves.toEqual({ ok: true });
      await expect(service.get(actor, { name: "Interrogate" })).resolves.toMatchObject({
        id: "builtin:Interrogate",
        readOnly: true,
      });
    },
  );

  it("preserves plugin precedence and read-only enforcement", async () => {
    const { service, agentSkill } = setup([savedSkill(" Interrogate ", "plugin")]);
    await expect(service.get(actor, { name: "interrogate" })).resolves.toMatchObject({
      id: "saved-1",
      source: "plugin",
      readOnly: true,
    });
    await expect(service.update(actor, { skillId: "saved-1", body: "Changed" })).rejects.toThrow(
      "read-only",
    );
    await expect(service.remove(actor, "saved-1")).rejects.toThrow("read-only");
    expect(agentSkill.updateMany).not.toHaveBeenCalled();
    expect(agentSkill.deleteMany).not.toHaveBeenCalled();
  });

  it.each([{ spaceId: "other-space" }, { userId: "other-user" }])(
    "does not let foreign skills shadow the builtin: %j",
    async (foreignOwner) => {
      const { service } = setup([{ ...savedSkill(" Interrogate "), ...foreignOwner }]);
      await expect(service.get(actor, { name: "interrogate" })).resolves.toMatchObject({
        id: "builtin:Interrogate",
        readOnly: true,
      });
      await expect(service.list(actor)).resolves.toEqual([
        expect.objectContaining({ id: "builtin:Interrogate" }),
      ]);
      await expect(service.get(actor, { skillId: "saved-1" })).rejects.toThrow();
    },
  );
});

describe("skill save preservation", () => {
  it.each([0, 1, 2, 3])(
    "preserves raw imported metadata with %i trailing newlines through field edits",
    async (trailingNewlines) => {
      const indicator = trailingNewlines === 0 ? "|-" : trailingNewlines === 1 ? "|" : "|+";
      const raw = [
        "---",
        "name: Review recipe",
        "description: Original description",
        `detail: ${indicator}`,
        "  First: preserve this",
        "",
        "    indented step",
        "  Last line",
        ...Array.from({ length: Math.max(0, trailingNewlines - 1) }, () => ""),
        `indented: ${trailingNewlines === 0 ? "|2-" : trailingNewlines === 1 ? "|2" : "|2+"}`,
        "    first",
        "",
        "      second",
        ...Array.from({ length: Math.max(0, trailingNewlines - 1) }, () => ""),
        `other: ${indicator}`,
        "  Another block",
        "  with two lines",
        ...Array.from({ length: Math.max(0, trailingNewlines - 1) }, () => ""),
        "metadata:",
        "  owner: reviewers",
        "  enabled: true",
        "  version: 2",
        "---",
        "",
        "# Original steps",
        "",
        "Keep the body.",
        "",
      ].join("\n");
      const original = parseSkillMd(raw);
      if ("error" in original) throw new Error(original.error);
      expect(original.frontmatter.detail).toBe(
        `First: preserve this\n\n  indented step\nLast line${"\n".repeat(trailingNewlines)}`,
      );
      expect(original.frontmatter.other).toBe(
        `Another block\nwith two lines${"\n".repeat(trailingNewlines)}`,
      );
      expect(original.frontmatter.indented).toBe(
        `  first\n\n    second${"\n".repeat(trailingNewlines)}`,
      );

      const { service } = setup();
      const saved = await service.create(actor, { content: raw });
      const imported = parseSkillMd(saved.content);
      if ("error" in imported) throw new Error(imported.error);
      expect(imported).toEqual(original);

      const edited = await service.update(actor, {
        skillId: saved.id,
        description: "Updated description",
      });
      const descriptionEdited = parseSkillMd(edited.content);
      if ("error" in descriptionEdited) throw new Error(descriptionEdited.error);
      expect(descriptionEdited).toEqual({
        ...original,
        description: "Updated description",
        frontmatter: { ...original.frontmatter, description: "Updated description" },
      });

      await service.update(actor, { skillId: saved.id, body: "# Edited steps\n" });
      const reloaded = await service.get(actor, { skillId: saved.id });
      const bodyEdited = parseSkillMd(reloaded.content);
      if ("error" in bodyEdited) throw new Error(bodyEdited.error);
      expect(bodyEdited).toEqual({ ...descriptionEdited, body: "# Edited steps\n" });
    },
  );

  it.each(["raw", "fields", "prior"] as const)(
    "enforces the canonical content limit for %s saves",
    (mode) => {
      const fields = { name: "Limit recipe", description: "Bounded content", body: "" };
      const body = "x".repeat(100_000 - buildSkillMd(fields).length);
      const resolve = (value: string) => {
        if (mode === "raw")
          return resolveSkillContent({ content: buildSkillMd({ ...fields, body: value }) });
        if (mode === "prior")
          return resolveSkillContent({
            prior: { content: buildSkillMd({ ...fields, body: value }) },
            description: "Bounded content",
          });
        return resolveSkillContent({ ...fields, body: value });
      };
      expect(resolve(body).content).toHaveLength(100_000);
      expect(() => resolve(`${body}x`)).toThrow("at most 100000 characters");
    },
  );

  it.each([{ spaceId: "other-space" }, { userId: "other-user" }])(
    "rejects field edits and deletion outside the actor boundary: %j",
    async (foreignOwner) => {
      const row = { ...savedSkill("Private recipe"), ...foreignOwner };
      const originalContent = row.content;
      const { service, agentSkill } = setup([row]);
      await expect(
        service.update(actor, { skillId: row.id, body: "Changed" }),
      ).rejects.toBeInstanceOf(IsolationError);
      await expect(service.remove(actor, row.id)).rejects.toBeInstanceOf(IsolationError);
      expect(agentSkill.updateMany).not.toHaveBeenCalled();
      expect(agentSkill.deleteMany).not.toHaveBeenCalled();
      expect(row.content).toBe(originalContent);
    },
  );

  it("does not persist over-limit create or update requests", async () => {
    const row = savedSkill("Existing recipe");
    const { service, agentSkill } = setup([row]);
    await expect(
      service.create(actor, {
        name: "Large recipe",
        description: "Too large",
        body: "x".repeat(100_000),
      }),
    ).rejects.toThrow("at most 100000 characters");
    await expect(
      service.update(actor, { skillId: row.id, body: "x".repeat(100_000) }),
    ).rejects.toThrow("at most 100000 characters");
    expect(agentSkill.create).not.toHaveBeenCalled();
    expect(agentSkill.updateMany).not.toHaveBeenCalled();
  });

  it("preserves builtin row read-only enforcement", async () => {
    const { service, agentSkill } = setup([savedSkill("Builtin recipe", "builtin")]);
    await expect(service.update(actor, { skillId: "saved-1", body: "Changed" })).rejects.toThrow(
      "read-only",
    );
    await expect(service.remove(actor, "saved-1")).rejects.toThrow("read-only");
    expect(agentSkill.updateMany).not.toHaveBeenCalled();
    expect(agentSkill.deleteMany).not.toHaveBeenCalled();
  });
});
