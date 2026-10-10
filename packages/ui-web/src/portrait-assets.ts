import { avatarIdentitySeed } from "@rakazo/core";

// Same-origin, original portraits. Stable identity picks a subject independently
// of its name, role, model, or transient execution state.
const botPortraits = [
  new URL("./assets/avatars/fox.svg", import.meta.url).href,
  new URL("./assets/avatars/seal.svg", import.meta.url).href,
  new URL("./assets/avatars/cat.svg", import.meta.url).href,
  new URL("./assets/avatars/dinosaur.svg", import.meta.url).href,
  new URL("./assets/avatars/rabbit.svg", import.meta.url).href,
  new URL("./assets/avatars/fluffy.svg", import.meta.url).href,
] as const;

export function botPortraitUrl(identity: string): string {
  return botPortraits[avatarIdentitySeed(identity) % botPortraits.length] ?? botPortraits[0];
}

export const accountPortraitUrl = new URL("./assets/avatars/account.svg", import.meta.url).href;
