/** Commercial Microsoft Graph only. Application credentials remain instance-owned official/BYO. */
export const MICROSOFT_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
export const MICROSOFT_APP_METADATA = {
  "outlook-mail": {
    name: "Outlook Mail",
    scopes: ["Mail.Read", "Mail.ReadWrite", "Mail.Send"],
    businessOnly: false,
  },
  "outlook-calendar": {
    name: "Outlook Calendar",
    scopes: ["Calendars.ReadBasic", "Calendars.Read", "Calendars.ReadWrite"],
    businessOnly: false,
  },
  onedrive: {
    name: "OneDrive",
    scopes: ["Files.Read", "Files.ReadWrite", "Files.Read.All", "Files.ReadWrite.All"],
    businessOnly: false,
  },
  "microsoft-todo": {
    name: "Microsoft To Do",
    scopes: ["Tasks.Read", "Tasks.ReadWrite"],
    businessOnly: false,
  },
  sharepoint: {
    name: "SharePoint",
    scopes: ["Sites.Read.All", "Sites.ReadWrite.All", "Sites.Selected"],
    businessOnly: true,
  },
  excel: { name: "Excel Graph", scopes: ["Files.ReadWrite"], businessOnly: true },
  planner: {
    name: "Microsoft Planner",
    scopes: ["Tasks.Read", "Tasks.ReadWrite", "Group.Read.All", "Group.ReadWrite.All"],
    businessOnly: true,
  },
  teams: {
    name: "Microsoft Teams",
    scopes: [
      "Team.ReadBasic.All",
      "Channel.ReadBasic.All",
      "ChannelMessage.Read.All",
      "ChannelMessage.Send",
      "Chat.ReadBasic",
      "Chat.Read",
      "Chat.ReadWrite",
      "ChatMessage.Send",
    ],
    businessOnly: true,
  },
} as const;
export type MicrosoftAppId = keyof typeof MICROSOFT_APP_METADATA;
export const isMicrosoftApp = (appId: string): appId is MicrosoftAppId =>
  Object.hasOwn(MICROSOFT_APP_METADATA, appId);
export const MICROSOFT_IDENTITY_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "User.Read",
] as const;
export const MICROSOFT_CREDENTIAL_KINDS = ["oauth"] as const;
export const MICROSOFT_ACTORS = ["user"] as const;
export const MICROSOFT_EVENTS = {
  sharepoint: {
    kind: "sharepoint.list_item.changed",
    scopes: ["Sites.Read.All", "Sites.ReadWrite.All", "Sites.Selected"],
    fields: ["siteId", "listId"],
    api: "/sites/{siteId}/lists/{listId}/items/delta",
    cursor:
      "@odata.deltaLink; page @odata.nextLink before committing deltaLink; deleted item deleted facet (or @removed); token=latest baseline",
    documentation: "https://learn.microsoft.com/en-us/graph/api/listitem-delta?view=graph-rest-1.0",
  },
  excel: {
    kind: "excel.range.changed",
    scopes: ["Files.ReadWrite"],
    fields: ["driveId", "itemId", "worksheetId", "address"],
    api: "/drives/{driveId}/items/{itemId}/workbook/worksheets/{worksheetId}/range(address='{address}')",
    cursor:
      "deterministic sha256 of values+formulas+numberFormat; initial baseline emits no historical event; only selected range; bounded dimensions",
    documentation: "https://learn.microsoft.com/en-us/graph/api/range-get?view=graph-rest-1.0",
  },
  planner: {
    kind: "planner.task.changed",
    scopes: ["Tasks.Read", "Tasks.ReadWrite", "Group.Read.All", "Group.ReadWrite.All"],
    fields: ["planId"],
    api: "/planner/plans/{planId}/tasks",
    cursor:
      "complete paged snapshot keyed id+@odata.etag; initial baseline emits nothing; never infer deletion on incomplete scan; basic plans only",
    documentation:
      "https://learn.microsoft.com/en-us/graph/api/plannerplan-list-tasks?view=graph-rest-1.0",
  },
  teams: {
    kind: "teams.channel_message.created",
    scopes: ["ChannelMessage.Read.All"],
    fields: ["teamId", "channelId"],
    api: "/teams/{teamId}/channels/{channelId}/messages",
    cursor:
      "root messages only; id+createdDateTime dedup; fully page to previous cursor before advancing; channel listing order uses reply lastModified so do not stop on message timestamp alone; bounded scan overflow fails without advancing",
    documentation:
      "https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0",
  },
} as const;
