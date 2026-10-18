import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { NativeActionError } from "../action.js";
import { collaborationActions, incomplete, object, select } from "../collaboration-action.js";
import { authorizeBot, keyboard, messageNumber, safeFilename } from "./action.js";
import {
  boundTarget,
  id,
  telegramBot,
  telegramPermission,
  telegramResult,
  telegramTarget,
} from "./permissions.js";
import contract from "./telegram-bot.contract.json" with { type: "json" };

export const telegramActions = collaborationActions(
  contract.actions,
  async (args, run) => {
    const chatId = boundTarget(run.context.principal, args.chat_id, "telegram-bot").id;
    const request = run.request.bind(run),
      bot = await telegramBot(request),
      botId = id(bot.id);
    if (botId !== run.context.principal.subject)
      throw new NativeActionError(
        "authorization_expired",
        "The bot identity changed. Reconnect this account.",
      );
    const proof = await telegramTarget(request, botId, chatId),
      action = run.definition.id;
    if (action === "telegram.chats.get")
      return run.finish(
        select(proof.chat, [
          "id",
          "type",
          "title",
          "username",
          "first_name",
          "last_name",
          "description",
          "permissions",
          "available_reactions",
        ]),
      );
    if (action === "telegram.pinned.get") {
      const pinned =
        proof.chat.pinned_message === undefined ? null : object(proof.chat.pinned_message);
      if (pinned && (id(object(pinned.chat).id) !== chatId || !messageNumber(pinned.message_id)))
        return incomplete("Telegram returned another pinned message target.");
      return run.finish({
        chat_id: chatId,
        pinned_message: pinned,
        historyAvailable: false,
      });
    }
    const operation =
      action === "telegram.files.send"
        ? "files"
        : action === "telegram.messages.edit"
          ? "edit"
          : action === "telegram.messages.delete"
            ? "delete"
            : action === "telegram.messages.react"
              ? "reactions"
              : "send";
    telegramPermission(proof, operation);
    if (operation === "delete" || operation === "reactions") {
      const body =
        operation === "delete"
          ? { chat_id: chatId, message_id: args.message_id }
          : {
              chat_id: chatId,
              message_id: args.message_id,
              reaction: [{ type: "emoji", emoji: args.emoji }],
            };
      const result = telegramResult(
        await run.request(
          {
            method: "POST",
            path: operation === "delete" ? "/deleteMessage" : "/setMessageReaction",
            body,
          },
          true,
        ),
      );
      if (result !== true) return incomplete("Telegram did not confirm this message operation.");
      return run.finish(
        {
          chat_id: chatId,
          message_id: args.message_id,
          ...(operation === "delete" ? { deleted: true } : { reaction_set: true }),
        },
        { resource_id: String(args.message_id), channel: chatId },
      );
    }
    let body: unknown,
      path = "/sendMessage";
    if (operation === "files") {
      const artifact = await run.context.readArtifact(String(args.artifactId));
      if (!artifact.bytes.byteLength || artifact.bytes.byteLength > ATTACHMENT_MAX_BYTES)
        throw new NativeActionError(
          "invalid_input",
          "Choose a nonempty file within the attachment size limit.",
        );
      const form = new FormData();
      form.set("chat_id", chatId);
      if (args.caption) form.set("caption", String(args.caption));
      form.set(
        "document",
        new Blob([new Uint8Array(artifact.bytes)], { type: artifact.mimeType }),
        safeFilename(artifact.name),
      );
      body = form;
      path = "/sendDocument";
    } else if (operation === "edit") {
      path = "/editMessageText";
      body = {
        chat_id: chatId,
        message_id: args.message_id,
        text: args.text,
        ...(args.buttons ? { reply_markup: keyboard(args.buttons) } : {}),
      };
    } else
      body = {
        chat_id: chatId,
        text: args.text,
        ...select(args, ["disable_notification"]),
        ...(action === "telegram.messages.reply"
          ? {
              reply_parameters: {
                message_id: args.message_id,
                chat_id: chatId,
                allow_sending_without_reply: false,
              },
            }
          : {}),
        ...(args.buttons ? { reply_markup: keyboard(args.buttons) } : {}),
      };
    const message = object(telegramResult(await run.request({ method: "POST", path, body }, true)));
    if (id(object(message.chat).id) !== chatId || !messageNumber(message.message_id))
      return incomplete("Telegram omitted the exact target message identity.");
    if (proof.chat.type !== "channel" && id(object(message.from).id) !== botId)
      return incomplete("Telegram returned a message from another actor.");
    if (operation === "edit" && message.message_id !== args.message_id)
      return incomplete("Telegram returned another edited message.");
    return run.finish(
      select(message, [
        "message_id",
        "date",
        "edit_date",
        "chat",
        "from",
        "text",
        "caption",
        "document",
        "reply_to_message",
        "reply_markup",
      ]),
      { resource_id: String(message.message_id), channel: chatId },
    );
  },
  authorizeBot,
);
