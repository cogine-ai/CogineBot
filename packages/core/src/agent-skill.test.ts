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

  it.each([1, 49, 50, 51, 200, 201])(
    "reports the complete %s-skill directory while keeping its original 50-entry preview",
    (total) => {
      const entries = Array.from({ length: total }, (_, index) => ({
        name: `Skill ${String(index + 1).padStart(3, "0")}`,
        description: `Description ${index + 1}`,
        source: "user" as const,
        readOnly: false,
        content: `Private recipe body ${index + 1}`,
      }));
      const original = JSON.stringify(entries);
      const shown = Math.min(total, 50);
      const instruction = formatSkillsCatalogInstruction(entries)!;
      expect(instruction).toContain(
        `Skill catalog: ${total} total; ${shown} shown; ${total - shown} omitted.`,
      );
      expect(instruction.match(/^- Skill /gm)).toHaveLength(shown);
      expect(instruction).toContain(`- Skill ${String(shown).padStart(3, "0")}:`);
      expect(instruction).not.toContain("Private recipe body");
      if (total > 50) {
        expect(instruction).not.toContain("- Skill 051:");
        expect(instruction).toContain("skillsQuery");
        expect(instruction).toContain("skillsOffset");
        expect(instruction).toContain("skillsLimit");
      } else {
        expect(instruction).not.toContain("skillsOffset");
      }
      expect(instruction).toContain("skillId");
      expect(JSON.stringify(entries)).toBe(original);
    },
  );

  it("keeps the empty directory silent and explicit omitted-skill expansion intact", () => {
    expect(formatSkillsCatalogInstruction([])).toBeUndefined();
    const entries = Array.from({ length: 201 }, (_, index) => ({
      name: `Recipe ${index + 1}`,
      description: `Metadata ${index + 1}`,
      source: "user" as const,
      readOnly: false,
      content: `Exact body ${index + 1}\n\nKeep spacing.\n`,
    }));
    formatSkillsCatalogInstruction(entries);
    for (const number of [51, 200, 201]) {
      const forced = expandSkillReferencesInPrompt(`/Recipe ${number}\nContinue`, entries);
      expect(forced).toContain(`Exact body ${number}\n\nKeep spacing.`);
      expect(forced).toContain("Continue");
      expect(expandSkillReferencesInPrompt(forced, entries)).toBe(forced);
    }
  });

  it("does not direct a run to a disabled catalog tool", () => {
    const entries = Array.from({ length: 201 }, (_, index) => ({
      name: `Recipe ${index + 1}`,
      description: "Discoverable recipe",
      source: "user" as const,
      readOnly: false,
    }));
    const instruction = formatSkillsCatalogInstruction(entries, { catalogAvailable: false })!;
    expect(instruction).toContain("201 total; 50 shown; 151 omitted");
    expect(instruction).not.toContain("task_catalog");
    expect(instruction).not.toContain("skillsOffset");
    expect(instruction).toContain("exact skillId");
    expect(instruction.match(/^- Recipe /gm)).toHaveLength(50);
  });

  it("includes complete selectable IDs in the preview when catalog discovery is disabled", () => {
    const entries = [
      {
        id: 'first:"quoted"]\\line\n😀',
        name: "Shared",
        description: "First recipe",
        source: "user" as const,
        readOnly: false,
      },
      {
        id: "second-id",
        name: " Shared ",
        description: "Second recipe",
        source: "plugin" as const,
        readOnly: true,
      },
    ];
    const original = JSON.stringify(entries);
    const enabled = formatSkillsCatalogInstruction(entries)!;
    const disabled = formatSkillsCatalogInstruction(entries, { catalogAvailable: false })!;
    for (const entry of entries) {
      expect(disabled).toContain(
        `- ${entry.name} [skillId: ${JSON.stringify(entry.id)}]: ${entry.description}`,
      );
      expect(enabled).toContain(`- ${entry.name}: ${entry.description}`);
      expect(enabled).not.toContain(entry.id);
    }
    const printed = [...disabled.matchAll(/\[skillId: ("(?:\\.|[^"\\])*")\]/g)].map((match) =>
      JSON.parse(match[1]!),
    );
    expect(printed).toEqual(entries.map((entry) => entry.id));
    expect(disabled).not.toContain("task_catalog");
    expect(JSON.stringify(entries)).toBe(original);
  });
});

