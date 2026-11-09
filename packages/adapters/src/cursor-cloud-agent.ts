import { createHash } from "node:crypto";
import type {
  AdapterContext,
  CloudAgentHandle,
  CloudAgentLaunchRequest,
  CloudAgentProvider,
  CloudAgentReplyRequest,
  CloudAgentSnapshot,
  CloudAgentStatus,
} from "@rakazo/adapter-kit";
import {
  CloudAgentRequestRejected,
  CloudAgentRetryLater,
  CloudAgentUnavailable,
} from "@rakazo/adapter-kit";
import { z } from "zod";
import { providerRetryAfterAt } from "./provider-quota-reset.js";
import { readBodyCapped } from "./web-ssrf.js";

const agentSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  status: z.string(),
  url: z.string().optional(),
});
const runSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1).optional(),
  status: z.string(),
  git: z
    .object({
      branches: z.array(z.object({ branch: z.string().optional(), prUrl: z.string().optional() })),
    })
    .optional(),
});

const busyCode = z.object({ code: z.literal("agent_busy") });
const busyErrorSchema = z.union([busyCode, z.object({ error: busyCode })]);

export interface CursorCloudAgentOptions {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Cursor v1 wire formats and credential handling stay inside this adapter. */
export class CursorCloudAgentProvider implements CloudAgentProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CursorCloudAgentOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error("CURSOR_API_KEY is required");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  describe() {
    return {
      id: "cursor",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { launch: true, reply: true, cancel: true, offline: false },
    };
  }

  async launch(
    request: CloudAgentLaunchRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    // Cursor's client-supplied id makes create replay safe after a lost response.
    const id = cursorAgentId(request.idempotencyKey);
    const response = await this.request(
      "POST",
      "/v1/agents",
      {
        agentId: id,
        prompt: {
          text: request.prompt,
          ...(request.images?.length ? { images: request.images } : {}),
        },
        ...(request.repository ? { repos: [{ url: request.repository }] } : {}),
        ...(request.openPr !== undefined ? { autoCreatePR: request.openPr } : {}),
      },
      request.signal ?? context.signal,
      "reconcile",
    );
    if (response === null) {
      // A duplicate create may precede read visibility. Failure to observe it
      // is still ambiguous and must not terminate recovery of accepted work.
      try {
        const agent = await this.agent(id, context.signal);
        const { items, nextCursor } = await this.recentRuns(id, 2, context.signal);
        if (items.length !== 1 || nextCursor) throw new Error("Cloud agent create run is unknown");
        return this.handle(agent, items[0]!);
      } catch (error) {
        if (error instanceof CloudAgentRetryLater)
          throw new CloudAgentRetryLater(error.reason, error.retryAfterMs, false);
        if (error instanceof CloudAgentUnavailable && error.reason === "expired") throw error;
        throw new Error("Cloud agent create is awaiting reconciliation");
      }
    }
    const parsed = z.object({ agent: agentSchema, run: runSchema }).safeParse(response);
    if (!parsed.success || parsed.data.agent.id !== id)
      throw new Error("Invalid cloud agent response");
    return this.handle(parsed.data.agent, parsed.data.run);
  }

