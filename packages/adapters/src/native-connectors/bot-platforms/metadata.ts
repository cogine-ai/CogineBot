export const BOT_PLATFORM_DEFAULT_CAPABILITIES = [
  "read",
  "send",
  "edit",
  "delete",
  "reactions",
  "files",
] as const;
export const BOT_PLATFORM_CAPABILITIES = [
  ...BOT_PLATFORM_DEFAULT_CAPABILITIES,
  "commands",
] as const;
export const BOT_PLATFORM_METADATA = {
  "telegram-bot": {
    name: "Telegram Bot",
    baseUrl: "https://api.telegram.org",
    credentialKind: "bot_token",
    authKinds: ["bot_token"],
    scopes: [],
    actor: "bot",
    capabilities: BOT_PLATFORM_DEFAULT_CAPABILITIES,
    target: "fixed signed decimal chat ID",
    inbound: "existing single consumer only",
  },
  discord: {
    name: "Discord",
    baseUrl: "https://discord.com/api/v10",
    credentialKind: "bot_token",
    authKinds: ["bot_token"],
    scopes: [],
    actor: "bot",
    capabilities: BOT_PLATFORM_CAPABILITIES,
    target: "fixed channel snowflake in the configured guild",
    inbound: "existing single consumer only",
  },
} as const;
export type BotPlatformApp = keyof typeof BOT_PLATFORM_METADATA;
export const isBotPlatformApp = (app: string): app is BotPlatformApp =>
  Object.hasOwn(BOT_PLATFORM_METADATA, app);