describe("saved skill scalar and array fidelity", () => {
  it.each([
    { raw: String.raw`"Say \"go\""`, expected: 'Say "go"' },
    { raw: String.raw`"C:\\fixtures\\one"`, expected: "C:\\fixtures\\one" },
    { raw: String.raw`"tab\tvalue"`, expected: "tab\tvalue" },
    { raw: String.raw`"\u96ea"`, expected: "雪" },
    { raw: "'it''s here'", expected: "it's here" },
  ])("decodes imported quoted metadata $raw", ({ raw, expected }) => {
    const content = `---\nname: Fidelity recipe\ndescription: Preserve saved values\ndetail: ${raw}\n---\n# Body\n`;
    expect(standardFrontmatter(content).detail).toBe(expected);
    const parsed = parseSkillMd(content);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.frontmatter.detail).toBe(expected);
  });

  it.each([
    { raw: String.raw`"C:\path"`, expected: String.raw`C:\path` },
    { raw: "'", expected: "'" },
    { raw: '"', expected: '"' },
  ])("retains legacy nonstandard quoted metadata $raw", ({ raw, expected }) => {
    const parsed = parseSkillMd(
      `---\nname: Fidelity recipe\ndescription: Preserve saved values\ndetail: ${raw}\n---\nbody`,
    );
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.frontmatter.detail).toBe(expected);
  });

  const values = [
    "1.10",
    "010",
    "-2.5",
    "true",
    "false",
    '"quoted start',
    "'quoted start",
    '"',
    "'",
    "",
    "  padded  ",
    String.raw`C:\fixture, "quoted"`,
    "tab\tvalue, comma",
    "first\nsecond",
    "First: retain this",
    "\n\n",
    "first\n  \nsecond",
    "first\n\t\nsecond",
    "first\n \t ",
    " \nfirst",
    0,
    -2.5,
    true,
    false,
    [],
    ["a,b", "", String.raw`C:\fixture`, 'say "go"', "line\nbreak"],
    [0, -2.5, 1e21, 1e-7],
    [true, false],
    ["1.10", "true", "", 2, true, false],
  ];
  it.each(values.map((value) => ({ value })))(
    "preserves top-level and one-level metadata $value through three saves",
    ({ value }) => {
      const expected = {
        name: "Fidelity recipe",
        description: "Preserve saved values",
        detail: value,
        metadata: { detail: value, enabled: true },
      };
      let content = buildSkillMd({
        ...expected,
        body: "# Body\n",
        frontmatter: { detail: value, metadata: expected.metadata },
      });
      for (let edit = 0; edit < 3; edit += 1) {
        expect(standardFrontmatter(content)).toEqual(expected);
        const parsed = parseSkillMd(content);
        if ("error" in parsed) throw new Error(parsed.error);
        expect(parsed.frontmatter).toEqual(expected);
        expect(parsed.body).toBe("# Body\n");
        content = buildSkillMd(parsed);
      }
    },
  );

  it.each([
    'Use when the user says "ship it", then deploy.',
    String.raw`Paths like C:\fixtures, #fixture`,
    "Tabs\tand, commas",
    '"quoted" start',
  ])("keeps the description %j across repeated saves", (description) => {
    let content = buildSkillMd({ name: "Fidelity recipe", description, body: "body" });
    for (let edit = 0; edit < 3; edit += 1) {
      expect(standardFrontmatter(content).description).toBe(description);
      const parsed = parseSkillMd(content);
      if ("error" in parsed) throw new Error(parsed.error);
      expect(parsed.description).toBe(description);
      content = buildSkillMd(parsed);
    }
  });

  const jsonControls = [
    { label: "CR", char: "\r" },
    { label: "CRLF", char: "\r\n" },
    { label: "LF", char: "\n" },
    { label: "tab", char: "\t" },
    { label: "backspace", char: "\b" },
    { label: "form feed", char: "\f" },
    { label: "NUL", char: "\0" },
    { label: "vertical tab", char: "\v" },
    { label: "unit separator", char: "\x1f" },
    { label: "next line", char: "\u0085" },
    { label: "line separator", char: "\u2028" },
    { label: "paragraph separator", char: "\u2029" },
    { label: "DEL", char: "\u007f" },
    { label: "C1 start", char: "\u0080" },
    { label: "C1 end", char: "\u009f" },
    { label: "noncharacter FFFE", char: "\ufffe" },
    { label: "noncharacter FFFF", char: "\uffff" },
    { label: "lone high surrogate", char: "\ud800" },
    { label: "lone low surrogate", char: "\udc00" },
    { label: "astral Unicode", char: "😀" },
  ];
  const controlCases = jsonControls.flatMap(({ label, char }) =>
    ["middle", "with newline"].flatMap((position) =>
      ["top", "nested", "array"].map((location) => ({ label, char, position, location })),
    ),
  );
  it.each(controlCases)(
    "keeps decoded JSON controls: $label $position in $location metadata",
    ({ char, position, location }) => {
      const value = position === "middle" ? `first${char}second` : `first${char}second\nthird`;
      const metadata =
        location === "top"
          ? { detail: value }
          : location === "nested"
            ? { metadata: { detail: value } }
            : { values: [value] };
      const expected = {
        name: "Control recipe",
        description: "Preserve decoded values",
        ...metadata,
      };
      let content = buildSkillMd({ ...expected, body: "body", frontmatter: metadata });
      for (let edit = 0; edit < 3; edit += 1) {
        expect(content).not.toMatch(
          // biome-ignore lint/suspicious/noControlCharactersInRegex: Checks forbidden YAML output codepoints deliberately.
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u0084\u0086-\u009f\ud800-\udfff\ufffe\uffff]/u,
        );
        expect(standardFrontmatter(content)).toEqual(expected);
        const parsed = parseSkillMd(content);
        if ("error" in parsed) throw new Error(parsed.error);
        expect(parsed.frontmatter).toEqual(expected);
        content = buildSkillMd(parsed);
      }
    },
  );

  const whitespaceBlockCases = [
    "|2-",
    "|2",
    "|2+",
    ">2-",
    ">2",
    ">2+",
    "|-",
    "|",
    "|+",
    ">-",
    ">",
    ">+",
  ].flatMap((header) =>
    [
      ["  first", "    ", "  second"],
      ["  first", "  \t", "  second"],
      [header.includes("2") ? "    " : "  ", "  first", "    "],
      ["  \t", "  first", "  \t"],
      ["  first", "  \tcode", "  second"],
      ["  \t"],
      ["", "  \t", ""],
      ["  \t", "  \t"],
      ["  \u00a0"],
      ["  \u2003"],
      ["  \ufeff"],
      ["  \u3000"],
    ].map((lines, variant) => ({ header, lines, variant })),
  );
  it.each(whitespaceBlockCases)(
    "retains block content whitespace for $header variant $variant",
    ({ header, lines }) => {
      let content = [
        "---",
        "name: Whitespace recipe",
        "description: Preserve content whitespace",
        `detail: ${header}`,
        ...lines,
        "---",
        "body",
      ].join("\n");
      const expected = standardFrontmatter(content);
      for (let edit = 0; edit < 3; edit += 1) {
        const parsed = parseSkillMd(content);
        if ("error" in parsed) throw new Error(parsed.error);
        expect(parsed.frontmatter).toEqual(expected);
        content = buildSkillMd(parsed);
        expect(standardFrontmatter(content)).toEqual(expected);
      }
    },
  );

  const arrayWhitespaceCases = [" ", "\t", " \t "].flatMap((padding) =>
    [[], [1, true], ["a,b", "", false, 2]].map((values) => ({ padding, values })),
  );
  it.each(arrayWhitespaceCases)(
    "preserves JSON arrays with whitespace $padding around $values",
    ({ padding, values }) => {
      const content = `---\nname: Array recipe\ndescription: Preserve typed arrays\nvalues: ${padding}${JSON.stringify(values)}${padding}\nmetadata:\n  values: ${padding}${JSON.stringify(values)}${padding}\n---\nbody`;
      const expected = {
        name: "Array recipe",
        description: "Preserve typed arrays",
        values,
        metadata: { values },
      };
      expect(standardFrontmatter(content)).toEqual(expected);
      let saved = content;
      for (let edit = 0; edit < 3; edit += 1) {
        const parsed = parseSkillMd(saved);
        if ("error" in parsed) throw new Error(parsed.error);
        expect(parsed.frontmatter).toEqual(expected);
        saved = buildSkillMd(parsed);
      }
    },
  );

  it.each(["[shell, read_file]", "[null]", "[1e400]", '[{"value":1}]'])(
    "retains scoped legacy whitespace handling for unsupported array %s",
    (raw) => {
      let content = `---\nname: Legacy recipe\ndescription: Preserve legacy values\nvalues: ${raw} \t\nmetadata:\n  values: ${raw} \t\n---\nbody`;
      for (let edit = 0; edit < 3; edit += 1) {
        const parsed = parseSkillMd(content);
        if ("error" in parsed) throw new Error(parsed.error);
        expect(parsed.frontmatter.values).toBe(raw);
        expect(parsed.frontmatter.metadata).toEqual({ values: raw });
        content = buildSkillMd(parsed);
      }
    },
  );

  it.each(["Deploy the app", "don't panic"])(
    "keeps plain description %j unquoted",
    (description) => {
      expect(buildSkillMd({ name: "Fidelity recipe", description, body: "body" })).toContain(
        `description: ${description}\n`,
      );
    },
  );

  it.each([
    { raw: "[shell, read_file]", expected: ["shell", "read_file"] },
    { raw: "[1e400]", expected: ["1e400"] },
    { raw: "[null]", expected: ["null"] },
    { raw: '[{"value":1}]', expected: ['{"value":1}'] },
    { raw: "[[1]]", expected: ["[1]"] },
  ])("retains the scoped legacy array fallback for $raw", ({ raw, expected }) => {
    const parsed = parseSkillMd(
      `---\nname: Fidelity recipe\ndescription: Preserve saved values\nvalues: ${raw}\nmetadata:\n  values: ${raw}\n---\nbody`,
    );
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.frontmatter.values).toEqual(expected);
    expect(parsed.frontmatter.metadata).toEqual({ values: raw });
  });

  it("retains legacy overflow normalization without introducing null", () => {
    const parsed = parseSkillMd(
      `---\nname: Fidelity recipe\ndescription: Preserve saved values\nvalues: [${"9".repeat(400)}]\n---\nbody`,
    );
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.frontmatter.values).toEqual([Number.POSITIVE_INFINITY]);
    const again = parseSkillMd(buildSkillMd(parsed));
    if ("error" in again) throw new Error(again.error);
    expect(again.frontmatter.values).toEqual(["Infinity"]);
  });
});
