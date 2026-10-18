import { z } from "zod";

export const NativeMicrosoftAppIdSchema = z.enum([
  "outlook-mail",
  "outlook-calendar",
  "onedrive",
  "microsoft-todo",
  "sharepoint",
  "excel",
  "planner",
  "teams",
]);
export const NativeWorkManagementAppIdSchema = z.enum([
  "gitlab",
  "jira",
  "confluence",
  "todoist",
  "trello",
  "asana",
]);
export const NativeBusinessFilesAppIdSchema = z.enum([
  "clickup",
  "airtable",
  "dropbox",
  "hubspot",
  "figma",
]);
export const NativeEnterpriseAppIdSchema = z.enum([
  "feishu-lark",
  "dingtalk",
  "wecom",
  "telegram-bot",
  "discord",
]);
export const NativeRemainingAppIdSchema = z.enum([
  ...NativeMicrosoftAppIdSchema.options,
  ...NativeWorkManagementAppIdSchema.options,
  ...NativeBusinessFilesAppIdSchema.options,
  ...NativeEnterpriseAppIdSchema.options,
]);
export const NATIVE_REMAINING_APPLICATIONS = [
  { id: "outlook-mail", name: "Outlook Mail" },
  { id: "outlook-calendar", name: "Outlook Calendar" },
  { id: "onedrive", name: "OneDrive" },
  { id: "microsoft-todo", name: "Microsoft To Do" },
  { id: "sharepoint", name: "SharePoint" },
  { id: "excel", name: "Excel Graph" },
  { id: "planner", name: "Microsoft Planner" },
  { id: "teams", name: "Microsoft Teams" },
  { id: "gitlab", name: "GitLab" },
  { id: "jira", name: "Jira Cloud" },
  { id: "confluence", name: "Confluence Cloud" },
  { id: "todoist", name: "Todoist" },
  { id: "trello", name: "Trello" },
  { id: "asana", name: "Asana" },
  { id: "clickup", name: "ClickUp" },
  { id: "airtable", name: "Airtable" },
  { id: "dropbox", name: "Dropbox" },
  { id: "hubspot", name: "HubSpot" },
  { id: "figma", name: "Figma" },
  { id: "feishu-lark", name: "飞书 / Lark" },
  { id: "dingtalk", name: "钉钉" },
  { id: "wecom", name: "企业微信" },
  { id: "telegram-bot", name: "Telegram Bot" },
  { id: "discord", name: "Discord" },
] as const;
