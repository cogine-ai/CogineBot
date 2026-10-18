import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { NativeActionError } from "../action.js";
import type { Data } from "../collaboration-action.js";
import {
  array,
  collaborationActions,
  incomplete,
  object,
  segment,
  select,
  text,
} from "../collaboration-action.js";
import { authorizeBot, safeFilename } from "./action.js";
import contract from "./discord.contract.json" with { type: "json" };
import { publicDiscordMessage } from "./message.js";
import {
  boundTarget,
  channelSnapshot,
  denied,
  discordBot,
  discordTarget,
  id,
  PERMISSIONS,
  requireDiscord,
} from "./permissions.js";

function message(value: unknown, channelId: string, messageId?: unknown): Data {
  const row = object(value);
  if (row.channel_id !== channelId || (messageId !== undefined && row.id !== messageId))
    return incomplete("Discord returned another channel message.");
  id(row.id);
  return row;
}
export const discordActions = collaborationActions(
  contract.actions,
  async (args, run) => {
    const p = run.context.principal,
      c = p.context,
      request = run.request.bind(run),
      bot = await discordBot(request),
      botId = id(bot.id);
    if (botId !== p.subject)
      throw new NativeActionError(
        "authorization_expired",
        "The bot identity changed. Reconnect this account.",
      );
    const applicationId = text(c.applicationId),
      guildId = p.tenant!;
    if (run.definition.id.startsWith("discord.commands.")) {
      const app = object(
        (await run.request({ method: "GET", path: "/oauth2/applications/@me" })).body,
      );
      if (app.id !== applicationId || (app.bot !== undefined && id(object(app.bot).id) !== botId))
        return denied("Discord returned another application.");
      const target = object(array(c.verifiedTargets)[0]);
      boundTarget(p, target.id, "discord");
      await discordTarget(request, botId, guildId, id(target.id));
      const path = `/applications/${segment(applicationId)}/guilds/${segment(guildId)}/commands`;
      const existing = array((await run.request({ method: "GET", path })).body).map((value) => {
        const row = object(value);
        if (row.application_id !== applicationId || row.guild_id !== guildId)
          return incomplete("Discord returned a command outside this application and guild.");
        id(row.id);
        return row;
      });
      if (run.definition.id === "discord.commands.list")
        return run.finish({
          items: existing.map((row) =>
            select(row, [
              "id",
              "application_id",
              "guild_id",
              "type",
              "name",
              "description",
              "options",
              "default_member_permissions",
              "version",
            ]),
          ),
        });
      const options = Array.isArray(args.options) ? args.options.map(object) : [];
      if (
        new Set(options.map((o) => o.name)).size !== options.length ||
        options.some(
          (o, i) =>
            o.required === true && options.slice(0, i).some((prev) => prev.required !== true),
        )
      )
        throw new NativeActionError(
          "invalid_input",
          "Command options need unique names and required options first.",
        );
      const row = object(
        (
          await run.request(
            {
              method: "POST",
              path,
              body: {
                name: args.name,
                description: args.description,
                type: 1,
                options,
                default_member_permissions: args.default_member_permissions ?? "0",
              },
            },
            true,
          )
        ).body,
      );
      if (
        row.application_id !== applicationId ||
        row.guild_id !== guildId ||
        row.name !== args.name ||
        row.type !== 1
      )
        return incomplete("Discord did not confirm this exact guild command.");
      id(row.id);
      return run.finish(
        select(row, [
          "id",
          "application_id",
          "guild_id",
          "type",
          "name",
          "description",
          "options",
          "default_member_permissions",
          "version",
        ]),
        { resource_id: String(row.id) },
      );
    }
    const target = boundTarget(p, args.channel_id, "discord"),
      channelId = target.id,
      proof = await discordTarget(request, botId, guildId, channelId),
      action = run.definition.id,
      path = `/channels/${channelId}/messages`;
    if (action === "discord.channels.get") return run.finish(channelSnapshot(proof.channel));
    if (action === "discord.messages.list") {
      requireDiscord(proof, PERMISSIONS.READ_MESSAGE_HISTORY);
      if (args.before && args.after)
        throw new NativeActionError("invalid_input", "Choose a before or after cursor.");
      const limit = Number(args.limit ?? 30),
        items = array(
          (
            await run.request({
              method: "GET",
              path,
              query: { limit, ...select(args, ["before", "after"]) },
            })
          ).body,
        ).map((row) => message(row, channelId));
      const sorted = items
        .map((row) => id(row.id))
        .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      return run.finish({
        items: items.map((row) => publicDiscordMessage(row)),
        hasMore: items.length === limit,
        nextBefore: items.length === limit ? (sorted[0] ?? null) : null,
        nextAfter: items.length === limit ? (sorted.at(-1) ?? null) : null,
        allPagesRead: false,
        messageContentPolicy: "provider_filtered_fields_preserved",
      });
    }
    if (
      [
        "discord.messages.get",
        "discord.messages.update",
        "discord.messages.delete",
        "discord.attachments.download",
        "discord.reactions.create",
      ].includes(action)
    ) {
      requireDiscord(proof, PERMISSIONS.READ_MESSAGE_HISTORY);
      const current = message(
        (await run.request({ method: "GET", path: `${path}/${segment(args.message_id)}` })).body,
        channelId,
        args.message_id,
      );
      if (action === "discord.messages.get") return run.finish(publicDiscordMessage(current));
      if (action === "discord.attachments.download") {
        if (!run.context.downloadResource || !run.context.writeArtifact)
          throw new NativeActionError(
            "not_configured",
            "Private attachment storage is unavailable.",
          );
        const matches = array(current.attachments)
          .map(object)
          .filter((a) => a.id === args.attachment_id);
        if (matches.length !== 1)
          return denied("This attachment is not on the selected channel message.");
        const file = matches[0]!;
        let url: URL;
        try {
          url = new URL(text(file.url));
        } catch {
          return incomplete("Discord returned an invalid attachment URL.");
        }
        if (
          url.origin !== "https://cdn.discordapp.com" ||
          !url.pathname.startsWith(`/attachments/${channelId}/${String(args.attachment_id)}/`)
        )
          return denied("Discord returned a file outside the verified channel attachment.");
        if (typeof file.size !== "number" || file.size < 0 || file.size > ATTACHMENT_MAX_BYTES)
          throw new NativeActionError(
            "invalid_input",
            "The attachment exceeds the supported file size.",
          );
        const downloaded = await run.context.downloadResource({
          url: url.toString(),
          maxBytes: ATTACHMENT_MAX_BYTES,
        });
        if (downloaded.bytes.byteLength !== file.size)
          return incomplete("The attachment size did not match its verified message metadata.");
        const artifact = await run.context.writeArtifact({
          bytes: downloaded.bytes,
          name: safeFilename(text(file.filename)),
          mimeType: downloaded.mimeType,
        });
        return run.finish({
          channel_id: channelId,
          message_id: args.message_id,
          attachment_id: args.attachment_id,
          artifact,
        });
      }
      if (action === "discord.messages.update") {
        if (id(object(current.author).id) !== botId)
          return denied("This bot may edit only its own messages.");
        requireDiscord(
          proof,
          [10, 11, 12].includes(Number(proof.channel.type))
            ? PERMISSIONS.SEND_MESSAGES_IN_THREADS
            : PERMISSIONS.SEND_MESSAGES,
          true,
        );
        const updated = message(
          (
            await run.request(
              {
                method: "PATCH",
                path: `${path}/${segment(args.message_id)}`,
                body: { content: args.content, allowed_mentions: { parse: [] } },
              },
              true,
            )
          ).body,
          channelId,
          args.message_id,
        );
        if (id(object(updated.author).id) !== botId)
          return incomplete("Discord returned another message author.");
        return run.finish(publicDiscordMessage(updated), {
          resource_id: String(updated.id),
          channel: channelId,
        });
      }
      if (action === "discord.messages.delete") {
        if (id(object(current.author).id) !== botId)
          requireDiscord(proof, PERMISSIONS.MANAGE_MESSAGES, true);
        const deleted = await run.request(
          { method: "DELETE", path: `${path}/${segment(args.message_id)}` },
          true,
        );
        if (deleted.status !== 204)
          return incomplete("Discord omitted the deletion acknowledgement.");
        return run.finish(
          { channel_id: channelId, message_id: args.message_id, deleted: true },
          { resource_id: String(args.message_id), channel: channelId },
        );
      }
      const existingEmoji = (current.reactions === undefined ? [] : array(current.reactions))
        .map(object)
        .some((reaction) => {
          if (
            typeof reaction.count !== "number" ||
            !Number.isSafeInteger(reaction.count) ||
            reaction.count < 1
          )
            return false;
          const emoji = object(reaction.emoji);
          return (
            (emoji.id === null && emoji.name === args.emoji) ||
            (typeof emoji.id === "string" &&
              typeof emoji.name === "string" &&
              `${emoji.name}:${emoji.id}` === args.emoji)
          );
        });
      requireDiscord(
        proof,
        existingEmoji ? PERMISSIONS.VIEW_CHANNEL : PERMISSIONS.ADD_REACTIONS,
        true,
      );
      const reacted = await run.request(
        {
          method: "PUT",
          path: `${path}/${segment(args.message_id)}/reactions/${segment(args.emoji)}/@me`,
        },
        true,
      );
      if (reacted.status !== 204)
        return incomplete("Discord omitted the reaction acknowledgement.");
      return run.finish(
        { channel_id: channelId, message_id: args.message_id, reaction_added: true },
        { resource_id: String(args.message_id), channel: channelId },
      );
    }
    requireDiscord(
      proof,
      [10, 11, 12].includes(Number(proof.channel.type))
        ? PERMISSIONS.SEND_MESSAGES_IN_THREADS
        : PERMISSIONS.SEND_MESSAGES,
      true,
    );
    const data: Data = {
      content: args.content,
      allowed_mentions: { parse: [] },
      ...(args.reply_to
        ? {
            message_reference: {
              message_id: args.reply_to,
              channel_id: channelId,
              guild_id: guildId,
              fail_if_not_exists: true,
            },
          }
        : {}),
    };
    let body: unknown = data;
    if (args.artifactId) {
      if (!p.capabilities.includes("files"))
        return denied("File sending is not enabled for this connection.");
      requireDiscord(proof, PERMISSIONS.ATTACH_FILES, true);
      const file = await run.context.readArtifact(String(args.artifactId));
      if (!file.bytes.byteLength || file.bytes.byteLength > ATTACHMENT_MAX_BYTES)
        throw new NativeActionError(
          "invalid_input",
          "Choose a nonempty file within the size limit.",
        );
      const name = safeFilename(file.name);
      data.attachments = [{ id: 0, filename: name }];
      const form = new FormData();
      form.set("payload_json", JSON.stringify(data));
      form.set("files[0]", new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), name);
      body = form;
    }
    const sent = message((await run.request({ method: "POST", path, body }, true)).body, channelId);
    if (id(object(sent.author).id) !== botId)
      return incomplete("Discord returned another message author.");
    return run.finish(publicDiscordMessage(sent), {
      resource_id: String(sent.id),
      channel: channelId,
    });
  },
  authorizeBot,
);
