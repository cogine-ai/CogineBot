import type { AgentRunRequest, AgentRuntime, ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  briefSourceAccounts,
  briefSources,
  deliverWeekdayBrief,
} from "./weekday-brief-delivery.js";
import { weekdayBriefSetup } from "./weekday-brief-setup.js";

const accounts = [
  { id: "inbox-a", provider: "gmail", connectorId: "native", displayName: "Inbox" },
  { id: "calendar-a", provider: "google-calendar", connectorId: "native", displayName: "Calendar" },
];
const tools: ConnectorTool[] = [
  "gmail.messages.search",
  "gmail.threads.get",
  "calendar.events.search",
].map((action) => {
  const account = action.startsWith("gmail") ? accounts[0]! : accounts[1]!;
  return {
    name: action,
    description: "",
    inputSchema: {},
    readOnly: true,
    route: {
      toolName: action,
      connectorId: "native",
      connectionId: account.id,
      resourceId: account.provider,
    },
  };
});
const sources = {
  mail: "inbox-a",
  calendar: "calendar-a",
  calendarId: "primary",
  timezone: "America/New_York",
  language: "en" as const,
};
async function collect<T>(events: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}
describe("weekday brief setup", () => {
  const input = {
    text: "/Weekday brief\n08:30 America/New_York",
    sources: briefSourceAccounts(accounts, tools),
    threadId: "private",
    runId: "one",
  };
  it("only schedules the confirmed sources and does not duplicate an active routine", async () => {
    const records: Record<string, unknown>[] = [];
    const execute = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "schedule_list") return { routines: records };
      records.push({ ...args, crons: [args.cron], threadId: "private", active: true });
      return { ok: true, nextRunAt: "2026-06-01T12:30:00Z" };
    });
    const [preview] = await collect(weekdayBriefSetup({ ...input, execute }));
    expect(preview).toMatchObject({
      type: "ask",
      detail: expect.stringContaining("Fictional sample"),
    });
    expect(execute).not.toHaveBeenCalled();
    if (preview?.type !== "ask") throw Error("Missing preview");
    const cancel = preview.actions![1]!.id,
      enable = preview.actions![0]!.id;
    expect(await collect(weekdayBriefSetup({ ...input, execute, selection: cancel }))).toEqual([
      { type: "done", text: "Setup cancelled." },
    ]);
    expect(execute).not.toHaveBeenCalled();
    const changed = await collect(
      weekdayBriefSetup({
        ...input,
        text: input.text.replace("08:30", "09:15"),
        execute,
        selection: enable,
      }),
    );
    expect(changed[0]?.type).toBe("ask");
    for (let i = 0; i < 2; i++)
      await collect(weekdayBriefSetup({ ...input, execute, selection: enable }));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ cron: "30 8 * * 1-5", timezone: sources.timezone });
    expect(briefSources(String(records[0]?.prompt))).toEqual(sources);
  });
  it("requires a choice when display names match more than one connected inbox", async () => {
    const execute = vi.fn();
    const result = await collect(
      weekdayBriefSetup({
        ...input,
        text: `${input.text} Inbox`,
        sources: {
          ...input.sources,
          mail: [...input.sources.mail, { ...accounts[0]!, id: "another" }],
        },
        execute,
      }),
    );
    expect(result[0]?.type).toBe("done");
    expect(execute).not.toHaveBeenCalled();
  });
});
describe("grounded weekday delivery", () => {
  const day = "2026-03-08";
  const event = (id: string, start: string, end: string) => ({
    id,
    summary: id,
    htmlLink: `https://calendar.example.test/${id}`,
    start: { dateTime: `${day}T${start}:00-04:00` },
    end: { dateTime: `${day}T${end}:00-04:00` },
  });
  const meetings = [
    event("A", "10:00", "11:00"),
    event("B", "10:30", "11:30"),
    event("C", "11:30", "12:00"),
  ];
  const thread = {
    id: "m1",
    webUrl: "https://mail.example.test/message",
    messages: [{ headers: { subject: "Print order" }, text: "Please confirm the quantity." }],
  };
  const classify: AgentRuntime["run"] = async function* (request) {
    expect(request.tools).toEqual([]);
    expect(request.history).toEqual([]);
    yield { type: "done", text: "[1]" };
  };
  async function run(mail: unknown, calendar: unknown, selection = accounts, model = classify) {
    const execute = vi.fn(async (name: string) =>
      name === "gmail.messages.search" ? mail : name === "gmail.threads.get" ? thread : calendar,
    );
    const events = await collect(
      deliverWeekdayBrief(
        sources,
        selection,
        { runId: "run", tools, executeTool: execute } as unknown as AgentRunRequest,
        model,
        new Date("2026-03-08T14:00:00Z"),
      ),
    );
    return { execute, last: events.at(-1) };
  }
  it("uses a DST-local day and renders three source URLs, excluding adjacent events", async () => {
    const { last, execute } = await run({ messages: [{ threadId: "m1" }] }, { items: meetings });
    expect(last).toMatchObject({
      text: expect.stringContaining("[Print order](https://mail.example.test/message)"),
    });
    expect(last).toMatchObject({
      text: expect.stringContaining(
        "10:30–11:00 · [A](https://calendar.example.test/A) / [B](https://calendar.example.test/B)",
      ),
    });
    expect(last).not.toMatchObject({ text: expect.stringContaining("example.test/C") });
    expect(execute).toHaveBeenCalledWith(
      "calendar.events.search",
      expect.objectContaining({
        timeMin: "2026-03-08T05:00:00.000Z",
        timeMax: "2026-03-09T04:00:00.000Z",
        singleEvents: true,
      }),
      expect.any(String),
    );
  });
  it("distinguishes a verified empty day from a revoked mailbox and a partial calendar", async () => {
    expect((await run({ messages: [] }, { items: [] })).last).toMatchObject({
      text: "No replies due or meeting conflicts today.",
    });
    const missing = (await run({ error: "revoked" }, { items: meetings })).last;
    expect(missing).toMatchObject({
      text: expect.stringContaining("Could not check the mailbox."),
    });
    expect(missing).toMatchObject({ text: expect.stringContaining("10:30–11:00") });
    expect((await run({ messages: [] }, { items: [], hasMore: true })).last).toMatchObject({
      text: "Could not check the calendar.",
    });
  });
  it("never reads a sibling account and never turns invalid model text into a clear day", async () => {
    const { last, execute } = await run({ messages: [] }, { items: [] }, [
      { ...accounts[0]!, id: "sibling" },
      accounts[1]!,
    ]);
    expect(last).toMatchObject({ text: "Could not check the mailbox." });
    expect(execute.mock.calls.map((c) => c[0])).toEqual(["calendar.events.search"]);
    const invalid: AgentRuntime["run"] = async function* () {
      yield { type: "done", text: "Visit https://example.test/invented" };
    };
    expect(
      (await run({ messages: [{ threadId: "m1" }] }, { items: [] }, accounts, invalid)).last,
    ).toMatchObject({ text: "Could not check the mailbox." });
  });
});
