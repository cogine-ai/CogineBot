import type {
  AdapterContext,
  AgentToolExecutionResult,
  BrowserActKind,
  BrowserActRequest,
  BrowserActStep,
  BrowserProvider,
  ComputerRef,
} from "@rakazo/adapter-kit";
import { MAX_BROWSER_UPLOAD_FILES } from "@rakazo/adapter-kit";
import type { LoginField } from "./bot-secrets.js";
import {
  CONNECTOR_REDACTION_MAX_DEPTH,
  CONNECTOR_REDACTION_MAX_NODES,
  redactConnectorPayload,
} from "./connector-safety.js";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";
import { withAbort } from "./web-ssrf.js";

const MAX_BROWSER_ACTIONS = 24;
export const BROWSER_ACT_KINDS = ["click", "fill", "type", "upload", "fill_secret"] as const;
const BROWSER_CONTROL_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
  "file upload",
  "generic",
]);
const BROWSER_CONTROL_TAGS = new Set([
  "input",
  "textarea",
  "select",
  "button",
  "a",
  "div",
  "span",
  "label",
  "summary",
  "details",
]);

class BrowserToolInputError extends Error {}

function refusedInput(error: string) {
  return { ok: false, completed: 0, uncertain: false, error };
}

/** Fills a saved website login by name; the model never supplies or sees the value. */
export type SecretFillStep = {
  kind: "fill_secret";
  ref: string;
  secret: string;
  field: LoginField;
};
export type BrowserActInput = BrowserActStep | SecretFillStep;
export type ResolveSecretFill = (
  step: SecretFillStep,
) => Promise<{ text: string; origin: string } | { error: string }>;

export async function browserNavigateFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const url = String(args.url ?? "").trim();
  if (!URL.canParse(url))
    return refusedInput("An HTTP(S) URL without embedded credentials is required");
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
      return {
        error: "An HTTP(S) URL without embedded credentials is required",
        uncertain: false,
      };
    }
    const result = await browser.navigate(computer, { url, signal: context.signal }, context);
    return formatBrowserResult(result);
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      error: error instanceof Error ? error.message : String(error),
      fallback: "computer_act" as const,
    };
  }
}

export async function browserSnapshotFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  void args;
  try {
    const result = await browser.snapshot(computer, { signal: context.signal }, context);
    return formatBrowserResult(result);
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      error: error instanceof Error ? error.message : String(error),
      fallback: "computer_act" as const,
    };
  }
}

export async function browserActFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: {
    resolveSecretFill?: ResolveSecretFill;
    redactions?: () => string[];
    resolveUploadPath?: (path: string) => string;
    uploadRoots?: string[];
  } = {},
) {
  const actionContext = {
    ...context,
  };
  const preparationSignal = AbortSignal.any([context.signal, AbortSignal.timeout(22_000)]);
  let dispatchStarted = false;
  try {
    preparationSignal.throwIfAborted();
    const actions: BrowserActStep[] = [];
    const request: BrowserActRequest = { actions, signal: context.signal };
    const steps = parseBrowserActions(args.actions);
    if (
      steps.some(
        (step) => step.kind === "fill_secret" || step.kind === "type" || step.kind === "upload",
      )
    ) {
      let supported = false;
      try {
        supported = await withAbort(
          Promise.resolve().then(
            () =>
              browser.supportsPageActions?.(computer, actionContext, request, preparationSignal) ??
              false,
          ),
          preparationSignal,
        );
      } catch {
        preparationSignal.throwIfAborted();
      }
      preparationSignal.throwIfAborted();
      if (!supported) return refusedInput("Page browser action is unavailable on this computer.");
    }
    // Resolve every saved login before acting, so a missing one cannot leave a half-filled form.
    for (const step of steps) {
      preparationSignal.throwIfAborted();
      if (step.kind === "upload") {
        if (!options.resolveUploadPath || !options.uploadRoots?.length)
          throw new BrowserToolInputError("File uploads are unavailable for this workspace.");
        let paths: string[];
        try {
          paths = step.paths.map(options.resolveUploadPath);
        } catch (error) {
          throw new BrowserToolInputError(error instanceof Error ? error.message : String(error));
        }
        actions.push({ ...step, paths, roots: [...options.uploadRoots] });
        continue;
      }
      if (step.kind !== "fill_secret") {
        actions.push(step);
        continue;
      }
      let resolved: Awaited<ReturnType<ResolveSecretFill>>;
      try {
        resolved = options.resolveSecretFill
          ? await withAbort(
              Promise.resolve().then(() => options.resolveSecretFill!(step)),
              preparationSignal,
            )
          : { error: "Saved logins are unavailable here." };
      } catch {
        preparationSignal.throwIfAborted();
        return refusedInput("This saved login could not be loaded.");
      }
      preparationSignal.throwIfAborted();
      if ("error" in resolved) return refusedInput(resolved.error);
      actions.push({
        kind: "fill",
        ref: step.ref,
        text: resolved.text,
        origin: resolved.origin,
        field: step.field,
      });
    }
    preparationSignal.throwIfAborted();
    // Preparation stays bounded, but must not consume the helper's action budget.
    actionContext.signal = AbortSignal.any([context.signal, AbortSignal.timeout(22_000)]);
    dispatchStarted = true;
    const result = await withAbort(
      Promise.resolve().then(() => browser.act(computer, request, actionContext)),
      actionContext.signal,
    );
    return redactBrowserResult(formatBrowserResult(result), options.redactions?.() ?? []);
  } catch (error) {
    context.signal.throwIfAborted();
    if (preparationSignal.aborted && !dispatchStarted) {
      return { ...refusedInput("Page browser action timed out before dispatch."), timedOut: true };
    }
    if (error instanceof BrowserToolInputError) return refusedInput(error.message);
    return redactBrowserResult(
      {
        ok: false,
        uncertain: true,
        error: error instanceof Error ? error.message : String(error),
        fallback: "computer_act" as const,
      },
      options.redactions?.() ?? [],
    );
  }
}

