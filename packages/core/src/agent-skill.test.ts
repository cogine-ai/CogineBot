import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  buildSkillMd,
  expandSkillReferencesInPrompt,
  extractForcedSkillName,
  extractRoutineSkillMentions,
  findSkillByName,
  formatSkillsCatalogInstruction,
  mergeBuiltinSkills,
  parseSkillMd,
} from "./agent-skill.js";

function standardFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (!match) throw new Error("Expected frontmatter fences");
  return parseYaml(`${match[1]}\n`) as Record<string, unknown>;
}

describe("built-in skill merging", () => {
  it("uses the same normalized names for catalog precedence and prompt expansion", () => {
    const builtin = {
      name: "Interrogate",
      description: "Builtin review",
      content: "Builtin instructions",
      source: "builtin" as const,
      readOnly: true,
    };
    const saved = {
      ...builtin,
      name: " Interrogate ",
      content: "Saved instructions",
      source: "user" as const,
      readOnly: false,
    };
    const skills = mergeBuiltinSkills<typeof builtin | typeof saved>([builtin], [saved]);
    expect(skills).toEqual([saved]);
    expect(findSkillByName(skills, " INTERROGATE ")).toBe(saved);
    for (const prompt of ["/Interrogate\nreview this", "Use @Interrogate to review this"]) {
      expect(expandSkillReferencesInPrompt(prompt, skills)).toContain("Saved instructions");
      expect(expandSkillReferencesInPrompt(prompt, skills)).not.toContain("Builtin instructions");
      expect(expandSkillReferencesInPrompt(prompt, skills)).not.toContain("@Interrogate");
    }
    expect(mergeBuiltinSkills([builtin], [])).toEqual([builtin]);
  });
});

const SAMPLE = `---
name: Daily standup
description: Prepare a concise standup update from recent work. Use when the user asks for standup notes or a status summary.
compatibility: optional-extra
allowed-tools: [shell, read_file]
long-desc: >-
  Folded description that spans
  multiple lines with strip chomping.
literal: |+
  Keep trailing newlines

  And blank lines.
---

# Daily standup

1. Scan recent commits and open tasks.
2. Summarize wins, plans, and blockers.
`;

describe("parseSkillMd", () => {
  it.each(["|", "|-", "|+", ">", ">-", ">+"])(
    "uses standard empty block chomping for %s before another field or the closing fence",
    (indicator) => {
      for (const trailingNewlines of [0, 1, 2, 3]) {
        for (const last of [false, true]) {
          const content = [
            "---",
            "name: Empty blocks",
            "description: Preserve empty block values",
            `blank: ${indicator}`,
            ...Array.from({ length: trailingNewlines }, () => "  "),
            ...(last ? [] : ["other: sentinel"]),
            "---",
            "",
            "# Body",
          ].join("\n");
          const expected = indicator.endsWith("+") ? "\n".repeat(trailingNewlines) : "";
          expect(standardFrontmatter(content).blank).toBe(expected);
          const parsed = parseSkillMd(content);
          if ("error" in parsed) throw new Error(parsed.error);
          expect(parsed.frontmatter.blank).toBe(expected);
        }
      }
    },
  );

  it("parses name, description, body, and extra frontmatter keys", () => {
    const parsed = parseSkillMd(SAMPLE);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.name).toBe("Daily standup");
    expect(parsed.description).toContain("standup");
    expect(parsed.body).toContain("# Daily standup");
    expect(parsed.frontmatter.compatibility).toBe("optional-extra");
    expect(parsed.frontmatter["allowed-tools"]).toEqual(["shell", "read_file"]);
    expect(String(parsed.frontmatter["long-desc"])).toBe(
      "Folded description that spans multiple lines with strip chomping.",
    );
    expect(String(parsed.frontmatter.literal)).toContain("Keep trailing newlines");
    expect(String(parsed.frontmatter.literal).endsWith("\n")).toBe(true);
  });

  it("parses block scalar indicators with chomping and indent hints", () => {
    const doc = `---
name: Folded
description: >-
  Multi-line description
  that folds.
notes: |+
  Keep trailing newlines.


indent: |2
  Indented block
chomp-indent: |-2
  Chomp then indent
---

# Body
`;
    const parsed = parseSkillMd(doc);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.description).toBe("Multi-line description that folds.");
    expect(parsed.frontmatter.notes).toBe("Keep trailing newlines.\n\n\n");
    expect(parsed.frontmatter.indent).toBe("Indented block\n");
    expect(parsed.frontmatter["chomp-indent"]).toBe("Chomp then indent");
  });

  it("preserves more-indented lines inside folded scalars", () => {
    const cases: Array<{ label: string; detail: string; expected: string }> = [
      {
        label: "adjacent indented fragment",
        detail: `>
  Intro line
  continues here
    more indented
    also indented
  outro line
`,
        // Matches yaml@2.9 folded semantics: newline separation, not space-fold.
        expected: "Intro line continues here\n  more indented\n  also indented\noutro line\n",
      },
      {
        label: "blank lines around indented list",
        detail: `>
  paragraph one
  still one

    - list item
    - two

  paragraph two
`,
        expected: "paragraph one still one\n\n  - list item\n  - two\n\nparagraph two\n",
      },
      {
        label: "indented block without surrounding blanks",
        detail: `>
  before
    code block
    line two
  after
`,
        expected: "before\n  code block\n  line two\nafter\n",
      },
    ];

    for (const { label, detail, expected } of cases) {
      const parsed = parseSkillMd(`---
name: Fold indent
description: Folded with indented fragment
detail: ${detail}---

# Body
`);
      expect("error" in parsed, label).toBe(false);
      if ("error" in parsed) return;
      expect(parsed.frontmatter.detail, label).toBe(expected);
    }
  });

  it("requires name and description", () => {
    expect(parseSkillMd("---\nname: x\n---\nbody")).toEqual({
      error: "SKILL.md frontmatter requires description.",
    });
    expect(parseSkillMd("no frontmatter")).toMatchObject({ error: expect.any(String) });
  });

  it("rejects overlong names", () => {
    const name = "N".repeat(81);
    expect(parseSkillMd(`---\nname: ${name}\ndescription: ok\n---\nbody`)).toEqual({
      error: "Skill name must be at most 80 characters.",
    });
  });
});

