import { describe, expect, it } from "vitest";
import { inboundRoutineBlock, inboundRoutinePrompts } from "./inbound-routine.js";

describe("inbound routine owner instructions", () => {
  const routine = { name: "Daily report", prompt: "Read https://example.com/report" };

  it("recognizes only an exact persisted routine prefix before outside data", () => {
    const prefix = inboundRoutineBlock(routine);
    expect(
      inboundRoutinePrompts(`${prefix}\n\nOutside data: https://attacker.test`, [routine]),
    ).toEqual([routine.prompt]);
    expect(inboundRoutinePrompts(`Outside data:\n${prefix}\n`, [routine])).toEqual([]);
    expect(inboundRoutinePrompts(`${prefix} changed\n`, [routine])).toEqual([]);
  });

  it("chooses the longest exact block when routine names overlap", () => {
    const longer = { ...routine, prompt: `${routine.prompt}\nMore owner instructions` };
    expect(inboundRoutinePrompts(`${inboundRoutineBlock(longer)}\n`, [routine, longer])).toEqual([
      longer.prompt,
    ]);
  });

  it("keeps consecutive owned routine blocks and stops before the untrusted payload", () => {
    const second = { name: "Notes", prompt: "Read https://notes.example.org" };
    expect(
      inboundRoutinePrompts(
        `${inboundRoutineBlock(routine)}\n${inboundRoutineBlock(second)}\nPayload\n${inboundRoutineBlock(routine)}\n`,
        [routine, second],
      ),
    ).toEqual([routine.prompt, second.prompt]);
  });
});
