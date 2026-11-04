import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installExactPage, typingScript } from "./page-browser.test-support.js";

describe("exact saved-login controls", () => {
  it.each(["input", "change"])(
    "does not report success when the %s handler discards part of a saved password",
    (eventName) => {
      const { win, exact, close } = installExactPage('<input id="password" type="password">');
      try {
        const field = win.document.querySelector<HTMLInputElement>("#password")!;
        const secret = "synthetic-password-retained-value";
        exact.bind("password-ref", field);
        field.addEventListener(eventName, () => {
          field.value = field.value.slice(0, 4);
        });
        let failure: unknown;
        try {
          exact.fill("password-ref", secret, "https://login.example.test", "password");
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeTruthy();
        expect(String(failure)).toMatch(/keep|accept|retained|changed/i);
        expect(String(failure)).not.toContain(secret);
        expect(field.value).toBe(secret.slice(0, 4));
      } finally {
        close();
      }
    },
  );
});

describe("exact page controls", () => {
  it("refuses a same-name replacement until a fresh node is bound", () => {
    const { win, exact, bind, hit, close } = installExactPage('<button id="save">Save</button>');
    try {
      bind("#save", "old-ref");
      win.document.querySelector("#save")!.outerHTML = '<button id="save">Save</button>';
      const replacement = win.document.querySelector("#save")!;
      let clicks = 0;
      replacement.addEventListener("click", () => clicks++);
      hit(replacement);
      expect(() => exact.act("old-ref", "click")).toThrow(/Stale/);
      expect(clicks).toBe(0);
      exact.bind("new-ref", replacement);
      expect(exact.resolve("new-ref")).toBe(replacement);
      expect(() => exact.act("new-ref", "click")).toThrow(/native|trusted|pointer/i);
      expect(clicks).toBe(0);
    } finally {
      close();
    }
  });

  it("invalidates earlier refs on reset even when their node remains connected", () => {
    const { exact, bind, close } = installExactPage('<button id="save">Save</button>');
    try {
      bind("#save");
      exact.reset();
      expect(() => exact.resolve("#save")).toThrow(/Stale/);
    } finally {
      close();
    }
  });

  it("rejects a node adopted by another document", () => {
    const { win, exact, bind, close } = installExactPage('<input id="field">');
    try {
      bind("#field");
      win.document.implementation
        .createHTMLDocument()
        .body.append(win.document.querySelector("#field")!);
      expect(() => exact.resolve("#field")).toThrow(/Stale/);
    } finally {
      close();
    }
  });

  it("keeps shadow nodes exact and refuses them when their host is hidden", () => {
    const { win, exact, hit, close } = installExactPage('<div id="host"></div>');
    try {
      const host = win.document.querySelector<HTMLElement>("#host")!;
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = '<input id="field">';
      const field = shadow.querySelector<HTMLInputElement>("#field")!;
      exact.bind("shadow-ref", field);
      hit(field);
      expect(exact.act("shadow-ref", "fill", "中文🙂")).toBe(true);
      expect(field.value).toBe("中文🙂");
      host.style.display = "none";
      expect(() => exact.act("shadow-ref", "fill", "should-not-reach")).toThrow(/Stale/);
      expect(field.value).toBe("中文🙂");
    } finally {
      close();
    }
  });

  it("refuses covered controls before dispatching input", () => {
    const { win, exact, bind, hit, close } = installExactPage(
      '<input id="field"><div id="cover"></div>',
    );
    try {
      bind("#field");
      hit(win.document.querySelector("#cover"));
      expect(() => exact.act("#field", "fill", "not-dispatched")).toThrow(/covered/);
      expect(win.document.querySelector<HTMLInputElement>("#field")!.value).toBe("");
    } finally {
      close();
    }
  });

  it("chooses a native option by value or its unique label and fires input/change", () => {
    const { win, exact, bind, close } = installExactPage(
      '<select id="field"><option value="a">Alpha</option><option value="b">Beta</option></select>',
    );
    try {
      const ref = bind("#field");
      const field = win.document.querySelector<HTMLSelectElement>("#field")!;
      const events: string[] = [];
      field.addEventListener("input", () => events.push("input"));
      field.addEventListener("change", () => events.push("change"));
      expect(exact.act(ref, "fill", "Beta")).toBe(true);
      expect(field.value).toBe("b");
      expect(exact.act(ref, "fill", "a")).toBe(true);
      expect(field.value).toBe("a");
      expect(events).toEqual(["input", "change", "input", "change"]);
    } finally {
      close();
    }
  });

  it.each(["Missing", "Disabled", "Duplicate"])(
    "refuses the %s native option without mutation",
    (label) => {
      const { win, exact, bind, close } = installExactPage(
        '<select id="field"><option value="start">Start</option><option disabled>Disabled</option><option value="one">Duplicate</option><option value="two">Duplicate</option></select>',
      );
      try {
        const ref = bind("#field");
        let events = 0;
        win.document.body.addEventListener("change", () => events++);
        expect(() => exact.act(ref, "fill", label)).toThrow(/unique enabled/);
        expect(win.document.querySelector<HTMLSelectElement>("#field")!.value).toBe("start");
        expect(events).toBe(0);
      } finally {
        close();
      }
    },
  );

  it("retains the selected native option beyond the first hundred", () => {
    const options = Array.from(
      { length: 130 },
      (_, index) =>
        `<option value="${index}" ${index === 129 ? "selected" : ""}>Choice ${index}</option>`,
    ).join("");
    const { exact, bind, close } = installExactPage(`<select id="field">${options}</select>`);
    try {
      const described = exact.describe(bind("#field"));
      expect(described.options).toHaveLength(101);
      expect(described.optionsTotal).toBe(130);
      expect(described.options?.at(-1)).toEqual(
        expect.objectContaining({
          label: "Choice 129",
          value: "129",
          selected: true,
          optionToken: expect.stringMatching(/^or2\.[a-f0-9]{32}$/),
        }),
      );
    } finally {
      close();
    }
  });

  it("replaces contenteditable text and keeps non-ASCII characters", () => {
    const { win, exact, bind, close } = installExactPage(
      '<div id="field" contenteditable="true">old</div>',
    );
    try {
      expect(exact.act(bind("#field"), "fill", "中文🙂\nsecond line")).toBe(true);
      expect(win.document.querySelector("#field")!.textContent).toBe("中文🙂\nsecond line");
    } finally {
      close();
    }
  });

  it("does not call an immediately rejected numeric fill successful", () => {
    const { win, exact, bind, close } = installExactPage('<input id="field" type="number">');
    try {
      expect(() => exact.act(bind("#field"), "fill", "123not-a-number")).toThrow(
        /keep|accept|retained|changed/i,
      );
      expect(win.document.querySelector<HTMLInputElement>("#field")!.value).toBe("");
    } finally {
      close();
    }
  });
});

describe("typing focus boundaries", () => {
  const digits = () =>
    Array.from(
      { length: 12 },
      (_, i) => `<input maxlength="1" aria-label="Digit ${(i % 6) + 1}">`,
    ).join("");
  const run = (
    win: ReturnType<typeof installExactPage>["win"],
    name: "TYPE_START" | "TYPE_CHECK",
    ref = "first",
  ) =>
    win.eval(
      typingScript(name)
        .replaceAll("TOKEN", "test-token")
        .replaceAll("WHOLE", "true")
        .replaceAll("EXACT_REF", JSON.stringify(ref)),
    );

  it("stops when focus jumps to the other same-name code in one container", () => {
    const { win, exact, hit, close } = installExactPage(`<div id="codes">${digits()}</div>`);
    try {
      const fields = win.document.querySelectorAll<HTMLInputElement>("input");
      exact.bind("first", fields[0]!);
      hit(fields[0]!);
      exact.act("first", "focus");
      run(win, "TYPE_START");
      fields[6]!.focus();
      expect(() => run(win, "TYPE_CHECK")).toThrow(/focus|Typing stopped/i);
      expect(Array.from(fields, (field) => field.value).join("")).toBe("");
    } finally {
      close();
    }
  });

  it("continues within the original connected code group when its child boxes redraw", () => {
    const { win, exact, hit, close } = installExactPage(`<div id="codes">${digits()}</div>`);
    try {
      const group = win.document.querySelector("#codes")!;
      const first = group.querySelector<HTMLInputElement>("input")!;
      exact.bind("first", first);
      hit(first);
      exact.act("first", "focus");
      run(win, "TYPE_START");
      group.innerHTML = digits();
      group.querySelectorAll<HTMLInputElement>("input")[1]!.focus();
      expect(run(win, "TYPE_CHECK")).toBe(true);
    } finally {
      close();
    }
  });

  it("stops when a whole code group is replaced by a same-name group", () => {
    const { win, exact, hit, close } = installExactPage(`<div id="codes">${digits()}</div>`);
    try {
      const group = win.document.querySelector("#codes")!;
      const first = group.querySelector<HTMLInputElement>("input")!;
      exact.bind("first", first);
      hit(first);
      exact.act("first", "focus");
      run(win, "TYPE_START");
      group.outerHTML = `<div id="codes">${digits()}</div>`;
      win.document.querySelector<HTMLInputElement>("#codes input")!.focus();
      expect(() => run(win, "TYPE_CHECK")).toThrow(/focus|Typing stopped/i);
    } finally {
      close();
    }
  });

  it("does not clear a different field when initial keyboard focus is redirected", () => {
    const { win, exact, bind, close } = installExactPage(
      '<input id="first"><input id="other" value="must-stay">',
    );
    try {
      bind("#first", "first");
      const first = win.document.querySelector<HTMLInputElement>("#first")!;
      const other = win.document.querySelector<HTMLInputElement>("#other")!;
      first.addEventListener("focus", () => other.focus());
      expect(() => {
        exact.act("first", "focus");
        run(win, "TYPE_START");
      }).toThrow(/focus/i);
      expect(first.value).toBe("");
      expect(other.value).toBe("must-stay");
    } finally {
      close();
    }
  });

  it.each(["focus", "detach"] as const)(
    "rechecks exact typing after an input listener changes %s",
    (change) => {
      const { win, exact, bind, close } = installExactPage(
        '<input id="field"><input id="other" value="untouched">',
      );
      try {
        bind("#field", "field");
        const field = win.document.querySelector<HTMLInputElement>("#field")!;
        const other = win.document.querySelector<HTMLInputElement>("#other")!;
        exact.act("field", "focus");
        run(win, "TYPE_START", "field");
        field.addEventListener(
          "input",
          () => {
            if (change === "detach") field.remove();
            other.focus();
          },
          { once: true },
        );
        field.value = "A";
        field.dispatchEvent(
          new win.InputEvent("input", { bubbles: true, data: "A", inputType: "insertText" }),
        );
        expect(() => run(win, "TYPE_CHECK", "field")).toThrow(/focus|Typing stopped|changed/i);
        expect(other.value).toBe("untouched");
      } finally {
        close();
      }
    },
  );

  it("rejects an unfocused document even when its old input remains the active element", () => {
    const { win, exact, bind, close } = installExactPage('<input id="field">');
    try {
      bind("#field", "field");
      exact.act("field", "focus");
      run(win, "TYPE_START", "field");
      const active = win.document.activeElement;
      // JSDOM does not update nested-document hasFocus after parent or sibling focus.
      // This isolates the browser-reported focus branch; real frames are checked in browser CI.
      const focus = vi.spyOn(win.document, "hasFocus").mockReturnValue(false);
      expect(win.document.activeElement).toBe(active);
      expect(() => run(win, "TYPE_CHECK", "field")).toThrow(/focus|Typing stopped/i);
      focus.mockRestore();
    } finally {
      close();
    }
  });

  it("focuses a layout-backed transparent AX input for typing while refusing fill and login", () => {
    const { win, exact, close } = installExactPage('<input id="field" style="opacity:0">');
    try {
      const field = win.document.querySelector<HTMLInputElement>("#field")!;
      exact.bind("first", field, { ax: true });
      expect(exact.act("first", "focus")).toBe(true);
      expect(run(win, "TYPE_START")).toMatchObject({ multiline: false });
      expect(() => exact.act("first", "click")).toThrow(/Stale|visible/i);
      expect(() => exact.act("first", "fill", "not-dispatched")).toThrow(/Stale|visible/i);
      expect(() =>
        exact.fill("first", "private", "https://login.example.test", "username"),
      ).toThrow(/Stale|visible/i);
      expect(field.value).toBe("");
    } finally {
      close();
    }
  });

  it.each([
    ['<input id="field" type="password" style="opacity:0">', true],
    ['<input id="field" style="opacity:0">', false],
    ['<input id="field" style="display:none">', true],
    ['<input id="field" style="visibility:hidden">', true],
    ['<div style="opacity:0"><input id="field" style="opacity:0"></div>', true],
    ['<input id="field" style="opacity:0" readonly>', true],
    ['<input id="field" style="opacity:0" disabled>', true],
  ] as const)(
    "does not extend transparent typing to hidden or unaudited controls %s",
    (html, ax) => {
      const { win, exact, close } = installExactPage(html);
      try {
        const field = win.document.querySelector<HTMLInputElement>("#field")!;
        expect(() => exact.bind("first", field, { ax })).toThrow(/visible/i);
        expect(field.value).toBe("");
      } finally {
        close();
      }
    },
  );
});

describe("typing completion identity", () => {
  it.each(["detached", "missing-token", "replaced-code-group"] as const)(
    "does not claim retained typing after %s",
    (change) => {
      const html =
        change === "replaced-code-group"
          ? '<div id="group">' +
            Array.from(
              { length: 6 },
              (_, i) => `<input maxlength="1" aria-label="Digit ${i + 1}">`,
            ).join("") +
            "</div>"
          : '<input id="field">';
      const { win, exact, bind, close } = installExactPage(html);
      try {
        bind("input", "field");
        exact.act("field", "focus");
        win.eval(
          typingScript("TYPE_START")
            .replaceAll("TOKEN", "token")
            .replaceAll("WHOLE", "true")
            .replaceAll("EXACT_REF", JSON.stringify("field")),
        );
        if (change === "missing-token") {
          delete (win as unknown as { __rakazoTyping?: unknown }).__rakazoTyping;
        } else if (change === "replaced-code-group") {
          win.document.querySelector("#group")!.remove();
        } else {
          win.document.querySelector("input")!.remove();
        }
        let result: unknown;
        try {
          result = win.eval(
            typingScript("TYPE_DONE")
              .replaceAll("TOKEN", "token")
              .replaceAll("TEXT", JSON.stringify("Already typed")),
          );
        } catch (error) {
          expect(String(error)).toMatch(/page|document|detach|Typing stopped|changed/i);
          return;
        }
        if (typeof result !== "object" || result === null || !("kept" in result)) {
          throw new Error("Typing completion did not report a retention state");
        }
        expect(result.kept).not.toBe(true);
      } finally {
        close();
      }
    },
  );
});

describe("retained ordinary text", () => {
  it.each([
    ["Hi🙂", "Hi"],
    ["Hello!", "Hello"],
    ["Hello", "hello"],
  ])("does not call %s retained when the page kept %s", (wanted, actual) => {
    const { win, exact, bind, close } = installExactPage('<input id="field">');
    try {
      bind("#field", "field");
      exact.act("field", "focus");
      win.eval(
        typingScript("TYPE_START")
          .replaceAll("TOKEN", "token")
          .replaceAll("WHOLE", "true")
          .replaceAll("EXACT_REF", JSON.stringify("field")),
      );
      win.document.querySelector<HTMLInputElement>("#field")!.value = actual;
      const result = win.eval(
        typingScript("TYPE_DONE")
          .replaceAll("TOKEN", "token")
          .replaceAll("TEXT", JSON.stringify(wanted)),
      );
      expect(result).toEqual({ kept: false });
    } finally {
      close();
    }
  });

  it.each([
    ["Hi🙂!", "Hi🙂!"],
    ["Grace\n", "Grace"],
  ])("accepts intact ordinary text %s under the single-line contract", (wanted, actual) => {
    const { win, exact, bind, close } = installExactPage('<input id="field">');
    try {
      bind("#field", "field");
      exact.act("field", "focus");
      win.eval(
        typingScript("TYPE_START")
          .replaceAll("TOKEN", "token")
          .replaceAll("WHOLE", "true")
          .replaceAll("EXACT_REF", JSON.stringify("field")),
      );
      win.document.querySelector<HTMLInputElement>("#field")!.value = actual;
      const result = win.eval(
        typingScript("TYPE_DONE")
          .replaceAll("TOKEN", "token")
          .replaceAll("TEXT", JSON.stringify(wanted)),
      );
      expect(result).toEqual({ kept: true });
    } finally {
      close();
    }
  });

  it("refuses an option inside a disabled optgroup before changing the native select", () => {
    const { win, exact, bind, close } = installExactPage(
      '<select id="field"><option value="start">Start</option><optgroup disabled label="Unavailable"><option value="blocked">Blocked</option></optgroup></select>',
    );
    try {
      const ref = bind("#field");
      let events = 0;
      win.document.body.addEventListener("change", () => events++);
      expect(() => exact.act(ref, "fill", "blocked")).toThrow(/enabled|disabled/i);
      expect(win.document.querySelector<HTMLSelectElement>("#field")!.value).toBe("start");
      expect(events).toBe(0);
    } finally {
      close();
    }
  });
});

describe("native file and option metadata", () => {
  it("advertises a layout-visible aria-hidden file input as a file upload target", () => {
    const { exact, close } = installExactPage(
      '<input type="file" aria-hidden="true" aria-label="Attach files">',
    );
    try {
      const controls = exact.cursor("tab", "frame", "loader");
      expect(controls).toHaveLength(1);
      expect(controls[0]).toMatchObject({ role: "file upload", name: "Attach files" });
      expect(controls[0]!.ref).toMatch(/^r2\./);
    } finally {
      close();
    }
  });

  it.each([
    '<input type="file" aria-hidden="true" style="display:none">',
    '<input type="password" aria-hidden="true">',
    '<input type="text" aria-hidden="true">',
  ])("keeps the file-only visibility exception out of hidden and non-file targets %s", (html) => {
    const { exact, close } = installExactPage(html);
    try {
      expect(exact.cursor("tab", "frame", "loader")).toEqual([]);
    } finally {
      close();
    }
  });

  it("marks native options disabled when their optgroup is disabled", () => {
    const { exact, bind, close } = installExactPage(
      '<select id="field"><option value="start">Start</option><optgroup disabled><option value="blocked">Blocked</option></optgroup></select>',
    );
    try {
      expect(exact.describe(bind("#field")).options).toContainEqual(
        expect.objectContaining({
          label: "Blocked",
          value: "blocked",
          disabled: true,
          optionToken: expect.stringMatching(/^or2\.[a-f0-9]{32}$/),
        }),
      );
    } finally {
      close();
    }
  });
});

it("does not treat synthetic pointer events as trusted recovery evidence", () => {
  const { win, close } = installExactPage("");
  try {
    const source = readFileSync(
      new URL("../../../infra/sandboxes/computer/page_secrets.py", import.meta.url),
      "utf8",
    );
    const script = source.match(/POINTER_OBSERVER = r"""\n([\s\S]*?)\n"""/)?.[1];
    if (!script) throw new Error("Pointer observer was not found");
    win.eval(script);
    const observer = (
      win as unknown as {
        __rakazoPointerObserver: {
          arm: (token: string) => unknown;
          read: (token: string) => unknown;
        };
      }
    ).__rakazoPointerObserver;
    observer.arm("owned-token");
    win.dispatchEvent(new win.MouseEvent("mousedown", { buttons: 1 }));
    win.dispatchEvent(new win.MouseEvent("mouseup", { buttons: 0 }));
    expect(observer.read("owned-token")).toEqual({ down: null, up: null });
  } finally {
    close();
  }
});

it("records only a fresh trusted left-button release for pointer recovery", () => {
  const source = readFileSync(
    new URL("../../../infra/sandboxes/computer/page_secrets.py", import.meta.url),
    "utf8",
  );
  const script = source.match(/POINTER_OBSERVER = r"""\n([\s\S]*?)\n"""/)?.[1];
  if (!script) throw new Error("Pointer observer was not found");
  type Event = { type: string; isTrusted: boolean; button: number; buttons: number };
  const handlers = new Map<string, (event: Event) => void>();
  let stamp = 0;
  const context = {
    window: {} as {
      __rakazoPointerObserver?: {
        arm: (token: string) => unknown;
        read: (token: string) => { down: number | null; up: number | null };
      };
    },
    performance: { timeOrigin: 0, now: () => ++stamp },
    addEventListener: (name: string, listener: (event: Event) => void) => {
      handlers.set(name, listener);
    },
  };
  runInNewContext(script, context);
  const observer = context.window.__rakazoPointerObserver!;
  const release = (button: number, isTrusted = true, buttons = 0) =>
    handlers.get("mouseup")!({ type: "mouseup", button, buttons, isTrusted });
  release(0); // A release before registration cannot become recovery evidence.
  observer.arm("recovery-token");
  release(2);
  expect(observer.read("recovery-token").up).toBeNull();
  release(0, false);
  expect(observer.read("recovery-token").up).toBeNull();
  release(0, true, 1);
  expect(observer.read("recovery-token").up).toBeNull();
  release(0);
  expect(observer.read("recovery-token").up).toBeGreaterThan(0);
  const oldObserver = { version: 1 };
  const upgraded = { ...context, window: { __rakazoPointerObserver: oldObserver } };
  runInNewContext(script, upgraded);
  expect(upgraded.window.__rakazoPointerObserver).not.toBe(oldObserver);
  expect(upgraded.window.__rakazoPointerObserver).toMatchObject({ version: 2 });
});

it("keeps one observer token while preserving repeated-arm object identity", () => {
  const { win, close } = installExactPage("");
  try {
    const source = readFileSync(
      new URL("../../../infra/sandboxes/computer/page_secrets.py", import.meta.url),
      "utf8",
    );
    const script = source.match(/POINTER_OBSERVER = r"""\n([\s\S]*?)\n"""/)?.[1];
    if (!script) throw new Error("Pointer observer was not found");
    win.eval(script);
    const observer = (
      win as unknown as {
        __rakazoPointerObserver: {
          arm: (token: string) => { down: number | null; up: number | null };
          read: (token: string) => { down: number | null; up: number | null };
        };
      }
    ).__rakazoPointerObserver;
    const first = observer.arm("first");
    first.down = 1; // Private state fixture only; this does not simulate a trusted DOM event.
    expect(observer.arm("first")).toBe(first);
    expect(observer.read("first").down).toBe(1);
    const next = observer.arm("next");
    expect(observer.read("first")).toEqual({ down: null, up: null });
    expect(observer.arm("next")).toBe(next);
    expect(observer.arm("first")).not.toBe(first);
  } finally {
    close();
  }
});

it("mints only the remaining exact cursor references requested by the collector", () => {
  const { exact, close } = installExactPage(
    Array.from({ length: 10 }, (_, i) => `<div onclick="void 0">Extra ${i}</div>`).join(""),
  );
  try {
    const controls = exact.cursor("tab", "frame", "loader", 3);
    expect(controls).toHaveLength(3);
    for (const control of controls) expect(exact.resolve(control.ref)).toBeTruthy();
  } finally {
    close();
  }
});