describe("buildSkillMd", () => {
  it.each([0, 1, 2, 3])(
    "exports standards-compatible block values with %i trailing newlines across repeated builds",
    (trailingNewlines) => {
      const values = [
        "\n".repeat(trailingNewlines),
        `First: preserve this\n\n  indented step\nLast line${"\n".repeat(trailingNewlines)}`,
        `  first\n\n    second${"\n".repeat(trailingNewlines)}`,
        `\n\n  first\n    second${"\n".repeat(trailingNewlines)}`,
      ];
      for (const last of [false, true]) {
        const key = last ? "z-value" : "a-value";
        for (const value of values) {
          let content = buildSkillMd({
            name: "Portable recipe",
            description: "Preserve metadata values",
            body: "# Body\n",
            frontmatter: { [key]: value, middle: "sentinel" },
          });
          for (let edit = 0; edit < 3; edit += 1) {
            const standard = standardFrontmatter(content);
            expect(standard[key]).toBe(value);
            expect(standard.middle).toBe("sentinel");
            const parsed = parseSkillMd(content);
            if ("error" in parsed) throw new Error(parsed.error);
            expect(parsed.frontmatter).toEqual(standard);
            expect(parsed.body).toBe("# Body\n");
            content = buildSkillMd(parsed);
          }
        }
      }
    },
  );

  it.each([0, 1, 2, 3])(
    "preserves multiline metadata with %i trailing newlines across repeated edits",
    (trailingNewlines) => {
      const detail = `First: preserve this\n\n  indented step\nLast line${"\n".repeat(trailingNewlines)}`;
      const input = {
        name: "Review recipe",
        description: "Review a change",
        body: "# Review\n\nKeep the original steps.\n",
        frontmatter: {
          detail,
          indented: `  first\n\n    second${"\n".repeat(trailingNewlines)}`,
          blank: "\n".repeat(trailingNewlines),
          other: `Another block\nwith two lines${"\n".repeat(Math.min(trailingNewlines, 2))}`,
          metadata: { owner: "reviewers", enabled: true, version: 2 },
        },
      };
      let content = buildSkillMd(input);
      for (let edit = 0; edit < 3; edit += 1) {
        const parsed = parseSkillMd(content);
        if ("error" in parsed) throw new Error(parsed.error);
        expect(parsed).toMatchObject({
          name: input.name,
          description: input.description,
          body: input.body,
          frontmatter: input.frontmatter,
        });
        content = buildSkillMd(parsed);
      }
    },
  );

  it("round-trips and preserves extra keys", () => {
    const parsed = parseSkillMd(SAMPLE);
    if ("error" in parsed) throw new Error(parsed.error);
    const rebuilt = buildSkillMd(parsed);
    const again = parseSkillMd(rebuilt);
    if ("error" in again) throw new Error(again.error);
    expect(again.name).toBe(parsed.name);
    expect(again.description).toBe(parsed.description);
    expect(again.frontmatter.compatibility).toBe("optional-extra");
    expect(again.body.trim()).toBe(parsed.body.trim());
  });

  it("round-trips keep-chomp and strip-chomp block scalars", () => {
    const doc = `---
name: Chomp
description: Round-trip chomp
notes: |+
  Keep trailing newlines.


strip: |-
  No trailing newline
clip: |
  One trailing newline
---

# Body
`;
    const parsed = parseSkillMd(doc);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.frontmatter.notes).toBe("Keep trailing newlines.\n\n\n");
    expect(parsed.frontmatter.strip).toBe("No trailing newline");
    expect(parsed.frontmatter.clip).toBe("One trailing newline\n");
    const rebuilt = buildSkillMd(parsed);
    const again = parseSkillMd(rebuilt);
    if ("error" in again) throw new Error(again.error);
    expect(again.frontmatter.notes).toBe(parsed.frontmatter.notes);
    expect(again.frontmatter.strip).toBe(parsed.frontmatter.strip);
    expect(again.frontmatter.clip).toBe(parsed.frontmatter.clip);
  });

  it("rejects overlong structured names", () => {
    expect(() => buildSkillMd({ name: "N".repeat(81), description: "ok", body: "body" })).toThrow(
      /at most 80 characters/,
    );
  });
});

