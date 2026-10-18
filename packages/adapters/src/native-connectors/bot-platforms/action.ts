import type { NativeActionContext } from "../action.js";
import { NativeActionError } from "../action.js";
import type { CollaborationDefinition, Data } from "../collaboration-action.js";
import { array, object, text } from "../collaboration-action.js";

export interface BotDefinition extends CollaborationDefinition {
  requiredCapabilities: string[];
}
export function authorizeBot(
  def: CollaborationDefinition,
  context: Pick<NativeActionContext, "principal">,
): void {
  const p = context.principal,
    c = p.context;
  if (
    c.actorType !== "bot" ||
    c.credentialType !== "bot_token" ||
    c.botId !== p.subject ||
    c.scopeAuthority !== "provider_enforced" ||
    !c.boundSpaceId ||
    !array(c.verifiedTargets).length
  )
    throw new NativeActionError(
      "authorization_required",
      "Select a verified bot bound to this space.",
    );
  if (def.id.startsWith("discord.") && (!p.tenant || c.bindingNamespace !== "guild"))
    throw new NativeActionError(
      "authorization_required",
      "Select this space's verified guild installation.",
    );
  if (
    array(object(def).requiredCapabilities).some(
      (cap) => typeof cap !== "string" || !p.capabilities.includes(cap),
    )
  )
    throw new NativeActionError(
      "insufficient_scope",
      "This bot connection has not enabled the requested operation.",
    );
}
export function keyboard(value: unknown): Data | undefined {
  if (value === undefined) return undefined;
  const rows = array(value).map((row) =>
    array(row).map((button) => {
      const b = object(button);
      let url: URL;
      try {
        url = new URL(text(b.url));
      } catch {
        throw new NativeActionError("invalid_input", "Enter a valid HTTPS button URL.");
      }
      if (url.protocol !== "https:" || url.username || url.password)
        throw new NativeActionError(
          "invalid_input",
          "Buttons require HTTPS URLs without credentials.",
        );
      return { text: text(b.text), url: url.toString() };
    }),
  );
  return { inline_keyboard: rows };
}
export function messageNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return 0;
  return value;
}

export function safeFilename(value: string): string {
  return (
    Array.from(value)
      .map((char) => (char === "/" || char === "\\" || char.charCodeAt(0) < 32 ? "_" : char))
      .join("")
      .slice(0, 200) || "attachment"
  );
}
