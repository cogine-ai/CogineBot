import {
  createMicrosoftTodoActions,
  createOneDriveActions,
  createSharePointActions,
} from "./files-tasks.js";
import { createOutlookCalendarActions, createOutlookMailActions } from "./outlook.js";
import {
  createExcelActions,
  createPlannerActions,
  createTeamsActions,
} from "./workbook-collaboration.js";

export { MicrosoftAuthorities } from "./auth.js";
export {
  isMicrosoftApp,
  MICROSOFT_APP_METADATA,
  MICROSOFT_EVENTS,
  MICROSOFT_GRAPH_BASE,
  MICROSOFT_IDENTITY_SCOPES,
} from "./metadata.js";
export const microsoftApps = [
  { slug: "outlook-mail", name: "Outlook Mail", actions: createOutlookMailActions() },
  { slug: "outlook-calendar", name: "Outlook Calendar", actions: createOutlookCalendarActions() },
  { slug: "onedrive", name: "OneDrive", actions: createOneDriveActions() },
  { slug: "microsoft-todo", name: "Microsoft To Do", actions: createMicrosoftTodoActions() },
  { slug: "sharepoint", name: "SharePoint", actions: createSharePointActions() },
  { slug: "excel", name: "Excel Graph", actions: createExcelActions() },
  { slug: "planner", name: "Microsoft Planner", actions: createPlannerActions() },
  { slug: "teams", name: "Microsoft Teams", actions: createTeamsActions() },
] as const;

export type {
  MicrosoftEventObservation,
  MicrosoftEventSpec,
  MicrosoftReadApi,
  MicrosoftReadContext,
} from "./readers.js";
export { readMicrosoftEvent } from "./readers.js";
