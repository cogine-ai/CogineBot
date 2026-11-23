import { createHash } from "node:crypto";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { isApprovalPausedResult } from "./approval-effect.js";

type Account = { id: string; provider: string; displayName: string };
type Setup = {
  text: string;
  timezone?: string | null;
  sources: { mail: Account[]; calendars: Account[] };
  threadId: string;
  runId: string;
  selection?: string;
  execute: NonNullable<AgentRunRequest["executeTool"]>;
};

export function briefSetupChoice(prompt: string) {
  return /^Selected choice (brief-(?:enable|cancel)-[a-f0-9]{16}): /.exec(prompt)?.[1];
}

export async function* weekdayBriefSetup(input: Setup): AsyncGenerator<AgentRuntimeEvent> {
  const zh = /[\u3400-\u9fff]/u.test(input.text);
  const { mail, calendars } = input.sources;
  const selected = (rows: Account[]) => {
    const matches =
      rows.length === 1
        ? rows
        : rows.filter(
            (row) =>
              input.text.includes(row.id) ||
              (row.displayName && input.text.includes(row.displayName)),
          );
    return matches.length === 1 ? matches[0] : undefined;
  };
  const inbox = selected(mail);
  const calendar = selected(calendars);
  const time = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(input.text);
  const hour = Number(time?.[1] ?? 8);
  const minute = Number(time?.[2] ?? 30);
  const at = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const timezone =
    input.text.match(/\b(?:[A-Z][a-zA-Z_+-]+\/)+[A-Za-z_+-]+\b|\bUTC\b/)?.[0] ??
    (/北京时间|北京時間/.test(input.text) ? "Asia/Shanghai" : input.timezone);
  if (!inbox || !calendar) {
    yield {
      type: "done",
      text: zh
        ? "请在连接页选择 Gmail 和 Google Calendar 的原生连接。若有多个账号，在本私聊选中要使用的两个账号后，再打开 /Weekday brief。"
        : "Connect native Gmail and Google Calendar in Apps. If you have multiple accounts, select the two to use in this chat and open /Weekday brief again.",
    };
    return;
  }
  if (!timezone || !validTimezone(timezone)) {
    yield {
      type: "done",
      text: zh
        ? "请重新打开 /Weekday brief，写明时间和时区，例如 08:30 Asia/Shanghai。"
        : "Open /Weekday brief with your local time and timezone, for example 08:30 Europe/London.",
    };
    return;
  }
  const mainCalendar =
    /(?:calendarId|日历ID)\s*[=:：]\s*([^\s，。]+)/i.exec(input.text)?.[1] ?? "primary";
  const binding = {
    mail: inbox.id,
    calendar: calendar.id,
    calendarId: mainCalendar,
    timezone,
    language: zh ? "zh" : "en",
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([input.runId, binding, at]))
    .digest("hex")
    .slice(0, 16);
  const enable = `brief-enable-${fingerprint}`;
  if (input.selection === `brief-cancel-${fingerprint}`) {
    yield { type: "done", text: zh ? "已取消本次设置。" : "Setup cancelled." };
    return;
  }
  const when = zh ? `工作日 ${at}（${timezone}）` : `Weekdays at ${at} (${timezone})`;
  if (input.selection !== enable) {
    yield {
      type: "ask",
      text: zh ? "启用工作日晨报？" : "Enable your weekday brief?",
      detail: [
        when,
        zh
          ? `邮箱：${inbox.displayName}\n日历：${calendar.displayName} (${mainCalendar})`
          : `Mail: ${inbox.displayName}\nCalendar: ${calendar.displayName} (${mainCalendar})`,
        zh
          ? "虚构样例：禾舟询问样册数量，等你回复。10:30–11:00「初稿走读」与「排期会」冲突。"
          : "Fictional sample: River needs your print quantity. Layout review and Planning overlap from 10:30 to 11:00.",
      ].join("\n\n"),
      actions: [
        { id: enable, label: zh ? "确认启用" : "Enable brief" },
        { id: `brief-cancel-${fingerprint}`, label: zh ? "取消" : "Cancel" },
      ],
    };
    return;
  }
  const schedulePrompt = `@Weekday brief\nScheduled delivery. Read the selected inbox and calendar independently and deliver the final brief in this chat.\nBrief sources: ${JSON.stringify(binding)}`;
  const cron = `${minute} ${hour} * * 1-5`;
  const listing = await input.execute("schedule_list", {}, `${input.runId}:brief-list`);
  if (isApprovalPausedResult(listing)) return;
  const rows = (
    listing as {
      routines?: {
        active: boolean;
        threadId: string;
        timezone: string;
        prompt: string;
        crons: string[];
      }[];
    }
  )?.routines;
  if (!Array.isArray(rows)) {
    yield {
      type: "done",
      text: zh ? "没能核对现有例程，请稍后重试。" : "Could not check existing routines. Try again.",
    };
    return;
  }
  const match = rows.some(
    (r) =>
      r.active &&
      r.threadId === input.threadId &&
      r.timezone === timezone &&
      r.prompt === schedulePrompt &&
      r.crons.includes(cron),
  );
  if (!match) {
    const result = await input.execute(
      "schedule_create",
      { name: zh ? "工作日晨报" : "Weekday brief", prompt: schedulePrompt, cron, timezone },
      `${input.runId}:brief-create`,
    );
    if (isApprovalPausedResult(result)) return;
    if (!(result as { ok?: boolean })?.ok || !(result as { nextRunAt?: string })?.nextRunAt) {
      yield {
        type: "done",
        text: zh
          ? "例程创建失败，请在例程里核对后重试。"
          : "Could not create the routine. Check Routines and try again.",
      };
      return;
    }
  }
  yield {
    type: "done",
    text: zh
      ? `已启用工作日晨报。${when}，我会发到本私聊。`
      : `Weekday brief is active. ${when}, in this chat.`,
  };
}

function validTimezone(zone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
