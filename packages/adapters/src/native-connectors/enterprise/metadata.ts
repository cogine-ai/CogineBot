export const ENTERPRISE_APP_METADATA = {
  "feishu-lark": {
    name: "Feishu / Lark",
    actors: ["app", "user"],
    credentialKinds: ["machine_key", "oauth"],
    scopes: [
      "offline_access",
      "contact:user.base:readonly",
      "tenant:tenant:readonly",
      "docx:document:readonly",
      "docx:document",
      "docx:document:create",
      "task:task:read",
      "task:task:write",
      "calendar:calendar:readonly",
      "calendar:calendar",
      "calendar:calendar.event:read",
      "calendar:calendar.event:create",
      "im:message",
      "im:message:send_as_bot",
      "im:message.send_as_user",
    ],
  },
  dingtalk: {
    name: "DingTalk",
    actors: ["app", "user"],
    credentialKinds: ["machine_key", "oauth"],
    scopes: ["openid", "corpid"],
  },
  wecom: { name: "WeCom", actors: ["app"], credentialKinds: ["machine_key", "oauth"], scopes: [] },
} as const;
export type EnterpriseAppId = keyof typeof ENTERPRISE_APP_METADATA;
export const isEnterpriseApp = (id: string): id is EnterpriseAppId =>
  Object.hasOwn(ENTERPRISE_APP_METADATA, id);
export function enterpriseBase(app: string, region?: string): string {
  if (app === "feishu-lark" && (region === "feishu" || region === "lark"))
    return region === "feishu"
      ? "https://open.feishu.cn/open-apis"
      : "https://open.larksuite.com/open-apis";
  if (app === "dingtalk") return "https://api.dingtalk.com";
  if (app === "wecom") return "https://qyapi.weixin.qq.com/cgi-bin";
  throw new Error("Select an explicit supported enterprise authority and region.");
}
export const ENTERPRISE_EVENTS = {
  "feishu-lark": {
    kind: "feishu.calendar_event.changed",
    fields: ["calendarId"],
    scopes: ["calendar:calendar.event:read", "calendar:calendar:readonly", "calendar:calendar"],
    api: "/calendar/v4/calendars/{calendarId}/events",
    cursor:
      "complete bounded anchor_time=1 calendar snapshot; stable content hash plus persisted observation sequence; initial baseline silent; no deletion inference",
  },
  dingtalk: {
    kind: "dingtalk.calendar_event.changed",
    fields: ["userId", "calendarId", "timeMin", "timeMax"],
    scopes: [],
    api: "/v1.0/calendar/users/{userId}/calendars/{calendarId}/events",
    cursor:
      "complete bounded explicit-window snapshot; event id+updateTime; initial baseline silent; no deletion inference on partial page",
  },
  wecom: {
    kind: "wecom.schedule.changed",
    fields: ["calendarId"],
    scopes: [],
    api: "/oa/schedule/get_by_calendar",
    cursor:
      "complete offset/limit selected-cal_id snapshot until empty page; stable content hash plus persisted observation sequence; initial baseline silent; no deletion inference",
  },
} as const;
