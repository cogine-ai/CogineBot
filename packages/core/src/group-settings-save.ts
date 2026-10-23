export type GroupSettingsSaveInput = {
  name?: string;
  botIds?: string[];
  expectedBotIds?: string[];
};

type SavedGroup = {
  id: string;
  spaceId?: string;
  name: string;
  members: readonly { botId: string }[];
};

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/** Keeps an uncertain save tied to its original editor and compare-and-swap input. */
export function createGroupSettingsSave<TGroup extends SavedGroup>(options: {
  group: TGroup;
  update: (input: GroupSettingsSaveInput) => Promise<TGroup>;
  read: () => Promise<TGroup>;
  isCurrent: () => boolean;
  isAmbiguous: (error: unknown) => boolean;
}): (input: GroupSettingsSaveInput) => Promise<TGroup> {
  const original = {
    id: options.group.id,
    spaceId: options.group.spaceId,
    botIds: options.group.members.map((member) => member.botId),
  };
  type Intent = {
    input: GroupSettingsSaveInput;
    name?: string;
    botIds: string[];
    expectedBotIds: string[];
    error?: unknown;
    blocked: boolean;
  };
  let uncertain: Intent | undefined;
  let busy = false;
  const assertCurrent = () => {
    if (!options.isCurrent()) throw new Error("GROUP_SETTINGS_CLOSED");
  };
  const intentFor = (input: GroupSettingsSaveInput): Intent => ({
    input: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.botIds === undefined ? {} : { botIds: [...input.botIds] }),
      ...(input.expectedBotIds === undefined ? {} : { expectedBotIds: [...input.expectedBotIds] }),
    },
    name: input.name?.trim(),
    botIds: [...(input.botIds ?? original.botIds)],
    expectedBotIds: [...(input.expectedBotIds ?? original.botIds)],
    blocked: false,
  });
  const validGroup = (group: TGroup | undefined): group is TGroup =>
    group?.id === original.id &&
    (original.spaceId === undefined || group.spaceId === original.spaceId) &&
    typeof group.name === "string" &&
    Array.isArray(group.members) &&
    group.members.every((member) => typeof member?.botId === "string");
  const desired = (group: TGroup | undefined, intent: Intent): boolean =>
    validGroup(group) &&
    (intent.name === undefined || group.name === intent.name) &&
    (intent.input.botIds === undefined ||
      sameIds(
        group.members.map((member) => member.botId),
        intent.botIds,
      ));
  const readReceipt = async (intent: Intent): Promise<TGroup | null> => {
    assertCurrent();
    let group: TGroup;
    try {
      group = await options.read();
    } catch {
      assertCurrent();
      throw intent.error;
    }
    assertCurrent();
    if (desired(group, intent)) {
      uncertain = undefined;
      return group;
    }
    if (!validGroup(group)) throw intent.error;
    if (
      (intent.input.botIds !== undefined || intent.input.expectedBotIds !== undefined) &&
      !sameIds(
        group.members.map((member) => member.botId),
        intent.expectedBotIds,
      )
    )
      intent.blocked = true;
    return null;
  };
  const write = async (intent: Intent): Promise<TGroup> => {
    assertCurrent();
    try {
      const group = await options.update(intent.input);
      assertCurrent();
      if (!desired(group, intent)) throw new TypeError("INVALID_GROUP_SAVE_RECEIPT");
      uncertain = undefined;
      return group;
    } catch (error) {
      assertCurrent();
      if (!options.isAmbiguous(error)) {
        if (uncertain === intent) {
          intent.blocked = true;
          intent.error = error;
        }
        throw error;
      }
      intent.error = error;
      uncertain = intent;
      const receipt = await readReceipt(intent);
      if (receipt) return receipt;
      throw error;
    }
  };
  return async (input) => {
    assertCurrent();
    if (busy) throw new Error("GROUP_SETTINGS_SAVE_PENDING");
    busy = true;
    try {
      const next = intentFor(input);
      if (!uncertain) return await write(next);
      const intent = uncertain;
      if (
        intent.blocked ||
        intent.name !== next.name ||
        !sameIds(intent.botIds, next.botIds) ||
        !sameIds(intent.expectedBotIds, next.expectedBotIds)
      )
        throw intent.error;
      const receipt = await readReceipt(intent);
      if (receipt) return receipt;
      if (intent.blocked) throw intent.error;
      return await write(intent);
    } finally {
      busy = false;
    }
  };
}
