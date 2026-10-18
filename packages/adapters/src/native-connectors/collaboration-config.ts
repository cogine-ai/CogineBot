/** Fixed protocol scopes. GitHub App permissions are not OAuth scope strings. */
export const COLLABORATION_SCOPES: Record<string, readonly string[]> = {
  github: ["offline_access"],
  linear: ["read", "write", "issues:create", "comments:create"],
  slack: [
    "users:read",
    "users:read.email",
    "app_mentions:read",
    "channels:read",
    "groups:read",
    "im:read",
    "mpim:read",
    "channels:history",
    "groups:history",
    "im:history",
    "mpim:history",
    "search:read",
    "chat:write",
    "chat:write.public",
    "im:write",
    "mpim:write",
    "reactions:write",
    "files:write",
    "files:read",
  ],
};
export const SLACK_POLICY_CAPABILITIES = new Set([
  "slack_user_data_allowed",
  "slack_legacy_search_allowed",
]);
