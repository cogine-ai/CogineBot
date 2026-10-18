import type { Data } from "../collaboration-action.js";
import { array, object, select } from "../collaboration-action.js";

const user = (value: unknown): Data =>
  select(object(value), ["id", "username", "global_name", "bot"]);
const attachment = (value: unknown): Data =>
  select(object(value), [
    "id",
    "filename",
    "description",
    "size",
    "content_type",
    "width",
    "height",
    "ephemeral",
    "duration_secs",
    "waveform",
  ]);
function embed(value: unknown): Data {
  const row = object(value),
    result = select(row, ["type", "title", "description", "color", "timestamp"]);
  if (row.fields !== undefined)
    result.fields = array(row.fields).map((value) =>
      select(object(value), ["name", "value", "inline"]),
    );
  if (row.author !== undefined) result.author = select(object(row.author), ["name"]);
  if (row.footer !== undefined) result.footer = select(object(row.footer), ["text"]);
  for (const key of ["image", "thumbnail", "video"])
    if (row[key] !== undefined)
      result[key] = select(object(row[key]), ["width", "height", "content_type"]);
  return result;
}
/** Public message facts. Signed download URLs remain only in the private API response. */
export function publicDiscordMessage(row: Data, depth = 0): Data {
  const result = select(row, [
    "id",
    "channel_id",
    "content",
    "timestamp",
    "edited_timestamp",
    "type",
    "flags",
  ]);
  if (row.author !== undefined) result.author = user(row.author);
  if (row.attachments !== undefined) result.attachments = array(row.attachments).map(attachment);
  if (row.embeds !== undefined) result.embeds = array(row.embeds).map(embed);
  if (row.mentions !== undefined) result.mentions = array(row.mentions).map(user);
  if (row.reactions !== undefined)
    result.reactions = array(row.reactions).map((value) => {
      const reaction = object(value),
        out = select(reaction, ["count", "me", "me_burst"]);
      if (reaction.count_details !== undefined)
        out.count_details = select(object(reaction.count_details), ["burst", "normal"]);
      if (reaction.emoji !== undefined)
        out.emoji = select(object(reaction.emoji), ["id", "name", "animated"]);
      return out;
    });
  if (row.message_reference !== undefined)
    result.message_reference = select(object(row.message_reference), [
      "type",
      "message_id",
      "channel_id",
      "guild_id",
    ]);
  if (row.referenced_message === null) result.referenced_message = null;
  else if (row.referenced_message !== undefined && depth < 3) {
    const reference = object(row.referenced_message);
    // A reply preview never expands the owner's channel allowlist.
    if (reference.channel_id === row.channel_id)
      result.referenced_message = publicDiscordMessage(reference, depth + 1);
  }
  return result;
}
