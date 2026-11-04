import { describe, expect, it } from "vitest";
import { installExactPage } from "./page-browser.test-support.js";

type OptionView = {
  label: string;
  value: string;
  optionToken: string;
  selected?: boolean;
  disabled?: boolean;
};
function optionsOf(exact: ReturnType<typeof installExactPage>["exact"], ref: string) {
  return exact.describe(ref).options as OptionView[];
}

describe("exact opaque select options", () => {
  it("reports NotKept when a change handler selects another same-value option", () => {
    for (const mode of ["switch", "additional"]) {
      const page = installExactPage(
        '<select id="choice"><option>Start</option><option value="duplicate">First</option><option value="duplicate">Second</option></select>',
      );
      try {
        const ref = page.bind("#choice"),
          token = optionsOf(page.exact, ref)[2]!.optionToken;
        const select = page.win.document.querySelector<HTMLSelectElement>("#choice")!;
        let events = 0;
        select.addEventListener("change", () => {
          events++;
          if (mode === "additional") select.multiple = true;
          select.options[1]!.selected = true;
        });
        expect(() => page.exact.act(ref, "fill", token)).toThrow(/NotKept/);
        expect(events).toBe(1);
        expect(select.value).toBe("duplicate");
        expect(select.options[1]!.selected).toBe(true);
        expect(select.options[2]!.selected).toBe(mode === "additional");
      } finally {
        page.close();
      }
    }
  });

  it("retains truncation evidence and selects the original full value through its token", () => {
    const page = installExactPage(
      '<select id="choice"><option>Start</option><option id="long"></option></select>',
    );
    try {
      const option = page.win.document.querySelector<HTMLOptionElement>("#long")!;
      option.label = "L".repeat(2001);
      option.value = "V".repeat(2001);
      const ref = page.bind("#choice");
      const view = optionsOf(page.exact, ref)[1]!;
      expect(view).toMatchObject({ labelTruncated: true, valueTruncated: true });
      expect(view.label).toHaveLength(2000);
      expect(view.value).toHaveLength(2000);
      expect(page.exact.act(ref, "fill", view.optionToken)).toBe(true);
      expect(page.win.document.querySelector<HTMLSelectElement>("#choice")!.value).toBe(
        "V".repeat(2001),
      );
    } finally {
      page.close();
    }
  });

  it("selects the exact original option when another option has the same real value", () => {
    const page = installExactPage(
      '<select id="choice"><option>Start</option><option value="duplicate">First</option><option value="duplicate">Second</option></select>',
    );
    try {
      const ref = page.bind("#choice"),
        token = optionsOf(page.exact, ref)[2]!.optionToken;
      expect(page.exact.act(ref, "fill", token)).toBe(true);
      const select = page.win.document.querySelector<HTMLSelectElement>("#choice")!;
      expect(select.selectedIndex).toBe(2);
      expect(select.options[1]!.selected).toBe(false);
    } finally {
      page.close();
    }
  });

  it("mints stable random option refs independent of label/value and resolves masked display input", () => {
    const page = installExactPage(
      '<select id="choice"><option value="start">Start</option><option value="alpha-secret">A private label</option></select>',
    );
    try {
      const ref = page.bind("#choice");
      const first = optionsOf(page.exact, ref)[1]!;
      expect(first.optionToken).toMatch(/^or2\.[a-f0-9]{32}$/);
      expect(first.optionToken).not.toContain("alpha-secret");
      expect(optionsOf(page.exact, ref)[1]!.optionToken).toBe(first.optionToken);
      expect(page.exact.act(ref, "fill", first.optionToken)).toBe(true);
      expect(page.win.document.querySelector<HTMLSelectElement>("#choice")!.value).toBe(
        "alpha-secret",
      );
    } finally {
      page.close();
    }
  });

  it.each(["label", "value"])(
    "rejects a stale token after the original option %s changes, even after describe",
    (part) => {
      const page = installExactPage(
        '<select id="choice"><option value="start">Start</option><option value="original">Original</option></select>',
      );
      try {
        const ref = page.bind("#choice");
        const token = optionsOf(page.exact, ref)[1]!.optionToken;
        const select = page.win.document.querySelector<HTMLSelectElement>("#choice")!;
        const option = select.options[1]!;
        if (part === "value") option.value = "changed";
        else option.label = "Changed";
        page.exact.describe(ref);
        expect(() => page.exact.act(ref, "fill", token)).toThrow(/stale/i);
        expect(select.value).toBe("start");
      } finally {
        page.close();
      }
    },
  );

  it.each(["replace-option", "replace-select", "move-option", "reset", "adopt"])(
    "rejects %s without selecting a same-name substitute",
    (change) => {
      const page = installExactPage(
        '<select id="choice"><option value="start">Start</option><option value="pick">Same name</option></select><select id="other"><option value="other">Other</option></select>',
      );
      try {
        const ref = page.bind("#choice");
        const token = optionsOf(page.exact, ref)[1]!.optionToken;
        const select = page.win.document.querySelector<HTMLSelectElement>("#choice")!;
        if (change === "replace-option")
          select.options[1]!.outerHTML = '<option value="pick">Same name</option>';
        if (change === "replace-select") {
          select.replaceWith(select.cloneNode(true));
          page.hit(page.win.document.querySelector("#choice"));
        }
        if (change === "move-option")
          page.win.document.querySelector("#other")!.append(select.options[1]!);
        if (change === "reset") {
          page.exact.reset();
          page.bind("#choice", ref);
        }
        if (change === "adopt")
          page.win.document.implementation.createHTMLDocument().body.append(select);
        expect(() => page.exact.act(ref, "fill", token)).toThrow(/stale/i);
        expect(
          page.win.document.querySelector<HTMLSelectElement>("#choice")?.value ?? "start",
        ).toBe("start");
      } finally {
        page.close();
      }
    },
  );

  it("rejects another select's token and a foreign document token before matching raw values", () => {
    const a = installExactPage(
      '<select id="a"><option>Start</option><option value="pick">Same</option></select><select id="b"><option>Other</option><option value="pick">Same</option></select>',
    );
    const b = installExactPage(
      '<select id="a"><option>Start</option><option value="pick">Same</option></select>',
    );
    try {
      const ar = a.bind("#a"),
        token = optionsOf(a.exact, ar)[1]!.optionToken;
      const br = a.bind("#b");
      expect(() => a.exact.act(br, "fill", token)).toThrow(/stale/i);
      const foreign = b.bind("#a");
      expect(() => b.exact.act(foreign, "fill", token)).toThrow(/stale/i);
      expect(a.win.document.querySelector<HTMLSelectElement>("#b")!.value).toBe("Other");
    } finally {
      a.close();
      b.close();
    }
  });

  it.each(["option", "group"])("rejects an opaque option when its %s becomes disabled", (kind) => {
    const page = installExactPage(
      '<select id="choice"><option>Start</option><optgroup label="Group"><option value="pick">Pick</option></optgroup></select>',
    );
    try {
      const ref = page.bind("#choice"),
        token = optionsOf(page.exact, ref)[1]!.optionToken;
      const select = page.win.document.querySelector<HTMLSelectElement>("#choice")!;
      if (kind === "option") select.options[1]!.disabled = true;
      else page.win.document.querySelector<HTMLOptGroupElement>("optgroup")!.disabled = true;
      expect(() => page.exact.act(ref, "fill", token)).toThrow(/enabled|disabled/i);
      expect(select.value).toBe("Start");
    } finally {
      page.close();
    }
  });

  it("keeps ordinary value and unique-label selection semantics", () => {
    const page = installExactPage(
      '<select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select>',
    );
    try {
      const ref = page.bind("#choice");
      expect(page.exact.act(ref, "fill", "Beta")).toBe(true);
      expect(page.exact.act(ref, "fill", "a")).toBe(true);
      expect(page.win.document.querySelector<HTMLSelectElement>("#choice")!.value).toBe("a");
    } finally {
      page.close();
    }
  });

  it("does not report success if an event handler adopts the selected control into another document", () => {
    const page = installExactPage(
      '<select id="choice"><option>Start</option><option value="pick">Pick</option></select>',
    );
    try {
      const ref = page.bind("#choice"),
        token = optionsOf(page.exact, ref)[1]!.optionToken;
      const select = page.win.document.querySelector<HTMLSelectElement>("#choice")!;
      select.addEventListener("change", () =>
        page.win.document.implementation.createHTMLDocument().body.append(select),
      );
      expect(() => page.exact.act(ref, "fill", token)).toThrow(/NotKept/);
    } finally {
      page.close();
    }
  });
});