  async get(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot> {
    const agent = await this.agent(id, context.signal);
    if (runId === undefined) {
      const {
        items: [run],
      } = await this.recentRuns(id, 1, context.signal);
      if (!run) throw new Error("Cloud agent has no run to inspect");
      return this.handle(agent, run);
    }
    const parsed = runSchema.safeParse(
      await this.request(
        "GET",
        `/v1/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`,
        undefined,
        context.signal,
      ),
    );
    if (!parsed.success || parsed.data.id !== runId)
      throw new Error("Invalid cloud agent run response");
    return this.handle(agent, parsed.data);
  }

  async observeRunSuccessor(
    id: string,
    previousRunId: string | null,
    context: AdapterContext,
  ): Promise<string | null> {
    await this.agent(id, context.signal);
    if (!previousRunId) return null;
    const { items: runs } = await this.recentRuns(id, 2, context.signal);
    const [newest, previous] = runs;
    // Adjacency proves ordering only. The list does not identify which request started a run.
    if (
      runs.length !== 2 ||
      !newest ||
      previous?.id !== previousRunId ||
      newest.id === previousRunId ||
      newest.id.includes(this.apiKey)
    ) {
      return null;
    }
    return newest.id;
  }

  async reply(
    id: string,
    request: CloudAgentReplyRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    const signal = request.signal ?? context.signal;
    // A failed metadata read happens before the follow-up mutation is sent.
    const agent = await this.agent(id, signal).catch((error) => {
      if (
        error instanceof CloudAgentRequestRejected ||
        error instanceof CloudAgentRetryLater ||
        error instanceof CloudAgentUnavailable
      ) {
        throw error;
      }
      throw new CloudAgentRetryLater("unavailable");
    });
    if (signal.aborted) throw new CloudAgentRetryLater("unavailable");
    const response = await this.request(
      "POST",
      `/v1/agents/${encodeURIComponent(id)}/runs`,
      {
        prompt: {
          text: request.prompt,
          ...(request.images?.length ? { images: request.images } : {}),
        },
      },
      signal,
      "followup",
    );
    // A conflict can be the first visible sign of an earlier accepted follow-up.
    if (response === null) throw new Error("Cloud agent is busy with another run");
    const parsed = z.object({ run: runSchema }).safeParse(response);
    if (!parsed.success) throw new Error("Invalid cloud agent follow-up response");
    return this.handle(agent, parsed.data.run);
  }

  async cancel(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot> {
    const snapshot = await this.get(id, context, runId);
    if (snapshot.status !== "running") return snapshot;
    await this.request(
      "POST",
      `/v1/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(snapshot.latestRunId!)}/cancel`,
      {},
      context.signal,
      "reconcile",
    );
    // Cancellation may still be in progress. Never report success before observing it.
    return this.get(id, context, snapshot.latestRunId);
  }

  private async agent(id: string, signal: AbortSignal) {
    const parsed = agentSchema.safeParse(
      await this.request("GET", `/v1/agents/${encodeURIComponent(id)}`, undefined, signal),
    );
    if (!parsed.success || parsed.data.id !== id) throw new Error("Invalid cloud agent response");
    if (parsed.data.status === "ARCHIVED") throw new CloudAgentUnavailable("expired");
    return parsed.data;
  }

  private async recentRuns(id: string, limit: 1 | 2, signal: AbortSignal) {
    const path = `/v1/agents/${encodeURIComponent(id)}/runs?limit=${limit}`;
    const parsed = z
      .object({ items: z.array(runSchema), nextCursor: z.string().nullish() })
      .safeParse(await this.request("GET", path, undefined, signal));
    if (!parsed.success || parsed.data.items.some((run) => run.agentId && run.agentId !== id)) {
      throw new Error("Invalid cloud agent run response");
    }
    return parsed.data;
  }

  private handle(
    agent: z.infer<typeof agentSchema>,
    run: z.infer<typeof runSchema>,
  ): CloudAgentSnapshot {
    if (
      (run.agentId && run.agentId !== agent.id) ||
      agent.id.includes(this.apiKey) ||
      run.id.includes(this.apiKey)
    ) {
      throw new Error("Invalid cloud agent response");
    }
    if (run.status === "EXPIRED" || agent.status === "ARCHIVED") {
      throw new CloudAgentUnavailable("expired");
    }
    const status: CloudAgentStatus =
      run.status === "FINISHED"
        ? "finished"
        : run.status === "CANCELLED"
          ? "cancelled"
          : run.status === "ERROR"
            ? "failed"
            : "running";
    const branch = run.git?.branches[0];
    const branchName = this.publicText(branch?.branch);
    const prUrl = this.publicLink(branch?.prUrl);
    return {
      id: agent.id,
      title: this.publicText(agent.name) || "Cloud agent",
      status,
      url:
        this.publicLink(agent.url) || `https://cursor.com/agents/${encodeURIComponent(agent.id)}`,
      latestRunId: run.id,
      ...(branchName ? { branch: branchName } : {}),
      ...(prUrl ? { prUrl } : {}),
    };
  }

  private publicText(value?: string) {
    return value?.includes(this.apiKey) ? undefined : value;
  }

  private publicLink(value?: string) {
    const safeText = this.publicText(value);
    if (!safeText) return undefined;
    try {
      return this.publicText(decodeURIComponent(safeText)) ? safeText : undefined;
    } catch {
      return undefined;
    }
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    conflict?: "reconcile" | "followup",
  ): Promise<unknown> {
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    if (boundedSignal.aborted) throw new CloudAgentRetryLater("unavailable");
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.cursor.com${path}`, {
        method,
        redirect: "error",
        signal: boundedSignal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error("Cloud agent request did not complete");
    }
    if (!response.ok) {
      if (conflict === "followup" && response.status === 409) {
        let busy = false;
        try {
          const bytes = await readBodyCapped(response, 16_384, boundedSignal);
          busy = busyErrorSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes))).success;
        } catch {
          // An unreadable conflict does not prove that this request was refused.
        }
        if (busy) throw new CloudAgentRetryLater("unavailable");
        return null;
      }
      void response.body?.cancel().catch(() => undefined);
      if (conflict && response.status === 409) return null;
      if (response.status === 404) throw new CloudAgentUnavailable("not_found");
      if (response.status === 401 || response.status === 403)
        throw new CloudAgentRetryLater("credential");
      if (response.status === 429) {
        const now = Date.now();
        const retryAt = providerRetryAfterAt(response.headers.get("retry-after"), now);
        throw new CloudAgentRetryLater(
          "rate_limit",
          retryAt === undefined ? undefined : retryAt - now,
        );
      }
      if ([400, 409, 422].includes(response.status)) throw new CloudAgentRequestRejected();
      throw new Error(`Cloud agent request failed (${response.status})`);
    }
    if (response.status === 204) {
      void response.body?.cancel().catch(() => undefined);
      return {};
    }
    try {
      const bytes = await readBodyCapped(response, 1_000_000, boundedSignal);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("Invalid cloud agent response");
    }
  }
}

export function cursorAgentId(key: string) {
  const bytes = createHash("sha256").update(key).digest();
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `bc-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
