import type { Bot, BotCreationDraft, BotTemplateSelection } from "@rakazo/contracts";
import {
  BOT_CREATION_SPAWN_KEY_PREFIX,
  BotSchema,
  CreateBotInput,
  getBotTemplate,
  isBotCreationSpawnKey,
} from "@rakazo/contracts";

export type BotCreationSubmission = Readonly<{
  draft: BotCreationDraft;
  draftVersion: number;
  template: BotTemplateSelection | null;
}>;
export type BotCreationReceipt = Readonly<{
  bot: Bot;
  submitted: BotCreationSubmission;
  spawnKey: string;
  exampleNonce: string | null;
  source: "created" | "recovered";
}>;
export type BotCreationStatus = "idle" | "pending" | "unknown" | "confirmed";
export type BotCreationErrorCode =
  | "pending"
  | "closed"
  | "invalid_receipt"
  | "unknown"
  | "archived_recovery";
export class BotCreationError extends Error {
  constructor(
    readonly code: BotCreationErrorCode,
    options?: ErrorOptions,
  ) {
    super(`BOT_CREATION_${code.toUpperCase()}`, options);
    this.name = "BotCreationError";
  }
}

/** Binds retries to the original creation snapshot and authenticated editor. */
export function createBotCreation(options: {
  spaceId: string;
  create(input: CreateBotInput): Promise<Bot>;
  list(): Promise<readonly Bot[]>;
  makeNonce(): string;
  isCurrent(): boolean;
  isAmbiguous(error: unknown): boolean;
}): {
  status(): BotCreationStatus;
  submit(input: BotCreationSubmission): Promise<BotCreationReceipt>;
  startAnother(): void;
} {
  type Intent = {
    submitted: BotCreationSubmission;
    payload: CreateBotInput;
    spawnKey: string;
    exampleNonce: string | null;
    uncertain: boolean;
  };
  let busy = false;
  let closed = false;
  let intent: Intent | undefined;
  let confirmed: BotCreationReceipt | undefined;
  let archived: BotCreationError | undefined;
  const assertCurrent = () => {
    if (closed || !options.isCurrent()) {
      closed = true;
      throw new BotCreationError("closed");
    }
  };
  const unknown = (cause?: unknown) => new BotCreationError("unknown", { cause });
  const confirm = (response: unknown, active: Intent, source: BotCreationReceipt["source"]) => {
    const parsed = BotSchema.safeParse(response);
    if (
      !parsed.success ||
      parsed.data.spaceId !== options.spaceId ||
      parsed.data.spawnKey !== active.spawnKey
    )
      throw new BotCreationError("invalid_receipt");
    if (parsed.data.archivedAt !== null) {
      archived = new BotCreationError("archived_recovery");
      throw archived;
    }
    confirmed = Object.freeze({
      bot: parsed.data,
      submitted: active.submitted,
      spawnKey: active.spawnKey,
      exampleNonce: active.exampleNonce,
      source,
    });
    return confirmed;
  };
  const readReceipt = async (active: Intent): Promise<BotCreationReceipt | null> => {
    assertCurrent();
    let rows: readonly Bot[];
    try {
      rows = await options.list();
    } catch (error) {
      assertCurrent();
      throw unknown(error);
    }
    assertCurrent();
    if (!Array.isArray(rows)) throw unknown(new BotCreationError("invalid_receipt"));
    const valid: Bot[] = [];
    for (const row of rows) {
      const parsed = BotSchema.safeParse(row);
      if (!parsed.success || parsed.data.spaceId !== options.spaceId)
        throw unknown(new BotCreationError("invalid_receipt"));
      valid.push(parsed.data);
    }
    const matches = valid.filter((row) => row.spawnKey === active.spawnKey);
    if (matches.length > 1) throw unknown(new BotCreationError("invalid_receipt"));
    if (!matches.length) return null;
    return confirm(matches[0], active, "recovered");
  };
  const write = async (active: Intent): Promise<BotCreationReceipt> => {
    assertCurrent();
    try {
      const response = await options.create(active.payload);
      assertCurrent();
      return confirm(response, active, active.uncertain ? "recovered" : "created");
    } catch (error) {
      assertCurrent();
      if (archived) throw archived;
      let definitelyUnwritten = false;
      if (!(error instanceof BotCreationError) && !active.uncertain) {
        try {
          definitelyUnwritten = !options.isAmbiguous(error);
        } catch {
          // An unrecognized error cannot prove that no write occurred.
        }
      }
      if (definitelyUnwritten) {
        intent = undefined;
        throw error;
      }
      active.uncertain = true;
      const receipt = await readReceipt(active);
      if (receipt) return receipt;
      throw unknown(error);
    }
  };
  return {
    status: () =>
      busy
        ? "pending"
        : confirmed || archived
          ? "confirmed"
          : intent?.uncertain
            ? "unknown"
            : "idle",
    async submit(input) {
      assertCurrent();
      if (busy) throw new BotCreationError("pending");
      if (archived) throw archived;
      if (confirmed) return confirmed;
      busy = true;
      try {
        if (intent) {
          const receipt = await readReceipt(intent);
          if (receipt) return receipt;
          return await write(intent);
        }
        if (!Number.isSafeInteger(input.draftVersion) || input.draftVersion < 0)
          throw new TypeError("INVALID_BOT_DRAFT_VERSION");
        if (input.template && !getBotTemplate(input.template.templateId, input.template.version))
          throw new TypeError("INVALID_BOT_TEMPLATE");
        if (typeof input.draft.instructions !== "string")
          throw new TypeError("INVALID_BOT_INSTRUCTIONS");
        const parsedDraft = CreateBotInput.parse(input.draft);
        const submitted: BotCreationSubmission = Object.freeze({
          draft: Object.freeze({
            name: input.draft.name,
            title: input.draft.title,
            description: input.draft.description,
            instructions: input.draft.instructions,
            notifyOnFinish: input.draft.notifyOnFinish,
            computerMode: input.draft.computerMode,
          }),
          draftVersion: input.draftVersion,
          template: input.template
            ? Object.freeze({
                templateId: input.template.templateId,
                version: input.template.version,
              })
            : null,
        });
        const spawnKey = `${BOT_CREATION_SPAWN_KEY_PREFIX}${options.makeNonce()}`;
        if (!isBotCreationSpawnKey(spawnKey) || spawnKey.trim() !== spawnKey)
          throw new TypeError("INVALID_BOT_CREATION_NONCE");
        const payload = Object.freeze(CreateBotInput.parse({ ...parsedDraft, spawnKey }));
        const exampleNonce = submitted.template ? `bot-example:${options.makeNonce()}` : null;
        intent = { submitted, payload, spawnKey, exampleNonce, uncertain: false };
        return await write(intent);
      } finally {
        busy = false;
      }
    },
    startAnother() {
      assertCurrent();
      if (busy) throw new BotCreationError("pending");
      if (!confirmed && !archived) throw unknown();
      confirmed = undefined;
      archived = undefined;
      intent = undefined;
    },
  };
}
