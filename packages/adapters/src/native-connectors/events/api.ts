import type {
  NativeEventScope,
  NativeRoutineTrigger,
  PreparedNativeRoutineTrigger,
} from "@rakazo/contracts";
import {
  NativeRoutineTriggersInputSchema,
  RemoveNativeRoutineTriggerInputSchema,
  SaveNativeRoutineTriggerInputSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { NativeEventResourceVerifier } from "./resource-verifier.js";
import {
  listNativeRoutineTriggers,
  removeNativeRoutineTrigger,
  requireNativeEventRoutineOwner,
  saveNativeRoutineTrigger,
} from "./store.js";

const ownerScope = (scope: NativeEventScope): NativeEventScope => ({
  userId: scope.userId,
  spaceId: scope.spaceId,
});

/** The API actor supplies scope. Input never contains owner, auth revision, grants, cursor or proof. */
export class NativeRoutineEventApi {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly verifier: Pick<NativeEventResourceVerifier, "prepare">,
  ) {}
  list(scope: NativeEventScope, routineId: string): Promise<NativeRoutineTrigger[]> {
    return listNativeRoutineTriggers(this.prisma, ownerScope(scope), routineId);
  }
  async save(
    actor: NativeEventScope,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<NativeRoutineTrigger> {
    const scope = ownerScope(actor);
    const { routineId, ...input } = SaveNativeRoutineTriggerInputSchema.parse(raw);
    await requireNativeEventRoutineOwner(this.prisma, scope, routineId);
    const prepared = await this.verifier.prepare(scope, input, signal);
    return saveNativeRoutineTrigger(this.prisma, scope, routineId, prepared);
  }
  remove(scope: NativeEventScope, raw: unknown): Promise<void> {
    return removeNativeRoutineTrigger(
      this.prisma,
      ownerScope(scope),
      RemoveNativeRoutineTriggerInputSchema.parse(raw),
    );
  }
  /**
   * Existing routines.create/update call this BEFORE a transaction. Inside that same transaction:
   * ordinary Routine write -> replaceNativeRoutineTriggersTx(tx,...,prepared).
   * undefined means preserve existing native triggers; [] means explicitly remove all.
   * Resource verification stays outside SQL locks. The store rechecks current authorization under locks.
   */
  async prepareForRoutineMutation(
    actor: NativeEventScope,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<PreparedNativeRoutineTrigger[] | undefined> {
    const scope = ownerScope(actor);
    if (raw === undefined) return undefined;
    const inputs = NativeRoutineTriggersInputSchema.parse(raw);
    const prepared: PreparedNativeRoutineTrigger[] = [];
    for (const input of inputs) prepared.push(await this.verifier.prepare(scope, input, signal));
    return prepared;
  }
}
