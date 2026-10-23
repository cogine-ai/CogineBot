import { BOT_DESCRIPTION_MAX_LENGTH } from "@rakazo/contracts";

type Profile = { description: string; instructions: string };
type ProfilePatch = { description?: string; instructions?: string; expectedInstructions?: string };

/** Compare each draft against its last accepted value; rule whitespace is meaningful. */
export function botProfilePatch(stored: Profile, next: Profile): ProfilePatch {
  return {
    ...(next.description !== stored.description.trim()
      ? { description: next.description.slice(0, BOT_DESCRIPTION_MAX_LENGTH) }
      : {}),
    ...(next.instructions !== stored.instructions
      ? { instructions: next.instructions, expectedInstructions: stored.instructions }
      : {}),
  };
}
