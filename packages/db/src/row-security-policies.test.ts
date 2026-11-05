import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROW_SECURITY_MODELS } from "./row-security.js";
import { ROW_SECURITY_POLICIES } from "./row-security-policies.js";

describe("row-security policy schema coverage", () => {
  it("classifies every actual model and physical table exactly once", () => {
    const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
    const actual = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(
      ([, model, body]) => ({
        model: model!,
        table: body!.match(/@@map\(\s*"([^"]+)"\s*\)/)?.[1] ?? model!,
      }),
    );
    expect(actual.length).toBeGreaterThan(0);
    expect(new Set(ROW_SECURITY_POLICIES.map((entry) => entry.model)).size).toBe(actual.length);
    expect(new Set(ROW_SECURITY_POLICIES.map((entry) => entry.table)).size).toBe(actual.length);
    expect(
      ROW_SECURITY_POLICIES.map(({ model, table }) => ({ model, table })).sort((a, b) =>
        a.model.localeCompare(b.model),
      ),
    ).toEqual(actual.sort((a, b) => a.model.localeCompare(b.model)));
    expect(new Set(ROW_SECURITY_POLICIES.map(({ model }) => model))).toEqual(ROW_SECURITY_MODELS);
  });

  it("gives tenant and account tables a constrained predicate and system tables no tenant grant", () => {
    for (const entry of ROW_SECURITY_POLICIES) {
      expect(["tenant", "user/account", "explicit-system"]).toContain(entry.scope);
      if (entry.scope === "explicit-system") {
        expect(entry.tenantPredicate, entry.table).toBeUndefined();
      } else {
        expect(entry.tenantPredicate, entry.table).toBeTruthy();
        expect(entry.tenantPredicate, entry.table).not.toMatch(/^\s*\(?true\)?\s*$/i);
        expect(entry.tenantPredicate, entry.table).toContain(
          entry.scope === "tenant" ? "app.space_id" : "app.user_id",
        );
      }
    }
  });
});