describe("skill prompt helpers", () => {
  it("extracts forced /Name and Use skill: Name", () => {
    expect(extractForcedSkillName("/Daily standup\nplease")).toEqual({
      name: "Daily standup",
      rest: "please",
    });
    expect(extractForcedSkillName("Use skill: Weekly review")).toEqual({
      name: "Weekly review",
      rest: "",
    });
    expect(extractForcedSkillName("/Settings: General")).toBeNull();
  });

  it("extracts @skill mentions from routine prompts", () => {
    expect(extractRoutineSkillMentions("Run @Daily standup, then post to Slack")).toEqual([
      "Daily standup",
    ]);
    expect(extractRoutineSkillMentions("ping @everyone then @Weekly review")).toEqual([
      "Weekly review",
    ]);
  });

  it("expands forced and mentioned skills into the prompt", () => {
    const skills = [
      {
        name: "Daily standup",
        description: "standup",
        source: "user" as const,
        readOnly: false,
        content: SAMPLE,
      },
    ];
    const forced = expandSkillReferencesInPrompt("/Daily standup\nfocus on blockers", skills);
    expect(forced).toContain("Use skill: Daily standup");
    expect(forced).toContain(SAMPLE.trim());
    expect(forced).toContain("focus on blockers");

    const mentioned = expandSkillReferencesInPrompt("Run @Daily standup then email me", skills);
    expect(mentioned).toContain("Use skill: Daily standup");
    expect(mentioned).toContain("then email me");
    expect(mentioned).not.toMatch(/@Daily standup/i);

    // Fire-time expand then run-time expand must not duplicate the body.
    const again = expandSkillReferencesInPrompt(mentioned, skills);
    expect(again).toBe(mentioned);
    expect(again.split(SAMPLE.trim()).length - 1).toBe(1);

    const twice = expandSkillReferencesInPrompt(
      "Run @Daily standup then repeat @Daily standup",
      skills,
    );
    expect(twice).not.toMatch(/@Daily standup/i);
    expect(twice.split(SAMPLE.trim()).length - 1).toBe(1);
    expect(expandSkillReferencesInPrompt(twice, skills)).toBe(twice);
  });

  it("builds catalog instructions for auto-use", () => {
    const line = formatSkillsCatalogInstruction([
      {
        name: "Daily standup",
        description: "Prepare standup notes",
        source: "user",
        readOnly: false,
      },
    ]);
    expect(line).toContain("- Daily standup: Prepare standup notes");
    expect(line).toContain("skill_read");
    expect(line).toContain("Prefer matching skills");
  });
});
