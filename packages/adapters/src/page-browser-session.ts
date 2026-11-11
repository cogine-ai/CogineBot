import type {
  BrowserActResult,
  BrowserActStep,
  BrowserNavigateResult,
  BrowserSnapshotNode,
  BrowserSnapshotResult,
} from "@rakazo/adapter-kit";
import { MAX_BROWSER_UPLOAD_FILES } from "@rakazo/adapter-kit";
import { JSDOM } from "jsdom";

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='combobox']",
  "[role='menuitem']",
  "[contenteditable='true']",
].join(",");

const REOPEN_SAVED_SITE = "Open the saved site with browser_navigate, then fill again.";
/** Saved usernames are typed only into these input types. Textareas stay out: a username is an input. */
const USERNAME_INPUT_TYPES = new Set(["text", "email", "tel"]);

/** A saved-login fill declined before the page changed; reported as settled, not uncertain. */
class FillRefused extends Error {}

/** A step the page cannot take as asked, such as an option the dropdown does not have. */
class SettledStep extends Error {}

type DomWindow = JSDOM["window"];
type DomElement = InstanceType<DomWindow["Element"]>;

/** In-process page session used by fake/emulator browser adapters (offline). */
export class PageBrowserSession {
  private dom: JSDOM;
  private refs = new Map<string, DomElement>();
  /** Fields holding a saved login; snapshots never report their values. */
  private loginFilled = new WeakSet<DomElement>();
  private nextRef = 1;

  constructor(
    url = "about:blank",
    html = "<!doctype html><html><head><title></title></head><body></body></html>",
  ) {
    this.dom = new JSDOM(html, { url, contentType: "text/html", pretendToBeVisual: true });
  }

  close(): void {
    this.dom.window.close();
    this.refs.clear();
  }

  get url(): string {
    return this.dom.window.location.href;
  }

  get title(): string {
    return this.dom.window.document.title || "";
  }

  load(url: string, html: string): BrowserNavigateResult {
    this.dom.window.close();
    this.dom = new JSDOM(html, { url, contentType: "text/html", pretendToBeVisual: true });
    this.refs.clear();
    return { url: this.url, title: this.title };
  }

  snapshot(): BrowserSnapshotResult {
    const { elements, tree } = this.buildSnapshot();
    return {
      url: this.url,
      title: this.title,
      tree,
      elements,
    };
  }

