import { discordActions } from "./discord.js";
import { telegramActions } from "./telegram.js";
export const botPlatformApps = [
  { slug: "telegram-bot", name: "Telegram Bot", actions: telegramActions },
  { slug: "discord", name: "Discord", actions: discordActions },
] as const;
