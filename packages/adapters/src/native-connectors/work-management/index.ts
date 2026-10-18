import { asanaActions } from "./asana.js";
import { confluenceActions } from "./confluence.js";
import { gitlabActions } from "./gitlab.js";
import { jiraActions } from "./jira.js";
import { todoistActions } from "./todoist.js";
import { trelloActions } from "./trello.js";

export const workManagementApps = [
  { slug: "gitlab", name: "GitLab", actions: gitlabActions },
  { slug: "jira", name: "Jira Cloud", actions: jiraActions },
  { slug: "confluence", name: "Confluence Cloud", actions: confluenceActions },
  { slug: "todoist", name: "Todoist", actions: todoistActions },
  { slug: "trello", name: "Trello", actions: trelloActions },
  { slug: "asana", name: "Asana", actions: asanaActions },
] as const;