  act(actions: BrowserActStep[], signal?: AbortSignal): BrowserActResult {
    signal?.throwIfAborted();
    const protectedBatch =
      Array.isArray(actions) && actions.some((action) => action?.kind === "fill" && action.origin);
    try {
      this.validateActions(actions);
    } catch (error) {
      return {
        ok: false,
        completed: 0,
        ...(protectedBatch && { loginFieldsFilled: 0 }),
        uncertain: false,
        url: this.url,
        title: this.title,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    let completed = 0;
    let loginFieldsFilled = 0;
    const observed = (outcome: {
      ok: boolean;
      error?: string;
      uncertain?: boolean;
      fallback?: "computer_act";
    }): BrowserActResult => ({
      ...this.snapshot(),
      ...outcome,
      completed,
      ...(protectedBatch && { loginFieldsFilled }),
    });
    for (const action of actions) {
      signal?.throwIfAborted();
      const el = this.refs.get(action.ref);
      if (!el?.isConnected || el.ownerDocument !== this.dom.window.document) {
        return observed({
          ok: false,
          error: `Stale element ref "${action.ref}": the page has changed since that snapshot. Use a ref from the page below.`,
          uncertain: false,
        });
      }
      try {
        this.applyAction(el, action);
      } catch (error) {
        return observed({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof FillRefused || error instanceof SettledStep
            ? { uncertain: false }
            : { fallback: "computer_act" as const }),
        });
      }
      completed += 1;
      if (action.kind === "fill" && action.origin) {
        if (
          !(el instanceof this.dom.window.HTMLInputElement) ||
          !el.isConnected ||
          el.value !== action.text
        )
          return observed({
            ok: false,
            uncertain: false,
            error: "The page did not keep the saved login.",
          });
        loginFieldsFilled += 1;
      }
    }
    return observed({ ok: true });
  }

  private validateActions(actions: BrowserActStep[]): void {
    if (!Array.isArray(actions) || actions.length === 0 || actions.length > 24)
      throw new SettledStep("Expected 1 to 24 actions");
    for (const action of actions) {
      if (
        !action ||
        !["click", "fill", "type", "upload"].includes(action.kind) ||
        typeof action.ref !== "string" ||
        !action.ref
      )
        throw new SettledStep("Invalid browser action");
      if (action.kind === "fill" || action.kind === "type") {
        if (typeof action.text !== "string") throw new SettledStep("Text is required");
        this.checkFillOrigin(action);
      }
      if (
        action.kind === "upload" &&
        (!Array.isArray(action.paths) ||
          action.paths.length === 0 ||
          action.paths.length > MAX_BROWSER_UPLOAD_FILES ||
          action.paths.some((path) => typeof path !== "string" || !path.trim()))
      )
        throw new SettledStep("Upload file paths are required");
    }
  }

  private checkFillOrigin(action: { kind: string; origin?: string; field?: string }): void {
    if (!action.origin && !action.field) return;
    if (
      action.kind !== "fill" ||
      !action.origin ||
      !["username", "password"].includes(action.field ?? "")
    )
      throw new FillRefused("A saved login fill requires its origin and field.");
    let saved: URL;
    try {
      saved = new URL(action.origin);
    } catch {
      throw new FillRefused(`Website logins can only be filled on HTTPS. ${REOPEN_SAVED_SITE}`);
    }
    const page = new URL(this.url);
    if (saved.protocol !== "https:" || page.protocol !== "https:")
      throw new FillRefused(`Website logins can only be filled on HTTPS. ${REOPEN_SAVED_SITE}`);
    if (page.origin !== saved.origin)
      throw new FillRefused(
        `The page is not on the site this login was saved for. ${REOPEN_SAVED_SITE}`,
      );
  }

  private applyAction(el: DomElement, action: BrowserActStep): void {
    const win = this.dom.window;
    if (action.kind === "upload") {
      if (!(el instanceof win.HTMLInputElement) || el.type !== "file") {
        throw new Error("upload needs a file upload element from browser_snapshot");
      }
      if (action.paths.length > 1 && !el.multiple) {
        throw new Error("This file upload accepts one file");
      }
      // jsdom cannot build a FileList, so page handlers get named, empty files instead.
      const files = action.paths.map((path) => new win.File([], path.split("/").pop() ?? path));
      Object.defineProperty(el, "files", { configurable: true, value: files });
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
      return;
    }
    if (action.kind === "click") {
      if (el instanceof win.HTMLAnchorElement && el.href) {
        const next = new URL(el.href, this.url);
        if (next.href !== this.url) {
          // jsdom does not load a new document on location changes. Fall back so
          // callers use computer_act on the live browser instead of a false success.
          throw new Error(
            "In-process page browser cannot navigate links. Use computer_act on the desktop browser.",
          );
        }
      }
      el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
      // Checkboxes toggle via jsdom activation behavior. Force radios on; do not
      // invert checkboxes after dispatchEvent (that would undo the activation).
      if (el instanceof win.HTMLInputElement && el.type === "radio") {
        el.checked = true;
      }
      return;
    }
    if (action.kind === "fill" || action.kind === "type") {
      if (action.origin) {
        const inputType = el instanceof win.HTMLInputElement ? el.type : "";
        if (action.field === "password" && inputType !== "password")
          throw new FillRefused("A saved password can only be typed into a password field.");
        if (action.field === "username" && !USERNAME_INPUT_TYPES.has(inputType))
          throw new FillRefused(
            "A saved username can only be typed into a text, email, or telephone field.",
          );
      }
      const text = action.text;
      const formField = el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement;
      if (formField) {
        // Fill and type both replace the field, and with it any saved login.
        if (action.origin) this.loginFilled.add(el);
        else this.loginFilled.delete(el);
        el.value = text;
        // A partly accepted login is not left on the page, as in the live helper.
        if (action.origin && el.value !== text) {
          el.value = "";
          throw new FillRefused("This field didn't accept the saved login, so it was cleared.");
        }
        el.dispatchEvent(new win.Event("input", { bubbles: true }));
        el.dispatchEvent(new win.Event("change", { bubbles: true }));
        return;
      }
      if (el instanceof win.HTMLSelectElement) {
        const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
        const options = [...el.options];
        const match =
          options.find((o) => o.value === text) ??
          options.find((o) => optionLabel(o) === text) ??
          options.find((o) => norm(optionLabel(o)) === norm(text) || norm(o.value) === norm(text));
        if (!match) {
          throw new SettledStep(
            `This dropdown has no option "${text}". Its options: ${describeOptions(optionsOf(el, win))}.`,
          );
        }
        if (unavailable(win, match)) {
          throw new SettledStep(
            `The option "${optionLabel(match)}" is disabled. Its options: ${describeOptions(optionsOf(el, win))}.`,
          );
        }
        // The old choice goes: a multiple select would keep it otherwise.
        for (const option of options) option.selected = false;
        match.selected = true;
        el.dispatchEvent(new win.Event("input", { bubbles: true }));
        el.dispatchEvent(new win.Event("change", { bubbles: true }));
        return;
      }
      if (el.getAttribute("contenteditable") === "true") {
        el.textContent = text;
        el.dispatchEvent(new win.Event("input", { bubbles: true }));
        return;
      }
      throw new Error(`Ref ${action.ref} is not fillable`);
    }
    throw new Error(`Unsupported browser action ${action.kind}`);
  }

  private buildSnapshot(): { elements: BrowserSnapshotNode[]; tree: string } {
    this.refs.clear();
    const win = this.dom.window;
    const elements: BrowserSnapshotNode[] = [];
    const lines: string[] = [];
    const nodes = win.document.querySelectorAll(INTERACTIVE_SELECTOR);
    for (const node of nodes) {
      if (!(node instanceof win.Element)) continue;
      if (isIgnored(win, node)) continue;
      const ref = `e${this.nextRef++}`;
      this.refs.set(ref, node);
      const role = roleFor(win, node);
      const name = nameFor(win, node);
      const value = this.loginFilled.has(node) ? undefined : valueFor(win, node);
      const tag = node.tagName.toLowerCase();
      const entry: BrowserSnapshotNode = { ref, role, name, tag };
      if (value !== undefined) entry.value = value;
      if (node instanceof win.HTMLSelectElement) entry.options = optionsOf(node, win);
      elements.push(entry);
      const valuePart = value !== undefined ? ` value=${JSON.stringify(value)}` : "";
      const optionsPart = entry.options ? ` options: ${describeOptions(entry.options)}` : "";
      lines.push(`- ${role} ${JSON.stringify(name)} [${ref}]${valuePart}${optionsPart}`);
    }
    return { elements, tree: lines.join("\n") || "(no interactive elements)" };
  }
}

function isIgnored(win: DomWindow, el: DomElement): boolean {
  if (el instanceof win.HTMLInputElement && el.type === "hidden") return true;
  // Sites often aria-hide the real file input behind a styled button; it is still the upload target.
  if (el.getAttribute("aria-hidden") === "true")
    return !(el instanceof win.HTMLInputElement && el.type === "file");
  return false;
}

function optionLabel(option: { label: string; text: string }): string {
  return (option.label || option.text).replace(/\s+/g, " ").trim();
}

/** An option is out of reach when it, or the group it is in, is disabled. */
function unavailable(win: DomWindow, option: HTMLOptionElement): boolean {
  const group = option.parentElement;
  return option.disabled || (group instanceof win.HTMLOptGroupElement && group.disabled);
}

function optionsOf(select: { options: Iterable<HTMLOptionElement> }, win: DomWindow) {
  return [...select.options].map((option) => ({
    label: optionLabel(option),
    value: option.value,
    ...(option.selected ? { selected: true } : {}),
    ...(unavailable(win, option) ? { disabled: true } : {}),
  }));
}

function describeOptions(options: NonNullable<BrowserSnapshotNode["options"]>): string {
  return options
    .map(
      (option) =>
        JSON.stringify(option.label) +
        (option.value !== option.label ? `=${JSON.stringify(option.value)}` : "") +
        (option.selected ? " (selected)" : "") +
        (option.disabled ? " (disabled)" : ""),
    )
    .join(", ");
}

function roleFor(win: DomWindow, el: DomElement): string {
  if (el instanceof win.HTMLInputElement && el.type === "file") return "file upload";
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "summary") return "button";
  if (tag === "input" && el instanceof win.HTMLInputElement) {
    const type = (el.type || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button" || type === "reset") return "button";
    return "textbox";
  }
  return tag;
}

function nameFor(win: DomWindow, el: DomElement): string {
  const root = el.getRootNode();
  const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((id) =>
      root instanceof win.Document || root instanceof win.ShadowRoot
        ? (root.getElementById(id)?.textContent ?? "")
        : "",
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (labelledBy) return labelledBy;
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  if (el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement) {
    const label = el.labels?.[0]?.textContent?.trim();
    if (label) return label;
    if (el.placeholder?.trim()) return el.placeholder.trim();
    if (el.name?.trim()) return el.name.trim();
  }
  const text = el.textContent?.replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 120);
  return el.tagName.toLowerCase();
}

function valueFor(win: DomWindow, el: DomElement): string | undefined {
  if (el instanceof win.HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? "checked" : "unchecked";
    if (el.type === "file") return Array.from(el.files ?? [], (file) => file.name).join(", ");
    if (el.type === "password") return el.value ? "••••" : "";
    return el.value;
  }
  if (el instanceof win.HTMLTextAreaElement || el instanceof win.HTMLSelectElement) return el.value;
  return undefined;
}

/**
 * In-process page sessions for fake/emulator providers.
 * Callers must pass an isolation key that includes bot identity on Team
 * Computers (see `pageBrowserSessionKey`), never the bare computer id alone.
 */
export class PageBrowserSessionStore {
  private readonly sessions = new Map<string, PageBrowserSession>();

  get(sessionKey: string): PageBrowserSession {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = new PageBrowserSession();
      this.sessions.set(sessionKey, session);
    }
    return session;
  }

  clear(sessionKey?: string): void {
    if (sessionKey) {
      this.sessions.get(sessionKey)?.close();
      this.sessions.delete(sessionKey);
    } else {
      for (const session of this.sessions.values()) session.close();
      this.sessions.clear();
    }
  }
}

/**
 * Isolate page state per computer and running bot on Team Computers.
 * Prefer `context.botId` (the running bot). `computer.botId` is the home key and
 * is shared by every bot on a Team Computer, so it alone cannot isolate sessions.
 * Do not include screen-lease fences: the same bot reacquiring the computer must
 * keep the in-process page and element refs across renewals and takeover resumes.
 */
export function pageBrowserSessionKey(
  computer: { id: string; botId: string },
  context?: { botId?: string },
): string {
  const bot = context?.botId?.trim() || computer.botId;
  return `${computer.id}::${bot}`;
}