export function parseBrowserActions(value: unknown): BrowserActInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BrowserToolInputError("browser_act requires at least one action");
  }
  if (value.length > MAX_BROWSER_ACTIONS) {
    throw new BrowserToolInputError(`browser_act accepts at most ${MAX_BROWSER_ACTIONS} actions`);
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new BrowserToolInputError(`browser_act action ${index} must be an object`);
    }
    const action = raw as Record<string, unknown>;
    const kind = String(action.kind ?? "") as BrowserActKind | "fill_secret";
    if (!(BROWSER_ACT_KINDS as readonly string[]).includes(kind)) {
      throw new BrowserToolInputError(`browser_act action ${index} has unsupported kind`);
    }
    const ref = String(action.ref ?? "").trim();
    if (!ref) throw new BrowserToolInputError(`browser_act action ${index} requires ref`);
    if (kind === "upload") {
      if (
        !Array.isArray(action.paths) ||
        action.paths.length === 0 ||
        action.paths.length > MAX_BROWSER_UPLOAD_FILES ||
        action.paths.some((path) => typeof path !== "string" || !path.trim())
      )
        throw new BrowserToolInputError(
          `browser_act upload requires 1 to ${MAX_BROWSER_UPLOAD_FILES} file paths`,
        );
      return { kind, ref, paths: action.paths.map((path) => String(path)) };
    }
    if (kind === "fill_secret") {
      const secret = String(action.secret ?? "").trim();
      const field = action.field;
      if (!secret) throw new BrowserToolInputError("browser_act fill_secret requires secret");
      if (field !== "username" && field !== "password") {
        throw new BrowserToolInputError(
          "browser_act fill_secret field must be username or password",
        );
      }
      return { kind, ref, secret, field };
    }
    if (kind === "fill" || kind === "type") {
      if (typeof action.text !== "string") {
        throw new BrowserToolInputError(`browser_act ${kind} requires text`);
      }
      return { kind, ref, text: String(action.text) };
    }
    return { kind, ref };
  });
}

