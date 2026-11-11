type AskSnapshot = {
  messages: readonly {
    id: string;
    runId?: string | null;
    blocks: readonly { kind: string; status?: string }[];
  }[];
  run?: { id: string; status: string } | null;
  activeRuns?: readonly { id: string; status: string }[];
};

type LoginAnswerMessage = {
  id: string;
  runId?: string | null;
  blocks: readonly { kind: string; status?: string; loginRequestEffectId?: string }[];
};

function hasWebsiteLoginAnswer(
  original: LoginAnswerMessage,
  messages: readonly LoginAnswerMessage[],
): boolean {
  const request = original.blocks.find(
    (block) => block.kind === "ask" && block.status !== "answered" && block.loginRequestEffectId,
  )?.loginRequestEffectId;
  const current =
    original.runId &&
    request &&
    messages
      .find((message) => message.id === original.id && message.runId === original.runId)
      ?.blocks.find((block) => block.kind === "ask" && block.loginRequestEffectId === request);
  if (!current) throw new Error("The original protected login card could not be read.");
  return current.status === "answered";
}

export class WebsiteLoginAnswerUnconfirmed extends Error {
  constructor(readonly check: () => Promise<boolean>) {
    super("The protected login answer could not be confirmed.");
    this.name = "WebsiteLoginAnswerUnconfirmed";
  }
}

export async function reconcileWebsiteLoginAnswer(
  original: LoginAnswerMessage,
  read: () => Promise<readonly LoginAnswerMessage[]>,
  { rejection, confirmed }: { rejection?: unknown; confirmed?: () => void } = {},
): Promise<boolean> {
  const check = async () => {
    const answered = hasWebsiteLoginAnswer(original, await read());
    if (answered) confirmed?.();
    return answered;
  };
  try {
    if (await check()) return true;
  } catch {
    throw new WebsiteLoginAnswerUnconfirmed(check);
  }
  if (
    rejection &&
    typeof rejection === "object" &&
    "status" in rejection &&
    typeof rejection.status === "number" &&
    [400, 401, 403, 404, 409, 422].includes(rejection.status)
  )
    return false;
  throw new WebsiteLoginAnswerUnconfirmed(check);
}

export function latestAnswerableAskMessageId(snapshot: AskSnapshot | null): string | null {
  if (!snapshot) return null;
  const waitingRunIds = new Set(
    (snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : []))
      .filter((run) => run.status === "waiting_input")
      .map((run) => run.id),
  );
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (!message?.runId || !waitingRunIds.has(message.runId)) continue;
    if (message.blocks.some((block) => block.kind === "ask" && block.status !== "answered")) {
      return message.id;
    }
  }
  return null;
}

export function selectedAskActionLabel(
  answer: string,
  actions?: readonly { id: string; label: string }[],
): string {
  return resolveAskChoice(answer, actions)?.label ?? answer;
}

export function resolveAskChoice(
  answer: string,
  actions?: readonly { id: string; label: string }[],
): { id: string; label: string } | undefined {
  if (!actions?.length) return undefined;
  const trimmed = answer.trim();
  if (!trimmed) return undefined;
  const byId = actions.find((action) => action.id === trimmed);
  if (byId) return byId;
  const lower = trimmed.toLowerCase();
  return actions.find((action) => action.label.trim().toLowerCase() === lower);
}