/** Snapshot strings can quote a secret differently from its raw stored representation. */
export function redactBrowserResult<T>(result: T, secrets: string[]): unknown {
  if (result === undefined) return result;
  try {
    const value = JSON.parse(JSON.stringify(result));
    const refs = new Set<string>(
      Array.isArray(value?.elements)
        ? value.elements.flatMap((element: { ref?: unknown }) =>
            typeof element?.ref === "string" && element.ref.length > 0 ? [element.ref] : [],
          )
        : [],
    );
    const optionRefs = new Set<string>(
      Array.isArray(value?.elements)
        ? value.elements.flatMap(
            (element: { options?: Array<{ value?: unknown; valueRef?: unknown }> }) =>
              (element.options ?? []).flatMap((option) =>
                option.valueRef === true &&
                typeof option.value === "string" &&
                /^or2\.[0-9a-f]{32}$/.test(option.value)
                  ? [option.value]
                  : [],
              ),
          )
        : [],
    );
    const tokens = new Set([...refs, ...optionRefs]);
    const pattern = tokens.size
      ? new RegExp(
          `(${[...tokens].map((ref) => ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
          "g",
        )
      : undefined;
    let nodes = 0;
    const visit = (item: unknown, key = "", depth = 0): unknown => {
      if (++nodes > CONNECTOR_REDACTION_MAX_NODES || depth > CONNECTOR_REDACTION_MAX_DEPTH)
        throw new Error("redaction_error");
      if (typeof item === "string") {
        if (
          (key === "ref" && refs.has(item)) ||
          (key === "value" && optionRefs.has(item)) ||
          (key === "role" && BROWSER_CONTROL_ROLES.has(item)) ||
          (key === "tag" && BROWSER_CONTROL_TAGS.has(item)) ||
          (key === "fallback" && item === "computer_act")
        )
          return item;
        if (key === "tree" && pattern)
          return item
            .split(pattern)
            .map((part) => (tokens.has(part) ? part : redactConnectorPayload(part, secrets)))
            .join("");
        return redactConnectorPayload(item, secrets);
      }
      if (Array.isArray(item)) return item.map((child) => visit(child, key, depth + 1));
      if (item && typeof item === "object")
        return Object.fromEntries(
          Object.entries(item).map(([name, child]) => [name, visit(child, name, depth + 1)]),
        );
      return item;
    };
    return visit(value);
  } catch {
    return { error: "redaction_error" };
  }
}

/** Keep the bounded page tree in model text and full structured controls in details. */
export function browserResultForModel<T>(result: T): T | AgentToolExecutionResult {
  if (!result || typeof result !== "object") return result;
  const { elements, ...view } = result as { elements?: unknown; tree?: unknown } & Record<
    string,
    unknown
  >;
  if (!Array.isArray(elements) || typeof view.tree !== "string") return result;
  let text = JSON.stringify(view);
  if (text.length > TOOL_RESULT_TEXT_LIMIT) {
    const tree = view.tree;
    const starts = elements.map((element: { role?: string; name?: string; ref?: string }) => {
      const line = `- ${element.role} ${JSON.stringify(element.name ?? "")} [${element.ref}]`;
      return tree.startsWith(line) ? 0 : tree.lastIndexOf(`\n${line}`);
    });
    const start = starts.length ? Math.min(...starts) : tree.length;
    const suffix = start >= 0 ? tree.slice(start) : "";
    const prefix = Array.from(tree.slice(0, Math.max(0, start)));
    const encode = (length: number) =>
      JSON.stringify({
        ...view,
        tree: `${prefix.slice(0, length).join("")}\n[page text truncated]\n${suffix}`,
      });
    if (start >= 0 && encode(0).length <= TOOL_RESULT_TEXT_LIMIT) {
      let low = 0,
        high = prefix.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (encode(middle).length <= TOOL_RESULT_TEXT_LIMIT) low = middle;
        else high = middle - 1;
      }
      text = encode(low);
    } else {
      const outcome = Object.fromEntries(
        [
          "ok",
          "completed",
          "uncertain",
          "timedOut",
          "loading",
          "navigationOutcomeKnown",
          "fallback",
        ]
          .filter(
            (key) =>
              typeof view[key] === "boolean" ||
              typeof view[key] === "number" ||
              (key === "fallback" && view[key] === "computer_act"),
          )
          .map((key) => [key, view[key]]),
      );
      text = JSON.stringify({
        ...outcome,
        snapshotOmitted: true,
        note: "Page snapshot omitted because its metadata and controls exceed the model text budget. Inspect the current state before continuing. Do not replay completed or uncertain actions.",
      });
    }
  }
  return { kind: "agent_tool_result", content: [{ type: "text", text }], details: result };
}

function formatBrowserResult<T extends { fallback?: "computer_act"; error?: string }>(result: T) {
  if (result.fallback === "computer_act") {
    return {
      ...result,
      note: "Page browser could not complete this step. Inspect the current state before continuing with computer_act if available, otherwise request_takeover. Do not replay completed or uncertain actions.",
    };
  }
  return result;
}
